'use strict';
/**
 * recycle.js — 把文件送进 Windows 回收站。
 *
 * 为什么不用 `fs.unlink`：删素材是不可逆的，用户手滑一下几百 G 就没了。
 * 送进回收站之后随时能在资源管理器里还原，代价只是磁盘暂时不释放。
 *
 * 实现用 shell32 的 `SHFileOperationW` + `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT |
 * FOF_NOERRORUI`：带 `FOF_ALLOWUNDO` 才是「进回收站」，否则就是永久删除；后三个标志保证
 * 它不会弹确认框/错误框（服务在后台跑，弹框等于卡死）。不用 `Shell.Application` 的
 * `InvokeVerb('delete')`，那个会弹确认框，也没法一次处理一批。
 *
 * 返回逐条结果而不是一个总成败：一批 50 个文件里可能有 1 个被别的程序占着，
 * 剩下 49 个照样要删掉，界面也要能说清楚是哪几个没成功。
 */

const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const { spawn } = require('child_process');

const SCRIPT_TIMEOUT_MS = 120000;

class RecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecycleError';
  }
}

/**
 * 这个 PowerShell 脚本做两件事：
 *   1. 用 Add-Type 现编一小段 C#，把 SHFileOperationW 包出来（每个进程编一次，约 0.3 秒）；
 *   2. 拿列表逐条删，把「谁成功 / 谁失败 / Shell 返回码」写成 JSON。
 * 列表走文件而不是命令行参数：几百个中文长路径塞进命令行会超 32K 限制，还要跟引号转义打架。
 */
const PS_SCRIPT = [
  'param([Parameter(Mandatory=$true)][string]$List, [Parameter(Mandatory=$true)][string]$Out)',
  '$ErrorActionPreference = "Stop"',
  'if (-not ("TagStudioShell" -as [type])) {',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class TagStudioShell {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct SHFILEOPSTRUCT {',
  '    public IntPtr hwnd;',
  '    public uint wFunc;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;',
  '    public ushort fFlags;',
  '    public bool fAnyOperationsAborted;',
  '    public IntPtr hNameMappings;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;',
  '  }',
  '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern int SHFileOperation(ref SHFILEOPSTRUCT op);',
  '  public static int DeleteOne(string file) {',
  '    var sb = new StringBuilder(file);',
  '    sb.Append((char)0);',
  '    sb.Append((char)0);',
  '    var op = new SHFILEOPSTRUCT();',
  '    op.wFunc = 3;',
  '    op.pFrom = sb.ToString();',
  '    op.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x0200;',
  '    op.fAnyOperationsAborted = false;',
  '    int rc = SHFileOperation(ref op);',
  '    if (op.fAnyOperationsAborted) return 1223;',
  '    return rc;',
  '  }',
  '}',
  '"@',
  '}',
  '$data = Get-Content -LiteralPath $List -Raw -Encoding UTF8 | ConvertFrom-Json',
  '$rows = New-Object System.Collections.ArrayList',
  'foreach ($p in $data.paths) {',
  '  $item = [string]$p',
  '  try {',
  '    $rc = [TagStudioShell]::DeleteOne($item)',
  '    if ($rc -eq 0) { [void]$rows.Add([pscustomobject]@{ path = $item; ok = $true; error = $null }) }',
  '    else { [void]$rows.Add([pscustomobject]@{ path = $item; ok = $false; error = ("回收站返回码 " + $rc) }) }',
  '  } catch {',
  '    [void]$rows.Add([pscustomobject]@{ path = $item; ok = $false; error = $_.Exception.Message })',
  '  }',
  '}',
  '$obj = [pscustomobject]@{ rows = @($rows) }',
  '$json = ConvertTo-Json -InputObject $obj -Depth 4 -Compress',
  '[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))',
  '',
].join('\r\n');

function trimOutput(text, limit = 400) {
  const s = String(text || '').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 把一批绝对路径送进回收站。
 * @param {string[]} files
 * @param {{timeoutMs?: number, env?: object}} [opts]
 * @returns {Promise<{deleted: string[], failed: Array<{path: string, error: string}>}>}
 */
async function recycleFiles(files, opts = {}) {
  const list = (files || []).map((p) => path.resolve(String(p))).filter(Boolean);
  const result = { deleted: [], failed: [] };
  if (!list.length) return result;
  if (process.platform !== 'win32') {
    throw new RecycleError('这台机器不是 Windows，没有回收站可用');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tagstudio-recycle-'));
  const listFile = path.join(tmpDir, 'files.json');
  const scriptFile = path.join(tmpDir, 'recycle.ps1');
  const outFile = path.join(tmpDir, 'result.json');
  try {
    await fsp.writeFile(listFile, JSON.stringify({ paths: list }), 'utf8');
    // 带 BOM 写：Windows PowerShell 5.1 读「没有 BOM 的 .ps1」时按系统 ANSI 代码页（简中机器是 GBK）
    // 解码，脚本里的中文字符串会变成乱码。BOM 一加就按 UTF-8 读。
    await fsp.writeFile(scriptFile, `\uFEFF${PS_SCRIPT}`, 'utf8');
    // 每个文件一次 shell 调用 + 编译开销，给足时间；下限 30 秒，上限 2 分钟
    const timeout = opts.timeoutMs || Math.min(SCRIPT_TIMEOUT_MS, Math.max(30000, list.length * 1500 + 20000));
    const env = { ...process.env, ...(opts.env || {}) };
    const run = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptFile, '-List', listFile, '-Out', outFile,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (err) {
        resolve({ code: -1, stderr: String(err && err.message) });
        return;
      }
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch { /* 已经退了 */ }
        resolve({ code: -2, stderr: `${stderr}\n（超时 ${timeout} ms，已中止）` });
      }, timeout);
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: -1, stderr: String(err && err.message) });
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });

    const raw = await fsp.readFile(outFile, 'utf8').catch(() => '');
    if (!raw) {
      throw new RecycleError(`无法把文件送进回收站：${trimOutput(run.stderr) || `PowerShell 退出码 ${run.code}`}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new RecycleError(`回收站脚本返回了无法解析的内容：${trimOutput(raw)}`);
    }
    const rows = (parsed && Array.isArray(parsed.rows)) ? parsed.rows : [];
    const byPath = new Map();
    for (const row of rows) {
      if (!row || !row.path) continue;
      byPath.set(path.resolve(String(row.path)).toLowerCase(), row);
    }
    for (const abs of list) {
      const row = byPath.get(abs.toLowerCase());
      if (row && row.ok) result.deleted.push(abs);
      else result.failed.push({ path: abs, error: (row && row.error) || '没有拿到这条文件的结果' });
    }
    return result;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { recycleFiles, RecycleError };
