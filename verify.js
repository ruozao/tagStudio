'use strict';
/**
 * verify.js — tagStudio 自验证。
 *
 * 这是「做完自己验证」里的那个验证：不是跑一遍单元测试就算数，而是
 * 真的建库 → 真的把文件改到磁盘上 → 真的起 HTTP 服务 → 真的导出复制一份，
 * 然后回去检查磁盘上的文件名、zip 结构、Range 响应、崩溃恢复。
 *
 * 跑法：
 *   node verify.js            完整（含 HTTP 服务与视频缩略图）
 *   node verify.js --quick    跳过 HTTP 服务部分
 *
 * 全部产物落在 <项目目录>/.verify/ 下，随时可以删。
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const util = require('./lib/util');
const naming = require('./lib/naming');
const tagmod = require('./lib/tags');
const { Database, rebuildTags } = require('./lib/db');
const { Thumbnails } = require('./lib/thumbnails');
const { Journal } = require('./lib/journal');
const { Library } = require('./lib/library');
const { Exports, ExportJob } = require('./lib/exporter');
const { crc32 } = require('./lib/zipcrc');

const ROOT = __dirname;
const VDIR = path.join(ROOT, '.verify');
const LIB = path.join(VDIR, 'lib');
const DEST = path.join(VDIR, 'dest');
const APP_PORT = 8791;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const QUICK = process.argv.includes('--quick');

// ------------------------------------------------------------------ 微型测试框架

let passed = 0;
const failures = [];
const notes = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  process.stdout.write(`\n── ${name}\n`);
}

function check(desc, cond, detail) {
  if (cond) {
    passed += 1;
    process.stdout.write(`   ✓ ${desc}\n`);
  } else {
    failures.push({ group: currentGroup, desc, detail });
    process.stdout.write(`   ✗ ${desc}${detail ? `  → ${detail}` : ''}\n`);
  }
}

function eq(desc, actual, expected) {
  check(desc, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

function note(text) {
  notes.push(text);
  process.stdout.write(`   · ${text}\n`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

async function freshDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(p, content) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
  return p;
}

/** 列出目录下的文件（相对路径，posix 风格）。默认跳过 .mtag：那是工具的元数据，不是素材。 */
function listDisk(dir, opts = {}) {
  const skipMeta = opts.includeMeta !== true;
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (skipMeta && ent.name === util.META_DIRNAME) continue;
        stack.push(abs);
      } else {
        out.push(path.relative(dir, abs).split(path.sep).join('/'));
      }
    }
  }
  return out.sort();
}

async function makeLibrary(root) {
  await Database.ensureLibraryRoot(root);
  const db = new Database(path.join(root, util.META_DIRNAME));
  await db.load(root);
  const journal = new Journal(path.join(root, util.META_DIRNAME));
  await journal.init();
  const library = new Library({ root, db, journal });
  return { db, journal, library };
}

// ------------------------------------------------------------------ 1. 命名

async function testNaming() {
  group('1. 命名规则（标签1-标签2-uuid.扩展名）');

  // 元数据文件的读写容错。这一条是踩过坑才加的：用 PowerShell / 记事本改过
  // config.json 之后文件会带 UTF-8 BOM，JSON.parse 直接抛错，表现是
  // "配置明明写着上次的库，程序却当没这回事" —— 很难查。
  const jsonDir = await freshDir(path.join(VDIR, 'json'));
  const bomFile = path.join(jsonDir, 'config.json');
  await fsp.writeFile(bomFile, '\ufeff{"port":8787,"lastRoot":"E:\\\\某处"}', 'utf8');
  const withBom = await util.readJson(bomFile, null);
  eq('带 UTF-8 BOM 的 JSON 也能读出来（记事本/PowerShell 写过的文件）', withBom && withBom.port, 8787);
  await fsp.writeFile(bomFile, '{"port":8788}', 'utf8');
  eq('不带 BOM 的 JSON 正常读', (await util.readJson(bomFile, null)).port, 8788);
  await fsp.writeFile(bomFile, '{坏掉的 json', 'utf8');
  eq('坏文件回退到默认值而不是抛异常', await util.readJson(bomFile, 'fallback'), 'fallback');
  eq('文件不存在也回退', await util.readJson(path.join(jsonDir, '没有这个文件.json'), 'fallback'), 'fallback');

  const id = util.hex32();
  const b1 = naming.buildName({ id, originalName: '原视频.MP4', tags: ['美食', '助眠'] });
  eq('两个标签按输入顺序用 - 连接（第一个是主要特点，不按码点重排）', b1.name, `美食-助眠-${id}.MP4`);
  check('扩展名大小写原样保留', b1.name.endsWith('.MP4'), b1.name);
  eq('34 位 uuid 完整保留', naming.parseIdFromName(b1.name), id);
  eq('反解标签一致（顺序也保留）', JSON.stringify(naming.parseTagsFromName(b1.name)), JSON.stringify(['美食', '助眠']));
  const b1b = naming.buildName({ id, originalName: '原视频.MP4', tags: ['助眠', '美食'] });
  eq('调换顺序会得到另一个文件名', b1b.name, `助眠-美食-${id}.MP4`);

  const b2 = naming.buildName({ id, originalName: '2024-08-23 直播录屏.mp3', tags: [] });
  eq('没有标签 → 保持原文件名不动（用户要靠原名判断该打什么标签）', b2.name, '2024-08-23 直播录屏.mp3');
  eq('原名里没有 uuid，所以反解不出东西（未打标签时本来就不需要 uuid）', naming.parseTagsFromName(b2.name), null);
  eq('tagged 标记为 false', b2.tagged, false);
  const b2b = naming.buildName({ id, originalName: '', tags: [] });
  eq('原名是空的极端情况 → 退回 uuid，至少还有个合法名字', b2b.name, id);
  const b2c = naming.buildName({ id, originalName: '子目录/歌.mp3', tags: [] });
  eq('原名带目录时只取文件名本体（目录由 rel 负责）', b2c.name, '歌.mp3');

  // 从"有标签"退回"没标签"：应当回到入库时的原名（transformer 传进来的就是 origName）
  const b2d = naming.buildName({ id, originalName: '旧手机导出的照片.jpg', tags: [] });
  eq('清空标签后回到原名', b2d.name, '旧手机导出的照片.jpg');

  const b3 = naming.buildName({ id, originalName: 'x.webm', tags: ['b', 'A', 'C', 'a'] });
  eq('大小写不同的同一个标签只留第一次，其余顺序不动', b3.name, `b-A-C-${id}.webm`);
  check('文件名不超过 180 字节预算', util.bbytes(b3.name) <= naming.DEFAULT_BUDGET_BYTES, `${util.bbytes(b3.name)} 字节`);

  const many = ['一个中文标签', '第二个中文标签', '第三个中文标签', '第四个中文标签', '第五个', '第六个', '第七个', '第八个', '第九个', '第十个'];
  const b4 = naming.buildName({ id, originalName: 'video.mp4', tags: many });
  check('放不下时从末尾丢次要标签', b4.droppedTags.includes('第十个') && b4.name.startsWith('一个中文标签-'), `留下 ${b4.name} / 丢掉 ${b4.droppedTags.join(',')}`);
  check('丢完之后仍在预算内', util.bbytes(b4.name) <= naming.DEFAULT_BUDGET_BYTES, `${util.bbytes(b4.name)} 字节`);
  check('uuid 与扩展名绝不被裁剪', b4.name.includes(id) && b4.name.endsWith('.mp4'), b4.name);

  const b5 = naming.buildName({ id, originalName: 'v.mp4', tags: ['超级无敌长的标签名字'.repeat(30)] });
  check('只剩一个超长标签时按字节截断而不是砍掉整组', b5.name.includes(id) && b5.name.endsWith('.mp4') && util.bbytes(b5.name) <= naming.DEFAULT_BUDGET_BYTES, `${util.bbytes(b5.name)} 字节`);
  check('截断不产生半个字符（能正常做 UTF-8 往返）', Buffer.from(b5.name, 'utf8').toString('utf8') === b5.name);

  eq('dotfile 没有扩展名', naming.originalExt('.gitignore'), '');
  eq('多段扩展名只取最后一段', naming.originalExt('a.tar.gz'), '.gz');
  eq('没有扩展名', naming.originalExt('noext'), '');
  check('原文件名里的 32 位 hex 会被当成 uuid 认出来', naming.parseIdFromName(`x-${id}.mkv`) === id);
  eq('不像 uuid 的串不认', naming.parseIdFromName('普通名字-abc.mp4'), null);
  eq('不符合本工具格式时不反解标签', naming.parseTagsFromName('随便-一个-名字.mp4'), null);
  eq('未分类反解为空数组', JSON.stringify(naming.parseTagsFromName(`未分类-${id}.jpg`)), '[]');
  eq('「未分类」占位符本身是合法标签字面量但不该被当成标签', JSON.stringify(naming.parseTagsFromName(`旅行-风景-${id}.jpg`)), JSON.stringify(['旅行', '风景']));
}

// ------------------------------------------------------------------ 1b. 遍历目录

async function testWalk() {
  group('1b. 遍历目录：并发 stat 不改变结果、不错过文件');

  // 并发池本身：顺序无关，但必须「真的并发」且不吞异常。
  const t0 = Date.now();
  await util.poolMap(new Array(8).fill(0), 4, async () => { await new Promise((r) => setTimeout(r, 60)); });
  const poolMs = Date.now() - t0;
  check('4 路并发跑 8 个 60ms 任务：应该 ~120ms 而不是串行的 480ms', poolMs < 300, `实测 ${poolMs} ms`);

  let threw = false;
  try { await util.poolMap([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); }); } catch { threw = true; }
  eq('poolMap 不吞异常（walkFiles 是自己按文件 try 的，别的调用方要能看见错）', threw, true);

  // 造一棵有子目录、有中文名、大小各不相同的树，再和「磁盘上实际有什么」逐条比。
  const root = await freshDir(path.join(VDIR, 'walk'));
  const expect = [];
  for (let i = 0; i < 120; i += 1) {
    const rel = i % 3 === 0 ? `f-${i}.mp4` : i % 3 === 1 ? `子目录/g-${i}.jpg` : `子目录/更深一层/h-${i}.txt`;
    expect.push(rel);
    await writeFile(path.join(root, rel), Buffer.alloc(i * 7));
  }
  await writeFile(path.join(root, util.META_DIRNAME, 'db.json'), '{}');   // 元数据目录不该算素材
  await writeFile(path.join(root, '下载中.mp4.part'), 'x');               // 半截文件也不该算
  expect.sort();

  const walked = await util.walkFiles(root);
  eq('文件和磁盘上一样多（.mtag 与半截文件都不算）', walked.length, expect.length);
  eq('相对路径集合一致（posix 风格 + 按 rel 排序）', JSON.stringify(walked.map((f) => f.rel)), JSON.stringify(expect));
  const statsOk = walked.every((f) => {
    const real = fs.statSync(f.abs);
    return f.size === real.size && f.name === path.basename(f.abs) && Math.abs(f.mtimeMs - Math.round(real.mtimeMs)) < 1;
  });
  check('每条的 size / name / mtimeMs 都是真实 stat 结果', statsOk);

  const serial = await util.walkFiles(root, { concurrency: 1 });
  eq('并发度不影响结果（1 路与 64 路完全一致）', JSON.stringify(serial.map((f) => f.rel)), JSON.stringify(walked.map((f) => f.rel)));

  const capped = await util.walkFiles(root, { maxFiles: 10 });
  eq('maxFiles 上限生效（超大目录不会把库吞掉）', capped.length, 10);
  eq('截断时仍然是排好序的前 10 个', JSON.stringify(capped.map((f) => f.rel)), JSON.stringify(expect.slice(0, 10)));
}

// ------------------------------------------------------------------ 2. 标签校验

