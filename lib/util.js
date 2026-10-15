'use strict';
/**
 * util.js — 通用工具：字节安全、原子 JSON 读写、路径守卫、SSE、id。
 *
 * 设计要点（踩坑记录，改动前请先读）：
 *  1. Windows 的 MAX_PATH 是 260 个字符，只有给 Win32 API 加 `\\?\` 前缀才能到 32767。
 *     Node 在 Windows 上对绝对路径会自动加前缀，所以「深层目录 + 长文件名」能用，
 *     但资源管理器 / 大多数播放器 / 数据线对拷的目标设备不一定行。
 *     因此命名时按**字节**预算（见 naming.js），并且绝对路径总长也要设上限。
 *  2. 字节数一律用 Buffer.byteLength(s,'utf8')，不要用 [...s].length 或 s.length：
 *     中文一字 3 字节，emoji 可能 4 字节，NTFS 的 255 限制是字节不是字符。
 *  3. 目录遍历一律不用递归，改用显式栈 —— 深层目录 + 符号链接容易把递归打爆。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const META_DIRNAME = '.mtag';       // 库内元数据目录（sqlite 替代品 / 日志 / 缓存 / 导出暂存）
const THUMB_DIRNAME = 'thumbs';
const EXPORT_DIRNAME = 'exports';

function nowIso() {
  return new Date().toISOString();
}

function hex32() {
  return crypto.randomBytes(16).toString('hex');
}

function sha1hex(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function bbytes(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

/** 逐码点遍历，避免把代理对（emoji）切半。 */
function chars(s) {
  return Array.from(String(s));
}

function truncateChars(s, n) {
  const a = chars(s);
  return a.length <= n ? String(s) : a.slice(0, n).join('');
}

function truncateCharsFromEnd(s, n) {
  const a = chars(s);
  return a.length <= n ? String(s) : a.slice(a.length - n).join('');
}

/** 按字节上限从尾部截断（不会切出半个码点）。 */
function truncateBytes(s, maxBytes) {
  const a = chars(s);
  let out = '';
  let used = 0;
  for (const ch of a) {
    const b = bbytes(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** 原子写 JSON：先写同目录临时文件，再 rename 覆盖。断电最多丢一次写入，不会写出半个文件。 */
async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    let raw = await fsp.readFile(file, 'utf8');
    // 去掉 UTF-8 BOM：记事本、PowerShell 的 Set-Content、各种编辑器都可能给文件加 BOM，
    // 而 JSON.parse 见到 BOM 会直接抛错 —— 表现就是"配置明明在那儿却像没读到一样"，
    // 排查起来很费劲。这里顺手剥掉，容错比严格更重要。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function removeIfExists(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {
    /* 忽略：删除失败不致命 */
  }
}

/**
 * 路径守卫：确保 target 落在 root 内。
 * 用 path.relative 判断，跨盘符时 relative 会返回绝对路径，也能被正确识别。
 */
function withinRoot(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function fromPosix(p) {
  return String(p).split('/').join(path.sep);
}

/** 库内相对路径（始终 posix 风格，便于跨平台存库） */
function relTo(root, abs) {
  return toPosix(path.relative(path.resolve(root), path.resolve(abs)));
}

function absFrom(root, rel) {
  return path.resolve(root, fromPosix(rel));
}

function stripDrive(p) {
  return String(p).replace(/^[a-zA-Z]:/, '');
}

/** 绝对路径长度上限：给目标设备 / 资源管理器留余量 */
const MAX_ABS_PATH_CHARS = 250;

function pathLengthOk(p) {
  return path.resolve(p).length <= MAX_ABS_PATH_CHARS;
}

/** 把本地绝对路径变成安全可读的提示（前端展示用） */
function displayPath(p) {
  return path.resolve(p);
}

// ---------------------------------------------------------------- 目录遍历

/** Windows 常见系统垃圾，扫描时直接跳过 */
const JUNK_NAMES = new Set([
  'desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store', 'icon\r',
  '$recycle.bin', 'system volume information', '.git', 'node_modules',
]);
const JUNK_EXT = new Set(['.tmp', '.part', '.crdownload', '.aria2', '.!ut', '.downloading']);

function isJunk(name) {
  const lower = name.toLowerCase();
  if (JUNK_NAMES.has(lower)) return true;
  if (JUNK_EXT.has(path.extname(lower))) return true;
  if (lower.endsWith('.aria2')) return true;
  if (/^\._/.test(lower)) return true;          // macOS 资源分支
  return false;
}

/** 显式栈遍历，返回 [{abs, rel, name, size, mtimeMs}] */
async function walkFiles(root, opts = {}) {
  const ignoreDirs = new Set([META_DIRNAME, ...(opts.ignoreDirs || [])].map((s) => s.toLowerCase()));
  const out = [];
  const stack = [path.resolve(root)];
  const guard = opts.maxFiles || 200000;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;                                  // 权限 / 竞态：跳过该目录
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name.toLowerCase())) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;               // 符号链接 / 设备文件一律忽略
      if (isJunk(ent.name)) continue;
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      out.push({
        abs,
        rel: relTo(root, abs),
        name: ent.name,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      });
      if (out.length >= guard) return out;
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

async function listDirs(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (isJunk(ent.name)) continue;
    out.push({ name: ent.name, path: path.join(dir, ent.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp', '.ogv', '.rmvb', '.vob']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.ape', '.aiff', '.alac']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.jfif', '.svg']);

function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.ogv': 'video/ogg', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.zip': 'application/zip',
};

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/** 浏览器 <video>/<audio> 只对这部分容器有把握；其余给「复制路径/下载」提示 */
const BROWSER_PLAYABLE = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);

function browserPlayable(name) {
  return BROWSER_PLAYABLE.has(path.extname(name).toLowerCase());
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** SSE 帮助器：统一心跳与关闭 */
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = {
  META_DIRNAME,
  THUMB_DIRNAME,
  EXPORT_DIRNAME,
  MAX_ABS_PATH_CHARS,
  nowIso,
  hex32,
  sha1hex,
  bbytes,
  chars,
  truncateChars,
  truncateCharsFromEnd,
  truncateBytes,
  ensureDir,
  exists,
  statOrNull,
  writeJsonAtomic,
  readJson,
  removeIfExists,
  withinRoot,
  toPosix,
  fromPosix,
  relTo,
  absFrom,
  stripDrive,
  pathLengthOk,
  displayPath,
  isJunk,
  walkFiles,
  listDirs,
  classify,
  mimeFor,
  browserPlayable,
  humanBytes,
  safeDecode,
  sseInit,
  sseSend,
  cpus: os.cpus().length,
};
