'use strict';
/**
 * server.js — 零依赖 HTTP 服务：REST API + 媒体流（含 Range）+ SSE 进度 + 静态页面。
 *
 * 为什么手写 HTTP 而不是 express/koa：这个应用要能「复制文件夹就能跑」，
 * 不想让用户先装 node_modules。Range 支持必须自己写（<video> 拖动进度条要靠它），
 * 但只有几十行。
 *
 * 启动：
 *   node server.js                     使用上次的库
 *   node server.js --root D:\media     指定素材根目录
 *   node server.js --port 8787
 *   node server.js --no-open           不自动打开浏览器
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

const util = require('./lib/util');
const { Database } = require('./lib/db');
const { Journal } = require('./lib/journal');
const { Library } = require('./lib/library');
const { Thumbnails } = require('./lib/thumbnails');
const { Exports } = require('./lib/exporter');
const tagsMod = require('./lib/tags');
const naming = require('./lib/naming');

const APP_ROOT = __dirname;
const WEB_DIR = path.join(APP_ROOT, 'web');
const DATA_DIR = path.join(APP_ROOT, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_PORT = 8787;

// ------------------------------------------------------------------ 命令行

function parseArgs(argv) {
  const out = { root: null, port: null, open: true, scanInterval: 45000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' || a === '-r') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--no-open') out.open = false;
    else if (a === '--scan-interval') out.scanInterval = Number(argv[++i]) || 0;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`tagStudio — 本地媒体标签管理\n\n  node server.js [--root <素材目录>] [--port 8787] [--no-open]\n\n`);
      process.exit(0);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 状态

const state = {
  config: { port: DEFAULT_PORT },
  root: null,
  db: null,
  library: null,
  journal: null,
  thumbs: null,
  exports: null,
  ready: false,
  bootError: null,
  lastScan: null,
  scanTimer: null,
  scanInterval: 45000,
};

async function loadConfig() {
  await util.ensureDir(DATA_DIR);
  state.config = Object.assign({ port: DEFAULT_PORT }, await util.readJson(CONFIG_FILE, {}));
  return state.config;
}

async function saveConfig(patch) {
  state.config = Object.assign({}, state.config, patch);
  await util.writeJsonAtomic(CONFIG_FILE, state.config);
}

/** 库整体挂载/切换。切换是「先建新、成功后再换」，失败不会把已有会话弄坏。 */
async function mount(root, opts = {}) {
  const absRoot = path.resolve(root);
  const st = await fsp.stat(absRoot).catch(() => null);
  if (!st) {
    if (!opts.create) throw new Error(`目录不存在：${absRoot}`);
    await util.ensureDir(absRoot);
  } else if (!st.isDirectory()) {
    throw new Error(`不是目录：${absRoot}`);
  }

  const metaRoot = await Database.ensureLibraryRoot(absRoot);
  const db = new Database(metaRoot);
  try {
    await db.load(absRoot);
  } catch (err) {
    // db.json 坏了。**绝不能**退化成空库继续跑：那样 save() 会把空库写回去，
    // 用户攒的标签就永久没了。这里明确拒绝打开，并把原因说清楚。
    if (err && err.code === 'DB_CORRUPT') {
      throw new ApiError(409,
        `这个库打不开：元数据文件损坏，为避免清空已有标签，程序没有继续动它。\n` +
        `原因：${db.corrupt && db.corrupt.reason ? db.corrupt.reason : '无法解析'}\n` +
        (db.corrupt && db.corrupt.quarantinedTo
          ? `坏文件已留底：${db.corrupt.quarantinedTo}`
          : `文件未能挪动，仍在原位：${db.corrupt ? db.corrupt.file : 'unknown'}`) +
        `\n处理办法：把留底的坏文件改回 db.json（能修就修好），或者删掉它重新建库（素材文件名里的标签还在，重新扫描能认回来），然后重新打开。`
      );
    }
    throw err;
  }
  const journal = new Journal(metaRoot);
  await journal.init();
  const library = new Library({ root: absRoot, db, journal });
  const thumbs = new Thumbnails({ metaRoot, rootOf: () => state.root, dbOf: () => state.db });
  await thumbs.init();
  const exports = new Exports({ metaRoot, rootOf: () => state.root, dbOf: () => state.db });
  await exports.init();

  const previousRoot = state.root;
  state.root = absRoot;
  state.db = db;
  state.library = library;
  state.journal = journal;
  state.thumbs = thumbs;
  state.exports = exports;
  state.bootError = null;

  const recovery = await library.recover();
  const scan = await library.scan({ rename: true, prune: true });
  state.lastScan = scan;
  state.ready = true;

  await saveConfig({ lastRoot: absRoot });
  scheduleScan();
  if (previousRoot && path.resolve(previousRoot) !== absRoot) {
    // 切换库：旧库的缓存目录跟着旧库走，不需要额外清理
  }
  return { root: absRoot, recovery, scan };
}

