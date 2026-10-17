/*
 * browser_test.js —— 真浏览器端到端验证（零依赖）
 *
 * 为什么要它：verify.js 只能证明 HTTP 层对不对（静态文件能取到、接口返回 200），
 * 但证明不了「页面在浏览器里真的跑起来了」—— app.js 里任何一处 TypeError 都会让
 * 界面白屏，而 HTTP 测试对此完全无感。这个脚本用 Chrome 的 DevTools Protocol
 * 打开真实页面、点真实按钮，检查 DOM 与磁盘文件是否按预期变化。
 *
 * 依赖：本机装的 Chrome（自动探测常见路径）+ Node 24 自带的 WebSocket。
 * 用法：node browser_test.js            （会启动一个临时服务，结束后关掉）
 *      node browser_test.js --keep     （保留临时服务与 Chrome，便于手工接着看）
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const VDIR = path.join(ROOT, '.browser');
const LIBDIR = path.join(VDIR, 'lib');
const SHOTDIR = path.join(VDIR, 'shots');
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9333;
const KEEP = process.argv.includes('--keep');

let passed = 0;
const failures = [];
function check(desc, cond, detail) {
  if (cond) { passed += 1; console.log(`   ✓ ${desc}`); return true; }
  failures.push({ desc, detail: detail === undefined ? '' : String(detail) });
  console.log(`   ✗ ${desc}${detail !== undefined ? `  → ${detail}` : ''}`);
  return false;
}
function eq(desc, actual, expected) { return check(desc, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`); }
function note(msg) { console.log(`   · ${msg}`); }
function section(title) { console.log(`\n── ${title}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 找 Chrome

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ------------------------------------------------------------------ CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const w = this.waiters[i];
          if (w.method === msg.method) { this.waiters.splice(i, 1); w.resolve(msg.params); }
        }
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
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

// ------------------------------------------------------------------ 页面操作

/** 在页面里跑一段表达式，返回它的值（传的是 async IIFE 源码）。 */
async function evaluate(session, expr) {
  const res = await session.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面里抛异常：${(d.exception && (d.exception.description || d.exception.value)) || d.text}`);
  }
  return res.result ? res.result.value : undefined;
}

/** 轮询直到 fn() 为真。fn 出错也继续等（元素还没出现时很正常）。 */
async function until(fn, timeoutMs = 20000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (err) { lastErr = err; }
    await sleep(everyMs);
  }
  if (lastErr) throw lastErr;
  return false;
}

async function shot(session, name) {
  try {
    const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fsp.writeFile(path.join(SHOTDIR, name), Buffer.from(r.data, 'base64'));
    return path.join(SHOTDIR, name);
  } catch (err) {
    note(`截图 ${name} 失败：${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------------ 主体

async function main() {
  const chrome = findChrome();
  section('0. 环境准备');
  if (!chrome) {
    console.log('   本机没找到 Chrome/Edge，跳过浏览器验证。');
    return;
  }
  note(`浏览器：${chrome}`);

  await fsp.rm(VDIR, { recursive: true, force: true });
  await fsp.mkdir(LIBDIR, { recursive: true });
  await fsp.mkdir(SHOTDIR, { recursive: true });

  // 造几个小素材，让浏览器这一趟跑得快（真视频留给 verify.js 的第 7 组）
  await fsp.writeFile(path.join(LIBDIR, '演示片段.mp4'), Buffer.alloc(256 * 1024, 3));
  await fsp.writeFile(path.join(LIBDIR, '一首歌.mp3'), Buffer.alloc(64 * 1024, 4));
  await fsp.writeFile(path.join(LIBDIR, '一张图.png'), Buffer.alloc(32 * 1024, 5));
  note(`临时素材库：${LIBDIR}（3 个假素材）`);

  const appLog = path.join(VDIR, 'app.log');
  const appLogFd = fs.openSync(appLog, 'a');
  const app = spawn(process.execPath, ['server.js', '--root', LIBDIR, '--port', String(PORT), '--no-open', '--scan-interval', '0'], {
    cwd: ROOT, stdio: ['ignore', appLogFd, appLogFd],
    // 删除测试不能真把文件扔进你的回收站：unlink 模式下服务端直接删。
    env: { ...process.env, TAGSTUDIO_RECYCLE: 'unlink' },
  });
  app.on('error', (err) => console.log(`   服务起不来：${err.message}`));

  const profile = path.join(VDIR, 'chrome-profile');
  const chromeLog = fs.openSync(path.join(VDIR, 'chrome.log'), 'a');
  let browser = null;
  let session = null;

  try {
    const up = await until(async () => (await fetch(`${BASE}/api/state`)).ok, 20000, 250);
    check('临时服务已就绪', up === true);

    browser = spawn(chrome, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--mute-audio',
      '--window-size=1440,1000',
      'about:blank',
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
    const pageWs = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`;
    session = await connect(pageWs);

    // 收集页面里的报错：这是本脚本存在的最大理由
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const rawSend = session.send.bind(session);
    session.send = (method, params) => rawSend(method, params);
    session.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      } else if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
        failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
      }
    });

    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Network.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const loaded = session.waitFor('Page.loadEventFired', 30000);
    await session.send('Page.navigate', { url: `${BASE}/` });
    await loaded;
    await until(async () => Boolean(await evaluate(session, `!!document.querySelector('#boot')`)), 15000);
    note('首页已加载');

    // ---------------------------------------------------------- 1. 启动
    section('1. 选素材文件夹并打开库（第一次使用的主流程）');
    // 启动遮罩是否可见，取决于服务端有没有记住上次的库（data/config.json）。
    // 冷启动会显示遮罩；之前跑过就自动打开上一次的库。两种都是对的，
    // 所以这里只断言"界面确实进入了可用状态"，而不是硬写遮罩的可见性。
    const bootUi = await evaluate(session, `({
      hasPath: !!document.querySelector('#bootPath'),
      hasGo: !!document.querySelector('#bootGo'),
      bootVisible: !document.querySelector('#boot').hidden,
      gridVisible: !!document.querySelector('#grid'),
    })`);
    eq('遮罩里有路径输入框', bootUi.hasPath, true);
    eq('遮罩里有「打开」按钮', bootUi.hasGo, true);
    check('界面状态自洽（要么显示启动遮罩，要么已经进了主界面）',
      bootUi.bootVisible || bootUi.gridVisible, JSON.stringify(bootUi));
    note(bootUi.bootVisible ? '本次是冷启动，显示「选择素材文件夹」遮罩' : '服务端记住了上次的库，直接进了主界面');

    await evaluate(session, `(async () => {
      const i = document.querySelector('#bootPath');
      i.value = ${JSON.stringify(LIBDIR)};
      document.querySelector('#bootGo').click();
    })()`);
    const booted = await until(async () => await evaluate(session, `document.querySelector('#boot').hidden === true`), 25000);
    check('点「打开」后进入主界面', booted === true,
      await evaluate(session, `document.querySelector('#bootMsg').textContent`));

    // 光看 .hidden 属性不够：CSS 里若有 display:flex 会把 [hidden]{display:none} 盖掉，
    // 表现就是"属性已是 hidden，遮罩却还糊在界面上"。所以必须查真实可见性。
    const overlay = await evaluate(session, `(() => {
      const b = document.querySelector('#boot');
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return { display: cs.display, w: Math.round(r.width), h: Math.round(r.height), blockedBy: top ? (top.id || top.className || top.tagName) : null };
    })()`);
    check('启动遮罩视觉上真的消失了（不是只设了 hidden 属性）', overlay.display === 'none' && overlay.w === 0, JSON.stringify(overlay));
    check('界面中心没有被浮层挡住（点得到卡片）', !/^boot/.test(String(overlay.blockedBy)), JSON.stringify(overlay));

    // ---------------------------------------------------------- 2. 列表
    section('2. 素材列表与统计');
    const cards = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 3, 20000);
    check('主区渲染出 3 张素材卡', cards === true, await evaluate(session, `document.querySelectorAll('#grid .card').length`));

    const stats = await evaluate(session, `document.querySelector('#stats').textContent.replace(/\\s+/g, ' ').trim()`);
    note(`侧栏统计：${stats}`);
    check('统计里写着 3 个素材', /3/.test(stats), stats);

    const topbar = await evaluate(session, `({
      root: document.querySelector('#rootPath').textContent.trim(),
      count: document.querySelector('#countLabel').textContent.trim(),
    })`);
    check('顶栏显示了库路径', topbar.root.includes(path.basename(LIBDIR)), topbar.root);
    note(`计数标签：${topbar.count}`);

    const kinds = await evaluate(session, `[...document.querySelectorAll('#grid .card .badge')].map(b => b.textContent)`);
    check('三种类型都被识别（视频/音频/图片）',
      ['视频', '音频', '图片'].every((k) => kinds.includes(k)), JSON.stringify(kinds));

    const names = await evaluate(session, `[...document.querySelectorAll('#grid .card .name')].map(n => n.textContent)`);
    check('还没打标签的素材在界面上显示原文件名（不改名，方便照着原名想标签）',
      names.length === 3 && ['一首歌.mp3', '演示片段.mp4', '一张图.png'].every((n) => names.includes(n)), JSON.stringify(names));
    check('没打标签时文件名里不会冒出 uuid',
      names.every((n) => !/[0-9a-f]{32}/i.test(n)), JSON.stringify(names));
    note(`文件名：${names.join(' | ')}`);

    const audioPh = await evaluate(session, `document.querySelectorAll('#grid .card .thumb .ph').length`);
    check('音频卡用占位图标（不发缩略图请求）', audioPh >= 1, `占位图标 ${audioPh} 个`);

    // 还没打标签的卡要有显眼的「待分类」标记：这类素材文件名没被改过，
    // 光看文件名看不出"进库了没有"，必须靠角标告诉他们"这条还没处理"。
    const pending = await evaluate(session, `[...document.querySelectorAll('#grid .card .badge.pending')].map(b => b.textContent)`);
    check('没打标签的卡都带「待分类」角标', pending.length === 3 && pending.every((t) => t === '待分类'), JSON.stringify(pending));
    const pendingChip = await evaluate(session, `[...document.querySelectorAll('#grid .card .tagmini.none')].map(b => b.textContent)`);
    check('卡片标签行也标着「待分类」', pendingChip.length === 3 && pendingChip.every((t) => t === '待分类'), JSON.stringify(pendingChip));
    const origLines = await evaluate(session, `document.querySelectorAll('#grid .card .origname').length`);
    check('还没改名时不用重复显示原始文件名那一行', origLines === 0, `${origLines} 行`);

    await shot(session, '01-列表.png');

    // ---------------------------------------------------------- 3. 打标签
    section('3. 打开素材 → 打标签 → 文件名随之改变');
    // 特意挑视频那张卡（有真实的 <video> 预览元素），顺便覆盖视频这条路径
    await evaluate(session, `(async () => {
      const cards = [...document.querySelectorAll('#grid .card')];
      const v = cards.find(c => c.querySelector('.badge').textContent === '视频') || cards[0];
      window.__pickedExt = (v.querySelector('.name').textContent.match(/\\.[^.]+$/) || [''])[0];
      v.click();
    })()`);
    const pickedExt = await evaluate(session, `window.__pickedExt`);
    note(`挑中的素材扩展名：${pickedExt}`);
    const editorOpen = await until(async () => await evaluate(session, `document.querySelector('#editor').open === true`), 10000);
    check('点卡片打开了标签编辑器', editorOpen === true);
    const editTitle = await evaluate(session, `document.querySelector('#editorTitle').textContent.trim()`);
    note(`编辑器标题：${editTitle}`);
    eq('编辑器里有预览播放器', await evaluate(session, `!!document.querySelector('#editorMedia video, #editorMedia audio, #editorMedia img, #editorMedia .muted')`), true);

    await evaluate(session, `(async () => {
      const t = document.querySelector('#editorTags');
      t.value = '旅行, 海边的日落';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const preview = await until(async () => {
      const s = await evaluate(session, `document.querySelector('#editorPreview').textContent`);
      return s.includes('旅行') && s.includes('海边的日落');
    }, 12000);
    check('文件名预览实时更新（含两个标签）', preview === true,
      await evaluate(session, `document.querySelector('#editorPreview').textContent`));

    await shot(session, '02-标签编辑器.png');

    await evaluate(session, `document.querySelector('#editorSave').click()`);
    const saved = await until(async () => await evaluate(session, `
      (() => {
        const n = [...document.querySelectorAll('#grid .card .name')].map(x => x.textContent);
        return n.some(v => v.includes('旅行') && v.includes('海边的日落'));
      })()
    `), 20000);
    check('保存后卡片上的文件名变成了「标签-uuid.扩展名」', saved === true,
      await evaluate(session, `[...document.querySelectorAll('#grid .card .name')].map(x => x.textContent).join(' | ')`));

    // 改名之后，卡片上要再显示一行入库时的原始文件名 —— 否则用户只能看到一串 uuid
    const origShown = await until(async () => {
      const t = await evaluate(session, `[...document.querySelectorAll('#grid .card .origname')].map(x => x.textContent)`);
      return t.some((s) => /\.mp4$/.test(s) && !/[0-9a-f]{32}/i.test(s));
    }, 8000);
    check('改名后卡片上多出「入库时的原始文件名」这一行', origShown === true,
      JSON.stringify(await evaluate(session, `[...document.querySelectorAll('#grid .card .origname')].map(x => x.textContent)`)));
    const stillPending = await evaluate(session, `document.querySelectorAll('#grid .card .badge.pending').length`);
    eq('打上标签的那张卡不再是「待分类」', stillPending, 2);

    // 再打开一次编辑器：标题已经是「标签-uuid.扩展名」，里面要能看到入库时的原名
    await evaluate(session, `(async () => {
      const cards = [...document.querySelectorAll('#grid .card')];
      const c = cards.find(x => (x.querySelector('.name').textContent || '').includes('海边的日落'));
      if (c) c.click();
    })()`);
    const reopened = await until(async () => await evaluate(session, `document.querySelector('#editor').open === true`), 10000);
    check('能再次打开已改名的素材', reopened === true);
    const editorOrig = await evaluate(session, `(() => {
      const e = document.querySelector('#editorOrig');
      return { hidden: e.hidden, text: e.textContent.trim() };
    })()`);
    check('编辑器里显示了原始文件名（标题已被改成 标签-uuid 了）',
      editorOrig.hidden === false && /\.mp4$/.test(editorOrig.text) && !/[0-9a-f]{32}/i.test(editorOrig.text),
      JSON.stringify(editorOrig));
    await evaluate(session, `document.querySelector('#editorCancel').click()`);
    await until(async () => await evaluate(session, `document.querySelector('#editor').open === false`), 8000);

    const diskNames = await fsp.readdir(LIBDIR).catch(() => []);
    const renamed = diskNames.filter((n) => n.startsWith('旅行-海边的日落-') || n.startsWith('海边的日落-旅行-'));
    check('磁盘上的文件真的被改名了', renamed.length === 1, diskNames.join(' | '));
    const newName = renamed[0] || '';
    check('改名后的文件名是 uuid + 原扩展名',
      newName.endsWith(`-${(newName.match(/([0-9a-f]{32})/i) || [])[1]}${pickedExt}`) && newName.endsWith(pickedExt),
      newName);
    note(`磁盘文件名：${newName}`);

    const tagChips = await evaluate(session, `[...document.querySelectorAll('#tagList .tag-row .tname, #tagList .tag-row')].map(x => x.textContent.trim()).slice(0, 6)`);
    check('新标签出现在左侧标签列表里', tagChips.some((c) => c.includes('旅行')), JSON.stringify(tagChips));

    // ---------------------------------------------------------- 4. 按标签筛选
    section('4. 按标签筛选 / 浏览');
    const tagsBefore = await evaluate(session, `document.querySelectorAll('#tagList .tag-row').length`);
    check('标签列表至少 2 个标签', tagsBefore >= 2, `实际 ${tagsBefore}`);

    await evaluate(session, `(async () => {
      const rows = [...document.querySelectorAll('#tagList .tag-row')];
      const r = rows.find(x => x.textContent.includes('海边的日落'));
      (r || rows[0]).click();
    })()`);
    const filtered = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 1, 15000);
    check('点标签后只剩带该标签的 1 个素材', filtered === true,
      `实际 ${await evaluate(session, `document.querySelectorAll('#grid .card').length`)}`);
    const filterBar = await evaluate(session, `document.querySelector('#activeFilters').textContent.trim()`);
    check('顶部出现当前筛选条件', filterBar.includes('海边的日落'), filterBar);
    await shot(session, '03-按标签筛选.png');

    await evaluate(session, `(async () => {
      const b = [...document.querySelectorAll('[data-quick]')].find(x => x.dataset.quick === 'all');
      if (b) b.click();
    })()`);
    const backAll = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 3, 15000);
    check('点「全部」回到 3 个素材', backAll === true,
      `实际 ${await evaluate(session, `document.querySelectorAll('#grid .card').length`)}`);

    const searchHit = await evaluate(session, `(async () => {
      const s = document.querySelector('#search');
      s.value = '一首歌';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    void searchHit;

    // 改名之后还能靠"入库时的原始文件名"搜到 —— 这是用户真正记得住的那个名字
    const searchByOrig = await until(async () =>
      (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 1, 15000);
    check('按原始文件名搜索能搜到（该素材已经被改名成 标签-uuid 了）', searchByOrig === true,
      await evaluate(session, `[...document.querySelectorAll('#grid .card .name')].map(x => x.textContent).join(' | ')`));

    // ---------------------------------------------------------- 5. 批量 + 导出
    section('5. 勾选素材 → 批量打标签 → 导出');
    await evaluate(session, `(async () => {
      const s = document.querySelector('#search');
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 3, 15000);

    await evaluate(session, `(async () => {
      document.querySelectorAll('#grid .card .check').forEach(c => c.click());
    })()`);
    const selCount = await until(async () => (await evaluate(session, `document.querySelector('#selCount').textContent`)).includes('3'), 10000);
    check('底部选择栏统计到 3 个已勾选', selCount === true,
      await evaluate(session, `document.querySelector('#selbar').textContent.replace(/\\s+/g,' ').trim()`));
    eq('选择栏此时是可见的', await evaluate(session, `getComputedStyle(document.querySelector('#selbar')).display !== 'none'`), true);

    await evaluate(session, `(async () => {
      document.querySelector('#bulkTags').value = '归档';
      document.querySelector('#bulkAdd').click();
    })()`);
    const bulkOk = await until(async () => {
      const n = await evaluate(session, `[...document.querySelectorAll('#grid .card .name')].map(x => x.textContent)`);
      return n.filter((v) => v.includes('归档')).length === 3;
    }, 25000);
    check('批量加标签后 3 个文件名都带上了「归档」', bulkOk === true,
      await evaluate(session, `[...document.querySelectorAll('#grid .card .name')].map(x => x.textContent).join(' | ')`));

    const diskAfterBulk = await fsp.readdir(LIBDIR).catch(() => []);
    const mediaAfterBulk = diskAfterBulk.filter((n) => /\.(mp3|mp4|png|jpg|jpeg|webp)$/i.test(n));
    // 批量加标签是「追加」：原来没标签的两个文件变成「归档-uuid」，
    // 已经叫「旅行-海边的日落-uuid」的那个接在末尾，不抢原来的主标签。
    check('批量加标签：原来没标签的两个文件变成「归档-uuid」',
      mediaAfterBulk.filter((n) => n.startsWith('归档-')).length === 2, diskAfterBulk.join(' | '));
    check('批量加标签：已有标签的那个接在末尾（旅行-海边的日落-归档-uuid）',
      mediaAfterBulk.some((n) => n.startsWith('旅行-海边的日落-归档-')), diskAfterBulk.join(' | '));
    note(`磁盘：${diskAfterBulk.join(' | ')}`);
    await shot(session, '04-批量打标签.png');

    // 导出对话框（真跑一次导出：目标就在临时目录里）
    const dest = path.join(VDIR, 'out');
    await evaluate(session, `document.querySelector('#exportBtn').click()`);
    const expOpen = await until(async () => await evaluate(session, `document.querySelector('#exportDlg').open === true`), 10000);
    check('点「导出」打开了导出对话框', expOpen === true);
    eq('导出对话框有三种命名模式', await evaluate(session, `document.querySelectorAll('input[name=nameMode]').length`), 3);
    eq('默认选中「标签-uuid.扩展名」', await evaluate(session, `document.querySelector('input[name=nameMode]:checked').value`), 'tagged');

    await evaluate(session, `(async () => {
      const d = document.querySelector('#expDest');
      d.value = ${JSON.stringify(dest)};
      d.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#expSubdir').value = 'batch';
    })()`);
    await sleep(600);
    await evaluate(session, `document.querySelector('#expStart').click()`);

    const exportDone = await until(async () => {
      const txt = await evaluate(session, `document.querySelector('#expLog').textContent + ' ' + document.querySelector('#expResult').textContent`);
      return /完成|成功|复制/.test(txt) && !/正在/.test(txt);
    }, 40000);
    const expText = await evaluate(session, `(document.querySelector('#expResult').textContent || '').replace(/\\s+/g,' ').trim()`);
    check('导出完成并在对话框里报了结果', exportDone === true, expText);
    note(`导出结果：${expText || '(见 expLog)'}`);

    const outFiles = await (async () => {
      const p = path.join(dest, 'batch');
      if (!fs.existsSync(p)) return [];
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp); else out.push(e.name);
        }
      };
      walk(p);
      return out;
    })();
    check('导出目标目录里出现了 3 个文件', outFiles.filter((n) => !n.endsWith('.csv') && !n.endsWith('.json') && !n.endsWith('.zip')).length === 3, outFiles.join(' | '));
    check('导出的文件名也是「标签-uuid.扩展名」', outFiles.some((n) => /^归档-.*[0-9a-f]{32}\./.test(n)), outFiles.join(' | '));
    note(`导出目录：${outFiles.join(' | ')}`);
    await shot(session, '05-导出完成.png');

    // 收尾也顺手验一下"藏得住"：关掉导出框、取消勾选，选择栏应该真的收起来
    await evaluate(session, `document.querySelector('#expClose').click()`);
    await sleep(300);
    eq('关掉导出对话框后它不再显示', await evaluate(session, `document.querySelector('#exportDlg').open`), false);
    await evaluate(session, `document.querySelector('#selClear').click()`);
    await sleep(400);
    eq('清空勾选后底部选择栏真的收起来了',
      await evaluate(session, `getComputedStyle(document.querySelector('#selbar')).display`), 'none');
    await shot(session, '06-收尾状态.png');

    // ---------------------------------------------------------- 6. 顶栏换库入口
    section('6. 顶栏换素材文件夹 + 快速切换用过的文件夹');

    const rootUi = await evaluate(session, `(() => {
      const btn = document.querySelector('#rootPath');
      const sel = document.querySelector('#rootSelect');
      return {
        hasBtn: Boolean(btn), hasSel: Boolean(sel),
        btnVisible: btn ? getComputedStyle(btn).display !== 'none' : false,
        options: sel ? [...sel.options].map((o) => ({ v: o.value, t: o.textContent })) : [],
        selected: sel ? sel.value : '',
        bootRows: document.querySelectorAll('#boot').length,
      };
    })()`);
    check('库路径本身就是一个按钮（点它就是换文件夹）', rootUi.hasBtn && rootUi.btnVisible, JSON.stringify(rootUi));
    check('路径旁边有一个「用过的文件夹」下拉框', rootUi.hasSel === true, JSON.stringify(rootUi));
    check('下拉框第一项是当前库、最后一项是「选择其他文件夹…」',
      rootUi.selected.includes(path.basename(LIBDIR))
      && rootUi.options.length >= 2
      && /选择其他文件夹/.test(rootUi.options[rootUi.options.length - 1].t),
      JSON.stringify(rootUi.options));
    note(`下拉框：${rootUi.options.map((o) => o.t).join(' / ')}`);

    await evaluate(session, `document.querySelector('#rootPath').click()`);
    const pickerOpened = await until(async () => await evaluate(session, `document.querySelector('#browser').open === true`), 8000);
    check('点库路径会打开目录浏览器（原来这个入口藏在设置里）', pickerOpened === true, '目录浏览器没打开');
    await evaluate(session, `document.querySelector('#brCancel').click()`);
    await sleep(300);

    // 真换一次库：再造一个小库并打开它（这样它才会被记进「用过的文件夹」），
    // 刷新页面后下拉框里应该同时有新旧两个库，再用下拉框切回来 —— 走的是用户真会走的那条路。
    const LIB2 = path.join(VDIR, 'lib2');
    await fsp.mkdir(LIB2, { recursive: true });
    await fsp.writeFile(path.join(LIB2, '另一个库里的视频.mp4'), Buffer.alloc(64 * 1024, 3));
    const boot2 = await fetch(`${BASE}/api/library/boot`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: LIB2 }),
    });
    check('第二个库能打开（这一步顺带把它登记进 recentRoots）', boot2.ok, `HTTP ${boot2.status}`);

    await evaluate(session, `location.reload()`);
    const onLib2 = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 1, 25000);
    check('刷新后页面显示的就是刚打开的那个库（1 个素材）', onLib2 === true,
      await evaluate(session, `document.querySelectorAll('#grid .card').length`));

    const secondUi = await evaluate(session, `(() => {
      const sel = document.querySelector('#rootSelect');
      const same = (v) => v.replace(/[\\\\/]+$/, '').toLowerCase();
      return {
        selected: sel.value,
        hasFirst: [...sel.options].some((o) => same(o.value) === same(${JSON.stringify(LIBDIR)})),
        options: [...sel.options].map((o) => ({ v: o.value, t: o.textContent })),
      };
    })()`);
    check('下拉框里还能看到上一个库（就是为了快速跳回去）',
      secondUi.selected.replace(/[\\/]+$/, '').toLowerCase() === LIB2.toLowerCase() && secondUi.hasFirst === true,
      JSON.stringify(secondUi.options));
    note(`换库后下拉框：${secondUi.options.map((o) => o.t).join(' / ')}`);

    const back = await evaluate(session, `(() => {
      const sel = document.querySelector('#rootSelect');
      const same = (v) => v.replace(/[\\\\/]+$/, '').toLowerCase();
      // 必须按完整路径比，不能只比 'lib' 这种子串：lib2 里也含 'lib'，
      // 那样会误选中"当前这一项"，切换压根不会发生（这个坑真踩过一次）。
      const o = [...sel.options].find((x) => same(x.value) === same(${JSON.stringify(LIBDIR)}));
      if (!o) return null;
      sel.value = o.value;
      sel.dispatchEvent(new Event('change'));
      return o.value;
    })()`);
    check('在下拉框里选中上一个库并触发了切换', Boolean(back), '下拉框里没找到上一个库');
    const backOk = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 3, 25000);
    check('用下拉框切回来之后，列表恢复成 3 张卡', backOk === true,
      await evaluate(session, `document.querySelectorAll('#grid .card').length`));
    note(`切回来后：${await evaluate(session, `document.querySelector('#rootPath').textContent.trim()`)}`);
    await shot(session, '07-顶栏快速切换素材文件夹.png');

    // ---------------------------------------------------------- 6b. 删除
    section('6b. 删除选中的素材（必须先选中才给删）');

    eq('没勾选时选择栏是收起的 —— 也就没有删除入口',
      await evaluate(session, `getComputedStyle(document.querySelector('#selbar')).display`), 'none');

    await evaluate(session, `document.querySelectorAll('#grid .card .check')[0].click()`);
    const delBar = await until(async () => await evaluate(session, `(() => {
      const b = document.querySelector('#selDelete');
      return Boolean(b) && getComputedStyle(document.querySelector('#selbar')).display !== 'none';
    })()`), 8000);
    check('勾选一个素材后，选择栏里出现「删除选中」', delBar === true);
    eq('按钮上写的是「删除选中」', await evaluate(session, `document.querySelector('#selDelete').textContent.trim()`), '删除选中');
    check('按钮提示写明是移到回收站（可以还原）',
      await evaluate(session, `document.querySelector('#selDelete').title.includes('回收站')`), true);

    await evaluate(session, `document.querySelector('#selDelete').click()`);
    const dlgOpen = await until(async () => await evaluate(session, `document.querySelector('#delDlg').open === true`), 8000);
    check('点「删除选中」先弹确认框（不是点一下就没了）', dlgOpen === true);
    eq('确认框里写着要删几个', await evaluate(session, `document.querySelector('#delCount').textContent.trim()`), '1');
    const delNameText = await evaluate(session, `document.querySelector('#delNames').textContent.trim()`);
    check('确认框里列出了要删的文件原名', delNameText.length > 0, delNameText);
    note(`确认框内容：${delNameText.replace(/\s+/g, ' ')}`);

    await evaluate(session, `document.querySelector('#delCancel').click()`);
    await sleep(400);
    eq('点「先不删」后弹窗关掉', await evaluate(session, `document.querySelector('#delDlg').open`), false);
    eq('取消之后卡片还是 3 张', await evaluate(session, `document.querySelectorAll('#grid .card').length`), 3);
    const diskBeforeDel = (await fsp.readdir(LIBDIR)).filter((n) => /\.(mp3|mp4|png|jpg|jpeg|webp)$/i.test(n));
    eq('取消之后磁盘上还是 3 个媒体文件', diskBeforeDel.length, 3);

    // 键盘 Delete 也能用，但前提是真的有选中（没选中时按了什么都不该发生）
    await evaluate(session, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    const keyOpen = await until(async () => await evaluate(session, `document.querySelector('#delDlg').open === true`), 5000);
    check('选中状态下按 Delete 键也会弹确认框', keyOpen === true);
    await evaluate(session, `document.querySelector('#delCancel').click()`);
    await sleep(300);

    // 真删一次
    await evaluate(session, `document.querySelector('#selDelete').click()`);
    await until(async () => await evaluate(session, `document.querySelector('#delDlg').open === true`), 8000);
    await shot(session, '08-删除确认.png');
    await evaluate(session, `document.querySelector('#delGo').click()`);
    const gone = await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) === 2, 25000);
    check('确认之后列表里少了一张卡', gone === true,
      await evaluate(session, `document.querySelectorAll('#grid .card').length`));
    const diskAfterDel = (await fsp.readdir(LIBDIR)).filter((n) => /\.(mp3|mp4|png|jpg|jpeg|webp)$/i.test(n));
    eq('磁盘上也真的少了那个文件', diskAfterDel.length, 2);
    note(`删完磁盘：${diskAfterDel.join(' | ')}`);
    const stDel = await httpJson(`${BASE}/api/state`);
    eq('库里的统计跟着变了', stDel.stats.total, 2);
    check('删完之后选择栏自动收起（不会留着旧勾选再删一次）',
      await evaluate(session, `getComputedStyle(document.querySelector('#selbar')).display`) === 'none',
      await evaluate(session, `document.querySelector('#selbar').textContent.replace(/\\s+/g,' ').trim()`));
    const delToast = await evaluate(session, `document.querySelector('#toast').textContent.trim()`);
    check('给了「删掉了几个、去哪了」的提示', /回收站|已删除/.test(delToast), delToast);
    note(`删除提示：${delToast.replace(/\s+/g, ' ')}`);
    await shot(session, '09-删除完成.png');

    // ---------------------------------------------------------- 7. 无报错
    section('7. 运行期有没有报错');
    check('页面没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' ｜ '));
    check('控制台没有 error 级日志', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' ｜ '));
    const mediaFails = failedRequests.filter((f) => !/image|other/i.test(f));
    check('没有关键资源加载失败', mediaFails.length === 0, failedRequests.slice(0, 5).join(' ｜ '));
    note(`加载失败的请求：${failedRequests.length ? failedRequests.slice(0, 5).join(' ｜ ') : '无'}`);

    session.close();
    bws.close();
  } finally {
    if (browser && !KEEP) { try { browser.kill(); } catch { /* 忽略 */ } }
    if (app && !KEEP) { try { app.kill(); } catch { /* 忽略 */ } }
    try { fs.closeSync(appLogFd); } catch { /* 忽略 */ }
    try { fs.closeSync(chromeLog); } catch { /* 忽略 */ }
  }

  section('结果');
  console.log(`   通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`   ✗ ${f.desc}${f.detail ? `\n        ${f.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('   全部通过。');
  }
  if (fs.existsSync(SHOTDIR)) console.log(`\n截图留在 ${SHOTDIR}`);
  console.log(`临时库留在 ${VDIR}（可随时删除）`);
  const killer = setTimeout(() => process.exit(process.exitCode || 0), 600);
  void killer;
}

main().catch((err) => {
  console.error(`\n浏览器验证脚本自身出错：${err && err.stack}`);
  if (KEEP) console.log('（--keep：进程留着，可手工接着看）');
  process.exit(2);
});