async function testTags() {
  group('2. 标签校验（会直接变成文件名，所以必须严格）');

  check('允许中文/字母/数字/空格', tagmod.validateTag('助眠 音乐 3').ok);
  check('允许下划线和括号', tagmod.validateTag('素材_(A)[1]').ok);
  check('拒绝破折号（会和标签分隔符冲突）', !tagmod.validateTag('助-眠').ok, tagmod.validateTag('助-眠').reason);
  check('拒绝点号（会破坏扩展名）', !tagmod.validateTag('a.b').ok);
  check('拒绝斜杠与反斜杠', !tagmod.validateTag('a/b').ok && !tagmod.validateTag('a\\b').ok);
  check('拒绝 Windows 保留设备名', !tagmod.validateTag('CON').ok && !tagmod.validateTag('com1').ok);
  check('拒绝超过 40 字符', !tagmod.validateTag('字'.repeat(41)).ok);
  check('恰好 40 字符可以通过', tagmod.validateTag('字'.repeat(40)).ok);
  check('拒绝空标签', !tagmod.validateTag('   ').ok);
  check('拒绝控制字符', !tagmod.validateTag('a\u0007b').ok);
  eq('空白折叠', tagmod.normalizeTag('  助眠   音乐  '), '助眠 音乐');
  eq('逗号切分', JSON.stringify(tagmod.splitTagInput('a, b，c；d')), JSON.stringify(['a', 'b', 'c', 'd']));
  eq('大小写不敏感去重', JSON.stringify(tagmod.validateTags(['Fun', 'fun', 'FUN']).tags), JSON.stringify(['Fun']));
  eq('按顺序去重（留第一次的写法）', JSON.stringify(tagmod.uniqueTags(['b', 'A', 'c', 'a'])), JSON.stringify(['b', 'A', 'c']));
  eq('集合比较用的排序仍然稳定', JSON.stringify(tagmod.sortTags(['b', 'A', 'c'])), JSON.stringify(['A', 'b', 'c']));
}

// ------------------------------------------------------------------ 3. 库：扫描 / 重命名 / 认领

async function testLibraryScanAndRename() {
  group('3. 库：首次扫描、打标签即改名、uuid 认领、唯一性');

  await freshDir(LIB);
  await writeFile(path.join(LIB, 'a 原始视频.mp4'), 'video-A');
  await writeFile(path.join(LIB, '子目录', 'b 音乐.mp3'), 'audio-B');
  await writeFile(path.join(LIB, '子目录', 'c 图片.PNG'), 'image-C');
  await writeFile(path.join(LIB, '垃圾.tmp'), 'should be ignored');
  await writeFile(path.join(LIB, 'desktop.ini'), 'ignored');

  const { db, library } = await makeLibrary(LIB);
  const scan1 = await library.scan({ rename: true, prune: true });

  eq('扫到 3 个媒体文件（.tmp / desktop.ini 被忽略）', scan1.added, 3);
  const disk1 = listDisk(LIB);
  if (disk1.length !== 5) note(`库目录实际内容：${disk1.join(' | ')}`);
  eq('磁盘上是 3 个素材 + 2 个被忽略的垃圾文件', disk1.length, 5);
  check('工具自己的说明文件写在 .mtag/ 里，没有被当成素材收进库（否则会凭空多出一个「未分类-uuid.md」）', !disk1.some((n) => n.toLowerCase().endsWith('.md')), disk1.join(' | '));
  check('desktop.ini 被忽略且没有被动过', disk1.includes('desktop.ini'), disk1.join(' | '));
  check('垃圾文件没有被动过', disk1.includes('垃圾.tmp'), disk1.join(' | '));

  const untaggedNames = disk1.filter((n) => n.endsWith('.mp4') || n.endsWith('.mp3') || n.endsWith('.PNG'));
  eq('三个素材都还在', untaggedNames.length, 3);
  check('未打标签的素材保持原文件名不动（用户要靠原名判断该打什么标签）',
    ['a 原始视频.mp4', 'b 音乐.mp3', 'c 图片.PNG'].every((n) => untaggedNames.some((x) => path.basename(x) === n)),
    untaggedNames.join(' | '));
  check('没打标签时不会被塞进 uuid（也就不会被误当成「本工具已经整理过」的文件）',
    untaggedNames.every((n) => naming.parseIdFromName(n) === null), untaggedNames.join(' | '));
  check('库里能认出这三个还没打标签的素材', db.query({ untagged: true }).total === 3, `未打标签 ${db.query({ untagged: true }).total} 个`);

  // 打标签 → 应当就地改名
  const video = db.items().find((i) => i.kind === 'video');
  const res = await library.applyTags(video.id, { mode: 'set', tags: ['美食', '助眠'] });
  check('applyTags 成功', res.ok, res.reason);
  eq('改名后的文件名（保持输入顺序）', res.item.name, `美食-助眠-${video.id}.mp4`);
  check('磁盘上确实只有这一个 mp4', fs.readdirSync(LIB).filter((n) => n.endsWith('.mp4')).length === 1);
  check('旧名字已经不在磁盘上', !fs.existsSync(path.join(LIB, untaggedNames.find((n) => n.endsWith('.mp4')))));

  // 幂等：同样的标签、同样的顺序再存一次，不应改名
  const again = await library.applyTags(video.id, { mode: 'set', tags: ['美食', '助眠'] });
  eq('顺序没变时不重复改名', again.rename.changed, false);
  const flipped = await library.applyTags(video.id, { mode: 'set', tags: ['助眠', '美食'] });
  eq('只调整顺序也会改名', flipped.item.name, `助眠-美食-${video.id}.mp4`);
  eq('调整顺序算一次改名', flipped.rename.changed, true);

  // 改标签 → 再改名
  const rename2 = await library.applyTags(video.id, { mode: 'set', tags: ['美食', '助眠', '睡前'] });
  eq('加标签后文件名跟着变', rename2.item.name, `美食-助眠-睡前-${video.id}.mp4`);

  // 移除标签
  const rm = await library.applyTags(video.id, { mode: 'remove', remove: ['睡前'] });
  eq('移除标签后文件名回退（剩下的顺序不变）', rm.item.name, `美食-助眠-${video.id}.mp4`);

  // 回归：applyTagsBulk 不传 mode 时，绝不能落到 applyTags 的默认 'set'
  // （set 走 next = tags || []，会把已有标签整批洗白 —— 真踩过：
  //   批量加标签把已打标签的素材标签清了，文件也不再跟着改名）
  const bulky = await library.applyTagsBulk([video.id], { add: ['批量加'] });
  eq('bulk 只给 add 时是「加」而不是「覆盖」', bulky.ok, true);
  eq('原有标签没被洗掉，新标签接在末尾', JSON.stringify(db.get(video.id).tags), JSON.stringify(['美食', '助眠', '批量加']));
  eq('bulk 之后文件名也带上了新标签', db.get(video.id).name, `美食-助眠-批量加-${video.id}.mp4`);
  const bulkyRm = await library.applyTagsBulk([video.id], { remove: ['批量加'] });
  eq('bulk 只给 remove 时是「删」', bulkyRm.ok, true);
  eq('删完回到原样', db.get(video.id).name, `美食-助眠-${video.id}.mp4`);
  const bulkySet = await library.applyTagsBulk([video.id], { mode: 'set', add: [] });
  eq('显式 mode=set 仍是覆盖语义', JSON.stringify(db.get(video.id).tags), JSON.stringify([]));
  await library.applyTags(video.id, { mode: 'set', tags: ['助眠', '美食'] });
  eq('恢复后文件名回到原样', db.get(video.id).name, `助眠-美食-${video.id}.mp4`);
  eq('对应的磁盘文件也在', fs.existsSync(path.join(LIB, db.get(video.id).name)), true);

  // 模拟「用户把文件挪到别的子目录」：靠文件名里的 uuid 认回来
  const movedFrom = path.join(LIB, rm.item.name);
  const movedTo = path.join(LIB, '子目录', rm.item.name);
  await fsp.rename(movedFrom, movedTo);
  const scan2 = await library.scan({ rename: true, prune: true });
  eq('挪动位置后被 uuid 认回（不当作新文件）', scan2.added, 0);
  eq('记录里的相对路径已更新', db.get(video.id).rel, '子目录/' + rm.item.name);

  // 两个同名目标：uuid 全局唯一所以不会撞
  const audio = db.items().find((i) => i.kind === 'audio');
  await library.applyTags(audio.id, { mode: 'set', tags: ['助眠', '美食'] });
  eq('另一格式同标签不会互相覆盖', db.get(audio.id).name, `助眠-美食-${audio.id}.mp3`);
  check('两种格式都还在', fs.readdirSync(path.join(LIB, '子目录')).filter((n) => /\.(mp3|mp4)$/.test(n)).length === 2);

  // 外部塞进来的、名字本来就是本工具格式的文件：标签应被「推断」出来
  const fakeId = util.hex32();
  await writeFile(path.join(LIB, '子目录', `旅行-风景-${fakeId}.jpg`), 'image-D');
  const scan3 = await library.scan({ rename: true, prune: true });
  eq('外来新文件被加入', scan3.added, 1);
  const inferred = db.items().find((i) => i.id === fakeId);
  check('文件名里带了 uuid 就沿用该 uuid', !!inferred);
  eq('标签从文件名推断出来', JSON.stringify(inferred.tags), JSON.stringify(['旅行', '风景']));
  eq('并且标记为 inferred（前端会提示）', inferred.inferred, true);
  eq('不再二次改名', scan3.renamed, 0);

  // 删掉磁盘上的文件 → 记录被剔除
  await fsp.rm(path.join(LIB, '子目录', `旅行-风景-${fakeId}.jpg`));
  const scan4 = await library.scan({ rename: true, prune: true });
  eq('文件消失后记录被剔除', scan4.removed, 1);
  check('库里不再有这个 id', !db.get(fakeId));

  // 什么都没变时不要再重写整个 db.json。
  // 以前每趟扫描都无条件 save()：13.4MB 的库被 45 秒一次的定时扫描反复重写，
  // 而期间所有写操作都排在 exclusive 队列里，表现就是「隔一会儿卡一下」。
  const dbFile = path.join(LIB, util.META_DIRNAME, 'db.json');
  const mtimeBefore = (await fsp.stat(dbFile)).mtimeMs;
  const scanQuiet = await library.scan({ rename: true, prune: true });
  await new Promise((r) => setTimeout(r, 30));           // 给文件系统一点时间，别让 mtime 精度掩盖问题
  const mtimeAfter = (await fsp.stat(dbFile)).mtimeMs;
  eq('没变化的一趟扫描：saved=false（这趟没写盘）', scanQuiet.saved, false);
  eq('没变化的一趟扫描：db.json 的 mtime 一点没动', mtimeAfter, mtimeBefore);
  eq('不写盘也照样报告这趟扫了多少文件', scanQuiet.filesOnDisk > 0, true);
  eq('不写盘时新增/变化/改名仍然是 0', `${scanQuiet.added}/${scanQuiet.changed}/${scanQuiet.renamed}`, '0/0/0');

  // 真有变化时必须写盘（别把上面那条优化做成「永远不存」）—— 用另一个临时库试，免得弄脏 LIB
  const saveRoot = await freshDir(path.join(VDIR, 'lib-save'));
  const saveLib = await makeLibrary(saveRoot);
  const saveFile = path.join(saveRoot, util.META_DIRNAME, 'db.json');
  await writeFile(path.join(saveRoot, 'a.mp4'), 'x');
  const saveFirst = await saveLib.library.scan({ rename: true, prune: true });
  eq('首次扫描认出新文件并写盘', `${saveFirst.added}/${saveFirst.saved}`, '1/true');
  const saveMtime = (await fsp.stat(saveFile)).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  const saveAgain = await saveLib.library.scan({ rename: true, prune: true });
  eq('同一个库再扫一遍：没有变化就不写盘', saveAgain.saved, false);
  eq('db.json 没被重写', (await fsp.stat(saveFile)).mtimeMs, saveMtime);

  // 查询：AND / OR / 未打标签 / 关键词
  eq('按标签查询（AND）', db.query({ tags: ['助眠', '美食'] }).total, 2);
  eq('AND 多一个不存在的标签 → 0', db.query({ tags: ['助眠', '不存在'] }).total, 0);
  eq('OR 查询', db.query({ any: ['助眠', '不存在'] }).total, 2);
  eq('未打标签', db.query({ untagged: true }).total, 1);
  eq('按类型', db.query({ kind: 'image' }).total, 1);
  eq('关键词搜文件名（搜的是还没打标签、保留原名的那个素材）', db.query({ q: 'c 图片' }).total, 1);
  eq('关键词搜标签', db.query({ q: '助眠' }).total, 2);
  eq('标签计数', db.tagList().find((t) => t.name === '助眠').count, 2);

  // 全局改标签名（连带改名）
  const global = await library.renameTagGlobal('睡前', '入睡');
  check('dryRun 不落盘', (await library.renameTagGlobal('助眠', '睡眠', { dryRun: true })).dryRun === true);
  check('改名不存在的标签时 affected=0', global.ok && global.affected === 0);
  const renameTag = await library.renameTagGlobal('美食', '吃播');
  eq('全局改标签影响 2 个素材', renameTag.affected, 2);
  eq('其中 2 个都实际改了文件名', renameTag.renamed, 2);
  eq('改名无失败', renameTag.failures.length, 0);
  check('文件名已同步', fs.existsSync(path.join(LIB, '子目录', `助眠-吃播-${video.id}.mp4`)), listDisk(LIB).join(' | '));

  // 合集
  const col = db.setCollections([{ name: '助眠素材', tags: ['助眠', '吃播'] }]);
  check('合集保存成功', col.ok);
  eq('合集读回一致', JSON.stringify(db.collections()), JSON.stringify([{ name: '助眠素材', tags: ['助眠', '吃播'] }]));
  await db.save();
}

