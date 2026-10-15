/*
 * e2e_real.js —— 拿真实素材跑一遍完整流程（不是造假文件）。
 *
 * 用法：node e2e_real.js
 *
 * 它做这些事，每步都断言：
 *   1. 直接以 <项目>/素材 为素材库启动服务
 *   2. 扫描：两个大视频入库，此时还没打标签，所以文件名保持原样
 *   3. 用 ffmpeg 抽视频缩略图，并确认抽出来的是**能解码的 JPEG**（不是 0 字节、不是报错页）
 *   4. 打标签 → 磁盘文件名变成 标签1-标签2-uuid.mp4，扩展名不变
 *   5. 按标签筛选能各自看到对应视频
 *   6. 导出到临时目录，逐字节比对大小，清单 CSV/JSON 内容对得上
 *   7. 再来一次导出，确认不会覆盖上一次（同名自动让位）
 *   8. Range 请求能用（拖动进度条的前提）
 *
 * 全程不会删除素材；改名后会**把名字恢复成原始文件名**再退出，
 * 这样你第一次打开界面时看到的就是干净的素材目录。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const LIB = path.join(ROOT, '素材');
const OUT = path.join(ROOT, '.e2e');
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 夹具基准文件：记着素材目录里每个文件"原本叫什么、多大"。
 * 目的是让这个测试**自己把现场收拾干净**，不用人工去修素材名。
 *
 * 为什么需要它：测试会给视频打标签（改名），再跑一次时素材目录里就躺着
 * `助眠-直播录屏-<uuid>.mp4` 这种名字，而"原始名"已经没人记得了。
 * 基准文件在第一次跑的时候把原始名+大小记下来，以后每次开跑前按大小把
 * 文件对回去，于是反复跑多少次都以同样的起点开始。
 *
 * 注意它**故意放在 OUT 外面**：OUT 每次开跑都会被整个删掉重建，基准要是放在
 * 里面就会跟着被删，于是下一次跑只好拿"当前状态"（已经被改过名的）当基准，
 * 越跑越歪。这个坑踩过一次了。
 */
const BASELINE = path.join(ROOT, '.e2e-fixture-baseline.json');

async function loadBaseline() {
  try {
    const raw = await fsp.readFile(BASELINE, 'utf8');
    const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (Array.isArray(data.files) && data.files.length) return data.files;
  } catch { /* 第一次跑，或者文件被删了 */ }
  return null;
}

/**
 * 开跑前把素材目录恢复成基准状态。只在"能唯一确定"时才改名：
 * 同一个大小对应多个文件就不动它（宁可测试报红，也不猜错把素材改乱）。
 * 返回 {repaired:[], unknown:[]}，unknown 是基准里没有的新文件。
 */
async function repairFixture(baseline) {
  resyncBaseline(baseline);   // 先按名字把「大小变了但不是被改名」的条目刷新一下
  const now = fs.readdirSync(LIB, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, size: fs.statSync(path.join(LIB, e.name)).size }));
  const repaired = [];
  const unknown = [];
  for (const want of (baseline.files || baseline)) {
    if (now.some(f => f.name === want.name && f.size === want.size)) continue;  // 已经是基准名
    const cands = now.filter(f => f.size === want.size && f.name !== want.name);
    if (cands.length === 1) {
      await fsp.rename(path.join(LIB, cands[0].name), path.join(LIB, want.name));
      repaired.push(`${cands[0].name} → ${want.name}`);
      cands[0].name = want.name;                    // 同步内存视图，避免二次改名
    } else if (cands.length === 0) {
      unknown.push(`${want.name}（大小 ${want.size}）没找到`);
    } else {
      unknown.push(`${want.name}（大小 ${want.size}）有 ${cands.length} 个候选，分不清`);
    }
  }
  // 基准里没登记的杂项：不动它，只记下来。基准是按「大小」配对的，所以
  // 就算某个文件被改成了「标签-uuid.扩展名」，上面的循环也能按大小认回来。
  for (const f of now) {
    if ((baseline.files || baseline).some(w => w.name === f.name)) continue;
    unknown.push(`${f.name}（大小 ${f.size}）不在基准里`);
  }
  return { repaired, unknown };
}

