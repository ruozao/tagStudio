'use strict';
/**
 * journal.js — 重命名「预写日志（write-ahead log）」。
 *
 * 为什么必须有它：一次「改标签」= 改磁盘上的文件名 + 改库里的记录，这是两个存储。
 * 中间断电/被杀进程会出现三种状态：文件已改名但库里还是旧名（能靠重新扫描救回），
 * 文件没改名但库里已经是新名（**记录指向不存在的文件，标签全丢**）。
 * 所以顺序固定为：
 *
 *   1. 写一条 pending 日志（含 itemId、from、to、tags、ext）
 *   2. 真正 fs.rename
 *   3. 更新内存/磁盘数据库
 *   4. 删掉日志
 *
 * 启动时 `recover()` 读所有残留日志，按「谁在磁盘上」决定补做还是回滚。
 */

const path = require('path');
const fsp = require('fs').promises;
const util = require('./util');

class Journal {
  /** @param {string} metaRoot 库内的 .mtag 目录 */
  constructor(metaRoot) {
    this.dir = path.join(metaRoot, 'journal');
    this.seq = 0;
  }

  async init() {
    await util.ensureDir(this.dir);
  }

  newOpId() {
    this.seq += 1;
    return `${Date.now().toString(36)}-${process.pid.toString(36)}-${this.seq.toString(36)}-${util.hex32().slice(0, 8)}`;
  }

  /** 记录「即将把 from 改名为 to」 */
  async begin(entry) {
    const opId = entry.opId || this.newOpId();
    const record = {
      v: 1,
      opId,
      kind: entry.kind || 'rename',
      itemId: entry.itemId || null,
      from: entry.from,
      to: entry.to,
      tags: entry.tags || null,
      ext: entry.ext || null,
      createdAt: util.nowIso(),
    };
    await util.writeJsonAtomic(path.join(this.dir, `${opId}.json`), record);
    return record;
  }

  async commit(opId) {
    await util.removeIfExists(path.join(this.dir, `${opId}.json`));
  }

  async pending() {
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const rec = await util.readJson(path.join(this.dir, name), null);
      if (rec && rec.from && rec.to) out.push(rec);
    }
    out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return out;
  }

  /**
   * 崩溃恢复。返回 {replayed, rolledBack, lost, conflict} 四类结果，交由上层更新数据库。
   * 判定逻辑只看磁盘事实，不猜：
   *   from 在 & to 不在 → 没改成，重试
   *   to 在   & from 不在 → 改成了，补记账
   *   两个都在            → 冲突，保留 to（新名才是目标），删掉 from，并报出来
   *   两个都不在          → 文件没了，报 lost
   */
  async recover() {
    const list = await this.pending();
    const result = { replayed: [], rolledBack: [], lost: [], conflict: [] };
    for (const rec of list) {
      const fromThere = await util.exists(rec.from);
      const toThere = await util.exists(rec.to);
      if (fromThere && !toThere) {
        try {
          await util.ensureDir(path.dirname(rec.to));
          await fsp.rename(rec.from, rec.to);
          result.replayed.push(rec);
          await this.commit(rec.opId);
        } catch (err) {
          result.conflict.push({ ...rec, error: String(err && err.message) });
        }
      } else if (!fromThere && toThere) {
        result.rolledBack.push(rec);       // 其实已经改完了，只是没来得及提交
        await this.commit(rec.opId);
      } else if (fromThere && toThere) {
        try {
          await fsp.rm(rec.from, { force: true });
        } catch { /* 忽略 */ }
        result.conflict.push(rec);
        await this.commit(rec.opId);
      } else {
        result.lost.push(rec);
        await this.commit(rec.opId);
      }
    }
    return result;
  }
}

module.exports = { Journal };