// ------------------------------------------------------------------ 4. 崩溃恢复

async function testJournalRecovery() {
  group('4. 崩溃恢复：文件改了但库没落盘 / 库没改 / 文件丢了');

  const dir = await freshDir(path.join(VDIR, 'crash'));
  await writeFile(path.join(dir, 'x.mp4'), 'video-X');
  const { db, journal, library } = await makeLibrary(dir);
  await library.scan({ rename: false, prune: false });
  const item = db.items()[0];

  // 场景 A：文件已改名，但数据库没来得及保存（最危险的情况）
  const target = `未分类-${item.id}.mp4`;
  const rec = await journal.begin({ kind: 'rename', itemId: item.id, from: path.join(dir, item.name), to: path.join(dir, target), tags: [] });
  await fsp.rename(path.join(dir, item.name), path.join(dir, target));
  // 故意不调用 db.save()，模拟此刻进程被杀
  const db2 = new Database(path.join(dir, util.META_DIRNAME));
  await db2.load(dir);
  const journal2 = new Journal(path.join(dir, util.META_DIRNAME));
  await journal2.init();
  const lib2 = new Library({ root: dir, db: db2, journal: journal2 });
  const rec1 = await lib2.recover();
  eq('日志被识别为「已经改完，只是没记账」', rec1.rolledBack.length, 1);
  check('恢复后库里记录指向真实存在的文件', fs.existsSync(db2.absOf(db2.get(item.id))), db2.get(item.id).rel);
  check('崩溃恢复后日志目录已清空', (await journal2.pending()).length === 0);

  // 场景 B：日志写了，但 rename 根本没执行
  const dirB = await freshDir(path.join(VDIR, 'crash-b'));
  await writeFile(path.join(dirB, 'y.mp4'), 'video-Y');
  const B = await makeLibrary(dirB);
  await B.library.scan({ rename: false, prune: false });
  const itemB = B.db.items()[0];
  await B.journal.begin({ kind: 'rename', itemId: itemB.id, from: path.join(dirB, itemB.name), to: path.join(dirB, `未分类-${itemB.id}.mp4`), tags: [] });
  const recB = await B.library.recover();
  eq('日志被识别为「还没改，重放」', recB.replayed.length, 1);
  eq('重放后文件确实改名了', B.db.get(itemB.id).name, `未分类-${itemB.id}.mp4`);
  check('重放后磁盘一致', fs.existsSync(path.join(dirB, `未分类-${itemB.id}.mp4`)));

  // 场景 C：文件被人删了
  const dirC = await freshDir(path.join(VDIR, 'crash-c'));
  await writeFile(path.join(dirC, 'z.mp4'), 'video-Z');
  const C = await makeLibrary(dirC);
  await C.library.scan({ rename: false, prune: false });
  const itemC = C.db.items()[0];
  await C.journal.begin({ kind: 'rename', itemId: itemC.id, from: path.join(dirC, itemC.name), to: path.join(dirC, `未分类-${itemC.id}.mp4`), tags: [] });
  await fsp.rm(path.join(dirC, itemC.name));
  const recC = await C.library.recover();
  eq('两个名字都不在磁盘上 → 报 lost', recC.lost.length, 1);
  check('lost 不伪造记录', !fs.existsSync(path.join(dirC, `未分类-${itemC.id}.mp4`)));

  note('db.json 用「临时文件 + rename」原子写；坏掉时必须拒绝打开，绝不能当新建库覆盖');
  const broken = path.join(dirC, util.META_DIRNAME, 'db.json');
  await fsp.writeFile(broken, '{ 这不是 JSON');
  const dbBroken = new Database(path.join(dirC, util.META_DIRNAME));
  let corruptErr = null;
  try {
    await dbBroken.load(dirC);
  } catch (e) {
    corruptErr = e;
  }
  check('db.json 坏掉时 load() 抛 DB_CORRUPT（而不是静默退回空库）',
    corruptErr && corruptErr.code === 'DB_CORRUPT', corruptErr ? corruptErr.stack : '没有抛错');
  check('坏文件被挪到一边留底（原文件已不在原位）', !fs.existsSync(broken));
  const rescued = fs.readdirSync(path.join(dirC, util.META_DIRNAME))
    .filter(n => n.includes('损坏'));
  eq('留底文件确实存在', rescued.length, 1);
  check('留底文件里还是那份坏内容（没有被清掉）',
    fs.readFileSync(path.join(dirC, util.META_DIRNAME, rescued[0]), 'utf8').startsWith('{ 这不是 JSON'),
    rescued[0]);
  // 关键回归：绝不能因为读不动就把空库写回去
  const stillBroken = fs.existsSync(broken) ? fs.readFileSync(broken, 'utf8') : null;
  check('原 db.json 没有被空库覆盖（没被写回一个空库）',
    stillBroken === null || stillBroken.startsWith('{ 这不是 JSON'),
    String(stillBroken).slice(0, 80));
}

// ------------------------------------------------------------------ 5. 导出

function parseFirstZipEntry(buf) {
  let off = 0;
  const entries = [];
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const compSize = buf.readUInt32LE(off + 18);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    entries.push({ name, method, crc, compSize, uncompSize, data });
    off = dataStart + compSize;
  }
  return entries;
}

