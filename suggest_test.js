/*
 * suggest_test.js —— 「从文件名里认出旧标签」这个功能的浏览器端验证。
 *
 * 为什么要有这一套：这个功能的一半在服务端（识别、计数、采纳时改名），
 * 另一半在浏览器里（弹窗、逐组采纳/不用、卡片上的提示条）。服务端对了但弹窗不出来，
 * 功能等于没做。所以这里起真服务 + 真 Chrome，用 CDP 点真实按钮。
 *
 * 场景：一个文件夹里混着
 *   · 以前用本工具打过标签的名字（旅行-风景.mp4 / 助眠-直播录屏-轻语.mp3）→ 应该被认出来
 *   · 本来就是这类名字但没打标签的（2024-08-23 直播录屏.mp4）→ 会被猜成 ["2024","08","23 直播录屏"]
 *   · 已经符合规范名的（旅行-风景-<uuid>.mp4）→ 不该再提示（已经打过标签了）
 *   · 一段没有连字符的（单段.mp4）→ 不该提示
 *
 * 跑法：node suggest_test.js
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const VDIR = path.join(ROOT, '.suggest');
const LIBDIR = path.join(VDIR, 'lib');
const SHOTDIR = path.join(VDIR, 'shots');
const PORT = 8805;
const CDP_PORT = 9336;
const BASE = `http://127.0.0.1:${PORT}`;

const U1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const U2 = '0f9e8d7c6b5a4938271605f4e3d2c1b0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 微型测试框架

let pass = 0;
const failures = [];
function check(desc, cond, detail) {
  if (cond) { pass += 1; console.log(`   ✓ ${desc}`); return true; }
  failures.push({ desc, detail: detail === undefined ? '' : String(detail) });
  console.log(`   ✗ ${desc}${detail === undefined ? '' : ` —— ${detail}`}`);
  return false;
}
function eq(desc, actual, expected) {
  return check(desc, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}
function note(msg) { console.log(`   · ${msg}`); }
function section(title) { console.log(`\n── ${title}`); }

// ---------------------------------------------------------------- CDP（复用 browser_test.js 的做法）

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i].method === msg.method) {
          const w = this.waiters.splice(i, 1)[0];
          w.resolve(msg.params);
        }
      }
    });
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = (this.id += 1);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }
      }, 30000).unref();
    });
  }

  waitFor(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`等 ${method} 超时`)); }
      }, timeoutMs).unref();
    });
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`连不上 ${wsUrl}`)), { once: true });
  });
  return new Cdp(ws);
}

async function httpJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function evaluate(session, expr) {
  const res = await session.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面里抛异常：${(d.exception && (d.exception.description || d.exception.value)) || d.text}`);
  }
  return res.result ? res.result.value : undefined;
}

async function until(fn, timeoutMs = 25000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch { /* 还没出现，继续等 */ }
    await sleep(everyMs);
  }
  return false;
}

async function shot(session, name) {
  try {
    const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fsp.writeFile(path.join(SHOTDIR, name), Buffer.from(r.data, 'base64'));
  } catch (err) { note(`截图 ${name} 失败：${err.message}`); }
}

// 供测试用的轻量 HTTP 客户端（重活用浏览器，断言用 API）
async function apiget(p) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 200)}`);
  return j;
}
async function apipost(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 300)}`);
  return j;
}

const disk = async () => (await fsp.readdir(LIBDIR, { withFileTypes: true }))
  .filter((e) => e.isFile() && !e.name.startsWith('.'))
  .map((e) => e.name).sort();

// ---------------------------------------------------------------- 主体