/**
 * 基准条目是按「大小」配对的，所以你只要编辑过素材目录里那个说明文档（大小变了），
 * 基准就对不上它了。这里先按**文件名**把大小刷一遍：名字还一样、只是大小变了，
 * 说明是你自己改了内容，不是被程序改了名，直接更新基准即可。
 * 返回被刷新过的条目描述。
 */
function resyncBaseline(baseline) {
  const now = diskFiles(LIB);
  const touched = [];
  for (const w of baseline.files || baseline) {
    const same = now.find(f => f.name === w.name);
    if (same && same.size !== w.size) {
      touched.push(`${w.name}（${w.size} → ${same.size}）`);
      w.size = same.size;
    }
  }
  return touched;
}

async function saveBaseline(files) {  await fsp.mkdir(path.dirname(BASELINE), { recursive: true });
  await fsp.writeFile(BASELINE, JSON.stringify({
    note: 'e2e_real.js 的夹具基准：素材目录里每个文件原本的名字与大小',
    createdAt: new Date().toISOString(),
    files,
  }, null, 2), 'utf8');
}

let passed = 0, failed = 0;
const failures = [];

function section(t) { console.log(`\n── ${t}`); }
function note(t) { console.log(`   · ${t}`); }
function check(desc, ok, extra) {
  if (ok) { passed++; console.log(`   ✓ ${desc}`); }
  else {
    failed++;
    failures.push(desc + (extra ? ` —— ${extra}` : ''));
    console.log(`   ✗ ${desc}${extra ? ` —— ${extra}` : ''}`);
  }
}
function eq(desc, got, want) { check(desc, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (opts.headers) Object.assign(headers, opts.headers);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* 不是 JSON 就算了 */ }
        // 注意：这里不能无条件 buf.toString('utf8') —— 请求 593MB 的视频时，
        // 把它转成字符串会直接抛 ERR_STRING_TOO_LONG 把整个验证脚本干掉。
        const text = buf.length <= 4 * 1024 * 1024 ? buf.toString('utf8') : `<${buf.length} 字节二进制>`;
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const api = {
  get: (p, o) => request('GET', p, null, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
};

function diskFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 磁盘上属于「素材」的文件（含被改名过的），只排除隐藏文件 */
function mediaOnDisk(dir) {
  return diskFiles(dir).filter(f => !f.name.startsWith('.'));
}

/* 判断一段 buffer 是不是真 JPEG：SOI 魔数 + 至少一个 EOI 段 + 合理尺寸 */
function jpegInfo(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2, w = 0, h = 0;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      h = buf.readUInt16BE(i + 5);
      w = buf.readUInt16BE(i + 7);
    }
    if (marker === 0xDA) break; // 到了扫描数据，够了
    i += 2 + len;
  }
  if (!w || !h) return null;
  return { w, h };
}

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await api.get('/api/state'); if (r.status === 200) return true; } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

