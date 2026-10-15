/*
 * probe_external.js —— 专门验证一个容易出错的场景：
 * "用户在资源管理器里手动改了文件名，库里的记录会怎么样？"
 *
 * 为什么值得单独验证：这个应用的卖点就是"标签固化进文件名"，
 * 所以用户拿资源管理器、播放器、下载器去动文件名是很自然的事。
 * 如果库里记的名字和磁盘对不上，用户就会看到"点一个不存在的文件"。
 *
 * 用法：node probe_external.js    （用临时库，不动你的素材）
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const LIB = path.join(ROOT, '.probe', 'lib');
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
const section = (t) => console.log(`\n── ${t}`);
const note = (t) => console.log(`   · ${t}`);
function check(desc, ok, extra) {
  if (ok) { passed++; console.log(`   ✓ ${desc}`); }
  else { failed++; failures.push(desc + (extra ? ` —— ${extra}` : '')); console.log(`   ✗ ${desc}${extra ? ` —— ${extra}` : ''}`); }
}
function eq(d, g, w) { check(d, g === w, `期望 ${JSON.stringify(w)}，实际 ${JSON.stringify(g)}`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const c = [];
      res.on('data', x => c.push(x));
      res.on('end', () => {
        const buf = Buffer.concat(c);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  await fsp.rm(path.join(ROOT, '.probe'), { recursive: true, force: true });
  await fsp.mkdir(LIB, { recursive: true });
  // 造三个小文件当素材
  await fsp.writeFile(path.join(LIB, '素材甲.mp4'), Buffer.alloc(3000, 1));
  await fsp.writeFile(path.join(LIB, '素材乙.mp3'), Buffer.alloc(2000, 2));
  await fsp.writeFile(path.join(LIB, '素材丙.png'), Buffer.alloc(1000, 3));

  const errLog = path.join(ROOT, '.probe', 'err.log');
  const fd = fs.openSync(errLog, 'a');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--root', LIB, '--port', String(PORT), '--no-open', '--scan-interval', '0'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', fd], windowsHide: true });

  const up = async () => {
    for (let i = 0; i < 60; i++) {
      try { const r = await request('GET', '/api/state'); if (r.status === 200 && r.json.ready) return true; } catch {}
      await sleep(250);
    }
    return false;
  };

  try {
    check('服务起来了', await up());

    section('1. 首次扫描：还没打标签，所以外部文件保持原文件名');
    const sc = await request('POST', '/api/scan', {});
    eq('扫描成功', sc.status, 200);
    let list = (await request('GET', '/api/items?limit=50')).json;
    eq('库里 3 个素材', list.total, 3);
    for (const it of list.items) note(`${it.name}`);
    check('还没打标签的素材保持原文件名（不改名，方便照着原名想标签）',
      ['素材甲.mp4', '素材乙.mp3', '素材丙.png'].every(n => list.items.some(i => i.name === n)),
      list.items.map(i => i.name).join(' | '));
    check('没打标签时不会出现 uuid（否则会被误认为本工具已经整理过）',
      list.items.every(i => !/[0-9a-f]{32}/i.test(i.name)), list.items.map(i => i.name).join(' | '));
    check('但库里能一眼看出这三个都还没打标签',
      list.items.every(i => i.tags.length === 0 && i.inferred === false), JSON.stringify(list.items.map(i => i.tags)));

    section('2. 打标签后再手动改名（模拟用户在资源管理器里动手）');
    const first = list.items.find(i => i.kind === 'video');
    await request('POST', `/api/items/${first.id}/tags`, { tags: ['手动改名前'], mode: 'set' });
    const onDisk = fs.readdirSync(LIB).filter(n => !n.startsWith('.'));
    note(`磁盘：${onDisk.join(' | ')}`);
    const vid = onDisk.find(n => n.includes(first.id));
    const wrongName = `${first.id}-改乱了.mp4`;   // 名字里还带 uuid，但格式不再规范
    await fsp.rename(path.join(LIB, vid), path.join(LIB, wrongName));
    note(`手动改成：${wrongName}（标签前缀被抹掉）`);
    // 让服务端刷新（模拟下次自动扫描）
    await request('POST', '/api/scan', {});
    list = (await request('GET', '/api/items?limit=50')).json;
    const after = list.items.find(i => i.id === first.id);
    const diskNow = fs.readdirSync(LIB).filter(n => !n.startsWith('.'));
    note(`库里现在记的是：${after.name}`);
    note(`磁盘现在是：${diskNow.filter(n => n.includes(first.id)).join(' | ')}`);
    // 期望的自愈行为：扫描发现名字不合规范，就按库里的标签改回去
    check('扫描后把被改乱的名字恢复成带标签的规范名', after.name === `手动改名前-${first.id}.mp4`, after.name);
    check('磁盘上和库里记录一致', fs.existsSync(path.join(LIB, after.rel)), after.rel);
    check('标签没丢', after.tags.includes('手动改名前'), after.tags.join(','));

    section('3. 手动改成完全认不出来的名字（uuid 也被去掉）');
    const orphan = '随便起的名字.mp4';
    await fsp.rename(path.join(LIB, after.rel), path.join(LIB, orphan));
    note(`手动改成：${orphan}（uuid 也没了，只能靠 大小+修改时间 认领）`);
    await request('POST', '/api/scan', {});
    list = (await request('GET', '/api/items?limit=50')).json;
    eq('库里还是 3 个素材（靠 大小+修改时间 认回来了）', list.total, 3);
    const reclaimed = list.items.find(i => i.id === first.id);
    if (reclaimed) {
      note(`认回来了：id=${reclaimed.id} 名字=${reclaimed.name} 标签=${reclaimed.tags.join(',')}`);
      check('按 大小+修改时间 认回旧记录，标签保住了', reclaimed.tags.includes('手动改名前'), reclaimed.tags.join(','));
      check('认回后重新按规范命名（带标签 + uuid）',
        /^(.*-)?[0-9a-f]{32}\.mp4$/.test(reclaimed.name) && reclaimed.name.includes('手动改名前'), reclaimed.name);
      check('磁盘上和库里记录一致', fs.existsSync(path.join(LIB, reclaimed.rel)), reclaimed.rel);
    } else {
      // 如果没认回来，至少不该出现"库里指着不存在的文件"
      check('没有认回来也算可接受，但不能有一条指向不存在文件的记录',
        list.items.every(i => fs.existsSync(path.join(LIB, i.rel))),
        list.items.map(i => `${i.name}→${i.rel}`).join(' | '));
    }

    section('4. 关键不变量：库里每一条记录都指向磁盘上真实存在的文件');
    const finalList = (await request('GET', '/api/items?limit=50')).json;
    const dangling = finalList.items.filter(i => !fs.existsSync(path.join(LIB, i.rel)));
    check('没有悬空记录', dangling.length === 0, dangling.map(i => i.rel).join(' | '));
    const diskSet = new Set(fs.readdirSync(LIB).filter(n => !n.startsWith('.')));
    const unrecorded = [...diskSet].filter(n => !finalList.items.some(i => i.rel === n));
    check('磁盘上每个素材都在库里有记录', unrecorded.length === 0, unrecorded.join(' | '));

    section('5. 直接删掉文件后再扫描，记录要跟着消失');
    const victim = finalList.items[0];
    await fsp.rm(path.join(LIB, victim.rel));
    note(`删掉：${victim.rel}`);
    await request('POST', '/api/scan', {});
    const afterDel = (await request('GET', '/api/items?limit=50')).json;
    eq('库里剩 2 个素材', afterDel.total, 2);
    check('被删掉的那条记录已经不在了', !afterDel.items.some(i => i.id === victim.id));
  } catch (e) {
    failed++; failures.push(`运行中断：${e.message}`);
    console.log(`\n✗ 运行中断：${e.stack || e.message}`);
  } finally {
    try { proc.kill(); } catch {}
    await sleep(400);
    try { fs.closeSync(fd); } catch {}
    const errText = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '';
    const errs = errText.split(/\r?\n/).filter(l => /\[api\]|TypeError|ReferenceError/.test(l));
    check('服务端没有未处理异常', errs.length === 0, errs.slice(0, 5).join('\n   '));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`   通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) { console.log('\n失败明细：'); for (const f of failures) console.log(`   ✗ ${f}`); process.exitCode = 1; }
  else console.log('   全部通过。');
  console.log(`\n临时库留在 ${path.join(ROOT, '.probe')}（可随时删除）`);
})();