async function main() {
  const chrome = findChrome();
  section('0. 环境准备');
  if (!chrome) { console.log('   本机没找到 Chrome/Edge，跳过。'); return; }
  note(`浏览器：${chrome}`);

  await fsp.rm(VDIR, { recursive: true, force: true });
  await fsp.mkdir(LIBDIR, { recursive: true });
  await fsp.mkdir(SHOTDIR, { recursive: true });

  // 造素材：前两个是「以前打过标签的名字」，第三个长得像但不是，第四个已经规范，第五个太短
  await fsp.writeFile(path.join(LIBDIR, '旅行-风景.mp4'), Buffer.alloc(48 * 1024, 7));
  await fsp.writeFile(path.join(LIBDIR, '助眠-直播录屏-轻语.mp3'), Buffer.alloc(32 * 1024, 8));
  await fsp.writeFile(path.join(LIBDIR, '2024-08-23 直播录屏.mp4'), Buffer.alloc(64 * 1024, 9));
  await fsp.writeFile(path.join(LIBDIR, `旅行-风景-${U1}.mp4`), Buffer.alloc(16 * 1024, 10));
  await fsp.writeFile(path.join(LIBDIR, '单段.mp4'), Buffer.alloc(8 * 1024, 11));
  note(`临时素材库：${LIBDIR}（5 个假素材）`);

  const appLog = path.join(VDIR, 'app.log');
  const appLogFd = fs.openSync(appLog, 'a');
  const app = spawn(process.execPath, ['server.js', '--root', LIBDIR, '--port', String(PORT), '--no-open', '--scan-interval', '0'],
    { cwd: ROOT, stdio: ['ignore', appLogFd, appLogFd] });
  app.on('error', (err) => console.log(`   服务起不来：${err.message}`));

  const profile = path.join(VDIR, 'chrome-profile');
  const chromeLog = fs.openSync(path.join(VDIR, 'chrome.log'), 'a');
  let browser = null;
  let session = null;

  try {
    const up = await until(async () => (await fetch(`${BASE}/api/state`)).ok, 20000, 250);
    check('临时服务已就绪', up === true);

    // 先跑一次扫描（服务端在 boot 时已经扫过，这里只是为了拿到确定的扫描结果）
    await apipost('/api/scan');

    // ---------------------------------------------------------- 1. 服务端识别
    section('1. 服务端识别：哪些文件名被当成标签');
    const sug = await apiget('/api/suggestions');
    const byKey = Object.fromEntries(sug.groups.map((g) => [g.tags.join('-'), g]));
    note(`识别出 ${sug.count} 组 / ${sug.itemCount} 个素材：${sug.groups.map((g) => `[${g.tags.join('|')}]×${g.ids.length}`).join(' ')}`);

    check('「旅行-风景.mp4」被认成标签 [旅行, 风景]', Boolean(byKey['旅行-风景']), JSON.stringify(Object.keys(byKey)));
    check('「助眠-直播录屏-轻语.mp3」被认成三个标签', Boolean(byKey['助眠-直播录屏-轻语']));
    // 标签会先按码点排序再拼进文件名，所以 "2024-08-23 直播录屏.mp4" 猜出来是 [08, 2024, 23 直播录屏]
    const dateKey = sug.groups.map((g) => g.tags.join('-')).find((k) => k.includes('2024') && k.includes('直播录屏'));
    check('「2024-08-23 直播录屏.mp4」也被当候选列出（这种名字程序分不清，交给用户判断）',
      Boolean(dateKey), JSON.stringify(Object.keys(byKey)));
    if (dateKey) note(`这种名字猜出来的标签是 [${dateKey.split('-').join('|')}]（顺序按码点，所以 08 在最前）`);
    const flatIds = sug.groups.flatMap((g) => g.ids);
    const all = await apiget('/api/items');
    const u1 = all.items.find((i) => i.id === U1);
    check('已经规范命名的「旅行-风景-<uuid>.mp4」不再提示', !flatIds.includes(U1));
    check('已经规范命名的那个素材标签确实已经在库里', Boolean(u1) && u1.tags.join(',') === '旅行,风景',
      u1 ? JSON.stringify(u1.tags) : '找不到');
    const single = all.items.find((i) => i.name === '单段.mp4');
    check('「单段.mp4」不提示（没有连字符，看不出标签）', Boolean(single) && !flatIds.includes(single.id));
    check('没打标签的素材文件名没被改动（保留原名）',
      all.items.some((i) => i.name === '旅行-风景.mp4') && all.items.some((i) => i.name === '单段.mp4'),
      JSON.stringify(all.items.map((i) => i.name)));
    eq('扫描结果里带着待确认组数', (await apipost('/api/scan')).suggested, 3);

    // ---------------------------------------------------------- 2. 浏览器弹窗
    section('2. 浏览器：打开库就弹窗问用户');
    browser = spawn(chrome, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--mute-audio',
      '--window-size=1440,1000', 'about:blank',
    ], { stdio: ['ignore', chromeLog, chromeLog] });

    const wsUrl = await (async () => {
      const ok = await until(async () => {
        const v = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return Boolean(v && v.webSocketDebuggerUrl);
      }, 25000, 300);
      if (!ok) return null;
      const v = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      note(`浏览器版本：${v.Browser}`);
      return v.webSocketDebuggerUrl;
    })();
    check('Chrome 调试端口可用', Boolean(wsUrl));
    if (!wsUrl) throw new Error('Chrome 没起来，后面的检查没法做');

    const bws = await connect(wsUrl);
    const target = await bws.send('Target.createTarget', { url: 'about:blank' });
    session = await connect(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`);

    const pageErrors = [];
    const consoleErrors = [];
    session.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const loaded = session.waitFor('Page.loadEventFired', 30000);
    await session.send('Page.navigate', { url: `${BASE}/` });
    await loaded;
    await until(async () => Boolean(await evaluate(session, `!!document.querySelector('#suggestChip')`)), 15000);

    // 服务端记住的库可能是上一次跑剩下的；显式打开本次的库
    await evaluate(session, `(async () => {
      const i = document.querySelector('#bootPath'); if (i) i.value = ${JSON.stringify(LIBDIR)};
      const go = document.querySelector('#bootGo'); if (go) go.click();
      window.boot ? window.boot(${JSON.stringify(LIBDIR)}) : null;
    })()`);

    const dlgOpen = await until(async () => await evaluate(session, `document.querySelector('#suggestDlg').open === true`), 25000);
    check('打开库之后自动弹出「文件名里好像带着标签」确认框', dlgOpen === true);
    if (!dlgOpen) {
      // 没弹出来也要把原因说清楚：chip 上有没有数字？
      note(`chip 文本：${await evaluate(session, `document.querySelector('#suggestChip').textContent`)} / hidden=${await evaluate(session, `document.querySelector('#suggestChip').hidden`)}`);
    }

    const ui = await evaluate(session, `({
      title: document.querySelector('#suggestDlg h3').textContent,
      chip: document.querySelector('#suggestChip').textContent,
      chipHidden: document.querySelector('#suggestChip').hidden,
      groups: document.querySelectorAll('#sugList .suggroup').length,
      firstTags: [...document.querySelectorAll('#sugList .suggroup')][0]
        ? [...[...document.querySelectorAll('#sugList .suggroup')][0].querySelectorAll('.sugtags .tagmini')].map(n => n.textContent) : [],
      hasArrow: document.querySelectorAll('#sugList .sugnew').length > 0,
      newNameShown: [...document.querySelectorAll('#sugList .sugnew')].map(n => n.textContent).slice(0, 3),
      oldNameShown: [...document.querySelectorAll('#sugList .sugold')].map(n => n.textContent).slice(0, 3),
    })`);
    note(`弹窗标题：${ui.title}`);
    note(`顶栏提示：${ui.chipHidden ? '(隐藏)' : ui.chip}`);
    check('顶栏有一条「认出 N 个文件名里的标签」的提示', ui.chipHidden === false && /认出\s*\d+\s*个/.test(ui.chip), ui.chip);
    eq('弹窗里按标签组合分成 3 组', ui.groups, 3);
    check('每组显示认出来的标签', ui.firstTags.length === 3 || ui.firstTags.length === 2, JSON.stringify(ui.firstTags));
    check('弹窗里给出了「原名 → 规范名」的预览', ui.hasArrow === true, JSON.stringify(ui.newNameShown));
    check('预览里的原名就是磁盘上的原名', ui.oldNameShown.some((n) => n === '旅行-风景.mp4' || n === '助眠-直播录屏-轻语.mp3'), JSON.stringify(ui.oldNameShown));
    check('预览里的新名带 uuid', ui.newNameShown.some((n) => /[0-9a-f]{32}\./.test(n)), JSON.stringify(ui.newNameShown));
    await shot(session, '01-自动识别弹窗.png');

    // ---------------------------------------------------------- 3. 逐组采纳 / 不用
    section('3. 采纳一组、另一组点「不用」，看磁盘和标签');

    // 找到「助眠-直播录屏-轻语」那一组对应的按钮（页面上按钮文字是「采纳这 N 个」）
    const clicked = await evaluate(session, `(() => {
      const groups = [...document.querySelectorAll('#sugList .suggroup')];
      const g = groups.find((n) => [...n.querySelectorAll('.sugtags .tagmini')].map(t => t.textContent).includes('轻语'));
      if (!g) return null;
      const btn = [...g.querySelectorAll('button')].find((b) => b.textContent.startsWith('采纳'));
      btn.click();
      return btn.textContent;
    })()`);
    check('在弹窗里点了「助眠-直播录屏-轻语」那组的采纳按钮', Boolean(clicked), '没找到按钮');
    note(`点了：${clicked}`);

    const accepted = await until(async () => {
      const d = await disk();
      return d.some((n) => /^助眠-直播录屏-轻语-[0-9a-f]{32}\.mp3$/.test(n));
    }, 25000);
    check('采纳后磁盘上出现规范的「标签-uuid.扩展名」', accepted === true, JSON.stringify(await disk()));

    // 再点一组「不用」
    const ignored = await evaluate(session, `(() => {
      const groups = [...document.querySelectorAll('#sugList .suggroup')];
      const g = groups.find((n) => [...n.querySelectorAll('.sugtags .tagmini')].map(t => t.textContent).join('-') === '旅行-风景');
      if (!g) return null;
      const btn = [...g.querySelectorAll('button')].find((b) => b.textContent.includes('不用'));
      btn.click();
      return btn.textContent;
    })()`);
    check('在弹窗里点了「旅行-风景」那组的「不用」', Boolean(ignored), '没找到按钮');
    note(`点了：${ignored}`);

    const stillThere = await until(async () => (await disk()).includes('旅行-风景.mp4'), 20000);
    check('点「不用」之后磁盘文件没被动过', stillThere === true, JSON.stringify(await disk()));

    const afterIgnore = await apiget('/api/suggestions');
    const keysLeft = afterIgnore.groups.map((g) => g.tags.join('-'));
    check('点过「不用」的那组不再出现在弹窗里', !keysLeft.includes('旅行-风景'), JSON.stringify(keysLeft));
    note(`剩余待确认：${keysLeft.join(' / ') || '(无)'}`);

    const taggedItem = (await apiget('/api/items')).items.find((i) => /^助眠/.test(i.name));
    check('采纳后的素材标签真的进了库', Boolean(taggedItem) && taggedItem.tags.join(',') === '助眠,直播录屏,轻语',
      taggedItem ? JSON.stringify(taggedItem.tags) : '找不到');
    check('采纳后的素材不再是「待分类」', Boolean(taggedItem) && taggedItem.tagSuggest === null,
      taggedItem ? JSON.stringify(taggedItem.tagSuggest) : '');

    // ---------------------------------------------------------- 4. 全部采纳
    section('4. 点「全部采纳」把剩下的都认下来');
    await evaluate(session, `document.querySelector('#sugAccept').click()`);
    const allDone = await until(async () => {
      const s = await apiget('/api/suggestions');
      return s.itemCount === 0;
    }, 25000);
    check('「全部采纳」之后没有待确认的了', allDone === true,
      JSON.stringify((await apiget('/api/suggestions')).groups.map((g) => g.tags)));

    const d2 = await disk();
    note(`磁盘现在：${d2.join(' | ')}`);
    // 判断「改没改成规范名」不能只看开头一段：标签本身也可能带多个连字符
    // （比如 "08-2024-23 直播录屏-<uuid>.mp4"），所以直接找文件名里有没有那个 uuid。
    const isNormalized = (n) => /[0-9a-f]{32}/.test(n);
    // 这两个本来就该保持原名：一个被用户点过「不用」，一个压根没被认出来（没有连字符）
    const keepOriginal = ['旅行-风景.mp4', '单段.mp4'];
    const notNormalized = d2.filter((n) => !isNormalized(n) && !keepOriginal.includes(n));
    check('该被认成标签的都改成了规范名，不该动的两个保持原名', notNormalized.length === 0, JSON.stringify(notNormalized));
    check('用户点过「不用」的文件名字没被动过', d2.includes('旅行-风景.mp4'), JSON.stringify(d2));
    check('没被认出来的文件名字没被动过', d2.includes('单段.mp4'), JSON.stringify(d2));
    check('弹窗已关闭', (await evaluate(session, `document.querySelector('#suggestDlg').open`)) === false,
      await evaluate(session, `JSON.stringify({ open: document.querySelector('#suggestDlg').open, chip: document.querySelector('#suggestChip').textContent, chipHidden: document.querySelector('#suggestChip').hidden, groups: document.querySelectorAll('#sugList .suggroup').length })`));

    const stats = await apiget('/api/state');
    note(`重扫后统计：${stats.stats.total} 个素材 / ${stats.stats.tagged} 已打标签 / ${stats.stats.tags} 个标签`);

    // 「不用」的决定要能跨重启记住
    section('5. 重启服务：「不用」的决定还记得，且不会再弹');
    app.kill();
    await sleep(600);
    const appLogFd2 = fs.openSync(appLog, 'a');
    const app2 = spawn(process.execPath, ['server.js', '--root', LIBDIR, '--port', String(PORT), '--no-open', '--scan-interval', '0'],
      { cwd: ROOT, stdio: ['ignore', appLogFd2, appLogFd2] });
    try {
      const up2 = await until(async () => (await fetch(`${BASE}/api/state`)).ok, 20000, 250);
      check('重启后服务又起来了', up2 === true);
      const s2 = await apiget('/api/suggestions');
      check('重启后不再提示那组被「不用」过的文件名', !s2.groups.map((g) => g.tags.join('-')).includes('旅行-风景'),
        JSON.stringify(s2.groups.map((g) => g.tags)));
      check('重启后文件名依然保持规范名 / 「不用」的原样', (await disk()).includes('旅行-风景.mp4'), JSON.stringify(await disk()));

      // 用户自己把这个文件改名了 → 旧决定失效，应该重新提示
      const item = (await apiget('/api/items')).items.find((i) => i.name === '旅行-风景.mp4');
      await fsp.rename(path.join(LIBDIR, '旅行-风景.mp4'), path.join(LIBDIR, '旅行-风景-新的名字.mp4'));
      await apipost('/api/scan');
      const s3 = await apiget('/api/suggestions');
      check('用户自己改了名之后，旧决定失效、重新给建议',
        s3.groups.some((g) => g.tags.includes('旅行') && g.tags.includes('风景')),
        JSON.stringify(s3.groups.map((g) => g.tags)));
      note(`改名后待确认：${s3.groups.map((g) => g.tags.join('|')).join(' / ')}`);
      // 把这个记录也清掉，别留着影响下次
      await apipost('/api/suggestions/ignore', {});
      if (item) note(`（这个素材的 id 是 ${item.id}，改名会被指纹认回来，标签不会丢）`);
    } finally {
      app2.kill();
    }

    // ---------------------------------------------------------- 6. 收尾
    section('6. 页面运行期有没有报错');
    check('页面没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('控制台没有 error 级日志', consoleErrors.length === 0, consoleErrors.join(' | '));
    await shot(session, '02-采纳完成后的列表.png');
  } finally {
    try { if (session) session.close(); } catch { /* 忽略 */ }
    try { if (browser) browser.kill(); } catch { /* 忽略 */ }
    try { app.kill(); } catch { /* 忽略 */ }
  }

  console.log('\n── 结果');
  console.log(`   通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log(`   ✗ ${f.desc} —— ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('   全部通过。');
  }
  console.log(`   截图目录：${SHOTDIR}`);
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

main().catch((err) => {
  console.error(`\n脚本自己挂了：${err.stack || err.message}`);
  process.exit(1);
});