function scheduleScan() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  if (!state.scanInterval) return;
  state.scanTimer = setInterval(async () => {
    if (!state.ready) return;
    try {
      const res = await state.library.scan({ rename: true, prune: true });
      if (res.added || res.removed || res.matched || res.renamed) state.lastScan = res;
    } catch (err) {
      process.stderr.write(`[scan] ${err && err.message}\n`);
    }
  }, state.scanInterval);
  if (state.scanTimer.unref) state.scanTimer.unref();
}

// ------------------------------------------------------------------ HTTP 小工具

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJson(res, status, { ok: false, error: message, ...(extra || {}) });
}

/** 从 req.url 取 query。分发时第二参数留给 res，所以处理器要自己解析查询串。 */
function queryOf(req) {
  return new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).searchParams;
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function staticFile(res, absPath, opts = {}) {
  return fsp.stat(absPath).then((st) => {
    if (!st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': util.mimeFor(absPath),
      'Content-Length': st.size,
      'Cache-Control': opts.cache || 'no-cache',
    });
    fs.createReadStream(absPath).pipe(res);
    return undefined;
  }).catch(() => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });
}

/** 带 Range 的文件流：<video> 的 seek 依赖 206 与 Content-Range。 */
function streamFile(req, res, absPath, opts = {}) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 ${err && err.code}`);
    return;
  }
  const st = fs.fstatSync(fd);
  const total = st.size;
  const range = req.headers.range;
  const baseHeaders = {
    'Content-Type': opts.mime || util.mimeFor(absPath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache || 'no-cache',
    ...(opts.disposition ? { 'Content-Disposition': opts.disposition } : {}),
  };

  if (!range) {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
    if (req.method === 'HEAD') {
      fs.closeSync(fd);
      res.end();
      return;
    }
    const stream = fs.createReadStream(null, { fd, autoClose: true });
    stream.pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) {
    fs.closeSync(fd);
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) {
    fs.closeSync(fd);
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  if (start === null) {
    start = Math.max(0, total - end);            // 后缀范围：最后 N 字节
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) {
    fs.closeSync(fd);
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  const length = end - start + 1;
  res.writeHead(206, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': length,
  });
  if (req.method === 'HEAD') {
    fs.closeSync(fd);
    res.end();
    return;
  }
  const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ------------------------------------------------------------------ 路由

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (m) return { handler: r.handler, params: m.slice(1).map(util.safeDecode) };
  }
  return null;
}

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// 说明：mount()（88 行）里也用了 ApiError。函数声明会提升，class 不会——但这个文件
// 是模块整体求值完才在末尾 main() 的，调用 mount 时 ApiError 早已就绪，所以顺序安全。
// 真正不要做的是"在文件中部就调用 mount()"，那时 ApiError 还在暂时性死区里。

function requireLibrary() {
  if (!state.ready || !state.db) throw new ApiError(409, '还没有选择素材文件夹，请先在设置里指定');
}

// --- 应用/库状态 ---------------------------------------------------------

route('GET', /^\/api\/state$/, async () => {
  const ffmpeg = state.thumbs ? await state.thumbs.ffmpeg() : null;
  return {
    ok: true,
    ready: state.ready,
    bootError: state.bootError,
    root: state.root,
    defaultExportRoot: state.exports ? state.exports.defaultRoot : null,
    rootMeta: state.root ? {
      metaDir: path.join(state.root, util.META_DIRNAME),
      parent: path.dirname(state.root),
      name: path.basename(state.root),
      drive: path.parse(state.root).root,
    } : null,
    ffmpeg,
    thresholds: {
      nameBudgetBytes: naming.DEFAULT_BUDGET_BYTES,
      maxTagChars: tagsMod.MAX_TAG_CHARS,
      maxAbsPathChars: util.MAX_ABS_PATH_CHARS,
    },
    scanInterval: state.scanInterval,
    lastScan: state.lastScan ? { scannedAt: state.lastScan.scannedAt, added: state.lastScan.added, removed: state.lastScan.removed, renamed: state.lastScan.renamed } : null,
    stats: state.ready ? state.db.stats() : null,
  };
});

route('POST', /^\/api\/library\/boot$/, async (req) => {
  const body = await readBody(req);
  const root = String(body.root || '').trim();
  if (!root) throw new ApiError(400, '请填写素材文件夹的完整路径');
  if (body.create === false && !(await util.exists(root))) throw new ApiError(404, `目录不存在：${root}`);
  try {
    const result = await mount(root, { create: body.create !== false });
    return { ok: true, ...result, stats: state.db.stats() };
  } catch (err) {
    state.bootError = String(err && err.message);
    throw new ApiError(400, `打开库失败：${state.bootError}`);
  }
});

route('GET', /^\/api\/fs\/drives$/, async () => {
  const drives = [];
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i += 1) {
      const letter = String.fromCharCode(i);
      const root = `${letter}:\\`;
      if (await util.exists(root)) {
        drives.push({ name: root, path: root });
      }
    }
  } else {
    drives.push({ name: '/', path: '/' });
  }
  return { ok: true, drives, home: process.env.USERPROFILE || process.env.HOME || '', desktop: path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop') };
});

route('GET', /^\/api\/fs\/list$/, async (req) => {
  const target = queryOf(req).get('path');
  if (!target) throw new ApiError(400, '缺少 path 参数');
  const dir = path.resolve(target);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new ApiError(404, `不是有效目录：${dir}`);
  const dirs = await util.listDirs(dir);
  const parent = path.dirname(dir);
  return {
    ok: true,
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    mediaCount: (await util.walkFiles(dir, { maxFiles: 5000 })).length,
  };
});

route('POST', /^\/api\/fs\/pick-folder$/, async (req) => {
  const body = await readBody(req);
  const start = body.start ? path.resolve(String(body.start)) : (process.env.USERPROFILE || APP_ROOT);
  const picked = await pickFolder(start);
  return { ok: true, path: picked, cancelled: !picked };
});

route('POST', /^\/api\/scan$/, async () => {
  requireLibrary();
  const result = await state.library.scan({ rename: true, prune: true });
  state.lastScan = result;
  return result;
});

// --- 素材 ---------------------------------------------------------------

route('GET', /^\/api\/items$/, async (req) => {
  requireLibrary();
  const q = queryOf(req);
  const list = (key) => (q.getAll(key).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const tags = list('tag');
  const any = list('any');
  const kind = q.get('kind') || '';
  const untagged = q.get('untagged') === '1';
  const search = q.get('q') || '';
  const offset = Number(q.get('offset') || 0);
  const limit = Math.min(2000, Number(q.get('limit') || 0));
  const sort = q.get('sort') || 'added-desc';
  const result = state.db.query({ tags, any, kind, untagged, q: search, offset, limit, sort });
  return {
    ok: true,
    total: result.total,
    items: result.items.map((item) => state.library.itemView(item)),
    appliedTags: tags,
    anyTags: any,
    kind,
    untagged,
    q: search,
    sort,
  };
});

route('GET', /^\/api\/items\/([0-9a-fA-F]{32})$/, async (req, _url, id) => {
  requireLibrary();
  const item = state.db.get(id);
  if (!item) throw new ApiError(404, '素材不存在');
  return { ok: true, item: state.library.itemView(item) };
});

route('POST', /^\/api\/items\/([0-9a-fA-F]{32})\/tags$/, async (req, _url, id) => {
  requireLibrary();
  const body = await readBody(req);
  const mode = body.mode || 'set';
  const res = await state.library.applyTags(id, {
    mode,
    tags: Array.isArray(body.tags) ? body.tags : tagsMod.splitTagInput(body.tags),
    add: Array.isArray(body.add) ? body.add : (body.add ? tagsMod.splitTagInput(body.add) : []),
    remove: Array.isArray(body.remove) ? body.remove : (body.remove ? tagsMod.splitTagInput(body.remove) : []),
  });
  if (!res.ok) throw new ApiError(res.code || 400, res.reason);
  return { ...res, item: state.library.itemView(res.item), stats: state.db.stats() };
});

route('POST', /^\/api\/items\/([0-9a-fA-F]{32})\/preview$/, async (req, _url, id) => {
  requireLibrary();
  const item = state.db.get(id);
  if (!item) throw new ApiError(404, '素材不存在');
  const body = await readBody(req);
  const merged = body.mode === 'add'
    ? Array.from(new Set([...(item.tags || []), ...tagsMod.splitTagInput(body.tags)]))
    : tagsMod.splitTagInput(body.tags);
  const v = tagsMod.validateTags(merged);
  if (!v.ok) throw new ApiError(400, v.reason);
  return { ok: true, preview: state.library.preview(item, v.tags), tags: v.tags };
});

route('POST', /^\/api\/items\/bulk$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const ids = (body.ids || []).map(String);
  if (!ids.length) throw new ApiError(400, '没有选中任何素材');
  const mode = body.mode || 'add';
  const res = await state.library.applyTagsBulk(ids, {
    mode,
    add: Array.isArray(body.add) ? body.add : tagsMod.splitTagInput(body.add || ''),
    remove: Array.isArray(body.remove) ? body.remove : tagsMod.splitTagInput(body.remove || ''),
  });
  return { ...res, stats: state.db.stats(), tags: state.db.tagList() };
});

// --- 标签 ---------------------------------------------------------------

route('GET', /^\/api\/tags$/, async () => {
  requireLibrary();
  return { ok: true, tags: state.db.tagList(), collections: state.db.collections() };
});

route('POST', /^\/api\/tags\/rename$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const res = await state.library.renameTagGlobal(body.from, body.to, { dryRun: !!body.dryRun });
  if (!res.ok) throw new ApiError(400, res.reason);
  return { ...res, stats: state.db.stats() };
});

route('POST', /^\/api\/tags\/merge$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const res = await state.library.mergeTags(body.sources || [], body.target);
  return { ...res, stats: state.db.stats() };
});

route('POST', /^\/api\/tags\/delete$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const res = await state.library.deleteTagGlobal(body.name);
  return { ...res, stats: state.db.stats() };
});

route('POST', /^\/api\/collections$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const res = state.db.setCollections(body.collections || body);
  if (!res.ok) throw new ApiError(400, res.reason);
  await state.db.save();
  return { ok: true, collections: res.collections };
});

// --- 缩略图 / 媒体流 -----------------------------------------------------

route('GET', /^\/api\/thumb\/([0-9a-fA-F]{32})$/, async (req, res, id) => {
  requireLibrary();
  const result = await state.thumbs.ensure(id);
  if (!result.ok) {
    // 「没有缩略图」是正常状态，不是服务端错误：音频本来就没有缩略图，视频也可能是没装
    // ffmpeg、或源文件本身没有视频轨（损坏/纯音频 mp4）。一律回 404，让前端安静地显示
    // 占位图标，而不是在浏览器控制台里刷 500。
    // 注意：这里别写成 `result.code === 503 ? 404 : (result.code || 404)`，实测那版在本机
    // 上仍然吐 500（三元 + || 混用被解析成了别的意思），显式 if 更稳也更好读。
    let code = 404;
    if (result.code && result.code >= 400 && result.code < 500) code = result.code;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(result.reason || 'no thumbnail');
    return undefined;
  }
  streamFile(req, res, result.source, { mime: result.mime, cache: 'public, max-age=86400' });
  return undefined;
});

route('POST', /^\/api\/thumbs\/clear$/, async () => {
  requireLibrary();
  return state.thumbs.clear();
});

route('GET', /^\/api\/media\/([0-9a-fA-F]{32})$/, async (req, res, id) => {
  requireLibrary();
  const item = state.db.get(id);
  if (!item) {
    sendError(res, 404, '素材不存在');
    return undefined;
  }
  const abs = state.db.absOf(item);
  if (!(await util.exists(abs))) {
    sendError(res, 404, '源文件不存在，请重新扫描');
    return undefined;
  }
  const dl = /[?&]dl=1/.test(req.url || '');
  streamFile(req, res, abs, {
    mime: util.mimeFor(item.name),
    disposition: dl ? contentDisposition(item.name) : null,
  });
  return undefined;
});

// --- 导出 ---------------------------------------------------------------

route('POST', /^\/api\/export\/start$/, async (req) => {
  requireLibrary();
  const body = await readBody(req);
  const ids = (body.ids || []).map(String);
  let items;
  if (ids.length) {
    // 明确点了名的素材优先，一个都不能少（点名的 id 找不到就跳过，不报错）
    items = ids.map((id) => state.db.get(id)).filter(Boolean);
  } else if (body.filter && Object.keys(body.filter).length) {
    // 只给了筛选条件：导出"当前视图里的全部"
    const f = body.filter;
    items = state.db.query({
      tags: f.tags || [],
      any: f.any || [],
      kind: f.kind || '',
      untagged: !!f.untagged,
      q: f.q || '',
    }).items;
  } else {
    // 既没点名也没给条件 = 把整个库导出去（界面上"全部素材"那个范围）
    items = state.db.items();
  }
  if (!items.length) throw new ApiError(400, '没有选中任何素材');
  const destRoot = path.resolve(String(body.destRoot || state.exports.defaultRoot));
  await util.ensureDir(destRoot);
  const job = state.exports.start({
    items,
    destRoot,
    subdir: body.subdir || null,
    nameMode: body.nameMode || 'tagged',
    makeZip: !!body.makeZip,
  });
  return { ok: true, job: job.snapshot() };
});

route('GET', /^\/api\/export\/([0-9a-zA-Z]+)$/, async (req, _url, id) => {
  const job = state.exports.get(id);
  if (!job) throw new ApiError(404, '导出任务不存在');
  return { ok: true, job: job.snapshot() };
});

route('GET', /^\/api\/export\/([0-9a-zA-Z]+)\/events$/, async (req, res, id) => {
  const job = state.exports.get(id);
  if (!job) {
    sendError(res, 404, '导出任务不存在');
    return undefined;
  }
  util.sseInit(res);
  util.sseSend(res, 'progress', job.snapshot());
  const onProgress = (snap) => util.sseSend(res, 'progress', snap);
  const onEnd = (snap) => {
    util.sseSend(res, 'end', snap);
    res.end();
  };
  job.on('progress', onProgress);
  job.on('end', onEnd);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    job.off('progress', onProgress);
    job.off('end', onEnd);
  });
  return undefined;
});

route('POST', /^\/api\/export\/([0-9a-zA-Z]+)\/cancel$/, async (req, _url, id) => {
  const job = state.exports.get(id);
  if (!job) throw new ApiError(404, '导出任务不存在');
  job.cancel();
  return { ok: true, job: job.snapshot() };
});

route('GET', /^\/api\/export\/([0-9a-zA-Z]+)\/zip$/, async (req, res, id) => {
  const job = state.exports.get(id);
  if (!job || !job.zipPath) {
    sendError(res, 404, '没有可下载的 zip');
    return undefined;
  }
  streamFile(req, res, job.zipPath, { mime: 'application/zip', disposition: contentDisposition(path.basename(job.zipPath)) });
  return undefined;
});

route('GET', /^\/api\/export\/([0-9a-zA-Z]+)\/manifest\.csv$/, async (req, res, id) => {
  const job = state.exports.get(id);
  if (!job || !job.manifestPath) {
    sendError(res, 404, '没有清单文件');
    return undefined;
  }
  streamFile(req, res, job.manifestPath, { mime: 'text/csv; charset=utf-8', disposition: contentDisposition('manifest.csv') });
  return undefined;
});

// 下载 manifest.json（导出时和 manifest.csv 一起写在目标目录里）
route('GET', /^\/api\/export\/([0-9a-zA-Z]+)\/manifest\.json$/, async (req, res, id) => {
  const job = state.exports.get(id);
  if (!job || !job.manifestJsonPath) {
    sendError(res, 404, '没有清单文件');
    return undefined;
  }
  streamFile(req, res, job.manifestJsonPath, { mime: 'application/json; charset=utf-8', disposition: contentDisposition('manifest.json') });
  return undefined;
});

route('GET', /^\/api\/exports$/, async () => ({ ok: true, jobs: state.exports ? state.exports.list() : [] }));

route('POST', /^\/api\/export\/review$/, async (req) => {
  // 「导出前体检」：把会被改名、会超长、源文件缺失的情况先报出来
  requireLibrary();
  const body = await readBody(req);
  const ids = (body.ids || []).map(String);
  const items = ids.length ? ids.map((id) => state.db.get(id)).filter(Boolean) : state.db.items();
  const missing = [];
  const long = [];
  const droppedTags = [];
  for (const item of items) {
    const abs = state.db.absOf(item);
    // 注意：这里同步探测，只用于体检接口；批量导出不会重复做
    // eslint-disable-next-line no-await-in-loop
    if (!(await util.exists(abs))) missing.push({ id: item.id, name: item.name });
    const preview = state.library.preview(item, item.tags || []);
    if (preview.droppedTags.length) droppedTags.push({ id: item.id, name: item.name, dropped: preview.droppedTags });
    if (preview.pathChars > util.MAX_ABS_PATH_CHARS - 10) long.push({ id: item.id, name: item.name, pathChars: preview.pathChars });
  }
  return {
    ok: true,
    count: items.length,
    totalBytes: items.reduce((n, i) => n + (i.size || 0), 0),
    missing,
    longPaths: long,
    droppedTags,
  };
});

// ------------------------------------------------------------------ 原生文件夹选择器

/**
 * 用 PowerShell 的 Win32 文件夹对话框（只读操作，不装任何依赖）。
 * 失败（比如没有 powershell）就返回 null，前端会退回到「直接输入路径 + 目录浏览器」。
 */
function pickFolder(startDir) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;',
    `$dlg.SelectedPath = ${psQuote(startDir)};`,
    "$dlg.Description = '选择素材文件夹';",
    "$dlg.ShowNewFolderButton = $true;",
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
  ].join(' ');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => { /* 忽略：对话框被取消也会写 stderr */ });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      resolve(null);
    }, 120000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const trimmed = out.trim();
      resolve(trimmed || null);
    });
  });
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ------------------------------------------------------------------ 主循环

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  // 只用于取 pathname；query 由各处理器自己从 req.url 解析（分发时第二参数留给 res）。
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname;
  } catch {
    sendError(res, 400, '非法 URL');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET,POST,HEAD,OPTIONS' });
    res.end();
    return;
  }

  // 静态页面
  if (!pathname.startsWith('/api/')) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const abs = path.join(WEB_DIR, rel);
    if (!util.withinRoot(WEB_DIR, abs)) {
      sendError(res, 403, '越界路径');
      return;
    }
    staticFile(res, abs, { cache: /\.(png|jpg|svg|ico|woff2?)$/i.test(abs) ? 'public, max-age=3600' : 'no-cache' });
    return;
  }

  const matched = matchRoute(req.method, pathname) || (req.method === 'HEAD' ? matchRoute('GET', pathname) : null);
  if (!matched) {
    sendError(res, 404, `未知接口：${req.method} ${pathname}`);
    return;
  }
  try {
    // 注意：处理器的第二参数是 res（不是 URL）。带捕获组的路由形如 (req, res, id)，
    // 缩略图/媒体流/zip/清单这些需要自己接管响应的路由全靠它拿 response 对象，
    // 一旦传错就会退化成 "res.writeHead is not a function" 的 500。
    const result = await matched.handler(req, res, ...matched.params);
    if (res.headersSent || res.writableEnded) return;      // 处理器自己接管了响应（流/SSE）
    if (result === undefined) {
      sendJson(res, 204, null);
      return;
    }
    sendJson(res, 200, result);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = String((err && err.message) || err);
    if (status >= 500) process.stderr.write(`[api] ${req.method} ${pathname} → ${status} ${message}\n${err && err.stack}\n`);
    if (!res.headersSent) sendError(res, status, message, err instanceof ApiError ? err.extra : undefined);
    else res.end();
  } finally {
    const ms = Date.now() - started;
    if (ms > 1500) process.stdout.write(`[slow] ${req.method} ${pathname} ${ms}ms\n`);
  }
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadConfig();
  state.scanInterval = args.scanInterval != null ? args.scanInterval : 45000;
  const port = args.port || state.config.port || DEFAULT_PORT;

  const rootArg = args.root || null;
  if (rootArg) {
    try {
      const result = await mount(rootArg, { create: true });
      process.stdout.write(`[tagStudio] 已打开库：${result.root}（新增 ${result.scan.added} / 剔除 ${result.scan.removed} / 重命名 ${result.scan.renamed}）\n`);
    } catch (err) {
      state.bootError = String(err && err.message);
      process.stderr.write(`[tagStudio] 打开 ${rootArg} 失败：${state.bootError}\n`);
    }
  } else if (state.config.lastRoot && await util.exists(state.config.lastRoot)) {
    try {
      const result = await mount(state.config.lastRoot, { create: false });
      process.stdout.write(`[tagStudio] 恢复上次的库：${result.root}（新增 ${result.scan.added} / 剔除 ${result.scan.removed}）\n`);
    } catch (err) {
      state.bootError = String(err && err.message);
      process.stderr.write(`[tagStudio] 恢复上次的库失败：${state.bootError}\n`);
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${port} 已被占用。换一个：node server.js --port ${port + 1}\n`);
    } else {
      process.stderr.write(`启动失败：${err && err.message}\n`);
    }
    process.exit(1);
  });

  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`\n  tagStudio 已启动 → ${url}\n`);
  process.stdout.write(state.ready ? `  素材库：${state.root}\n` : '  还没有选择素材文件夹：请在页面顶部「设置」里指定，或 node server.js --root <目录>\n');
  process.stdout.write('  按 Ctrl+C 退出\n\n');

  if (args.open) openBrowser(url);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

process.on('SIGINT', () => {
  process.stdout.write('\n[tagStudio] 正在退出…\n');
  if (state.scanTimer) clearInterval(state.scanTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`致命错误：${err && err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { state, mount, server, main, parseArgs, routes };
