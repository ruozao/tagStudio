'use strict';
/**
 * exporter.js — 导出：把选中的素材**复制**到指定文件夹（给「数据线传到别的设备」用）。
 *
 * 设计取舍：
 *  - 默认目标 = <导出根>/导出-YYYYMMDD-HHmmss/，每次导出独立子目录，避免和上次混在一起。
 *  - 导出根可以写在库里的 .mtag/exports（默认，跟着库走），也可以在界面上改成任意目录。
 *  - 文件名默认沿用库内的「标签-uuid.扩展名」；也可切到「原始文件名」。
 *  - 复制是手写流式拷贝（4MB 一块），这样能报进度、能在块边界取消。不用 copyFile 是因为
 *    它无法中断，几百 MB 的文件只能干等。
 *  - 附带 manifest.csv / manifest.json：文件名 ↔ 原始来源的对照，方便在别的设备上回溯。
 *  - 可选再打一个 zip（store / 不压缩），方便在手机上一次性接收。
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { EventEmitter } = require('events');
const util = require('./util');
const naming = require('./naming');

const CHUNK = 4 * 1024 * 1024;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitizeSegment(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'x';
}

class ExportJob extends EventEmitter {
  constructor({ id, items, destRoot, subdir, nameMode, makeZip, db }) {
    super();
    this.id = id;
    this.items = items;
    this.destRoot = path.resolve(destRoot);
    this.subdir = subdir;
    // tagged       —— 标签-uuid.扩展名，沿用库里的 uuid（同一素材反复导出名字稳定，便于去重）
    // tagged-fresh —— 标签-新uuid.扩展名（每次导出都是新 uuid，用于把不同设备的文件倒进同一个文件夹）
    // original     —— 入库时的原始文件名
    this.nameMode = ['original', 'tagged-fresh'].includes(nameMode) ? nameMode : 'tagged';
    this.makeZip = !!makeZip;
    this.db = db;
    this.status = 'queued';
    this.error = null;
    this.cancelled = false;
    this.copied = [];
    this.failed = [];
    this.bytesTotal = items.reduce((n, i) => n + (i.size || 0), 0);
    this.bytesDone = 0;
    this.zipPath = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.logs = [];
    this.events = [];
  }

  log(message) {
    this.logs.push({ at: util.nowIso(), message });
    this.emit('progress', this.snapshot());
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      destRoot: this.destRoot,
      destDir: this.destDir,
      count: this.items.length,
      done: this.copied.length + this.failed.length,
      copied: this.copied.length,
      failed: this.failed,
      bytesTotal: this.bytesTotal,
      bytesDone: this.bytesDone,
      zipPath: this.zipPath,
      zipUrl: this.zipPath ? `/api/export/${this.id}/zip` : null,
      manifestUrl: this.manifestPath ? `/api/export/${this.id}/manifest.csv` : null,
      manifestJsonUrl: this.manifestJsonPath ? `/api/export/${this.id}/manifest.json` : null,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastLog: this.logs.length ? this.logs[this.logs.length - 1].message : null,
    };
  }

  cancel() {
    this.cancelled = true;
    this.log('收到取消请求，正在收尾…');
  }

  async run() {
    this.status = 'running';
    this.startedAt = util.nowIso();
    try {
      const sub = this.subdir || `导出-${stamp()}`;
      this.destDir = path.join(this.destRoot, sanitizeSegment(sub));
      if (!util.withinRoot(this.destRoot, this.destDir)) throw new Error('导出子目录越界');
      await util.ensureDir(this.destDir);
      this.log(`目标目录：${this.destDir}`);

      const used = new Set();
      for (const item of this.items) {
        if (this.cancelled) break;
        const abs = this.db.absOf(item);
        if (!(await util.exists(abs))) {
          this.failed.push({ id: item.id, name: item.name, reason: '源文件不存在' });
          this.log(`跳过（源文件不存在）：${item.name}`);
          continue;
        }
        const wanted = this.nameMode === 'original'
          ? (item.origName || path.basename(item.name))
          : this.exportName(item, this.nameMode === 'tagged-fresh' ? util.hex32() : item.id);
        const finalName = uniqueName(wanted, used, this.destDir);
        used.add(finalName.toLowerCase());
        const dest = path.join(this.destDir, finalName);
        // 「原始文件名」模式会带上入库时的子目录（子目录/歌.mp3），所以要先把目录建出来。
        // 顺手再挡一次越界：万一 origName 里带了 .. 也不允许写到目标文件夹外面去。
        if (!util.withinRoot(this.destDir, dest)) {
          this.failed.push({ id: item.id, name: item.name, reason: '导出路径越界' });
          this.log(`跳过（导出路径越界）：${finalName}`);
          continue;
        }
        await util.ensureDir(path.dirname(dest));
        try {
          await this.copyFile(abs, dest, item.size || 0);
          this.copied.push({
            id: item.id,
            file: finalName,
            original: item.origName || path.basename(item.name),
            tags: item.tags || [],
            size: item.size || 0,
            source: abs,
          });
          this.log(`已复制 ${this.copied.length}/${this.items.length}：${finalName}`);
        } catch (err) {
          if (this.cancelled) {
            await util.removeIfExists(dest);
            break;
          }
          this.failed.push({ id: item.id, name: item.name, reason: String(err && err.message) });
          this.log(`复制失败：${finalName} — ${err && err.message}`);
        }
      }

      await this.writeManifest();
      if (this.makeZip && this.copied.length && !this.cancelled) {
        this.log('正在打包 zip…');
        const zipName = `${sanitizeSegment(path.basename(this.destDir))}.zip`;
        this.zipPath = path.join(this.destDir, zipName);
        await this.writeZip(this.zipPath);
        this.log(`zip 完成：${zipName}`);
      }

      this.status = this.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      this.status = 'error';
      this.error = String(err && err.message);
      this.log(`导出失败：${this.error}`);
    } finally {
      this.finishedAt = util.nowIso();
      this.emit('progress', this.snapshot());
      this.emit('end', this.snapshot());
    }
    return this.snapshot();
  }

  /**
   * 导出文件名（tagged 模式）：
   *   打了标签 → 「标签-uuid.ext」（沿用库里的名字）。
   *   没打标签 → 保持原名；真撞名了交给 run() 里的 uniqueName 加 (2)/(3) 后缀。
   * 理由：没打标签的素材本来就靠原文件名认，硬塞一个 uuid 出去等于把唯一的信息抹掉。
   */
  exportName(item, id = item.id) {
    const ext = naming.originalExt(item.name);
    const originalName = path.basename(item.origName || item.name);
    const tags = item.tags || [];
    if (!tags.length) return originalName || (id + ext);
    const built = naming.buildName({ id, ext, originalName, tags });
    return built.name;
  }

  async copyFile(src, dest, expectedSize) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src, { highWaterMark: CHUNK });
      const ws = fs.createWriteStream(dest, { flags: 'w' });
      let lastEmit = 0;
      const cleanup = () => {
        rs.destroy();
        ws.destroy();
      };
      rs.on('error', (err) => { cleanup(); reject(err); });
      ws.on('error', (err) => { cleanup(); reject(err); });
      rs.on('data', (buf) => {
        if (this.cancelled) {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        this.bytesDone += buf.length;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          this.emit('progress', this.snapshot());
        }
      });
      ws.on('finish', () => resolve());
      rs.pipe(ws);
    });
    const st = await fsp.stat(dest);
    if (expectedSize && st.size !== expectedSize) throw new Error(`复制后大小不符（期望 ${expectedSize}，实际 ${st.size}）`);
    return st.size;
  }

  async writeManifest() {
    const rows = [
      ['导出文件名', '原始文件名', '标签', '大小(字节)', 'uuid', '库内相对路径', '来源绝对路径'],
    ];
    for (const row of this.copied) {
      rows.push([
        row.file,
        row.original,
        row.tags.join(' '),
        String(row.size),
        row.id,
        (() => {
          const item = this.db.get(row.id);
          return item ? item.rel : '';
        })(),
        row.source,
      ]);
    }
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    this.manifestPath = path.join(this.destDir, 'manifest.csv');
    await fsp.writeFile(this.manifestPath, '\ufeff' + csv, 'utf8');
    const jsonPath = path.join(this.destDir, 'manifest.json');
    await util.writeJsonAtomic(jsonPath, {
      exportedAt: util.nowIso(),
      destDir: this.destDir,
      count: this.copied.length,
      failed: this.failed,
      items: this.copied.map((c) => ({
        file: c.file,
        original: c.original,
        tags: c.tags,
        size: c.size,
        id: c.id,
        source: c.source,
      })),
    });
    this.manifestJsonPath = jsonPath;
    this.log(`清单已写出：manifest.csv / manifest.json`);
  }

  /**
   * 极简 zip 写入器（只用 zlib，不引依赖）。
   * 用 deflateRaw：对已压缩的媒体文件几乎不省体积，但也不会显著变慢；
   * 需要「零压缩」时可以改 STORE 并自己算 CRC。
   */
  async writeZip(outPath) {
    const zlib = require('zlib');
    const { crc32 } = require('./zipcrc');
    const out = fs.createWriteStream(outPath);
    let streamError = null;
    out.on('error', (err) => { streamError = err; });
    // 用 write 的回调做背压：回调触发即代表这一块已经落盘/进缓冲，不需要手工管 drain。
    const write = (buf) => new Promise((resolve, reject) => {
      if (streamError) return reject(streamError);
      out.write(buf, (err) => (err ? reject(err) : resolve()));
      return undefined;
    });
    const central = [];
    let offset = 0;
    for (const entry of this.copied) {
      if (this.cancelled) break;
      const src = path.join(this.destDir, entry.file);
      await fsp.stat(src);
      const nameBuf = Buffer.from(util.truncateBytes(entry.file, 200), 'utf8');
      const data = await fsp.readFile(src);
      const compressed = zlib.deflateRawSync(data, { level: 1 });
      const crc = crc32(data);
      const useDeflate = compressed.length < data.length;
      const payload = useDeflate ? compressed : data;
      const method = useDeflate ? 8 : 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);              // UTF-8 文件名标志
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await write(local);
      await write(nameBuf);
      await write(payload);
      central.push({ nameBuf, crc, csize: payload.length, usize: data.length, method, offset });
      offset += local.length + nameBuf.length + payload.length;
    }
    const cdStart = offset;
    for (const e of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.method, 10);
      head.writeUInt16LE(0, 12);
      head.writeUInt16LE(0, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.csize, 20);
      head.writeUInt32LE(e.usize, 24);
      head.writeUInt16LE(e.nameBuf.length, 28);
      head.writeUInt16LE(0, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(0, 38);
      head.writeUInt32LE(e.offset, 42);
      await write(head);
      await write(e.nameBuf);
      offset += head.length + e.nameBuf.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    await write(end);
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
    return outPath;
  }
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 目标文件重名时的退让规则。
 * 既要避开「本次任务里已经用掉的名字」，也要避开「目标目录里已经躺着的文件」——
 * 只查前者的话，第二次往同一个文件夹导出会静默覆盖上一次的成果。
 */
