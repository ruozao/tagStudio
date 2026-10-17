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

/** Windows 上目标文件正被别人（并发 rename、杀毒、索引服务）短暂占用时 rename 会报这几种错 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has(err && err.code) || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/** 同一个文件的写入排队执行：Windows 上两个 rename 同时覆盖同一目标会有一个 EPERM */
const atomicWriteQueues = new Map();

/** 原子写 JSON：先写同目录临时文件，再 rename 覆盖。断电最多丢一次写入，不会写出半个文件。 */
function writeJsonAtomic(file, value) {
  const key = path.resolve(file).toLowerCase();
  const body = JSON.stringify(value, null, 2);
  const prev = atomicWriteQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now()}.${hex32().slice(0, 8)}.tmp`;
    await fsp.writeFile(tmp, body, 'utf8');
    try {
      await renameWithRetry(tmp, file);
    } catch (err) {
      await removeIfExists(tmp);
      throw err;
    }
  });
  atomicWriteQueues.set(key, run);
  const cleanup = () => { if (atomicWriteQueues.get(key) === run) atomicWriteQueues.delete(key); };
  run.then(cleanup, cleanup);
  return run;
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

/**
 * 有界并发地把 items 里的每一项交给 fn 跑一遍（fn 内部自己 await）。
 * 只用来包**叶子操作**（一次 stat / 一次写），别在 fn 里再嵌套 poolMap 等别人的名额 —— 会互相堵。
 */
async function poolMap(items, concurrency, fn) {
  const total = items.length;
  const lanes = Math.max(1, Math.min(concurrency || 1, total));
  let cursor = 0;
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * 遍历时的 stat 并发度。
 * 实测（F:\video，17,996 个文件、机械盘）：串行一次一个 820–920ms；
 * 8 路 255ms、16 路 238ms、32 路 243ms、64 路 255ms —— 到 8 路就到顶，再往上只是让盘来回跳。
 * 取 16：比 8 略快，又不会在机械盘上排太多并行的寻道。
 */
const WALK_CONCURRENCY = 16;

/**
 * 显式栈遍历，返回 [{abs, rel, name, size, mtimeMs}]（按 rel 排序）
 *
 * 分两段：先只 readdir 把目录树走一遍，再把所有文件丢进并发池取 size/mtime。
 * 以前是「拿到一个文件就 await 一次 stat」，一趟扫描大半时间都在排队等磁盘 ——
 * 一个 18,000 个文件的库光这一项就要 0.9 秒，正好是用户感觉到的「打开就卡一下」。
 */
async function walkFiles(root, opts = {}) {
  const ignoreDirs = new Set([META_DIRNAME, ...(opts.ignoreDirs || [])].map((s) => s.toLowerCase()));
  const guard = opts.maxFiles || 200000;
  const rootAbs = path.resolve(root);
  const pending = [];                            // 待取 size/mtime 的文件
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;                                  // 权限 / 竞态：跳过该目录
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name.toLowerCase())) continue;
        stack.push(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;               // 符号链接 / 设备文件一律忽略
      if (isJunk(ent.name)) continue;
      pending.push({ abs: path.join(dir, ent.name), name: ent.name });
    }
  }

  const out = [];
  await poolMap(pending, opts.concurrency || WALK_CONCURRENCY, async (job) => {
    let st;
    try {
      st = await fsp.stat(job.abs);              // 竞态删掉了：跳过这个文件就行
    } catch {
      return;
    }
    out.push({
      abs: job.abs,
      rel: relTo(rootAbs, job.abs),
      name: job.name,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
    });
  });
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // 上限裁掉尾巴（而不是像以前那样中途停下）：并发跑完更好排序，也少一条提前退出的路径
  if (out.length > guard) out.length = guard;
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

/** 目录这一层（不递归）里的视频/音频/图片文件数 */
async function countMediaFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((ent) => ent.isFile() && !isJunk(ent.name) && classify(ent.name) !== 'other').length;
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
  poolMap,
  walkFiles,
  listDirs,
  countMediaFiles,
  classify,
  mimeFor,
  browserPlayable,
  humanBytes,
  safeDecode,
  sseInit,
  sseSend,
  cpus: os.cpus().length,
};
