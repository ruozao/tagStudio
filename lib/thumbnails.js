'use strict';
/**
 * thumbs.js — 缩略图。
 *
 * - 图片：小图 / 动图 / 矢量图直接用原图；大于 512KB 的有 ffmpeg 时缩一张 jpg（见 ensureImage）。
 * - 视频：ffmpeg 抽一帧。这里有两个坑：
 *     1. `-ss` 放在 `-i` 前面是「快速定位」（只解关键帧索引），后面是「精确解码」。
 *        先用快速定位，失败再退回解码第 0 帧。
 *     2. ffmpeg 可能永远不退出（损坏文件）。所有调用都有超时，超时就杀进程。
 * - 音频：没有 ffmpeg 依赖的封面提取方案，返回 404，前端显示音符图标。
 * - 并发上限默认 4：一屏几十个格子同时要封面时，2 路是瓶颈（单张约 150ms，
 *   冷盘时更久），4 路实测快一倍多；再多收益就下去了（实测 8 路最稳，见 MAX_ACTIVE）。
 * - HTTP 那条路走 request()：最多等 THUMB_WAIT_MS，等不到先回占位图，前端过一会儿再来问。
 *   一页 200 张卡片全是未缓存封面时，如果让请求一直排队等，最后那几张要等几十秒
 *   （实测日志里有 32 秒的请求），而且把浏览器的 6 条连接全占住、连别的接口一起卡。
 */

const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const util = require('./util');

const THUMB_WIDTH = 480;
/**
 * 单次 ffmpeg 的超时。以前是 25 秒，配合「失败再退两档」最多能把一个 lane 占掉 75 秒；
 * 实测正常文件（包括 1.5GB 的冷盘文件）都在 10 秒内，超过 8 秒基本就是文件本身有问题
 * （索引损坏、需要整段解码），继续等也没意义。
 */
const FFMPEG_TIMEOUT_MS = 8000;
/** 一次 HTTP 请求最多等多久：抽不出来就先回占位图（前端会带着 p=1 重试） */
const THUMB_WAIT_MS = 1200;
/** 排队上限：超过说明用户在快速翻页，没必要把几百个抽帧任务都排上 */
const QUEUE_CAP = 96;
/** 同时跑几个 ffmpeg。实测（8 个 3.6GB 视频、热缓存）：1 路 174ms/张、2 路 71ms、4 路 54ms、6 路 46ms */
const DEFAULT_MAX_ACTIVE = 4;
const MAX_ACTIVE = 8;
/** 不超过这个体积的图片直接用原图当缩略图 */
const IMAGE_ORIGINAL_MAX_BYTES = 512 * 1024;
/** 动图缩成一帧、矢量图转成位图都只会更差，始终用原图 */
const KEEP_ORIGINAL_EXT = new Set(['.gif', '.svg']);
const BROWSER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg']);

/** 进程级的 ffmpeg 探测结果（Promise），所有库共用 */
let ffmpegProbe = null;

/** 把外部给的并发数夹到 1–MAX_ACTIVE；非法值（'abc'、0、负数、undefined）退回默认值 */
function clampActive(n) {
  if (n === undefined || n === null || n === '') return DEFAULT_MAX_ACTIVE;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_ACTIVE;
  return Math.min(MAX_ACTIVE, v);
}

class Thumbnails {
  /**
   * @param {object} opts
   * @param {string} opts.metaRoot
   * @param {() => string} opts.rootOf  取当前库根目录
   * @param {() => object} opts.dbOf    取当前 Database
   * @param {number} [opts.maxActive]   同时跑几个 ffmpeg（默认 4，1–8 之间，超范围会被夹回来）
   */
  constructor({ metaRoot, rootOf, dbOf, maxActive }) {
    this.dir = path.join(metaRoot, util.THUMB_DIRNAME);
    this.rootOf = rootOf;
    this.dbOf = dbOf;
    this.ffmpegPath = null;
    this.ffmpegChecked = false;
    this.queue = [];
    this.hot = [];                 // 优先队列：前端重试的、正在看的那些
    this.active = 0;
    this.maxActive = clampActive(maxActive);
    this.inflight = new Map();     // key -> Promise
    this.failures = new Map();     // id -> {mtimeMs, result}：生成失败过的文件
  }

  /** 运行期改并发（设置面板/测试用）：改完立刻按新上限补位 */
  setMaxActive(n) {
    this.maxActive = clampActive(n);
    this.pump();
    return this.maxActive;
  }

  async init() {
    await util.ensureDir(this.dir);
  }