async function testExport() {
  group('5. 导出：复制到别的文件夹 + 清单 + zip');

  await freshDir(DEST);
  const db = await (async () => {
    const d = new Database(path.join(LIB, util.META_DIRNAME));
    await d.load(LIB);
    return d;
  })();
  const exports1 = new Exports({ metaRoot: path.join(LIB, util.META_DIRNAME), rootOf: () => LIB, dbOf: () => db });
  await exports1.init();

  const items = db.items();
  check('库里有素材可导出', items.length >= 3, `实际 ${items.length}`);

  const job = exports1.start({ items, destRoot: DEST, subdir: '给手机', nameMode: 'tagged', makeZip: true });
  const snap = await new Promise((resolve) => {
    job.on('end', (s) => resolve(s));
    setTimeout(() => resolve(job.snapshot()), 30000);
  });

  eq('导出状态为完成', snap.status, 'done');
  eq('复制的文件数与选中数一致', snap.copied, items.length);
  eq('没有失败', snap.failed.length, 0);
  check('目标子目录已创建', fs.existsSync(path.join(DEST, '给手机')), snap.destDir);

  const destNames = listDisk(path.join(DEST, '给手机'));
  const mediaNames = destNames.filter((n) => !n.includes('manifest') && !n.endsWith('.zip'));
  eq('目标目录里的媒体文件数', mediaNames.length, items.length);
  // 打了标签的素材：名字就是「标签-uuid.扩展名」；没打标签的保持原名
  const taggedItems = items.filter((i) => (i.tags || []).length);
  const untaggedItems = items.filter((i) => !(i.tags || []).length);
  const expectedTaggedName = (i) => naming.buildName({ id: i.id, originalName: i.name, tags: i.tags }).name;
  check('打了标签的素材，导出名就是「标签-uuid.扩展名」',
    taggedItems.length > 0 && taggedItems.every((i) => mediaNames.some((n) => path.basename(n) === expectedTaggedName(i))),
    taggedItems.map(expectedTaggedName).join(' | '));
  check('没打标签的素材，导出时保持原文件名（不会莫名其妙变成一串 uuid）',
    untaggedItems.every((i) => mediaNames.some((n) => path.basename(n) === path.basename(i.origName || i.name))),
    untaggedItems.map((i) => i.origName || i.name).join(' | '));
  check('清单 CSV 存在', destNames.includes('manifest.csv'));
  check('清单 JSON 存在', destNames.includes('manifest.json'));
  check('zip 存在', destNames.some((n) => n.endsWith('.zip')));

  // 字节级比对：导出必须是复制而不是重编码
  const one = items.find((i) => i.kind === 'video');
  const srcBytes = await fsp.readFile(path.join(LIB, util.fromPosix(one.rel)));
  const dstBytes = await fsp.readFile(path.join(DEST, '给手机', one.name));
  check('复制前后字节完全一致（没有损坏/截断）', srcBytes.equals(dstBytes), `${srcBytes.length} vs ${dstBytes.length}`);
  check('源文件还在（导出是复制不是移动）', fs.existsSync(path.join(LIB, util.fromPosix(one.rel))));

  const csv = await fsp.readFile(path.join(DEST, '给手机', 'manifest.csv'), 'utf8');
  check('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csv.startsWith('\ufeff'));
  check('CSV 行数 = 素材数 + 表头', csv.trim().split(/\r?\n/).length === items.length + 1, `${csv.trim().split(/\r?\n/).length} 行`);
  check('CSV 里能看到中文标签', csv.includes('助眠'), csv.split(/\r?\n/)[1]);

  const zipPath = path.join(DEST, '给手机', destNames.find((n) => n.endsWith('.zip')));
  const zipBuf = await fsp.readFile(zipPath);
  const entries = parseFirstZipEntry(zipBuf);
  eq('zip 里的条目数', entries.length, items.length);
  check('zip 条目名是 UTF-8（带 0x0800 标志，中文不乱码）', entries.some((e) => /[\u4e00-\u9fa5]/.test(e.name)), entries.map((e) => e.name).join(' | '));

  // 逐个条目做「解压后与源文件字节一致」的往返校验：这才是 zip 写对了的证据
  const byName = new Map(entries.map((e) => [e.name, e]));
  let roundTripped = 0;
  for (const item of items) {
    const e = byName.get(item.name);
    if (!e) continue;
    const raw = e.method === 8 ? zlib.inflateRawSync(e.data) : e.data;
    if (raw.length !== item.size) continue;
    if ((crc32(raw) >>> 0) !== (e.crc >>> 0)) continue;
    if (!raw.equals(await fsp.readFile(path.join(LIB, util.fromPosix(item.rel))))) continue;
    roundTripped += 1;
  }
  eq('每个 zip 条目解压后都与库里的源文件字节一致', roundTripped, items.length);
  const firstEntry = entries[0];
  eq('zip 条目里写的 CRC32 与自算值一致', crc32(firstEntry.method === 8 ? zlib.inflateRawSync(firstEntry.data) : firstEntry.data) >>> 0, firstEntry.crc >>> 0);
  note(`zip 体积 ${util.humanBytes(zipBuf.length)}（媒体文件本来就是压缩过的，deflate 省不了多少）`);

  // 原始文件名模式：要用「入库时的原名」，而不是库内被改过的「标签-uuid」名
  await freshDir(path.join(VDIR, 'dest2'));
  const job2 = exports1.start({ items, destRoot: path.join(VDIR, 'dest2'), subdir: null, nameMode: 'original', makeZip: false });
  const snap2 = await new Promise((resolve) => { job2.on('end', resolve); setTimeout(() => resolve(job2.snapshot()), 30000); });
  eq('原始文件名模式也成功', snap2.status, 'done');
  const d2 = listDisk(snap2.destDir).filter((n) => !n.includes('manifest'));
  eq('原始文件名模式下导出的文件数不变', d2.length, items.length);
  const expectedOrig = items.map((i) => i.origName).sort();
  check('导出的就是入库时的原始文件名（含子目录、空格与中文）', JSON.stringify(d2.slice().sort()) === JSON.stringify(expectedOrig), `实际 ${d2.join(' | ')} / 期望 ${expectedOrig.join(' | ')}`);
  check('原始文件名模式用的是入库时的原名，而不是库内的标签-uuid 名', d2.includes('子目录/b 音乐.mp3'), d2.join(' | '));
  check('原始文件名模式下不出现 uuid 命名', d2.every((n) => !/[0-9a-f]{32}/.test(path.basename(n))), d2.join(' | '));

  // tagged-fresh：每次导出换新 uuid（把不同设备的文件倒进同一个文件夹时用）
  await freshDir(path.join(VDIR, 'dest-fresh'));
  const jobF = exports1.start({ items: items.slice(0, 1), destRoot: path.join(VDIR, 'dest-fresh'), subdir: 'x', nameMode: 'tagged-fresh', makeZip: false });
  const snapF = await new Promise((resolve) => { jobF.on('end', resolve); setTimeout(() => resolve(jobF.snapshot()), 30000); });
  eq('tagged-fresh 模式成功', snapF.status, 'done');
  const freshName = listDisk(snapF.destDir).filter((n) => !n.includes('manifest'))[0];
  note(`tagged-fresh 输出：${freshName}`);
  check('tagged-fresh 输出的 uuid 与库里的 uuid 不同', naming.parseIdFromName(freshName) !== items[0].id, `${naming.parseIdFromName(freshName)} vs ${items[0].id}`);

  const job3 = exports1.start({ items: items.slice(0, 1), destRoot: path.join(VDIR, 'dest3'), subdir: '取消测试', nameMode: 'tagged', makeZip: false });
  job3.cancel();
  const snap3 = await new Promise((resolve) => { job3.on('end', resolve); setTimeout(() => resolve(job3.snapshot()), 30000); });
  check('取消导出不会报错', snap3.status === 'done' || snap3.status === 'cancelled', snap3.status);

  // 往同一个目标目录导出两次：不能互相覆盖，第二次要自动加后缀
  const destA = await freshDir(path.join(VDIR, 'dest-same'));
  const job4 = exports1.start({ items: items.slice(0, 2), destRoot: destA, subdir: 'A', nameMode: 'tagged', makeZip: false });
  const snap4 = await new Promise((resolve) => { job4.on('end', resolve); setTimeout(() => resolve(job4.snapshot()), 30000); });
  const after1 = listDisk(snap4.destDir).filter((n) => !n.includes('manifest'));
  eq('第一次导出 2 个文件', after1.length, 2);
  const job5 = exports1.start({ items: items.slice(0, 2), destRoot: destA, subdir: 'A', nameMode: 'tagged', makeZip: false });
  const snap5 = await new Promise((resolve) => { job5.on('end', resolve); setTimeout(() => resolve(job5.snapshot()), 30000); });
  const after2 = listDisk(snap5.destDir).filter((n) => !n.includes('manifest'));
  eq('第二次导出后同名文件共 4 个（没有覆盖）', after2.length, 4);
  check('第二次导出给文件名加了 (2) 后缀', after2.some((n) => /\(2\)/.test(n)), after2.join(' | '));
  check('第一次导出的文件仍在', after1.every((n) => after2.includes(n)));
  // 同名但内容不同时必须去重，所以两两 hash 应当互不相同或至少文件都完整存在
  const sizes = after2.map((n) => fs.statSync(path.join(snap5.destDir, n)).size);
  eq('四个文件都非空', sizes.filter((s) => s > 0).length, 4);
}

// ------------------------------------------------------------------ 6. HTTP 服务

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGet(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* 不是 JSON */ }
  const out = { status: res.status, headers: res.headers, buf, json };
  // text 用 getter 惰性转换：下载 zip 之类的二进制时，无条件转字符串会白白烧内存，
  // 甚至可能撞上 ERR_STRING_TOO_LONG 把整个验证脚本干掉。
  Object.defineProperty(out, 'text', {
    get() { return buf.length <= 4 * 1024 * 1024 ? buf.toString('utf8') : `<${buf.length} 字节二进制>`; },
    enumerable: true,
  });
  return out;
}

