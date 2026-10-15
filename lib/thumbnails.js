'use strict';
/**
 * thumbs.js — 缩略图。
 *
 * - 图片：直接用原图（浏览器解码最快，也不产生第二份磁盘占用）。
 * - 视频：ffmpeg 抽一帧。这里有两个坑：
 *     1. `-ss` 放在 `-i` 前面是「快速定位」（只解关键帧索引），后面是「精确解码」。
 *        先用快速定位，失败再退回解码第 0 帧。
 *     2. ffmpeg 可能永远不退出（损坏文件）。所有调用都有超时，超时就杀进程。
 * - 音频：没有 ffmpeg 依赖的封面提取方案，返回 404，前端显示音符图标。
 * - 并发上限 2：一次加载几十个格子时不能把机器打满。
 */

const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const util = require('./util');

const THUMB_WIDTH = 480;
const FFMPEG_TIMEOUT_MS = 25000;

class Thumbnails {
  /**
   * @param {object} opts
   * @param {string} opts.metaRoot
   * @param {() => string} opts.rootOf  取当前库根目录
   * @param {() => object} opts.dbOf    取当前 Database
   */
  constructor({ metaRoot, rootOf, dbOf }) {
    this.dir = path.join(metaRoot, util.THUMB_DIRNAME);
    this.rootOf = rootOf;
    this.dbOf = dbOf;
    this.ffmpegPath = null;
    this.ffmpegChecked = false;
    this.queue = [];
    this.active = 0;
    this.maxActive = 2;
    this.inflight = new Map();     // key -> Promise
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
      this.ffmpegPath = await Thumbnails.probeFfmpeg();
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
    return { ok: true };
  }

  /** 返回 {ok, file} 或 {ok:false, code, reason} */
  async ensure(id) {
    const db = this.dbOf();
    const item = db.get(id);
    if (!item) return { ok: false, code: 404, reason: '素材不存在' };
    const abs = db.absOf(item);
    if (!(await util.exists(abs))) return { ok: false, code: 404, reason: '源文件不存在' };

    if (item.kind === 'image') return { ok: true, source: abs, mime: util.mimeFor(item.name) };

    const cached = this.fileFor(item.id);
    const st = await util.statOrNull(cached);
    if (st && st.size > 0 && st.mtimeMs >= item.mtimeMs) return { ok: true, source: cached, mime: 'image/jpeg' };

    if (item.kind !== 'video') return { ok: false, code: 404, reason: '该类型没有缩略图' };

    const key = item.id;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.enqueue(() => this.extract(item, abs, cached)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  enqueue(fn) {
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.maxActive && this.queue.length) {
      const job = this.queue.shift();
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

  async extract(item, abs, out) {
    const bin = await this.ffmpeg();
    if (!bin) return { ok: false, code: 503, reason: '未找到 ffmpeg，无法为视频生成缩略图' };
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', tmp];
    let ok = await this.run(bin, ['-ss', '3', ...common], FFMPEG_TIMEOUT_MS);
    if (!ok) ok = await this.run(bin, ['-ss', '0.5', ...common], FFMPEG_TIMEOUT_MS);
    if (!ok) ok = await this.run(bin, ['-ss', '0', ...common], FFMPEG_TIMEOUT_MS);
    if (!ok) return { ok: false, code: 500, reason: 'ffmpeg 抽帧失败（文件可能损坏或没有视频轨）' };
    try {
      await fsp.rename(tmp, out);
    } catch (err) {
      await util.removeIfExists(tmp);
      return { ok: false, code: 500, reason: `写入缩略图失败：${err && err.message}` };
    }
    return { ok: true, source: out, mime: 'image/jpeg' };
  }

  run(bin, args, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return resolve(false);
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* 忽略 */ }
        resolve(false);
      }, timeoutMs);
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
}

module.exports = { Thumbnails, THUMB_WIDTH };