function uniqueName(name, used, destDir) {
  const taken = (cand) => {
    if (used.has(cand.toLowerCase())) return true;
    if (!destDir) return false;
    try {
      return fs.existsSync(path.join(destDir, cand));
    } catch {
      return false;
    }
  };
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  for (let i = 2; i < 1000; i += 1) {
    const cand = `${stem}(${i})${ext}`;
    if (!taken(cand)) return cand;
  }
  return `${stem}-${util.hex32().slice(0, 8)}${ext}`;
}

class Exports {
  constructor({ metaRoot, rootOf, dbOf }) {
    this.metaRoot = metaRoot;
    this.rootOf = rootOf;
    this.dbOf = dbOf;
    this.jobs = new Map();
    this.defaultRoot = path.join(metaRoot, util.EXPORT_DIRNAME);
  }

  async init() {
    await util.ensureDir(this.defaultRoot);
  }

  start(opts) {
    const id = util.hex32().slice(0, 12);
    const job = new ExportJob({ id, db: this.dbOf(), ...opts });
    this.jobs.set(id, job);
    job.run().catch((err) => {
      job.status = 'error';
      job.error = String(err && err.message);
      job.emit('progress', job.snapshot());
    });
    return job;
  }

  get(id) {
    return this.jobs.get(String(id)) || null;
  }

  list() {
    return [...this.jobs.values()].map((j) => j.snapshot()).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
}

module.exports = { Exports, ExportJob, uniqueName, sanitizeSegment };