async function testServer() {
  group('6. HTTP 服务：静态页 / API / Range / 端到端打标签 / 端到端导出');

  const serverLib = await freshDir(path.join(VDIR, 'server-lib'));
  await writeFile(path.join(serverLib, '片头.mp4'), Buffer.alloc(4096, 7));
  await writeFile(path.join(serverLib, '歌.mp3'), Buffer.alloc(2048, 3));
  const destRoot = await freshDir(path.join(VDIR, 'server-dest'));

  const logPath = path.join(VDIR, 'server.log');
  const child = spawn(process.execPath, ['server.js', '--root', serverLib, '--port', String(APP_PORT), '--no-open', '--scan-interval', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });
  let childError = null;
  child.on('error', (err) => { childError = err; });

  let up = false;
  for (let i = 0; i < 60; i += 1) {
    if (childError) break;
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) {
    check('服务在 15 秒内启动', false, childError ? childError.message : '超时');
    try { child.kill(); } catch { /* 忽略 */ }
    return;
  }
  check('服务在 15 秒内启动并响应 /api/state', true);

  try {
    const st = await (await fetch(`${BASE}/api/state`)).json();
    check('启动参数指定的库已挂载', st.ready === true && path.resolve(st.root) === path.resolve(serverLib), `${st.root}`);
    eq('首扫把两个素材整理成未分类名', st.stats.total, 2);
    check('ffmpeg 探测结果被报出来', st.ffmpeg !== undefined);
    note(`ffmpeg: ${st.ffmpeg ? st.ffmpeg : '未找到（视频缩略图会退化成占位图标，不影响打标签与导出）'}`);

    // 顶栏那个「快速切换到用过的文件夹」下拉框靠 recentRoots：最新打开的排最前，重启也还在
    check('状态里带上了「用过的素材文件夹」列表',
      Array.isArray(st.recentRoots) && st.recentRoots.some((p) => path.resolve(p) === path.resolve(serverLib)),
      JSON.stringify(st.recentRoots));
    const lib2 = path.join(VDIR, 'http-lib2');
    await fsp.mkdir(lib2, { recursive: true });
    const postJson = async (p, body) => (await fetch(`${BASE}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const boot2 = await postJson('/api/library/boot', { root: lib2 });
    check('能切到另一个素材文件夹', boot2.ok === true, boot2.error);
    const st2 = await (await fetch(`${BASE}/api/state`)).json();
    eq('刚打开的文件夹排在历史最前面', path.resolve(st2.recentRoots[0]), path.resolve(lib2));
    check('上一个文件夹还留在历史里（可以一键跳回去）',
      st2.recentRoots.some((p) => path.resolve(p) === path.resolve(serverLib)), JSON.stringify(st2.recentRoots));
    eq('同一个文件夹不会在历史里出现两次',
      new Set(st2.recentRoots.map((p) => path.resolve(p))).size, st2.recentRoots.length);
    const bootBack = await postJson('/api/library/boot', { root: serverLib });
    check('能切回原来的库（后面的断言都基于它）', bootBack.ok === true, bootBack.error);

    // 打开库不再等扫描：boot 立刻返回（scan:null + scanning:true），磁盘核对挂到后台。
    // 这条就是「F:\video 那种上万条的库一打开就卡一下」的修法，契约必须钉住。
    const lib3 = path.join(VDIR, 'http-lib3');
    await fsp.mkdir(lib3, { recursive: true });
    for (const n of ['a.mp4', 'b.jpg', 'c.mp3']) await writeFile(path.join(lib3, n), 'x');
    const tBoot = Date.now();
    const boot3 = await postJson('/api/library/boot', { root: lib3 });
    const bootMs = Date.now() - tBoot;
    eq('能打开第三个库', boot3.ok, true);
    eq('boot 的 scan 字段是 null —— 扫描没挡在打开这条路上', boot3.scan, null);
    eq('并且明确告诉前端「正在后台核对」', boot3.scanning, true);
    check('打开这一步没等扫描（个位数毫秒；阈值给到 2000ms 只防回归）', bootMs < 2000, `${bootMs} ms`);
    note(`打开库耗时 ${bootMs} ms（扫描在后台跑）`);
    const stMount = await (await fetch(`${BASE}/api/state`)).json();
    eq('挂载本身已经完成了（mounting 归位）', stMount.mounting, null);
    check('scanning 是个布尔（后台跑多快都不影响挂载结果）', typeof stMount.scanning === 'boolean');

    let stScan = stMount;
    for (let i = 0; i < 100 && stScan.scanning; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      stScan = await (await fetch(`${BASE}/api/state`)).json();
    }
    eq('后台核对自己跑完了（不用谁去催）', stScan.scanning, false);
    eq('核对结果写进了 lastScan（新增 3 个）', stScan.lastScan && stScan.lastScan.added, 3);
    eq('后台核对全程没有报错', stScan.lastScanError, null);
    eq('核对完列表里就是 3 个素材', (await (await fetch(`${BASE}/api/items`)).json()).items.length, 3);

    // 手动「重新扫描」仍然是同步的：用户点完要立刻看到结果，不能变成「点了没反应」
    const manual = await postJson('/api/scan', {});
    eq('手动扫描是同步返回的', manual.ok, true);
    eq('再扫一遍没变化：这趟没写 db.json', manual.saved, false);

    const bootBack2 = await postJson('/api/library/boot', { root: serverLib });
    check('再切回原来的库（后面的断言都基于它）', bootBack2.ok === true, bootBack2.error);
    for (let i = 0; i < 100; i += 1) {                   // 等后台核对收尾，别让后面的断言踩在扫描中间
      const s = await (await fetch(`${BASE}/api/state`)).json();
      if (!s.scanning) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const css = await httpGet('/styles.css');
    eq('静态样式表可访问', css.status, 200);
    check('样式表 Content-Type 正确', /text\/css/.test(css.headers.get('content-type') || ''), css.headers.get('content-type'));
    check('样式表不含笔误 #1d3career', !css.buf.toString('utf8').includes('1d3career'));
    const js = await httpGet('/app.js');
    eq('前端脚本可访问', js.status, 200);
    const idx = await httpGet('/');
    eq('首页可访问', idx.status, 200);

    const list = await (await fetch(`${BASE}/api/items`)).json();
    eq('列表接口返回 2 个素材', list.items.length, 2);
    check('每项都带了缩略图/播放/下载地址', list.items.every((i) => i.thumbUrl && i.url && i.downloadUrl && i.sizeText && i.kindLabel));
    // 界面三处（卡片 / 标签编辑器 / 批量面板）都要靠这两个字段把"这原本是哪个文件"显示出来
    check('每项都带了入库时的原始文件名 origName',
      list.items.every((i) => typeof i.origName === 'string' && i.origName.length > 0), JSON.stringify(list.items.map((i) => i.origName)));
    check('每项都带了 untagged 标记（界面据此显示「待分类」）',
      list.items.every((i) => typeof i.untagged === 'boolean'), JSON.stringify(list.items.map((i) => i.untagged)));

    const vid = list.items.find((i) => i.kind === 'video');
    eq('还没打标签时 origName 就是当前文件名', vid.origName, vid.name);
    eq('还没打标签时 untagged 为 true', vid.untagged, true);

    // 端到端打标签：HTTP → 磁盘文件名
    const tagged = await (await fetch(`${BASE}/api/items/${vid.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set', tags: ['片头', '开场'] }),
    })).json();
    check('打标签接口返回成功', tagged.ok === true, tagged.error);
    eq('磁盘上的文件名已随之改变', tagged.item.name, `片头-开场-${vid.id}.mp4`);
    check('磁盘上确实有这个文件', fs.existsSync(path.join(serverLib, tagged.item.name)));

    // 改名之后，原始文件名必须还能查到 —— 这是用户"认得出哪个是哪个"的唯一线索
    eq('改名后 origName 仍然是入库时的原名', tagged.item.origName, '片头.mp4');
    eq('改名后 untagged 变成 false', tagged.item.untagged, false);
    const byOrig = await (await fetch(`${BASE}/api/items?q=${encodeURIComponent('片头')}`)).json();
    check('按原始文件名搜索能搜到（即使它已经被改名成 标签-uuid.mp4）',
      byOrig.items.some((i) => i.id === vid.id), JSON.stringify(byOrig.items.map((i) => i.name)));
    const byOrig2 = await (await fetch(`${BASE}/api/items?q=${encodeURIComponent('片头.mp4')}`)).json();
    eq('搜完整的原始文件名也命中', byOrig2.items.length, 1);

    const bad = await fetch(`${BASE}/api/items/${vid.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'set', tags: ['带-破折号'] }),
    });
    eq('非法标签被拒绝（400）', bad.status, 400);
    const badJson = await bad.json();
    check('错误信息可读', /破折号|分隔符|-/.test(badJson.error || ''), badJson.error);

    const preview = await (await fetch(`${BASE}/api/items/${vid.id}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ['开场', '片头', '尾声'] }),
    })).json();
    check('预览接口按传入顺序给文件名', preview.preview.file.startsWith('开场-片头-尾声-'), preview.preview.file);

    const tagsRes = await (await fetch(`${BASE}/api/tags`)).json();
    eq('标签列表里有 2 个标签', tagsRes.tags.length, 2);

    // Range：<video> 的 seek 靠它
    const full = await httpGet(`/api/media/${vid.id}`);
    eq('媒体流 200', full.status, 200);
    eq('Accept-Ranges 已声明', full.headers.get('accept-ranges'), 'bytes');
    eq('整文件长度正确', full.buf.length, 4096);
    const part = await httpGet(`/api/media/${vid.id}`, { headers: { Range: 'bytes=100-199' } });
    eq('Range 请求返回 206', part.status, 206);
    eq('Content-Range 正确', part.headers.get('content-range'), 'bytes 100-199/4096');
    eq('分片长度 100', part.buf.length, 100);
    check('分片内容与整文件一致', part.buf.equals(full.buf.slice(100, 200)));
    const suffix = await httpGet(`/api/media/${vid.id}`, { headers: { Range: 'bytes=-64' } });
    eq('后缀范围返回最后 64 字节', suffix.buf.length, 64);
    check('后缀范围内容正确', suffix.buf.equals(full.buf.slice(4096 - 64)));
    const badRange = await httpGet(`/api/media/${vid.id}`, { headers: { Range: 'bytes=99999-100000' } });
    eq('越界范围返回 416', badRange.status, 416);
    const head = await fetch(`${BASE}/api/media/${vid.id}`, { method: 'HEAD' });
    eq('HEAD 返回 200 且没有响应体', head.status, 200);

    const dl = await httpGet(`/api/media/${vid.id}?dl=1`);
    check('下载模式带 Content-Disposition（含 UTF-8 文件名）', /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));

    // 缩略图：有 ffmpeg 且文件真是视频 → 200 出图；否则应是 404（"没有缩略图"）而不是 500。
    // 这里的假视频是 4096 字节的填充数据，就算有 ffmpeg 也抽不出帧，所以两种都算通过。
    const thumb = await httpGet(`/api/thumb/${vid.id}`);
    check('缩略图接口不报 500', thumb.status !== 500, `${thumb.status} · ${thumb.buf.toString('utf8').slice(0, 120)}`);
    check('缩略图要么出图要么明确说没有', thumb.status === 200 || thumb.status === 404, String(thumb.status));
    if (thumb.status === 200) {
      eq('缩略图是 JPEG', thumb.buf.slice(0, 2).toString('hex'), 'ffd8');
      note(`ffmpeg 抽帧成功，缩略图 ${thumb.buf.length} 字节`);
    } else {
      note(`缩略图接口返回 404（${thumb.buf.toString('utf8').slice(0, 60)}），前端会显示占位图标`);
    }

    // 导出体检
    const review = await (await fetch(`${BASE}/api/export/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: list.items.map((i) => i.id) }),
    })).json();
    eq('体检数量正确', review.count, 2);
    eq('体检发现 0 个缺失源文件', review.missing.length, 0);

    // 端到端导出（走 HTTP，含 SSE 进度）
    const started = await (await fetch(`${BASE}/api/export/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: list.items.map((i) => i.id), destRoot, subdir: '天端到端', nameMode: 'tagged', makeZip: true }),
    })).json();
    check('导出任务已创建', started.ok === true && !!started.job.id);
    const jobId = started.job.id;

    let final = started.job;
    for (let i = 0; i < 120; i += 1) {
      const j = await (await fetch(`${BASE}/api/export/${jobId}`)).json();
      final = j.job;
      if (['done', 'error', 'cancelled'].includes(final.status)) break;
      await sleep(250);
    }
    eq('导出任务完成', final.status, 'done');
    eq('复制了 2 个文件', final.copied, 2);
    check('导出的文件真的在目标目录里', fs.existsSync(path.join(final.destDir, `片头-开场-${vid.id}.mp4`)), listDisk(final.destDir).join(' | '));

    const csv = await httpGet(`/api/export/${jobId}/manifest.csv`);
    eq('清单可通过 HTTP 下载', csv.status, 200);
    check('下载的清单带 BOM', csv.buf.slice(0, 3).toString('hex').toLowerCase() === 'efbbbf');
    check('清单附件名做了 UTF-8 编码', /filename\*=UTF-8''/.test(csv.headers.get('content-disposition') || ''));

    const zip = await httpGet(`/api/export/${jobId}/zip`);
    eq('zip 可通过 HTTP 下载', zip.status, 200);
    eq('zip 的魔数正确', zip.buf.readUInt32LE(0), 0x04034b50);

    // 导出时写了两份清单，两份都得能下载下来（否则目标目录里有文件、界面里却点不到）
    const mj = await httpGet(`/api/export/${jobId}/manifest.json`);
    eq('manifest.json 可通过 HTTP 下载', mj.status, 200);
    check('manifest.json 是合法 JSON 且条目数与导出数一致',
      mj.json && (mj.json.files || mj.json.items || []).length === 2, mj.text.slice(0, 160));
    check('任务快照里给了 manifest.json 下载链接', /manifest\.json$/.test(final.manifestJsonUrl || ''), String(final.manifestJsonUrl));

    const idem = await (await fetch(`${BASE}/api/export/${jobId}`, { method: 'POST' })).status;
    check('对不存在的导出任务/错误方法有合理响应', idem >= 400, String(idem));

    const notFound = await httpGet('/api/不存在');
    eq('未知接口返回 404', notFound.status, 404);

    const traverse = await httpGet('/../server.js');
    check('目录穿越被挡住', traverse.status === 403 || traverse.status === 404, String(traverse.status));

    // 重新扫描：人为加一个文件
    await writeFile(path.join(serverLib, '新来的.MP4'), Buffer.alloc(128, 1));
    const scanRes = await (await fetch(`${BASE}/api/scan`, { method: 'POST' })).json();
    eq('重新扫描发现新增', scanRes.added, 1);
    const after = await (await fetch(`${BASE}/api/items`)).json();
    eq('列表里有 3 个素材', after.items.length, 3);
    check('新加进来的素材没打标签，所以保持原文件名', after.items.some((i) => i.name === '新来的.MP4' && (i.tags || []).length === 0));

    // 全局改标签：走 HTTP
    const renamed = await (await fetch(`${BASE}/api/tags/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '开场', to: '序章' }),
    })).json();
    check('全局改标签成功', renamed.ok === true, renamed.reason);
    check('磁盘文件名已同步（被改的标签留在原位置）', fs.existsSync(path.join(serverLib, `片头-序章-${vid.id}.mp4`)), listDisk(serverLib).join(' | '));

    const uniq = new Set(listDisk(serverLib).filter((n) => /[0-9a-f]{32}/.test(n)).map((n) => naming.parseIdFromName(n)));
    eq('目录里每个文件都有互不相同的 uuid', uniq.size, listDisk(serverLib).filter((n) => /[0-9a-f]{32}/.test(n)).length);

    // ---- 回归：跨站请求防护
    const evil = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    eq('跨站 Origin 的写请求被拒（403）', evil.status, 403);
    const same = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { Origin: BASE } });
    eq('同源 Origin 的写请求照常放行', same.status, 200);
    const rebind = await new Promise((resolve) => {
      const r = require('http').request({ host: '127.0.0.1', port: APP_PORT, path: '/api/state', headers: { Host: `evil.example:${APP_PORT}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', () => resolve(-1));
      r.end();
    });
    eq('Host 不是本机名（DNS 重绑定）时拒绝（403）', rebind, 403);

    // ---- 回归：没写 mode、也没给 tags 的请求不能把标签清空
    const before = (await (await fetch(`${BASE}/api/items/${vid.id}`)).json()).item;
    const noTags = await fetch(`${BASE}/api/items/${vid.id}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    eq('既没 mode 也没 tags → 400', noTags.status, 400);
    const afterNoTags = (await (await fetch(`${BASE}/api/items/${vid.id}`)).json()).item;
    eq('标签没被清空', JSON.stringify(afterNoTags.tags), JSON.stringify(before.tags));
    const addOnly = await (await fetch(`${BASE}/api/items/${vid.id}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: ['追加'] }),
    })).json();
    check('只给 add 时按「追加」处理，原有标签还在',
      addOnly.ok && before.tags.every((t) => addOnly.item.tags.includes(t)) && addOnly.item.tags.includes('追加'), JSON.stringify(addOnly.item && addOnly.item.tags));
    const bulkSet = await fetch(`${BASE}/api/items/bulk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [vid.id], mode: 'set' }),
    });
    eq('批量接口不接受 mode=set', bulkSet.status, 400);

    // ---- 回归：体检「当前筛选」按完整筛选结果算，不受分页影响
    const untaggedList = await (await fetch(`${BASE}/api/items?untagged=1`)).json();
    const reviewF = await (await fetch(`${BASE}/api/export/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: { untagged: true } }),
    })).json();
    eq('体检按 filter 取素材，数量与筛选结果一致', reviewF.count, untaggedList.total);

    // ---- 回归：任务结束后才连上 SSE，也要收到 end 并且连接会关闭
    const quick = await (await fetch(`${BASE}/api/export/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [vid.id], destRoot, subdir: 'SSE补发', nameMode: 'tagged' }),
    })).json();
    for (let i = 0; i < 40; i += 1) {
      const j = await (await fetch(`${BASE}/api/export/${quick.job.id}`)).json();
      if (j.job.status === 'done') break;
      await sleep(100);
    }
    let sseText = '';
    try {
      sseText = await (await fetch(`${BASE}/api/export/${quick.job.id}/events`, { signal: AbortSignal.timeout(3000) })).text();
    } catch (err) {
      sseText = `超时：${err.message}`;
    }
    check('已结束任务的 SSE 会补发 end 并关闭连接', /event: end/.test(sseText), sseText.slice(0, 120));
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(400);
    if (!child.killed) { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }
    if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });
  }
}

// ------------------------------------------------------------------ 7. 真视频（可选）

async function testRealVideos() {
  group('7. 真素材：项目里的实际视频（若已就位）');

  // 项目自带的素材放在 <项目>/素材/ 下；也兼容直接丢在项目根目录的情况。
  const assetDir = fs.existsSync(path.join(ROOT, '素材')) ? path.join(ROOT, '素材') : ROOT;
  const candidates = fs.readdirSync(assetDir).filter((n) => /\.(mp4|mkv|mov|webm|avi|flv|ts)$/i.test(n) && !n.startsWith('.'));
  if (!candidates.length) {
    note(`项目目录里还没有视频文件（${assetDir}），跳过；把视频放进去后重跑本项即可`);
    return;
  }
  note(`素材目录：${assetDir}`);
  for (const name of candidates) {
    const st = await fsp.stat(path.join(assetDir, name));
    note(`${name} — ${util.humanBytes(st.size)}`);
  }

  const mediaLib = await freshDir(path.join(VDIR, 'media-lib'));
  for (const name of candidates) {
    await fsp.copyFile(path.join(assetDir, name), path.join(mediaLib, name));
  }
  const { db, library } = await makeLibrary(mediaLib);
  const scan = await library.scan({ rename: true, prune: true });
  eq('两个视频都入库', scan.added, candidates.length);

  const vid = db.items().find((i) => i.kind === 'video');
  const t0 = Date.now();
  const res = await library.applyTags(vid.id, { mode: 'set', tags: ['B站录屏', '助眠'] });
  check('真视频打标签成功', res.ok, res.reason);
  note(`改一个 ${util.humanBytes(vid.size)} 的文件名耗时 ${Date.now() - t0} ms（重命名是常数时间，不复制数据）`);
  check('磁盘上的新名字符合规范', /^B站录屏-助眠-[0-9a-f]{32}\.mp4$/.test(res.item.name), res.item.name);

  // 抽一帧看看 ffmpeg 是否真能处理这些文件
  const thumbs = new Thumbnails({ metaRoot: path.join(mediaLib, util.META_DIRNAME), rootOf: () => mediaLib, dbOf: () => db });
  await thumbs.init();
  const ff = await thumbs.ffmpeg();
  // 注意：Thumbnails#ffmpeg() 返回的是**路径字符串**或 null，不是 {path} 对象。
  // 早先这里写成 `if (ff && ff.path)` —— 有 ffmpeg 时字符串没有 .path 属性，
  // 于是真抽帧这一条被静默跳过、还打印"没有可用 ffmpeg"，等于自欺欺人。
  if (ff) {
    const out = spawnSync(ff, ['-v', 'error', '-ss', '3', '-i', db.absOf(db.get(vid.id)), '-frames:v', '1', '-vf', 'scale=320:-2', '-y', path.join(mediaLib, '.mtag', 'probe.jpg')], { encoding: 'utf8' });
    check('ffmpeg 能对真视频抽帧', out.status === 0, (out.stderr || '').slice(0, 300));
    const p = path.join(mediaLib, '.mtag', 'probe.jpg');
    check('抽出来的帧是个有效 JPEG', fs.existsSync(p) && fs.readFileSync(p).slice(0, 2).toString('hex') === 'ffd8');
    if (fs.existsSync(p)) note(`ffmpeg 抽帧成功：${ff} → ${util.humanBytes(fs.statSync(p).size)} 的 JPEG`);
  } else {
    note('没有可用 ffmpeg，跳过抽帧验证');
  }

  const t1 = Date.now();
  const ex = new Exports({ metaRoot: path.join(mediaLib, util.META_DIRNAME), rootOf: () => mediaLib, dbOf: () => db });
  await ex.init();
  const dest = await freshDir(path.join(VDIR, 'media-dest'));
  const job = ex.start({ items: db.items(), destRoot: dest, subdir: '导出', nameMode: 'tagged', makeZip: false });
  let last = job.snapshot();
  const progressSeen = [];
  job.on('progress', (s) => { last = s; progressSeen.push(s.bytesDone); });
  const final = await new Promise((resolve) => { job.on('end', resolve); setTimeout(() => resolve(job.snapshot()), 600000); });
  check('大文件导出完成', final.status === 'done', `${final.status} ${final.error || ''}`);
  eq('导出了 2 个文件', final.copied, candidates.length);
  check('进度是渐进的（不是 0 → 100 跳变）', progressSeen.length >= 2, `收到 ${progressSeen.length} 次进度`);
  const totalSrc = db.items().reduce((n, i) => n + i.size, 0);
  eq('复制的字节数与源文件总量一致', final.bytesDone, totalSrc);
  for (const item of db.items()) {
    const src = fs.statSync(db.absOf(item)).size;
    // 导出名要走 exporter 的规则算一遍，别拿 item.name 硬套：
    // 打了标签的两种模式可能不一致（tagged-fresh 会换 uuid），没打标签的则保持原名。
    const exported = job.exportName(item);
    const dstPath = path.join(final.destDir, exported);
    const dst = fs.existsSync(dstPath) ? fs.statSync(dstPath).size : -1;
    check(`${exported} 复制后大小一致`, src === dst, `${src} vs ${dst}`);
  }
  note(`复制 ${util.humanBytes(totalSrc)} 耗时 ${Math.round((Date.now() - t1) / 1000)} 秒`);
}

// ------------------------------------------------------------------ 8. 从文件名认出旧标签

/**
 * 场景：把以前用本工具打过标签的素材（文件名是「标签1-标签2.扩展名」，没有 uuid）
 * 再导进一个新库。程序应该认出这些标签，并且在**用户确认后**才改名。
 * 之所以必须确认而不能自动改：`2024-08-23 直播录屏.mp4` 这种名字长得一模一样，
 * 程序没法区分 `2024` 是标签还是日期的一部分。
 */
async function testSuggestions() {
  group('8. 从文件名里认出旧标签（tag1-tag2.mp4）');

  const lib = path.join(VDIR, 'sug');
  await freshDir(lib);
  const uuid = util.hex32();
  await writeFile(path.join(lib, '旅行-风景.mp4'), 'v1');
  await writeFile(path.join(lib, '助眠-直播录屏-轻语.mp3'), 'a1');
  await writeFile(path.join(lib, '2024-08-23 直播录屏.mp4'), 'v2');
  await writeFile(path.join(lib, `旅行-风景-${uuid}.jpg`), 'i1'); // 已经是规范名
  await writeFile(path.join(lib, '单段.mp4'), 'v3');             // 没有连字符，看不出标签
  await writeFile(path.join(lib, '带.点-标签.mp4'), 'v4');        // 点号是非法字符，不该当标签

  const { db, library } = await makeLibrary(lib);
  const scan = await library.scan({ rename: true, prune: true });
  eq('扫描到 6 个素材', scan.added, 6);
  eq('扫描时没有自动改名（不该动的就不动）', scan.renamed, 0);
  check('6 个文件都还在磁盘上', listDisk(lib).length === 6, listDisk(lib).join(' | '));

  const sug = library.suggestions();
  const keys = sug.groups.map((g) => g.tags.join('-'));
  eq('认出 3 组建议（前两组是干净的标签名，第三组是日期型名字）', sug.count, 3);
  note(`认出来的标签组：${keys.join(' / ')}`);
  check('「旅行-风景.mp4」给出标签建议', keys.includes('旅行-风景'), keys.join(' | '));
  check('「助眠-直播录屏-轻语.mp3」给出三个标签的建议', keys.includes('助眠-直播录屏-轻语'), keys.join(' | '));
  check('「2024-08-23 直播录屏.mp4」被当成候选（程序分不清，交给用户判断）',
    keys.some((k) => k.includes('2024')), keys.join(' | '));
  check('「单段.mp4」不给建议（没有连字符）', !sug.groups.some((g) => g.ids.includes(db.items().find((i) => i.name === '单段.mp4').id)));
  check('「带.点-标签.mp4」不给建议（点号不合法）', !sug.groups.some((g) => g.ids.includes(db.items().find((i) => i.name === '带.点-标签.mp4').id)));
  check('已经规范命名的素材不重复建议', !sug.groups.some((g) => g.ids.includes(uuid)));
  eq('已经有标签的素材不再当候选', db.items().filter((i) => i.tagSuggest && i.tags.length).length, 0);

  const preview = sug.groups.find((g) => g.tags.join('-') === '旅行-风景');
  eq('建议里带一条预览样例', preview.items.length, 1);
  eq('预览里显示原名', preview.items[0].origName, '旅行-风景.mp4');
  check('预览里显示改名后会是什么样', /^旅行-风景-[0-9a-f]{32}\.mp4$/.test(preview.items[0].target), preview.items[0].target);

  // ---- 采纳
  const acc = await library.acceptSuggestions(preview.ids, { tags: preview.tags });
  eq('采纳成功', acc.accepted, 1);
  eq('采纳后没有失败', acc.failures.length, 0);
  const accItem = db.get(preview.ids[0]);
  eq('标签写进了库', JSON.stringify(accItem.tags), JSON.stringify(['旅行', '风景']));
  check('磁盘文件名变成了规范名', fs.existsSync(path.join(lib, accItem.name)), listDisk(lib).join(' | '));
  check('采纳后这条不再出现在建议里', !library.suggestions().groups.some((g) => g.ids.includes(accItem.id)));
  check('采纳后文件名里带该素材的 uuid', accItem.name.includes(accItem.id), accItem.name);

  // ---- 「不用」
  const dateGroup = library.suggestions().groups.find((g) => g.tags.includes('2024'));
  const ign = await library.ignoreSuggestions(dateGroup.ids);
  eq('点「不用」记下了 1 条', ign.ignored, 1);
  check('「不用」之后不再给这组建议', !library.suggestions().groups.some((g) => g.ids.includes(dateGroup.ids[0])));
  check('「不用」不碰磁盘文件', listDisk(lib).some((n) => n === '2024-08-23 直播录屏.mp4'), listDisk(lib).join(' | '));
  const afterScan = await library.scan({ rename: true, prune: true });
  check('再扫一遍也不会把「不用」过的名字纠正成未分类名', listDisk(lib).some((n) => n === '2024-08-23 直播录屏.mp4'),
    listDisk(lib).join(' | '));
  eq('再扫没有意外改名', afterScan.renamed, 0);

  // 用户自己改名 → 旧决定失效，应该重新给建议
  const dateItem = db.get(dateGroup.ids[0]);
  await fsp.rename(path.join(lib, dateItem.name), path.join(lib, '旅行-风景-新名字.mp4'));
  await library.scan({ rename: true, prune: true });
  check('用户自己改名后，旧决定失效、重新给建议',
    library.suggestions().groups.some((g) => g.tags.includes('旅行')), JSON.stringify(library.suggestions().groups.map((g) => g.tags)));

  // 全部采纳（就是弹窗上的「全部采纳」按钮走的那条路）
  const accAll = await library.acceptSuggestions(library.suggestions().groups.flatMap((g) => g.ids));
  check('全部采纳成功', accAll.accepted >= 1, JSON.stringify(accAll));
  eq('全部采纳之后建议清零', library.suggestions().itemCount, 0);
  eq('全部采纳后没有失败', accAll.failures.length, 0);
  check('所有认出来的素材都改成了规范名',
    listDisk(lib).filter((n) => !/[0-9a-f]{32}\./.test(n)).every((n) => n === '单段.mp4' || n === '带.点-标签.mp4'),
    listDisk(lib).join(' | '));
  check('全程没有丢掉任何文件的记录',
    db.items().length === listDisk(lib).length, `库 ${db.items().length} / 磁盘 ${listDisk(lib).length}`);

  // 已经打过标签的素材：清空标签后规则是「回到原始文件名」。这里原始名正是
  // `旅行-风景.mp4`，所以会退回它（用户清空标签 = 回到没分类，文件名也从头来）。
  const cleared = db.get(accItem.id);
  await library.applyTags(cleared.id, { mode: 'set', tags: [] });
  eq('清空标签后文件名回到原始文件名（本工具的素材）', db.get(accItem.id).name, '旅行-风景.mp4');
  // 而**外部**拷进来的「标签-uuid.扩展名」：标签是按文件名认下的（inferred），
  // 清空标签时不该退回那个还带着旧标签的原始名，否则下次扫描又把它当候选，来回折腾。
  const orphanId = util.hex32();
  await writeFile(path.join(lib, `旅行-风景-${orphanId}.jpg`), 'i2');
  await library.scan({ rename: true, prune: true });
  const orphan = db.get(orphanId);
  eq('外部导入的规范名文件，标签直接按文件名认下', JSON.stringify(orphan.tags), JSON.stringify(['旅行', '风景']));
  eq('并且不把它列为待确认的建议', orphan.tagSuggest, null);
  await library.applyTags(orphanId, { mode: 'set', tags: [] });
  await library.scan({ rename: true, prune: true });
  eq('清空标签后名字里保留 uuid（不退回带旧标签的原名）', db.get(orphanId).name, `${orphanId}.jpg`);
  check('并且不会被当成待确认的建议',
    db.get(orphanId).tagSuggest === null, JSON.stringify(db.get(orphanId).tagSuggest));
}

// ------------------------------------------------------------------ 9. 回归：修过的 bug

/** 用 .NET 自带的 ZipFile 读 zip（独立于我们自己的写入器），返回 [{name, length, sha1}] */
function readZipWithDotNet(zipPath) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');`,
    '$sha = [System.Security.Cryptography.SHA1]::Create();',
    '$out = @(); foreach ($e in $z.Entries) { $s = $e.Open(); $h = -join ($sha.ComputeHash($s) | ForEach-Object { $_.ToString("x2") }); $s.Close();',
    '$out += [pscustomobject]@{ name = $e.FullName; length = $e.Length; sha1 = $h } }; $z.Dispose();',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress @($out)',
  ].join(' ');
  const fullPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const bin = fs.existsSync(fullPath) ? fullPath : 'powershell.exe';
  const r = spawnSync(bin, ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr || `powershell 退出码 ${r.status}`);
  const parsed = JSON.parse(r.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function testRegressions() {
  group('9. 回归：修过的 bug 不再复发');

  // uuid 只认本工具生成的形态（主干就是 uuid，或以 -uuid 结尾）
  const hash = '5d41402abc4b2a76b9719d911017c592';
  eq('原名中间夹带的 32 位 hex 不当成 uuid', naming.parseIdFromName(`IMG_${hash}.jpg`), null);
  eq('uuid 不在主干末尾时不认', naming.parseIdFromName(`x-${hash}-尾巴.mp4`), null);
  eq('纯 uuid 主干照样认', naming.parseIdFromName(`${hash}.jpg`), hash);

  const lib = await freshDir(path.join(VDIR, 'regress-lib'));
  await writeFile(path.join(lib, `IMG_${hash}.jpg`), 'img');
  await writeFile(path.join(lib, '片段.mp4'), 'clip');
  await writeFile(path.join(lib, '旅行-风景.mp4'), 'trip');
  const { db, journal, library } = await makeLibrary(lib);
  await library.scan({ rename: true, prune: true });
  check('原名带 32 位 hex 的未打标签文件，扫描后文件名不变', fs.existsSync(path.join(lib, `IMG_${hash}.jpg`)), listDisk(lib).join(' | '));
  const img = db.items().find((i) => i.name.startsWith('IMG_'));
  eq('并且 origName 记的是完整原名', img && img.origName, `IMG_${hash}.jpg`);

  // 清空标签时原名被占：退让成 原名(2)，而不是失败
  const clip = db.items().find((i) => i.name === '片段.mp4');
  const tagged = await library.applyTags(clip.id, { mode: 'set', tags: ['测试'] });
  check('打标签后改成规范名', tagged.ok && tagged.item.name.startsWith('测试-'), tagged.reason);
  await writeFile(path.join(lib, '片段.mp4'), '另一个同名文件');
  const cleared = await library.applyTags(tagged.item.id, { mode: 'set', tags: [] });
  check('原名被占时清空标签也能成功', cleared.ok === true, cleared.reason);
  eq('退让成「原名(2)」', cleared.item && cleared.item.name, '片段(2).mp4');
  eq('占着原名的那个文件没被动过', fs.readFileSync(path.join(lib, '片段.mp4'), 'utf8'), '另一个同名文件');

  // 采纳建议时改名失败：标签要回滚
  const trip = db.items().find((i) => i.name === '旅行-风景.mp4');
  check('「旅行-风景.mp4」被认成建议', !!(trip && trip.tagSuggest), JSON.stringify(trip && trip.tagSuggest));
  const realRename = library.renameItem;
  library.renameItem = async () => ({ ok: false, reason: '模拟改名失败' });
  let accepted;
  try {
    accepted = await library.acceptSuggestions([trip.id]);
  } finally {
    library.renameItem = realRename;
  }
  eq('改名失败时报告失败', accepted.failures.length, 1);
  eq('改名失败时标签回滚为原样（空）', JSON.stringify(db.get(trip.id).tags), '[]');
  check('文件名也没动', fs.existsSync(path.join(lib, '旅行-风景.mp4')), listDisk(lib).join(' | '));

  // 原子写在同一毫秒内并发也不互相踩
  const jf = path.join(VDIR, 'regress-concurrent.json');
  const writes = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => util.writeJsonAtomic(jf, { i })));
  eq('30 次并发原子写全部成功', writes.filter((w) => w.status === 'rejected').length, 0);
  check('最终文件是合法 JSON', (await util.readJson(jf, null)) !== null);

  // 日志恢复：from 和 to 都在时两个都保留
  const fromAbs = path.join(lib, '冲突-旧.mp4');
  const toAbs = path.join(lib, '冲突-新.mp4');
  await writeFile(fromAbs, 'from');
  await writeFile(toAbs, 'to');
  await journal.begin({ itemId: util.hex32(), from: fromAbs, to: toAbs, tags: [] });
  const rec = await journal.recover();
  eq('冲突被报出来', rec.conflict.length, 1);
  check('from 没被删掉', fs.existsSync(fromAbs));
  check('to 也还在', fs.existsSync(toAbs));
  eq('日志已清掉', (await journal.pending()).length, 0);

  // 批量操作：一批只落一次库，但结果必须和逐个落库完全一样
  const bulkLib = await freshDir(path.join(VDIR, 'regress-bulk'));
  for (let i = 0; i < 40; i += 1) await writeFile(path.join(bulkLib, `第${i}个.mp4`), String(i));
  const B = await makeLibrary(bulkLib);
  await B.library.scan({ rename: true, prune: true });
  const bulkIds = B.db.items().slice(0, 25).map((i) => i.id);
  const bulkRes = await B.library.applyTagsBulk(bulkIds, { add: ['甲', '乙'] });
  eq('批量加标签全部成功', bulkRes.count, 25);
  await B.library.applyTagsBulk(bulkIds.slice(0, 10), { remove: ['乙'] });
  await B.library.renameTagGlobal('甲', '丙');
  await B.library.mergeTags(['乙'], '丙');
  await B.library.applyTags(bulkIds[0], { mode: 'set', tags: ['丁', 'Abc'] });
  await B.library.applyTags(bulkIds[1], { mode: 'set', tags: ['ABC'] });
  eq('批量之后没有残留日志', (await B.journal.pending()).length, 0);
  const reloaded = new Database(path.join(bulkLib, util.META_DIRNAME));
  await reloaded.load(bulkLib);
  const diskMismatch = reloaded.items().filter((i) => {
    const live = B.db.get(i.id);
    return !live || live.name !== i.name || JSON.stringify(live.tags) !== JSON.stringify(i.tags);
  });
  eq('落盘的 db.json 与内存一致（批次结束时确实保存了）', diskMismatch.length, 0);
  const nameMismatch = B.db.items().filter((i) => !fs.existsSync(path.join(bulkLib, i.rel)));
  eq('每条记录都指向磁盘上真实存在的文件', nameMismatch.length, 0);
  const counts = (tags) => JSON.stringify(Object.entries(tags).map(([k, v]) => [k, v.count]).sort());
  const rebuilt = JSON.parse(JSON.stringify(B.db.db));
  rebuildTags(rebuilt);
  eq('增量维护的标签计数与全量重算一致', counts(B.db.db.tags), counts(rebuilt.tags));
  eq('标签被摘光后从标签列表里消失', B.db.db.tags[tagmod.foldTag('甲')], undefined);

  // 批处理中途「崩溃」：改名都做了，库却没来得及落盘 → 重开后按日志补齐，标签一个不丢
  const crashLib = await freshDir(path.join(VDIR, 'regress-crash'));
  for (let i = 0; i < 12; i += 1) await writeFile(path.join(crashLib, `崩${i}.mp4`), String(i));
  const C = await makeLibrary(crashLib);
  await C.library.scan({ rename: true, prune: true });
  const crashIds = C.db.items().map((i) => i.id);
  C.db.save = async () => { throw new Error('模拟断电'); };
  let crashed = false;
  try {
    // 嵌套批次：同一批里每个文件先加标签、再被全局改名，各改两次
    await C.library.batch(async () => {
      await C.library.applyTagsBulk(crashIds, { add: ['崩前'] });
      await C.library.renameTagGlobal('崩前', '崩后');
    });
  } catch (err) {
    crashed = /模拟断电/.test(err.message);
  }
  check('模拟断电生效（批次结束时保存失败）', crashed);
  check('断电时日志还留着', (await C.journal.pending()).length > 0);
  const C2 = await makeLibrary(crashLib);
  eq('重开时 db.json 还是旧的（没有标签）', C2.db.items().filter((i) => i.tags.length).length, 0);
  await C2.library.recover();
  const recovered = C2.db.items();
  eq('恢复后素材数不变', recovered.length, 12);
  eq('恢复后每个素材的标签都是最后一次的「崩后」', recovered.filter((i) => JSON.stringify(i.tags) === '["崩后"]').length, 12);
  eq('恢复后每条记录都指向真实文件', recovered.filter((i) => !fs.existsSync(path.join(crashLib, i.rel))).length, 0);
  eq('恢复后日志清空', (await C2.journal.pending()).length, 0);

  // 目录浏览只数这一层
  await writeFile(path.join(bulkLib, '子目录', '深处.mp4'), 'x');
  await writeFile(path.join(bulkLib, '说明.txt'), 'x');
  eq('countMediaFiles 只数这一层的媒体文件', await util.countMediaFiles(bulkLib), 40);

  // 缩略图：用替身 ffmpeg 覆盖「短视频」「大图缩图」「失败记忆」三条分支
  const thumbLib = await freshDir(path.join(VDIR, 'regress-thumb'));
  await writeFile(path.join(thumbLib, '短片.mp4'), 'v');
  await writeFile(path.join(thumbLib, '小图.png'), Buffer.alloc(1024, 1));
  await writeFile(path.join(thumbLib, '大图.jpg'), Buffer.alloc(600 * 1024, 1));
  await writeFile(path.join(thumbLib, '手机.heic'), Buffer.alloc(600 * 1024, 1));
  await writeFile(path.join(thumbLib, '坏视频.mp4'), 'bad');
  const T = await makeLibrary(thumbLib);
  await T.library.scan({ rename: true, prune: true });
  const byName = (n) => T.db.items().find((i) => i.name === n);
  const thumbs = new Thumbnails({ metaRoot: path.join(thumbLib, util.META_DIRNAME), rootOf: () => thumbLib, dbOf: () => T.db });
  await thumbs.init();
  thumbs.ffmpegChecked = true;
  thumbs.ffmpegPath = 'fake-ffmpeg';
  const calls = [];
  thumbs.run = async (_bin, args) => {
    calls.push(args);
    const input = args[args.indexOf('-i') + 1];
    if (input.endsWith('坏视频.mp4')) return false;
    // 短于 3 秒的视频：-ss 3 时 ffmpeg 退出码 0 却不写文件
    if (input.endsWith('短片.mp4') && args.includes('3')) return true;
    fs.writeFileSync(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return true;
  };
  const shortRes = await thumbs.ensure(byName('短片.mp4').id);
  check('短视频：-ss 3 没出图时退回 -ss 0.5 并成功', shortRes.ok && shortRes.mime === 'image/jpeg', JSON.stringify(shortRes));
  const small = await thumbs.ensure(byName('小图.png').id);
  check('小图直接用原图', small.ok && small.source.endsWith('小图.png'), JSON.stringify(small));
  const big = await thumbs.ensure(byName('大图.jpg').id);
  check('大图生成 jpg 缩略图', big.ok && big.source.startsWith(thumbs.dir), JSON.stringify(big));
  check('缩图不放大（scale 用 min(480,iw)）', calls.some((a) => a.includes("scale='min(480,iw)':-2")));
  const heic = await thumbs.ensure(byName('手机.heic').id);
  check('HEIC 也能生成缩略图', heic.ok && heic.mime === 'image/jpeg', JSON.stringify(heic));
  const before = calls.length;
  const bad1 = await thumbs.ensure(byName('坏视频.mp4').id);
  const afterFirst = calls.length;
  const bad2 = await thumbs.ensure(byName('坏视频.mp4').id);
  check('坏视频报失败', !bad1.ok && !bad2.ok);
  eq('坏视频第一次试了 3 次 ffmpeg', afterFirst - before, 3);
  eq('文件没变时第二次不再跑 ffmpeg', calls.length - afterFirst, 0);
  const noFf = new Thumbnails({ metaRoot: path.join(thumbLib, util.META_DIRNAME), rootOf: () => thumbLib, dbOf: () => T.db });
  noFf.ffmpegChecked = true;
  noFf.ffmpegPath = null;
  await fsp.rm(thumbs.fileFor(byName('大图.jpg').id), { force: true });
  await fsp.rm(thumbs.fileFor(byName('手机.heic').id), { force: true });
  const bigNoFf = await noFf.ensure(byName('大图.jpg').id);
  check('没有 ffmpeg 时大图退回原图', bigNoFf.ok && bigNoFf.source.endsWith('大图.jpg'), JSON.stringify(bigNoFf));
  const heicNoFf = await noFf.ensure(byName('手机.heic').id);
  eq('没有 ffmpeg 时 HEIC 报没有缩略图（浏览器显示不了原图）', heicNoFf.code, 404);

  // zip：普通 + 强制 ZIP64，都交给 .NET 的 ZipFile 独立解开校验
  if (process.platform !== 'win32') {
    note('非 Windows：跳过 .NET ZipFile 交叉校验');
    return;
  }
  await writeFile(path.join(lib, '大一点.bin'), Buffer.alloc(3 * 1024 * 1024 + 17, 9));
  await library.scan({ rename: true, prune: true });
  const zipItems = db.items();
  const sha1 = (p) => require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  for (const [label, threshold] of [['普通 zip', null], ['ZIP64（阈值调到 1 字节强制走 ZIP64 分支）', 1]]) {
    const dest = await freshDir(path.join(VDIR, `regress-zip-${threshold || 'std'}`));
    const job = new ExportJob({ id: 'z', items: zipItems, destRoot: dest, subdir: 'z', nameMode: 'tagged', makeZip: true, db });
    if (threshold) job.zip64Threshold = threshold;
    const snap = await job.run();
    eq(`${label}：导出完成`, snap.status, 'done');
    let entries = [];
    try {
      entries = readZipWithDotNet(snap.zipPath);
    } catch (err) {
      check(`${label}：.NET 能打开`, false, err.message);
      continue;
    }
    eq(`${label}：条目数`, entries.length, zipItems.length);
    const allSame = entries.every((e) => sha1(path.join(snap.destDir, e.name)) === e.sha1);
    check(`${label}：每个条目解开后与导出文件逐字节一致`, allSame, JSON.stringify(entries));
  }
}

// ------------------------------------------------------------------ 10. 真 ffmpeg 缩略图

async function testRealFfmpegThumbs() {
  group('10. 真 ffmpeg：现场生成的视频 / 图片抽缩略图');
  const probe = new Thumbnails({ metaRoot: path.join(VDIR, 'ff-probe'), rootOf: () => VDIR, dbOf: () => null });
  const ff = await probe.ffmpeg();
  if (!ff) {
    note('没找到 ffmpeg（PATH / FFMPEG_PATH / bin 目录都没有），跳过');
    return;
  }
  note(`ffmpeg：${ff}`);
  const ffprobe = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const gen = (out, args) => {
    const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { windowsHide: true });
    return r.status === 0 && fs.existsSync(out);
  };
  const dims = (file) => {
    const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
    const [w, h] = String(r.stdout || '').trim().split(',').map(Number);
    return { w, h };
  };

  const lib = await freshDir(path.join(VDIR, 'ff-lib'));
  const made = {
    '一秒短片.mp4': gen(path.join(lib, '一秒短片.mp4'), ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=25', '-pix_fmt', 'yuv420p']),
    '五秒横屏.mp4': gen(path.join(lib, '五秒横屏.mp4'), ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=1280x720:rate=25', '-pix_fmt', 'yuv420p']),
    '纯音频.mp4': gen(path.join(lib, '纯音频.mp4'), ['-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'aac']),
    '大照片.jpg': gen(path.join(lib, '大照片.jpg'), ['-f', 'lavfi', '-i', 'color=c=gray:s=2400x1600', '-vf', 'noise=alls=80:allf=t', '-frames:v', '1', '-q:v', '1']),
    '窄长图.jpg': gen(path.join(lib, '窄长图.jpg'), ['-f', 'lavfi', '-i', 'color=c=gray:s=300x4000', '-vf', 'noise=alls=80:allf=t', '-frames:v', '1', '-q:v', '1']),
    '小图标.png': gen(path.join(lib, '小图标.png'), ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1']),
  };
  check('测试素材都生成出来了', Object.values(made).every(Boolean), JSON.stringify(made));
  const bigSize = fs.statSync(path.join(lib, '大照片.jpg')).size;
  check('大照片确实超过 512KB（走缩图分支）', bigSize > 512 * 1024, util.humanBytes(bigSize));
  check('窄长图也超过 512KB', fs.statSync(path.join(lib, '窄长图.jpg')).size > 512 * 1024);

  const { db, library } = await makeLibrary(lib);
  await library.scan({ rename: true, prune: true });
  const thumbs = new Thumbnails({ metaRoot: path.join(lib, util.META_DIRNAME), rootOf: () => lib, dbOf: () => db });
  await thumbs.init();
  const get = (n) => db.items().find((i) => i.name === n);
  const isJpeg = (file) => fs.readFileSync(file).slice(0, 2).toString('hex') === 'ffd8';

  const t0 = Date.now();
  const short = await thumbs.ensure(get('一秒短片.mp4').id);
  check('1 秒短视频抽出了缩略图（-ss 3 超出时长后自动退回）', short.ok && isJpeg(short.source), JSON.stringify(short));
  if (short.ok) eq('短视频缩略图宽 480', dims(short.source).w, 480);

  const long = await thumbs.ensure(get('五秒横屏.mp4').id);
  check('5 秒视频抽出了缩略图', long.ok && isJpeg(long.source), JSON.stringify(long));
  if (long.ok) {
    const d = dims(long.source);
    check('视频缩略图 480 宽、保持 16:9', d.w === 480 && d.h === 270, JSON.stringify(d));
  }

  const big = await thumbs.ensure(get('大照片.jpg').id);
  check('大照片生成了缩略图（不是原图）', big.ok && big.source.startsWith(thumbs.dir) && isJpeg(big.source), JSON.stringify(big));
  if (big.ok) {
    const d = dims(big.source);
    check('大照片缩到 480 宽、保持 3:2', d.w === 480 && d.h === 320, JSON.stringify(d));
    const thumbSize = fs.statSync(big.source).size;
    check('缩略图比原图小得多', thumbSize * 10 < bigSize, `${util.humanBytes(thumbSize)} vs ${util.humanBytes(bigSize)}`);
  }

  const narrow = await thumbs.ensure(get('窄长图.jpg').id);
  check('窄长图生成了缩略图', narrow.ok && narrow.source.startsWith(thumbs.dir), JSON.stringify(narrow));
  if (narrow.ok) eq('比 480 窄的图不放大（宽仍是 300）', dims(narrow.source).w, 300);

  const icon = await thumbs.ensure(get('小图标.png').id);
  check('小图直接用原图', icon.ok && icon.source.endsWith('小图标.png'), JSON.stringify(icon));

  const audio = await thumbs.ensure(get('纯音频.mp4').id);
  check('没有视频轨的 mp4 明确报失败而不是挂住', !audio.ok, JSON.stringify(audio));
  const tAudio = Date.now();
  const audio2 = await thumbs.ensure(get('纯音频.mp4').id);
  check('再次请求直接返回记住的失败（不再跑 ffmpeg）', !audio2.ok && Date.now() - tAudio < 50, `${Date.now() - tAudio}ms`);

  const cachedAgain = await thumbs.ensure(get('五秒横屏.mp4').id);
  eq('第二次请求命中磁盘缓存', cachedAgain.source, long.source);
  note(`真 ffmpeg 生成全部缩略图用时 ${Date.now() - t0} ms`);
}

// ------------------------------------------------------------------ 主流程

async function main() {
  process.stdout.write('tagStudio 自验证\n');
  process.stdout.write(`项目目录：${ROOT}\n`);
  process.stdout.write(`验证目录：${VDIR}\n`);

  const t0 = Date.now();
  await freshDir(VDIR);
  await testNaming();
  await testWalk();
  await testTags();
  await testLibraryScanAndRename();
  await testJournalRecovery();
  await testExport();
  await testSuggestions();
  await testRegressions();
  if (!QUICK) await testRealFfmpegThumbs();
  if (!QUICK) await testServer();
  else note('--quick：跳过 HTTP 服务验证');
  if (!QUICK) await testRealVideos();
  else note('--quick：跳过真素材验证');

  section('结果');
  process.stdout.write(`   通过 ${passed} 项，失败 ${failures.length} 项，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒\n`);
  if (failures.length) {
    process.stdout.write('\n失败明细：\n');
    for (const f of failures) process.stdout.write(`   ✗ [${f.group}] ${f.desc}${f.detail ? `\n        ${f.detail}` : ''}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('   全部通过。\n');
  }
  process.stdout.write(`\n产物留在 ${VDIR}（可随时删除）\n`);

  process.exitCode = failures.length ? 1 : 0;

  // 收尾：verify 会起真实服务器并用 fetch 打它，undici 的连接池会留下 keep-alive
  // 套接字，让事件循环不肯退出（表现就是"结果打印完了但进程一直挂着"）。
  // 试着关掉全局 dispatcher；拿不到就等一小会儿，最后一定强制退出，保证脚本收得掉。
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch { /* 忽略 */ }
  const killer = setTimeout(() => process.exit(process.exitCode || 0), 800);
  void killer;
}

main().catch((err) => {
  process.stderr.write(`\n验证脚本自身出错：${err && err.stack}\n`);
  process.exit(2);
});