  static async probeFfmpeg() {
    const candidates = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    const local = path.resolve(__dirname, '..', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    candidates.push(local);
    // 顺带找一下常见安装位置：用户机器上 ffmpeg 未必在 PATH 里。
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    }
    for (const dir of [
      'E:\\workbench\\ffmpeg\\bin',
      'C:\\ffmpeg\\bin',
      'C:\\Program Files\\ffmpeg\\bin',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
      '/usr/local/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
    ]) {
      if (!dir) continue;
      candidates.push(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    }
    candidates.push('ffmpeg');
    for (const cand of candidates) {
      const ok = await Thumbnails.runFfmpegVersion(cand);
      if (ok) return cand;
    }
    return null;
  }

  static runFfmpegVersion(bin) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      let child;
      try {
        child = spawn(bin, ['-hide_banner', '-version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return finish(false);
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 忽略 */ }
        finish(false);
      }, 4000);
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    });
  }

  async ffmpeg() {
    if (!this.ffmpegChecked) {
      // 探测要把 PATH 里每个目录都试着跑一遍，最慢要几十秒；整个进程只做一次，换库也不重来
      if (!ffmpegProbe) ffmpegProbe = Thumbnails.probeFfmpeg();
      this.ffmpegPath = await ffmpegProbe;
      this.ffmpegChecked = true;
    }
    return this.ffmpegPath;
  }

  fileFor(id) {
    return path.join(this.dir, `${String(id).toLowerCase()}.jpg`);
  }

  async clear() {
    await util.removeIfExists(this.dir);
    await util.ensureDir(this.dir);
    this.failures.clear();
    return { ok: true };
  }

  /** 素材被删掉之后顺手清掉它的封面，不然 .mtag\thumbs 里会攒一堆孤儿 jpg */
  async forget(ids) {
    for (const raw of ids || []) {
      const id = String(raw);
      this.failures.delete(id);
      this.inflight.delete(id);
      await util.removeIfExists(this.fileFor(id));
    }
    return { ok: true, count: (ids || []).length };
  }

  /**
   * 给 HTTP 用的「要一张缩略图」：
   *   - 已经有图 → 立刻给；
   *   - 没有 → 排进队列抽帧，但**最多等 waitMs**；等不到返回 {pending:true}，
   *     前端过一会儿带着 p=1 再来问（那时通常已经抽好了）。
   * 为什么要这个上限：一页 200 张卡片同时请求时，请求会按队列位置一个个等，
   * 最后几张实测要等十几到三十几秒，而且把浏览器每个域名的 6 条连接全占住，
   * 连 /api/state 这种小请求都得排队 —— 界面看着就是整个卡住。
   */
  async request(id, opts = {}) {
    const priority = !!opts.priority;
    const waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, opts.waitMs) : THUMB_WAIT_MS;
    const cached = await this.cachedNow(id);
    if (cached) return cached;

    const item = this.dbOf().get(id);
    if (!item) return { ok: false, code: 404, reason: '素材不存在' };
    // 视频才需要排 ffmpeg；图片走原图那条路基本是瞬间的事，别被限流误伤
    if (item.kind !== 'image' && this.queue.length + this.hot.length >= QUEUE_CAP) {
      return { pending: true, throttled: true };
    }
    const p = this.ensure(id, { priority });
    if (waitMs === 0) return { pending: true };
    return this.raceWait(p, waitMs);
  }

  async raceWait(promise, waitMs) {
    let timer = null;
    try {
      const raced = await Promise.race([
        promise.then((result) => ({ done: result })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), waitMs); }),
      ]);
      return raced.timeout ? { pending: true } : raced.done;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 只看缓存有没有，不排队、不抽帧（request 的快路径） */
  async cachedNow(id) {
    const db = this.dbOf();
    const item = db.get(id);
    if (!item) return null;
    const failed = this.failures.get(id);
    if (failed && failed.mtimeMs === item.mtimeMs) return failed.result;
    const cached = this.fileFor(id);
    const st = await util.statOrNull(cached);
    if (st && st.size > 0 && st.mtimeMs >= item.mtimeMs) return { ok: true, source: cached, mime: 'image/jpeg' };
    return null;
  }

  /**
   * 返回 {ok, file} 或 {ok:false, code, reason}
   * @param {object} [opts]
   * @param {boolean} [opts.priority] 插到优先队列（前端重试时用）
   */
  async ensure(id, opts = {}) {
    const db = this.dbOf();
    const item = db.get(id);
    if (!item) return { ok: false, code: 404, reason: '素材不存在' };
    const abs = db.absOf(item);
    if (!(await util.exists(abs))) return { ok: false, code: 404, reason: '源文件不存在' };

    if (item.kind === 'image') return this.ensureImage(item, abs, opts);
    if (item.kind !== 'video') return { ok: false, code: 404, reason: '该类型没有缩略图' };
    return this.cachedOrExtract(item, abs, 'video', opts);
  }

  /**
   * 图片：小图、动图、矢量图直接用原图（浏览器解码最快，也不多占磁盘）；
   * 大图交给 ffmpeg 缩一张 jpg —— 一屏几十张原尺寸照片就是几百 MB 的流量和解码。
   * 缩不出来时退回原图；浏览器本身显示不了的格式（HEIC 等）退不了，就报没有缩略图。
   */
  async ensureImage(item, abs, opts = {}) {
    const ext = path.extname(item.name).toLowerCase();
    const browserOk = BROWSER_IMAGE_EXT.has(ext);
    const original = { ok: true, source: abs, mime: util.mimeFor(item.name) };
    if (browserOk && (KEEP_ORIGINAL_EXT.has(ext) || (item.size || 0) <= IMAGE_ORIGINAL_MAX_BYTES)) return original;
    const res = await this.cachedOrExtract(item, abs, 'image', opts);
    if (res.ok) return res;
    return browserOk ? original : { ok: false, code: 404, reason: '浏览器显示不了这种图片格式，也没能生成缩略图' };
  }

  async cachedOrExtract(item, abs, mode, opts = {}) {
    const cached = this.fileFor(item.id);
    const st = await util.statOrNull(cached);
    if (st && st.size > 0 && st.mtimeMs >= item.mtimeMs) return { ok: true, source: cached, mime: 'image/jpeg' };
    // 抽不出图的文件（损坏、没有视频轨）记住，文件没变就别每次刷列表都再跑三遍 ffmpeg
    const failed = this.failures.get(item.id);
    if (failed && failed.mtimeMs === item.mtimeMs) return failed.result;

    const key = item.id;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.enqueue(() => this.extract(item, abs, cached, mode), { priority: !!opts.priority })
      .then((res) => {
        // 没装 ffmpeg 不算这个文件的问题，装上之后应该能出图
        if (!res.ok && res.code !== 503) this.failures.set(item.id, { mtimeMs: item.mtimeMs, result: res });
        return res;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  enqueue(fn, opts = {}) {
    return new Promise((resolve) => {
      const job = { fn, resolve };
      if (opts.priority) this.hot.push(job); else this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    while (this.active < this.maxActive && (this.hot.length || this.queue.length)) {
      // 优先队列先跑：那些是用户正在看、前端已经在重试的封面
      const job = this.hot.length ? this.hot.shift() : this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve)
        .catch(() => job.resolve({ ok: false, code: 500, reason: '缩略图生成异常' }))
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  async extract(item, abs, out, mode = 'video') {
    const bin = await this.ffmpeg();
    if (!bin) return { ok: false, code: 503, reason: '未找到 ffmpeg，无法生成缩略图' };
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    // 图片比缩略图还小时不放大
    const scale = mode === 'image' ? `scale='min(${THUMB_WIDTH},iw)':-2` : `scale=${THUMB_WIDTH}:-2`;
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-frames:v', '1', '-vf', scale, '-q:v', '4', tmp];
    // -ss 超过视频时长时 ffmpeg 照样退出码 0 但不出图，所以必须看临时文件是否真的写出来了
    const attempt = async (seekArgs) => {
      await util.removeIfExists(tmp);
      const r = await this.run(bin, [...seekArgs, ...common], FFMPEG_TIMEOUT_MS);
      // 测试里会把 run 打补丁成返回 true/false，两种形状都认
      const ran = r === true || !!(r && r.ok);
      if (!ran) return { ok: false, timedOut: r !== true && !!(r && r.timedOut) };
      const st = await util.statOrNull(tmp);
      return { ok: !!(st && st.size > 0), timedOut: false };
    };
    let res;
    if (mode === 'image') {
      res = await attempt([]);
    } else {
      res = await attempt(['-ss', '3']);
      // 超时说明这个文件「定位/解码」卡住了，再退 -ss 0.5 / 0 两档大概率一样慢：不再重试，
      // 把一个 lane 占 3×8 秒换成 8 秒。真正「-ss 3 超过时长」那种是快速失败，会正常退回。
      if (!res.ok && !res.timedOut) {
        res = await attempt(['-ss', '0.5']);
        if (!res.ok && !res.timedOut) res = await attempt(['-ss', '0']);
      }
    }
    const ok = res.ok;
    if (!ok) await util.removeIfExists(tmp);
    if (!ok) return { ok: false, code: 500, reason: mode === 'image' ? 'ffmpeg 缩图失败' : 'ffmpeg 抽帧失败（文件可能损坏或没有视频轨）' };
    try {
      await fsp.rename(tmp, out);
    } catch (err) {
      await util.removeIfExists(tmp);
      return { ok: false, code: 500, reason: `写入缩略图失败：${err && err.message}` };
    }
    return { ok: true, source: out, mime: 'image/jpeg' };
  }

  /** 返回 {ok, timedOut}（测试里会把它打补丁成返回布尔值，调用方两种都认） */
  run(bin, args, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return resolve({ ok: false, timedOut: false });
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* 忽略 */ }
        resolve({ ok: false, timedOut: true });
      }, timeoutMs);
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, timedOut: false });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, timedOut: false });
      });
    });
  }
}

module.exports = { Thumbnails, THUMB_WIDTH, THUMB_WAIT_MS, QUEUE_CAP, DEFAULT_MAX_ACTIVE, MAX_ACTIVE, clampActive };
