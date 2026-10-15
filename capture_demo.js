/*
 * capture_demo.js —— 用真实素材截几张界面图，给 README 和验收报告用。
 *
 * 它做的事：
 *   1. 以 <项目>/素材 为库启动一个临时服务
 *   2. 用接口给两个真视频打上标签（相当于你在界面上手点），观察改名 + 缩略图
 *   3. 用无头 Chrome 打开界面，截图
 *   4. **收尾**：把标签清掉、库重置、文件名恢复成你复制进来的原样
 *
 * 第 4 步是刻意的：这个脚本是"演示工具"，不该把你的素材改动留下来。
 *
 * 用法：node capture_demo.js
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const LIB = path.join(ROOT, '素材');
const SHOTDIR = path.join(ROOT, '截图');
const PORT = 8802;
const CDP_PORT = 9334;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (m) => console.log(`   · ${m}`);

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const buf = Buffer.concat(c);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* 忽略 */ }
        resolve({ status: res.statusCode, buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------- CDP 最小客户端
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          if (this.waiters[i].method === msg.method) {
            const w = this.waiters.splice(i, 1)[0];
            clearTimeout(w.timer); w.resolve(msg.params);
          }
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  waitFor(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${method} 超时`)), timeout);
      this.waiters.push({ method, resolve, timer });
    });
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`连不上 ${wsUrl}`)), { once: true });
  });
  return new Cdp(ws);
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

async function until(fn, timeoutMs = 20000, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if (await fn()) return true; } catch { /* 继续等 */ } await sleep(everyMs); }
  return false;
}

async function httpJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function shot(session, name) {
  const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = path.join(SHOTDIR, name);
  await fsp.writeFile(p, Buffer.from(r.data, 'base64'));
  note(`截图：${name}`);
  return p;
}

// ---------------------------------------------------------------- 主体
(async () => {
  console.log('tagStudio —— 用真实素材截图\n');

  // 先清掉上一轮的截图：文件名带序号，重命名过之后旧图会留下来冒充新图
  await fsp.rm(SHOTDIR, { recursive: true, force: true });
  await fsp.mkdir(SHOTDIR, { recursive: true });

  const chrome = findChrome();
  if (!chrome) { console.error('没找到 Chrome/Edge，没法截图。'); process.exit(1); }

  const before = fs.readdirSync(LIB).filter((n) => !n.startsWith('.'));
  note(`素材目录原有 ${before.length} 个文件：${before.join(' | ')}`);
  const sizeToName = new Map(before.map((n) => [fs.statSync(path.join(LIB, n)).size, n]));

  await fsp.mkdir(SHOTDIR, { recursive: true });
  const tmp = path.join(ROOT, '.capture');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const logFd = fs.openSync(path.join(tmp, 'server.log'), 'a');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'),
    '--root', LIB, '--port', String(PORT), '--no-open', '--scan-interval', '0'],
    { cwd: ROOT, stdio: ['ignore', logFd, logFd], windowsHide: true });

  let browser = null, session = null, bws = null;
  const uuidOf = {};   // 原始文件名 → uuid（收尾时用来恢复名字）

  try {
    const up = await until(async () => (await request('GET', '/api/state')).json?.ready, 30000);
    if (!up) throw new Error('临时服务没起来');
    note('临时服务已就绪');

    // 1) 扫描 + 打标签（用接口做，等价于在界面上点）
    await request('POST', '/api/scan', {});
    let items = (await request('GET', '/api/items?limit=50')).json.items;
    for (const it of items) {
      const orig = sizeToName.get(it.size);
      if (orig) uuidOf[orig] = it.id;
    }
    note(`入库 ${items.length} 个`);

    items = (await request('GET', '/api/items?limit=50')).json.items;
    const plans = [['助眠', '轻语', '直播录屏'], ['美女合集', 'B站', '收藏']];

    // 故意先不打标签，留一张"刚导入、还没分类"的截图：
    // 这时候文件名保持原样、卡片上带「待分类」角标 —— 这是新加的交互，
    // 得在文档截图上看得见，所以下面第一次进界面是在"打标签之前"。

    // 2) 等缩略图抽好（后台并发 2，两个视频大概一两秒）
    for (const it of items) {
      const ok = await until(async () => (await request('GET', `/api/thumb/${it.id}`)).status === 200, 60000, 400);
      note(`缩略图 ${ok ? '已生成' : '没生成'}：${it.id.slice(0, 8)}…`);
    }

    // 3) 开浏览器截图
    const profile = path.join(tmp, 'chrome-profile');
    const chromeFd = fs.openSync(path.join(tmp, 'chrome.log'), 'a');
    browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio',
      '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', chromeFd, chromeFd] });

    const wsUrl = await (async () => {
      const ok = await until(async () => {
        const v = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return Boolean(v && v.webSocketDebuggerUrl);
      }, 25000, 300);
      if (!ok) return null;
      return (await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`)).webSocketDebuggerUrl;
    })();
    if (!wsUrl) throw new Error('Chrome 没起来');

    bws = await connect(wsUrl);
    const target = await bws.send('Target.createTarget', { url: 'about:blank' });
    session = await connect(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const loaded = session.waitFor('Page.loadEventFired', 30000);
    await session.send('Page.navigate', { url: `${BASE}/` });
    await loaded;
    // 服务端记住了这个库，应该直接进主界面
    await until(async () => await evaluate(session, `document.querySelector('#boot').hidden === true`), 25000);
    await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) >= 1, 20000);
    await sleep(1200);   // 等缩略图加载完再截

    // 01a) 刚导入、一个标签都还没打：文件名保持原样 + 卡片上「待分类」角标
    const pendingShot = await evaluate(session, `(() => {
      const cards = [...document.querySelectorAll('#grid .card')];
      return {
        names: cards.map((c) => c.querySelector('.name').textContent),
        badges: [...document.querySelectorAll('#grid .card .badge.pending')].map((b) => b.textContent),
        origLines: document.querySelectorAll('#grid .card .origname').length,
      };
    })()`);
    note(`未打标签状态：${pendingShot.badges.length} 个「待分类」角标，${pendingShot.origLines} 行重复原名`);
    if (pendingShot.badges.length !== pendingShot.names.length) {
      throw new Error(`截图 01a：不是每张卡都带「待分类」角标 → ${JSON.stringify(pendingShot)}`);
    }
    await shot(session, '01-刚导入还没分类（保留原文件名 + 待分类角标）.png');

    // 01b) 文件名里带着标签时会弹确认框（"别人打过的标签我们能认回来"）。
    // 真素材的名字里没有连字符，认不出东西，所以临时借两个名字合规的空壳文件
    // 演一遍这个流程，截完图就连同它们带来的索引一起清掉（下面删 .mtag 重新入库）。
    const castNames = ['旅行-风景.mp4', '助眠-直播录屏-轻语.mp3'];
    for (const n of castNames) await fsp.writeFile(path.join(LIB, n), 'x');
    await request('POST', '/api/scan', {});
    await evaluate(session, `location.reload()`);
    await until(async () => await evaluate(session, `document.querySelector('#suggestDlg').open === true`), 20000, 300);
    await sleep(900);
    const sugInfo = await evaluate(session, `(() => ({
      groups: document.querySelectorAll('#suggestDlg #sugList .suggroup').length,
      tags: [...document.querySelectorAll('#suggestDlg #sugList .tagmini')].map((e) => e.textContent),
    }))()`);
    note(`确认弹窗里的标签组合：${sugInfo.tags.join(' / ')}（${sugInfo.groups} 组）`);
    if (sugInfo.groups < 2) throw new Error(`截图 01b：弹窗没有列出两组候选 → ${JSON.stringify(sugInfo)}`);
    await shot(session, '01b-文件名里认出旧标签（弹窗让用户选）.png');

    // 收拾这两个演员：删掉文件 + 删库，回到"只有两个真视频、刚入库"的状态
    for (const n of castNames) await fsp.rm(path.join(LIB, n), { force: true });
    await fsp.rm(path.join(LIB, '.mtag'), { recursive: true, force: true });
    await request('POST', '/api/scan', {});
    items = (await request('GET', '/api/items?limit=50')).json.items;
    await evaluate(session, `location.reload()`);
    await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) >= 1, 20000);
    await sleep(800);

    // 现在打标签（等价于在界面上点标签编辑器保存），然后刷新看改名后的样子
    for (let i = 0; i < items.length; i += 1) {
      const r = await request('POST', `/api/items/${items[i].id}/tags`, { tags: plans[i % plans.length], mode: 'set' });
      note(`${r.json.item.sizeText.padStart(7)} → ${r.json.item.name}`);
    }
    await evaluate(session, `location.reload()`);
    await until(async () => (await evaluate(session, `document.querySelectorAll('#grid .card').length`)) >= 1, 20000);
    await sleep(1200);
    const origLines = await evaluate(session, `[...document.querySelectorAll('#grid .card .origname')].map((e) => e.textContent)`);
    note(`改名后卡片上的原始文件名：${origLines.join(' | ')}`);
    if (origLines.length < 1) {
      throw new Error('截图 01：改名后卡片上没有显示「入库时的原始文件名」那一行');
    }
    await shot(session, '02-素材列表（按标签浏览，原始文件名可见）.png');

    // 点第一个标签，展示"每个标签下都能看到对应视频"
    await evaluate(session, `(async () => {
      const rows = [...document.querySelectorAll('#tagList .tag-row')];
      const target = rows.find((r) => r.textContent.includes('助眠')) || rows[0];
      target.click();
    })()`);
    await sleep(900);
    await shot(session, '03-按标签筛选.png');

    // 回到全部，打开某个素材的标签编辑器
    await evaluate(session, `document.querySelector('[data-quick="all"]').click()`);
    await sleep(800);
    await evaluate(session, `document.querySelector('#grid .card').click()`);
    await until(async () => await evaluate(session, `document.querySelector('#editor').open === true`), 10000);
    await sleep(1500);
    const editorOrig = await evaluate(session, `(() => {
      const e = document.querySelector('#editorOrig');
      return { hidden: e.hidden, text: e.textContent.trim() };
    })()`);
    note(`编辑器里的原始文件名：${editorOrig.hidden ? '（没显示）' : editorOrig.text}`);
    if (editorOrig.hidden || !editorOrig.text) {
      throw new Error('截图 04：标签编辑器里没有显示原始文件名');
    }
    await shot(session, '04-标签编辑器（重命名预览 + 原始文件名）.png');
    await evaluate(session, `document.querySelector('#editorCancel').click()`);
    await sleep(500);

    // 勾两个素材 → 底部批量条
    // 注意类名是 .check（见 web/app.js 的 el('div','check','✓')）；
    // 这里原来写成 .pick，于是点了个空集合、截图跟第一张一模一样，
    // 而且不报错。所以下面断言"底部真的统计出 2 个"再截。
    await evaluate(session, `(async () => {
      const boxes = [...document.querySelectorAll('#grid .card .check')];
      boxes.slice(0, 2).forEach((c) => c.click());
    })()`);
    const picked = await until(async () => {
      const t = await evaluate(session, `document.querySelector('#selCount').textContent`);
      return String(t).replace(/\s/g, '').includes('2');
    }, 10000);
    if (!picked) throw new Error('截图 05：勾选没有生效（底部选择栏没统计到 2 个）');
    const barVisible = await evaluate(session,
      `getComputedStyle(document.querySelector('#selbar')).display !== 'none'`);
    if (!barVisible) throw new Error('截图 05：底部选择栏不可见');
    await sleep(900);
    await shot(session, '05-多选与批量操作.png');

    // 导出对话框
    await evaluate(session, `document.querySelector('#selExport').click()`);
    await until(async () => await evaluate(session, `document.querySelector('#exportDlg').open === true`), 10000);
    await sleep(700);
    await shot(session, '06-导出（复制到文件夹，准备数据线拷走）.png');

    console.log('\n截图完成，开始收尾（把素材恢复原样）…');
  } catch (e) {
    console.error(`\n截图过程出错：${e.stack || e.message}`);
    process.exitCode = 1;
  } finally {
    try { session && session.close(); } catch { /* 忽略 */ }
    try { bws && bws.close(); } catch { /* 忽略 */ }
    try { browser && browser.kill(); } catch { /* 忽略 */ }
    try { proc.kill(); } catch { /* 忽略 */ }
    await sleep(700);

    // ---- 收尾 1：清掉所有标签（等价于在界面上把标签清空）。
    //      "没打标签就不改名"生效后，清空标签本身就会把名字还原成入库时的相对路径，
    //      所以这一步现在既是清库、也是恢复名字的主力。
    try {
      const items = (await request('GET', '/api/items?limit=50')).json?.items || [];
      for (const it of items) {
        await request('POST', `/api/items/${it.id}/tags`, { tags: [], mode: 'set' });
      }
      note(`已清空 ${items.length} 个素材的标签`);
    } catch { /* 服务可能已经关了，下面直接按磁盘恢复 */ }

    // ---- 收尾 2：按磁盘事实把文件名恢复成你复制进来的原样
    const now = fs.readdirSync(LIB).filter((n) => !n.startsWith('.'));
    let restored = 0;
    for (const [orig, uuid] of Object.entries(uuidOf)) {
      const cur = now.find((n) => n.includes(uuid));
      if (cur && cur !== orig) {
        try { await fsp.rename(path.join(LIB, cur), path.join(LIB, orig)); restored += 1; note(`恢复名字：${orig}`); }
        catch (err) { note(`恢复失败：${orig}（${err.message}）`); }
      }
    }
    if (!restored) note('文件名已经是原始状态');

    // ---- 收尾 3：重置库，这样你第一次打开看到的是"干净首次入库"
    await fsp.rm(path.join(LIB, '.mtag'), { recursive: true, force: true });
    note('已重置库（删掉 .mtag，含缩略图缓存与索引）');

    const final = fs.readdirSync(LIB).filter((n) => !n.startsWith('.'));
    const good = final.length === before.length && before.every((n) => final.includes(n));
    console.log(`\n素材目录：${good ? '✓ 已恢复原样' : '✗ 没有完全恢复'}（${final.join(' | ')}）`);
    if (!good) process.exitCode = 1;
  }
})();