(async () => {
  console.log('tagStudio 真实素材端到端验证');
  console.log(`素材库：${LIB}`);
  console.log(`服务：${BASE}（临时实例，退出即关）`);

  if (!fs.existsSync(LIB)) { console.error(`找不到素材目录：${LIB}`); process.exit(1); }

  // ── 开跑前：把素材目录复位到基准状态 ──────────────────────────────────
  // 没有基准（或基准跟当前目录完全对不上）就用当前状态建一份。
  // 有基准就按大小把被改过名的文件对回去，这样"跑第二次"和"跑第一次"的起点一样，
  // 不需要人工去修素材名。
  //
  // 为什么还要判"完全对不上"：别人 clone 这个仓库时，仓库里带的是**一份**基准
  // （记着我这里那两个视频的名字），而对方多半会换成自己的素材。照基准去改名
  // 只会满屏"没找到"。所以先试着匹配，全不中就当基准作废、按当前目录重建。
  await fsp.mkdir(OUT, { recursive: true });
  const baseline = await loadBaseline();
  if (!baseline) {
    const files = diskFiles(LIB).map(f => ({ name: f.name, size: f.size }));
    await saveBaseline(files);
    note(`没有基准文件，按当前状态建了一份：${files.map(f => f.name).join(' | ')}`);
  } else {
    const noneMatch = baseline.every(w =>
      !diskFiles(LIB).some(f => f.size === w.size));
    if (noneMatch) {
      const files = diskFiles(LIB).map(f => ({ name: f.name, size: f.size }));
      await saveBaseline(files);
      note('基准与实际素材对不上（换了素材？），已按当前目录重建基准');
    } else {
      const touched = resyncBaseline(baseline);
      if (touched.length) {
        await saveBaseline(baseline.files || baseline);
        note(`基准里这些条目的大小已按磁盘刷新：${touched.join(' | ')}`);
      }
      const { repaired, unknown } = await repairFixture(baseline);
      if (repaired.length) {
        section('0. 开跑前复位素材名（上一次跑留下的改名）');
        for (const r of repaired) note(`复位：${r}`);
      }
      if (unknown.length) {
        console.log('   ! 基准里有文件对不上，素材目录可能被改动过：');
        for (const u of unknown) console.log(`     ! ${u}`);
        console.log(`   ! 基准文件：${BASELINE}（确认无误就删掉它重新生成）`);
      }
    }
  }

  const before = diskFiles(LIB);
  note(`开始前素材目录有 ${before.length} 个文件`);
  for (const f of before) note(`   ${f.name}  (${(f.size / 1048576).toFixed(1)} MB)`);

  // 记下每个文件的原始名字与大小。结束时按**大小**把它们对回来恢复名字
  // （大小是这里最稳的判据：改标签/改名都不改字节数）。
  // 注意变量名：这张表是 size → name，别拿 name 去 get（会永远 undefined）。
  const originalNames = before.map(f => f.name);
  const originalBySize = new Map(before.map(f => [f.size, f]));
  const uuidMap = {}; // 原始文件名 → 工具分配的 uuid

  // 注意：这行会删掉整个 OUT。夹具基准**不在** OUT 里（见 BASELINE 的注释），
  // 否则基准会被自己删掉，下一跑只好拿"已经改过名的"状态当基准。
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  // 从干净的库开始，复现"你第一次打开这个文件夹"的场景。
  // （上次跑剩下的 .mtag 里记着旧 uuid，会让这次变成"认领旧库"而不是"首次入库"。）
  const metaDir = path.join(LIB, '.mtag');
  if (fs.existsSync(metaDir)) {
    note('清掉上一次留下的 .mtag，从零库状态开始');
    await fsp.rm(metaDir, { recursive: true, force: true });
  }

  // ── 1. 起服务 ───────────────────────────────────────────────────────────
  section('1. 启动服务并扫描真实素材');
  const errLog = path.join(OUT, 'server.err.log');
  const errFd = fs.openSync(errLog, 'a');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'),
    '--root', LIB, '--port', String(PORT), '--no-open', '--scan-interval', '0'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', errFd], windowsHide: true });
  let stdout = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });

  let ok = false;
  try {
    ok = await waitServer(30000);
    check('服务起来了', ok, stdout.slice(0, 400));
    if (!ok) throw new Error('服务没起来，后面没法跑');

    const st = await api.get('/api/state');
    eq('GET /api/state 200', st.status, 200);
    const s = st.json;
    eq('库路径正确', path.resolve(s.root), path.resolve(LIB));
    note(`ffmpeg：${s.ffmpeg || '未找到'}`);
    check('探测到了 ffmpeg（否则没有视频缩略图）', !!s.ffmpeg, JSON.stringify(s.ffmpeg));
    eq('缩略图路径预算等阈值有下发', typeof s.thresholds?.nameBudgetBytes, 'number');
    note(`命名字节预算 ${s.thresholds.nameBudgetBytes}，标签最长 ${s.thresholds.maxTagChars}，绝对路径上限 ${s.thresholds.maxAbsPathChars}`);

    // ── 2. 扫描 ───────────────────────────────────────────────────────────
    section('2. 扫描 → 两个视频入库，但还没打标签所以保持原文件名');
    const scan = await api.post('/api/scan');
    eq('POST /api/scan 200', scan.status, 200);
    note(`扫到 ${scan.json.filesOnDisk} 个文件，新增 ${scan.json.added}，改名 ${scan.json.renamed}`);

    const list = await api.get('/api/items?limit=100');
    const items = list.json.items;
    // 断言的对象是「视频」，不是「库里所有素材」——这样再往素材目录里放别的东西也不会误报
    const videos = items.filter(i => i.kind === 'video');
    eq(`库里一共 ${items.length} 个素材`, list.json.total, items.length);
    eq('其中两个是视频（第三个是素材目录里的说明文档）', videos.length, 2);
    for (const it of videos) {
      note(`${it.kind} · ${it.name} · ${it.sizeText}`);
      const orig = originalBySize.get(it.size);
      if (orig) uuidMap[orig] = it.id;
      check(`「${it.name}」未打标签时保持原文件名（不改名，方便照着原名想标签）`,
        it.name === path.basename(it.origName || it.name) && !/[0-9a-f]{32}/i.test(it.name), it.name);
      eq(`「${it.id}」扩展名没被改动`, path.extname(it.name).toLowerCase(), '.mp4');
    }

    // ── 3. 缩略图 ─────────────────────────────────────────────────────────
    section('3. 视频缩略图真的抽出来了（ffmpeg 抽帧 + 是真 JPEG）');
    for (const it of videos) {
      const r = await api.get(`/api/thumb/${it.id}`);
      check(`「${it.name}」缩略图返回 200`, r.status === 200, `状态 ${r.status} ${r.text.slice(0, 200)}`);
      const info = jpegInfo(r.buf);
      check(`「${it.name}」缩略图是能解码的 JPEG`, !!info, `拿到 ${r.buf.length} 字节`);
      if (info) {
        note(`   尺寸 ${info.w}×${info.h}，${(r.buf.length / 1024).toFixed(1)} KB`);
        check(`   宽度是 ffmpeg 缩放的 480（不超）`, info.w <= 480 && info.w >= 120, `${info.w}`);
      }
    }

    // ── 4. Range（拖动进度条的前提）───────────────────────────────────────
    section('4. 媒体流支持 Range（拖动播放位置）');
    const mid = videos[0].id;   // 要用视频：items 是按 rel 排序的，第一个可能是素材目录里的说明文档
    const full = await api.get(`/api/media/${mid}`);
    eq('完整请求 200', full.status, 200);
    eq('声明了 Accept-Ranges', full.headers['accept-ranges'], 'bytes');
    eq('Content-Type 是 video/mp4', full.headers['content-type'], 'video/mp4');

    const part = await api.get(`/api/media/${mid}`, { headers: { Range: 'bytes=0-1023' } });
    eq('带 Range 的请求返回 206', part.status, 206);
    eq('只回了 1024 字节', part.buf.length, 1024);
    check('Content-Range 头正确', /^bytes 0-1023\/\d+$/.test(part.headers['content-range'] || ''),
      part.headers['content-range']);

    const tail = await api.get(`/api/media/${mid}`, { headers: { Range: 'bytes=-256' } });
    eq('后缀范围（bytes=-256）返回 206', tail.status, 206);
    eq('后缀范围回了 256 字节', tail.buf.length, 256);

    const bad = await api.get(`/api/media/${mid}`, { headers: { Range: 'bytes=99999999999-' } });
    eq('越界范围返回 416', bad.status, 416);

    // ── 5. 打标签 → 改名 ──────────────────────────────────────────────────
    section('5. 打标签 → 磁盘文件名变成 标签1-标签2-uuid.mp4');
    const planA = ['助眠', '轻语', '直播录屏'];
    const planB = ['美女合集', 'B站'];

    const tagA = await api.post(`/api/items/${videos[0].id}/tags`, { tags: planA, mode: 'set' });
    eq('给第一个视频打标签 200', tagA.status, 200);
    const nameA = tagA.json.item.name;
    note(`改名结果：${nameA}`);
    eq('文件名前缀是排好序的三个标签', nameA, `${['助眠', '轻语', '直播录屏'].sort().join('-')}-${videos[0].id}.mp4`);
    eq('改名后 uuid 没变', nameA.includes(videos[0].id), true);

    const tagB = await api.post(`/api/items/${videos[1].id}/tags`, { tags: planB, mode: 'set' });
    eq('给第二个视频打标签 200', tagB.status, 200);
    note(`改名结果：${tagB.json.item.name}`);

    const diskAfterTag = mediaOnDisk(LIB);
    eq(`磁盘上还是 ${items.length} 个素材文件（没多出副本）`, diskAfterTag.length, items.length);
    // 重新取一次列表：上面的 items 是"打标签之前"的快照，里面每个素材的 tags 都还是空的，
    // 拿它判断"这个文件打过标签没有"会全部判成没打过。这个坑踩过一次。
    const afterTag = (await api.get('/api/items?limit=100')).json.items;
    // 打标签会改名，rel 跟着变，所以按 id 配对。
    const taggedIds = new Set(afterTag.filter(i => (i.tags || []).length).map(i => i.id));
    for (const f of diskAfterTag) {
      const rec = afterTag.find(i => path.basename(i.rel) === f.name || path.basename(i.name) === f.name);
      const tagged = !!(rec && taggedIds.has(rec.id));
      if (tagged) {
        check(`「${f.name}」打过标签后是 标签-uuid.扩展名 规范名`,
          /^[^\\/:*?"<>|]+(-[^\\/:*?"<>|]+)*-[0-9a-f]{32}(\.[^.]+)?$/i.test(f.name),
          f.name);
      } else {
        check(`「${f.name}」没打标签所以没被改名`, !/[0-9a-f]{32}/i.test(f.name), f.name);
      }
    }

    // ── 6. 按标签浏览 ─────────────────────────────────────────────────────
    section('6. 按标签浏览：每个标签下都能看到对应的视频');
    const tags = await api.get('/api/tags');
    eq('标签列表 200', tags.status, 200);
    const tagNames = tags.json.tags.map(t => t.name);
    note(`标签：${tags.json.tags.map(t => `${t.name}(${t.count})`).join(' ')}`);
    for (const t of [...planA, ...planB]) {
      check(`标签「${t}」出现在列表里`, tagNames.includes(t));
    }

    for (const t of [...planA, ...planB]) {
      const q = await api.get(`/api/items?tag=${encodeURIComponent(t)}&limit=50`);
      eq(`按「${t}」筛选后能且只能看到 1 个视频`, q.json.total, 1);
    }

    const both = await api.get(`/api/items?tag=${encodeURIComponent('助眠')}&tag=${encodeURIComponent('轻语')}&limit=50`);
    eq('两个标签同时选（AND）命中 1 个', both.json.total, 1);
    const none = await api.get(`/api/items?tag=${encodeURIComponent('助眠')}&tag=${encodeURIComponent('美女合集')}&limit=50`);
    eq('互斥的两个标签（AND）命中 0 个', none.json.total, 0);
    const or = await api.get(`/api/items?any=${encodeURIComponent('助眠')}&any=${encodeURIComponent('美女合集')}&limit=50`);
    eq('用 any 做 OR 命中 2 个', or.json.total, 2);

    // ── 7. 导出 ───────────────────────────────────────────────────────────
    section('7. 导出：复制到一个文件夹，准备数据线拷走');
    const dest1 = path.join(OUT, '导出1');
    const review = await api.post('/api/export/review', {});
    eq('导出前体检 200', review.status, 200);
    eq('体检发现 0 个缺失源文件', review.json.missing.length, 0);
    eq('体检发现 0 个超长路径', review.json.longPaths.length, 0);
    note(`体检：${review.json.count} 个文件，共 ${(review.json.totalBytes / 1048576).toFixed(1)} MB，被裁剪标签 ${review.json.droppedTags.length} 个`);

    // 先试"什么都不给 = 导出整个库"这条最容易被忘掉的路径
    const whole = await api.post('/api/export/start', { destRoot: path.join(OUT, '整库'), nameMode: 'original', makeZip: false });
    eq('不给 ids 也不给 filter 时能导出整个库', whole.status, 200, whole.text.slice(0, 200));
    if (whole.status === 200) {
      let wj = whole.json.job;
      const tw = Date.now();
      while ((wj.status === 'running' || wj.status === 'queued') && Date.now() - tw < 180000) {
        await sleep(400);
        wj = (await api.get(`/api/export/${wj.id}`)).json.job;
      }
      eq('整库导出完成', wj.status, 'done');
    eq(`整库导出包含全部 ${items.length} 个素材（含素材目录里的说明文档）`, wj.done, items.length);
      const wl = diskFiles(wj.destDir).filter(f => /\.mp4$/i.test(f.name));
      note(`整库导出（原始文件名模式）：${wl.map(f => f.name).join(' | ')}`);
      check('原始文件名模式下导出的是复制进来时的原名（不是 标签-uuid、也不是 未分类-uuid）',
        wl.length > 0 && wl.every(f => !/[0-9a-f]{32}/i.test(f.name) && !f.name.startsWith('未分类-')), wl.map(f => f.name).join(' | '));
    }

    const started = await api.post('/api/export/start', { destRoot: dest1, subdir: '晚安', nameMode: 'tagged', makeZip: false });
    eq('导出启动 200', started.status, 200);
    const jobId = started.json.job.id;
    let job = started.json.job;
    const t0 = Date.now();
    while (job.status === 'running' || job.status === 'queued') {
      if (Date.now() - t0 > 180000) break;
      await sleep(400);
      job = (await api.get(`/api/export/${jobId}`)).json.job;
    }
    eq('导出状态是完成', job.status, 'done');
    eq('导出无失败项', job.failed.length, 0);
    eq(`导出文件数 ${items.length}（两个视频 + 那份说明文档）`, job.done, items.length);
    note(`导出 ${(job.bytesDone / 1048576).toFixed(1)} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    note(`目标：${job.destDir}`);

    const destDir1 = job.destDir;
    const exported = diskFiles(destDir1);
    note(`导出目录：${exported.map(f => f.name).join(' | ')}`);
    eq('导出目录里有全部素材 + manifest.csv + manifest.json', exported.length, items.length + 2);
    check('有 manifest.csv', exported.some(f => f.name === 'manifest.csv'));
    check('有 manifest.json', exported.some(f => f.name === 'manifest.json'));

    // 逐字节比对大小
    const lib = diskFiles(LIB).filter(f => /\.mp4$/i.test(f.name));
    for (const src of lib) {
      const copy = exported.find(f => f.name === src.name);
      check(`导出的「${src.name}」大小与源文件一致`, copy && copy.size === src.size,
        copy ? `${copy.size} vs ${src.size}` : '导出目录里找不到同名文件');
    }

    // manifest 内容
    const csv = await api.get(`/api/export/${jobId}/manifest.csv`);
    eq('下载 manifest.csv 200', csv.status, 200);
    check('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csv.buf[0] === 0xEF && csv.buf[1] === 0xBB && csv.buf[2] === 0xBF);
    const csvLines = csv.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    note(`CSV 表头：${csvLines[0]}`);
    eq(`CSV 有表头 + ${items.length} 行数据`, csvLines.length, items.length + 1);
    check('CSV 里记了标签', csv.text.includes('助眠'), csvLines[1]);

    const mf = await api.get(`/api/export/${jobId}/manifest.json`);
    eq('下载 manifest.json 200', mf.status, 200);
    eq(`manifest.json 里记了 ${items.length} 条`, (mf.json.files || mf.json.items || []).length, items.length);
    check('任务快照里给了 manifest.json 的下载链接', /manifest\.json$/.test(job.manifestJsonUrl || ''), job.manifestJsonUrl);

    // ── 8. 重复导出不覆盖 ─────────────────────────────────────────────────
    section('8. 再导出一次到同一目录：不许静默覆盖上一次的成果');
    const again = await api.post('/api/export/start', { destRoot: dest1, subdir: '晚安', nameMode: 'tagged', makeZip: false });
    const jobId2 = again.json.job.id;
    let job2 = again.json.job;
    const t1 = Date.now();
    while (job2.status === 'running' || job2.status === 'queued') {
      if (Date.now() - t1 > 180000) break;
      await sleep(400);
      job2 = (await api.get(`/api/export/${jobId2}`)).json.job;
    }
    eq('第二次导出完成', job2.status, 'done');
    const exported2 = diskFiles(destDir1);
    note(`第二次导出后目录里：${exported2.map(f => f.name).join(' | ')}`);
    eq(`文件数翻倍（${videos.length * 2} 个视频文件），上一次的没被覆盖`,
      exported2.filter(f => /\.mp4$/i.test(f.name)).length, videos.length * 2);
    check('新文件带 (2) 之类的退让后缀', exported2.some(f => /\(2\)\.mp4$/i.test(f.name)),
      exported2.map(f => f.name).join(' | '));

    // ── 9. 改标签 → 文件名跟着变 ──────────────────────────────────────────
    section('9. 事后改标签，磁盘文件名立刻跟着变');
    const rename = await api.post(`/api/items/${videos[0].id}/tags`, { remove: ['轻语'], mode: 'remove' });
    eq('移除一个标签 200', rename.status, 200);
    const newName = rename.json.item.name;
    note(`改名结果：${nameA} → ${newName}`);
    check('文件名里不再有「轻语」', !newName.includes('轻语'), newName);
    check('剩下的标签还在', newName.includes('助眠') && newName.includes('直播录屏'), newName);
    const onDisk = diskFiles(LIB).map(f => f.name);
    check('磁盘上确实存在新名字的文件', onDisk.includes(newName), onDisk.join(' | '));
    check('旧名字已经从磁盘上消失', !onDisk.includes(nameA), onDisk.join(' | '));
    eq(`磁盘上视频文件数还是 ${videos.length}（改名不是复制）`,
      diskFiles(LIB).filter(f => /\.mp4$/i.test(f.name)).length, videos.length);

  } catch (e) {
    failed++;
    failures.push(`运行中断：${e.message}`);
    console.log(`\n✗ 运行中断：${e.stack || e.message}`);
  } finally {
    // 关服务
    try { proc.kill(); } catch { /* 已经没了 */ }
    await sleep(500);
    try { fs.closeSync(errFd); } catch { /* ignore */ }

    // 顺手确认服务没偷偷报错
    const errText = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '';
    const errLines = errText.split(/\r?\n/).filter(l => /\[api\]|TypeError|ReferenceError|Error:/.test(l));
    section('10. 服务端日志有没有异常');
    check('服务端没有未处理异常', errLines.length === 0, errLines.slice(0, 6).join(' \n   '));
    if (errLines.length) note(errLines.slice(0, 6).join('\n   '));

    // ── 恢复素材原始文件名 ──────────────────────────────────────────────
    // 注意：**这里服务已经被 kill 了**（上面那行 proc.kill()），所以绝对不能再调 api.*，
    // 否则 fetch 直接抛错、把 finally 的剩余部分整段吞掉——表现就是"名字没恢复"。
    // 判据只能用磁盘上的事实：文件大小（改名与复制都不改字节数）。
    // 用的就是开跑前那套 repairFixture，和"复位上一次的改名"是同一段逻辑，
    // 免得两处写法不一致、一边修得好一边修不好。
    section('11. 把素材名字恢复成原样（方便你第一次打开界面就是干净状态）');
    try {
      const { repaired, unknown } = await repairFixture(baseline);
      if (repaired.length === 0) note('名字已经是原始状态，无需恢复');
      for (const r of repaired) note(`恢复：${r}`);
      for (const u of unknown) note(`没能恢复：${u}`);
    } catch (e) {
      failures.push(`恢复素材名时出错：${e.message}`);
      failed++;
      console.log(`   ✗ 恢复素材名时出错：${e.message}`);
    }
    const finalOnDisk = diskFiles(LIB).map(f => f.name);
    check('素材目录恢复成基准里的原始文件名',
      baseline.every(w => finalOnDisk.includes(w.name)),
      finalOnDisk.join(' | '));

    // 收尾：把这次跑出来的库元数据也删掉，让素材目录回到"从没打开过"的状态。
    // 删掉是安全的：标签已经写进文件名了，重新打开时会由文件名反解回来。
    // （脚本开头就是这么做的，这里是对称的另一半。）
    try {
      await fsp.rm(path.join(LIB, '.mtag'), { recursive: true, force: true });
      note('已清掉这次跑出来的 .mtag（素材目录回到初始状态）');
    } catch (e) {
      note(`.mtag 没清掉（不影响使用）：${e.message}`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`   通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`   ✗ ${f}`);
    console.log(`\n服务端错误日志：${path.join(OUT, 'server.err.log')}`);
  } else {
    console.log('   全部通过。');
  }
  console.log(`\n临时目录留在 ${OUT}（含导出样本，可随时删除）`);
  if (failed) process.exitCode = 1;
})();
