'use strict';
/**
 * library.js — 库的业务层：扫描/认领文件、打标签后改名、全局标签改名、导出。
 *
 * 核心不变量（verify.js 会逐条验证）：
 *   I1  每个 item.id 是 32 位 uuid hex，全库唯一。
 *   I2  每个 item.rel 指向一个真实存在的文件；不存在就在扫描时被剔除。
 *   I3  打了标签的素材，文件名恒等于 buildName(id, tags, ext) = 「标签1-标签2-uuid.ext」，
 *       标签顺序就是用户输入的顺序（第一个是主要特点），不会按码点重排；
 *       没打标签的素材**保持入库时的原文件名不动** —— 用户常常就是靠原名判断该打什么
 *       标签的（`2024-08-23 直播录屏.mp4`），一进口就改成「未分类-uuid」等于把这个
 *       依据当场抹掉。「谁还没分类」改用库里的 untagged 筛选来回答。
 *   I4  改名走预写日志：任何时刻崩溃，重启后要么补做改名、要么回到旧名，不会出现
 *       「库里的名字指向不存在的文件」。
 *   I5  文件名按字节预算裁剪，最终绝对路径不超过 MAX_ABS_PATH_CHARS，
 *       保证在 Windows 资源管理器和数据线对拷场景下都可用。
 */

const path = require('path');
const fsp = require('fs').promises;
const util = require('./util');
const naming = require('./naming');
const { foldTag, normalizeTag, uniqueTags, validateTag, validateTags } = require('./tags');
const { createItem, rebuildTags } = require('./db');
const { Journal } = require('./journal');

const KIND_LABEL = { video: '视频', audio: '音频', image: '图片', other: '其它' };

class Library {
  /**
   * @param {object} opts
   * @param {string} opts.root    素材根目录（用户指定）
   * @param {import('./db').Database} opts.db
   * @param {import('./journal').Journal} opts.journal
   */
  constructor({ root, db, journal }) {
    this.root = path.resolve(root);
    this.db = db;
    this.journal = journal;
    this.lastScan = null;
    this.dirtyCount = 0;              // 扫描时发现的外部变化数量，供「自动重扫」判断
    this.onChange = null;
    /** 批处理上下文（见 batch()）：{ relIndex: Map<小写rel, item>, ops: 待提交的日志 opId[] } */
    this._batch = null;
  }

  /**
   * 批处理：一批改名只在最后落一次库，而不是每个文件都把整个 db.json 重写一遍（几千条时差两个数量级）。
   * 预写日志的顺序不变 —— 改名成功的日志一直留着，等库落盘之后才统一删：
   * 中途崩溃时日志还在，重启按「to 在 / from 不在」补记账，不会丢。
   * 可以嵌套，嵌套时并入外层批次。
   */
  async batch(fn) {
    if (this._batch) return fn();
    const relIndex = new Map();
    for (const item of this.db.items()) relIndex.set(item.rel.toLowerCase(), item);
    this._batch = { relIndex, ops: [] };
    try {
      return await fn();
    } finally {
      const { ops } = this._batch;
      this._batch = null;
      await this.db.save();
      for (const opId of ops) await this.journal.commit(opId);
    }
  }

  // ------------------------------------------------------------ 扫描

  static fingerprint(size, mtimeMs) {
    return `${size}:${mtimeMs}`;
  }

  /**
   * 这个文件名是不是「本工具自己取的」？
   * 本工具取的名字只有两种形态：「标签1-标签2-<uuid>.ext」和早期版本的「未分类-<uuid>.ext」，
   * 共同点是**主干尾部一定挂着 32 位 hex**。用户的原始文件名极少长这样，可以据此区分。
   * 用途：补记 origName 时不能把工具自己的名字当成用户的原始名字。
   */
  static looksAutoNamed(name) {
    return !!naming.parseIdFromName(name);
  }

  /**
   * 这个文件名看起来像是「已经被打过标签、但还没挂 uuid」的名字吗？
   * 是的话返回里面的标签（保持文件名里的先后），否则返回 null。
   * 覆盖两种来源：① 以前用本工具打的标签、后来 uuid 被抹掉/从别处拷回来的文件；
   * ② 在别的设备上按同样规则命名的文件。
   * 注意：`2024-08-23 直播录屏.mp4` 也会被认出来（它确实长得一样），所以**只当建议**，
   * 必须由用户确认才真的当标签用。
   */
  static tagSuggestionFor(name) {
    const tags = naming.parseTagSuggestion(name, { validate: validateTag });
    return tags && tags.length ? uniqueTags(tags) : null;
  }

  /**
   * 扫描目录并把变化合并进库。
   * @param {{rename?: boolean, prune?: boolean}} opts
   */
  async scan(opts = {}) {
    const rename = opts.rename !== false;
    const prune = opts.prune !== false;
    const root = this.db.db.library.root;
    const files = await util.walkFiles(root);

    const byRel = new Map();
    const byId = new Map();
    const byFp = new Map();
    for (const item of this.db.items()) {
      byRel.set(item.rel.toLowerCase(), item);
      byId.set(item.id, item);
      const fp = Library.fingerprint(item.size, item.mtimeMs);
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push(item);
    }

    const claimed = new Set();
    const added = [];
    const changed = [];
    const renamedFiles = [];
    const pending = [];

    for (const file of files) {
      // 1) 相对路径直接命中
      let item = byRel.get(file.rel.toLowerCase());
      if (item && !claimed.has(item.id)) {
        claimed.add(item.id);
      } else {
        item = null;
      }

      // 2) 文件名里带 uuid（本工具改过名，或者用户挪过位置）
      if (!item) {
        const idInName = naming.parseIdFromName(file.name);
        if (idInName) {
          const cand = this.db.get(idInName);
          if (cand && !claimed.has(cand.id)) {
            item = cand;
            claimed.add(item.id);
            renamedFiles.push({ id: item.id, from: item.rel, to: file.rel, reason: 'path' });
          }
        }
      }

      // 3) 同尺寸 + 同 mtime 的已知项（外部改名/移动的兜底）
      if (!item) {
        const fp = Library.fingerprint(file.size, file.mtimeMs);
        const cands = (byFp.get(fp) || []).filter((c) => !claimed.has(c.id));
        if (cands.length === 1) {
          item = cands[0];
          claimed.add(item.id);
          renamedFiles.push({ id: item.id, from: item.rel, to: file.rel, reason: 'fingerprint' });
        }
      }

      if (item) {
        if (item.rel !== file.rel || item.name !== file.name) {
          item.rel = file.rel;
          item.name = file.name;
        }
        // 老版本库没有 origName，得补记一个。补记的来源是**磁盘上的当前文件名**，
        // 但如果这个名字本身就是「本工具自己取出来的」就不能用 —— 那会把工具生成的名字
        // 当成用户的原始名字记下来，于是「清空标签恢复原名」永远只能恢复成一串 uuid。
        // 注意这里文件名里的 uuid 可能不是 item.id（改名时会换新 uuid 重试），所以按「格式」判断。
        if (Library.looksAutoNamed(item.origName || item.name)) item.origName = file.rel;        // 认回来之后还得保证磁盘上的名字是规范的：
        // 用户可能把已经打了标签的素材改成「随便起的名字.mp4」这种完全看不出标签的名字，
        // 而库里明明存着标签 —— 那就等于标签没能固化进文件名，正是本工具要避免的情况。
        // 这里不用比字符串，直接算出「按当前标签应该叫什么」，不一样就交给后面的改名环节。
        //
        // 只在**有标签**时才这么纠：没标签的素材本来就该保持原名（见 naming.buildName），
        // 硬算会把用户刚改的名字又"纠正"回去，属于帮倒忙。
        if ((item.tags || []).length
          && this.targetNameFor(item, item.tags, item.id).name !== file.name) {
          if (!changed.includes(item.id)) changed.push(item.id);
        }
        if (item.size !== file.size || item.mtimeMs !== file.mtimeMs) {
          item.size = file.size;
          item.mtimeMs = file.mtimeMs;
          item.updatedAt = util.nowIso();
          changed.push(item.id);
        }
        continue;
      }

      const idInName = naming.parseIdFromName(file.name);
      const tagsFromName = naming.parseTagsFromName(file.name);
      let id = idInName && !this.db.get(idInName) ? idInName : util.hex32();
      while (this.db.get(id)) id = util.hex32();
      let tags = [];
      let inferred = false;
      if (tagsFromName && tagsFromName.length) {
        const cleaned = tagsFromName.filter((t) => t !== naming.UNTAGGED_SEGMENT && validateTag(t).ok);
        if (cleaned.length === tagsFromName.filter((t) => t !== naming.UNTAGGED_SEGMENT).length && cleaned.length) {
          tags = uniqueTags(cleaned);
          inferred = true;                          // 标签是从文件名里读回来的，不是用户这次敲的
        }
      }
      // 原始名字记「相对路径」而不是光秃秃的文件名：导出时把子目录结构一起带过去，
      // 同一批素材在不同子目录里撞了同名文件也不会被压平成一个。
      let origName = file.rel;
      if (idInName) {
        const stem = naming.stemOf(file.name);
        const stripped = stem.slice(0, stem.length - idInName.length).replace(/-$/, '');
        if (stripped) origName = path.posix.join(path.posix.dirname(file.rel), stripped + naming.originalExt(file.name));
      }
      const item2 = createItem({
        id,
        rel: file.rel,
        name: file.name,
        size: file.size,
        mtimeMs: file.mtimeMs,
        kind: util.classify(file.name),
        tags,
        inferred,
        importedNormalized: inferred && !!idInName,
        origName,
      });
      this.db.put(item2);
      claimed.add(item2.id);
      added.push(item2.id);
      pending.push(item2);
    }

    // 未被认领的旧记录：文件真的没了 → 剔除
    const removed = [];
    if (prune) {
      for (const item of this.db.items()) {
        if (claimed.has(item.id)) continue;
        removed.push({ id: item.id, rel: item.rel, name: item.name, tags: item.tags });
        if (rename) {
          const op = await this.journal.begin({
            kind: 'prune', itemId: item.id, from: this.db.absOf(item), to: null,
            tags: item.tags, ext: naming.originalExt(item.name),
          });
          await this.journal.commit(op.opId);
        }
        this.db.remove(item.id);
      }
    }

    rebuildTags(this.db.db);

    // 扫完再统一算一遍「文件名里像是标签」的建议。
    // 放在这里而不是扫描循环里，是因为新增和认领两条路径都要覆盖。
    // 「用户点过不用了」的判定绑在**当时的文件名**上：文件名一旦变了（用户自己重命名、
    // 或采纳了别的标签），旧决定就失效，重新给建议是合理的。
    const suggestKeys = new Set();
    const ignoredSuggestions = [];
    // 这两条「要不要重写库」的判断都靠比较前后值：只改内存不落盘的那次扫描不该写文件。
    let suggestDirty = false;
    const setSuggest = (item, next) => {
      const prev = Array.isArray(item.tagSuggest) ? item.tagSuggest.join('\u0001') : '';
      const after = Array.isArray(next) ? next.join('\u0001') : '';
      if (prev === after) return;
      item.tagSuggest = next;
      suggestDirty = true;
    };
    const clearIgnored = (item) => {
      if (!item.tagSuggestIgnored) return;
      item.tagSuggestIgnored = false;
      item.tagSuggestIgnoredName = null;
      suggestDirty = true;
    };
    for (const item of this.db.items()) {
      // 已经有标签的素材不用再猜：它的文件名本来就是本工具生成的「标签-uuid.扩展名」，
      // 再拿它去猜会把「08」「2024」这种噪声当成新标签反复提示。
      if ((item.tags || []).length) {
        setSuggest(item, null);
        clearIgnored(item);
        continue;
      }
      const sug = Library.tagSuggestionFor(item.name);
      if (!sug) {
        setSuggest(item, null);
        clearIgnored(item);
        continue;
      }
      setSuggest(item, sug);
      if (item.tagSuggestIgnored && item.tagSuggestIgnoredName === item.name) {
        ignoredSuggestions.push(item.id);
      } else {
        clearIgnored(item);
        suggestKeys.add(sug.map((t) => t.toLowerCase()).join('\u0000'));
      }
    }

    let renameResult = { renamed: [], failed: [] };
    const savesBefore = this.db.saveSeq || 0;
    if (rename) renameResult = await this.applyNaming(pending.concat(changed.map((id) => this.db.get(id)).filter(Boolean)));

    this.lastScan = util.nowIso();
    this.db.db.stats.lastScanAt = this.lastScan;
    this.dirtyCount = added.length + removed.length + renamedFiles.length;
    // 什么变化都没有就别重写 db.json。这个库 18,000 条、13MB：每 45 秒写一遍纯属白费力气，
    // 而且写的还是 F: 那块大盘 —— 用户这时候点一下「打标签」，得排在这 13MB 的写后面。
    const dirty = (added.length + changed.length + removed.length + renamedFiles.length
      + renameResult.renamed.length + renameResult.failed.length) > 0 || suggestDirty;
    // 改名那一步如果开过批处理，末尾已经整库落盘一次了（而且那时内存里的改动已经全在），
    // 就不用再写第二遍；否则这里补一次。
    const savedByBatch = (this.db.saveSeq || 0) !== savesBefore;
    if (dirty && !savedByBatch) await this.db.save();

    const result = {
      ok: true,
      scannedAt: this.lastScan,
      // false = 这一趟什么都没变，db.json 一个字都没写（省掉 13MB 写盘，见上面 dirty 的说明）
      saved: dirty,
      filesOnDisk: files.length,
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      matched: renamedFiles.length,
      renamed: renameResult.renamed.length,
      renameFailed: renameResult.failed.length,
      failures: renameResult.failed,
      removedItems: removed.slice(0, 20),
      // 供「自动识别出以前打过的标签」弹窗用：suggested 是待确认的**不同标签组合**种数
      suggested: suggestKeys.size,
      suggestIgnored: ignoredSuggestions.length,
      stats: this.db.stats(),
    };
    if (this.onChange) this.onChange(result);
    return result;
  }

  // ------------------------------------------------------------ 命名 / 改名

  /** 单文件在「绝对路径总长」约束下的目标文件名 */
  targetNameFor(item, tags, id) {
    const ext = naming.originalExt(item.name);
    // 没打标签时目标是「入库时的原始文件名」（见 naming.buildName 的说明），
    // 所以这里要把 origName 传进去 —— 传 item.name 的话，把标签清空之后就找不回原名了。
    //
    // 例外：标签本来就是**从这个文件名里读出来的**（importedNormalized，比如外部拷进来一个
    // 「旅行-风景-<uuid>.jpg」）。这种文件的"原始名"里已经带着 uuid 和旧标签了，如果清空标签时
    // 按 origName 退回，就会退回 `旅行-风景.jpg` —— 名字里还带着旧标签，下次扫描又会把它认成
    // 待确认的建议，来回折腾。所以这种情况下保留组件自己生成的名字（纯 uuid）。
    const originalName = item.importedNormalized
      ? naming.buildName({ id, ext, originalName: '', tags: [] }).name
      : path.basename(item.origName || item.name);
    const dir = path.dirname(this.db.absOf(item));
    const sep = path.sep;
    let budget = naming.DEFAULT_BUDGET_BYTES;
    for (let i = 0; i < 6; i += 1) {
      const built = naming.buildName({ id, ext, originalName, tags, budget });
      const abs = path.join(dir, built.name);
      if (abs.length <= util.MAX_ABS_PATH_CHARS) return built;
      const room = budget - (abs.length - util.MAX_ABS_PATH_CHARS);
      if (room >= 40) budget = room;              // 还有得救，继续收
      else break;
    }
    const built = naming.buildName({ id, ext, originalName, tags, budget: 40 });
    return built;
  }

  /** 只算目标名，不落盘。给前端预览用。 */
  preview(item, tags) {
    const ordered = uniqueTags(tags || []);
    const built = this.targetNameFor(item, ordered, item.id);
    const dir = path.dirname(this.db.absOf(item));
    const abs = path.join(dir, built.name);
    return {
      file: built.name,
      rel: util.relTo(this.db.db.library.root, abs),
      abs,
      droppedTags: built.droppedTags,
      bytes: util.bbytes(built.name),
      pathChars: abs.length,
      pathOk: abs.length <= util.MAX_ABS_PATH_CHARS,
    };
  }

  /** 库里是否已有人占了这个名字（用 rel 小写比较，跟 Windows 大小写不敏感一致） */
  occupantOf(rel, exceptId) {
    const key = rel.toLowerCase();
    if (this._batch) {
      const hit = this._batch.relIndex.get(key);
      return hit && hit.id !== exceptId ? hit : null;
    }
    for (const item of this.db.items()) {
      if (item.id === exceptId) continue;
      if (item.rel.toLowerCase() === key) return item;
    }
    return null;
  }

  /**
   * 把一个素材的文件改到「按当前标签应得的名字」。
   * 已是目标名 → 空操作（幂等）。目标被占 → 换一个新 uuid 再试（uuid 全局唯一，所以必然能成）。
   */
  async renameItem(item, opts = {}) {
    const wantedId = opts.id || item.id;
    if (!wantedId || !/^[0-9a-f]{32}$/.test(wantedId)) return { ok: false, reason: 'uuid 非法' };

    // 目标名不含 uuid（未打标签、退回原名）时换 uuid 没用，只能给原名加 (2)/(3) 后缀退让
    const idInTarget = (item.tags || []).length > 0 || !!item.importedNormalized;
    const maxAttempts = idInTarget ? 6 : 50;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const id = attempt === 0 || !idInTarget ? wantedId : util.hex32();
      const built = this.targetNameFor(item, item.tags || [], id);
      if (!idInTarget && attempt > 0) {
        const ext = naming.originalExt(built.name);
        built.name = `${naming.stemOf(built.name)}(${attempt + 1})${ext}`;
        built.fullName = built.name;
      }
      const dir = path.dirname(this.db.absOf(item));
      const targetAbs = path.join(dir, built.name);
      const currentAbs = this.db.absOf(item);

      if (path.resolve(currentAbs) === path.resolve(targetAbs)) {
        return { ok: true, changed: false, id, name: built.name, droppedTags: built.droppedTags };
      }
      const targetRel = util.relTo(this.db.db.library.root, targetAbs);
      const occupant = this.occupantOf(targetRel, item.id);
      const diskBusy = occupant || (await util.exists(targetAbs));
      if (diskBusy) continue;                      // 换 uuid 重试

      const record = await this.journal.begin({
        kind: 'rename',
        itemId: item.id,
        from: currentAbs,
        to: targetAbs,
        tags: item.tags || [],
        ext: naming.originalExt(item.name),
      });
      try {
        await fsp.rename(currentAbs, targetAbs);
      } catch (err) {
        await this.journal.commit(record.opId);
        return { ok: false, reason: `改名失败：${err && err.message}`, from: currentAbs, to: targetAbs };
      }
      const oldId = item.id;
      item.id = id;
      item.rel = targetRel;
      item.name = built.name;
      item.mime = util.mimeFor(built.name);
      item.updatedAt = util.nowIso();
      if (oldId !== id) {
        delete this.db.db.items[oldId];
        this.db.db.items[id] = item;
      }
      if (this._batch) {
        this._batch.relIndex.delete(util.relTo(this.db.db.library.root, currentAbs).toLowerCase());
        this._batch.relIndex.set(targetRel.toLowerCase(), item);
        this._batch.ops.push(record.opId);         // 批次结束、库落盘之后再删日志
      } else {
        await this.db.save();                      // 记录先落盘，再删日志：宁可重复改名也不丢文件
        await this.journal.commit(record.opId);
      }
      return { ok: true, changed: true, id, name: built.name, droppedTags: built.droppedTags, from: util.relTo(this.db.db.library.root, currentAbs), to: targetRel };
    }
    return { ok: false, reason: `连续 ${maxAttempts} 次都撞上已存在的文件名，已放弃（请检查库目录）` };
  }

  /** 给一批素材把文件整理成目标名（扫描后统一收口，保证 I3 成立） */
  async applyNaming(items) {
    const list = (items || []).filter(Boolean);
    // 没有要整理的：连批处理都不开。batch() 收尾必定写一次库（13MB），
    // 而 45 秒一趟的定时扫描绝大多数时候本来就是「一个都没变」—— 这一下就是白写。
    if (!list.length) return { renamed: [], failed: [] };
    return this.batch(async () => {
      const renamed = [];
      const failed = [];
      for (const item of list) {
        const res = await this.renameItem(item);
        if (res.ok && res.changed) renamed.push({ id: item.id, name: item.name });
        else if (!res.ok) failed.push({ id: item.id, name: item.name, reason: res.reason });
      }
      return { renamed, failed };
    });
  }

  /** 打标签（可增可删可覆盖）→ 改名 → 落库。单一入口，保证磁盘与库永远同向。 */
  async applyTags(id, { tags, add, remove, mode = 'set' } = {}) {
    const item = this.db.get(id);
    if (!item) return { ok: false, reason: '素材不存在', code: 404 };

    let next;
    if (mode === 'add') next = [...(item.tags || []), ...(add || tags || [])];
    else if (mode === 'remove') {
      const drop = new Set((remove || tags || []).map(foldTag));
      next = (item.tags || []).filter((t) => !drop.has(foldTag(t)));
    } else next = tags || [];

    const res = this.db.setTags(item.id, next);
    if (!res.ok) return res;
    const renamed = await this.renameItem(res.item);
    if (!this._batch) await this.db.save();
    if (!renamed.ok) {
      return { ok: false, reason: renamed.reason, code: 500, item: this.db.get(res.item.id), tagsSaved: true };
    }
    return {
      ok: true,
      item: this.db.get(res.item.id),
      rename: { changed: !!renamed.changed, name: renamed.name, droppedTags: renamed.droppedTags || [] },
      tags: this.db.tagList(),
    };
  }

  /** 批量：给多个素材加/删同一组标签 */
  async applyTagsBulk(ids, { add, remove, mode } = {}) {
    // mode 没给就按「给了 add 就是加、给了 remove 就是删」推断，绝不落到 'set'：
    // applyTags 的默认值是 'set'，而 set 走的是 next = tags || []，
    // 于是 {add:['x']} 这种最普通的调用会把原有标签整批清空（真踩过：
    // 批量加标签把已打标签的素材标签洗白了，文件却因为 tags=[] 而不再改名）。
    const useMode = mode || (Array.isArray(add) && add.length ? 'add'
      : Array.isArray(remove) && remove.length ? 'remove'
        : 'set');
    return this.batch(async () => {
      const results = [];
      const failures = [];
      for (const id of ids) {
        const res = await this.applyTags(id, { add, remove, mode: useMode });
        if (res.ok) results.push({ id, name: res.item.name, rename: res.rename });
        else failures.push({ id, reason: res.reason });
      }
      return { ok: failures.length === 0, count: results.length, results, failures };
    });
  }

  /** 全局改标签名：库里所有用到该标签的素材一起改 + 一起改名（含合并到已有标签的情形） */
  async renameTagGlobal(fromRaw, toRaw, opts = {}) {
    const from = normalizeTag(fromRaw);
    const to = normalizeTag(toRaw);
    if (!from || !to) return { ok: false, reason: '旧标签和新标签都不能为空' };
    const v = validateTag(to);
    if (!v.ok) return v;
    const fromKey = foldTag(from);
    const affected = this.db.items().filter((item) => (item.tags || []).some((t) => foldTag(t) === fromKey));
    const dryRun = opts.dryRun === true;
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        affected: affected.length,
        mergedInto: null,
        target: to,
        items: affected.slice(0, 50).map((i) => ({ id: i.id, name: i.name, tags: i.tags })),
      };
    }
    const renamed = [];
    const failed = [];
    await this.batch(async () => {
      for (const item of affected) {
        const next = uniqueTags((item.tags || []).map((t) => (foldTag(t) === fromKey ? to : t)));
        const res = this.db.setTags(item.id, next);
        if (!res.ok) {
          failed.push({ id: item.id, reason: res.reason });
          continue;
        }
        const r = await this.renameItem(res.item);
        if (r.ok) renamed.push({ id: item.id, name: r.name, changed: !!r.changed });
        else failed.push({ id: item.id, reason: r.reason });
      }
    });
    return {
      ok: true,
      from,
      to,
      affected: affected.length,
      renamed: renamed.filter((r) => r.changed).length,
      unchanged: renamed.filter((r) => !r.changed).length,
      failures: failed,
      tags: this.db.tagList(),
    };
  }

  /** 合并标签（把 a,b,c 都并到 target） */
  async mergeTags(sources, target) {
    const results = [];
    await this.batch(async () => {
      for (const src of sources) {
        if (foldTag(src) === foldTag(target)) continue;
        results.push(await this.renameTagGlobal(src, target));
      }
    });
    return { ok: true, results, tags: this.db.tagList() };
  }

  /** 只删标签定义：把所有素材上的该标签摘掉（不改名到「未分类」以外的东西） */
  async deleteTagGlobal(name) {
    const key = foldTag(name);
    const affected = this.db.items().filter((item) => (item.tags || []).some((t) => foldTag(t) === key));
    const failures = [];
    await this.batch(async () => {
      for (const item of affected) {
        this.db.setTags(item.id, (item.tags || []).filter((t) => foldTag(t) !== key));
        const r = await this.renameItem(item);
        // 单个失败不阻断整批，但要报出来：标签已摘掉、文件名却还带着它
        if (!r.ok) failures.push({ id: item.id, name: item.name, reason: r.reason });
      }
    });
    return { ok: failures.length === 0, affected: affected.length, failures, tags: this.db.tagList() };
  }

  /** 启动时的崩溃恢复：把日志里的残留操作做完，并让库与磁盘重新对齐 */
  async recover() {
    const result = await this.journal.recover();
    // 改名已经落到磁盘、库却没来得及保存（批处理中途崩溃时可能是一整批）：
    // 日志里记着目标路径和当时的标签，以日志为准把记录补齐，否则标签只剩在文件名里、库里是空的。
    const root = this.db.db.library.root;
    for (const rec of [...result.replayed, ...result.rolledBack].sort(Journal.byOrder)) {
      if (rec.kind !== 'rename' || !rec.itemId || !util.withinRoot(root, rec.to)) continue;
      const item = this.db.get(rec.itemId);
      if (!item) continue;
      if (Array.isArray(rec.tags)) {
        const v = validateTags(rec.tags);
        if (v.ok) item.tags = v.tags;
      }
      item.rel = util.relTo(root, rec.to);
      item.name = path.basename(rec.to);
      item.mime = util.mimeFor(item.name);
      // 撞名时 renameItem 会换新 uuid，记录的 id 要跟着文件名走
      const newId = naming.parseIdFromName(item.name);
      if (newId && newId !== item.id && !this.db.get(newId)) {
        delete this.db.db.items[item.id];
        item.id = newId;
        this.db.db.items[newId] = item;
      }
    }
    let rescan = null;
    if (result.replayed.length || result.rolledBack.length || result.lost.length || result.conflict.length) {
      rescan = await this.scan({ rename: true, prune: true });
    }
    return { ...result, rescan: rescan ? { added: rescan.added, removed: rescan.removed, renamed: rescan.renamed } : null };
  }

  // ------------------------------------------------ 「文件名里像是标签」的建议

  static #sugKey(tags) {
    return (tags || []).map((t) => foldTag(t)).join('\u0000');
  }

  /**
   * 待用户确认的建议列表。
   * 按「标签组合」合并，先后顺序也算在内：`轻语-助眠` 和 `助眠-轻语` 是两组。
   * 同一组点一次全采纳。
   */
  suggestions() {
    const groups = new Map();
    for (const item of this.db.items()) {
      // 已经有标签的不再猜（详见 scan 里的注释）
      if ((item.tags || []).length) continue;
      const sug = item.tagSuggest;
      if (!sug || !sug.length) continue;
      if (item.tagSuggestIgnored && item.tagSuggestIgnoredName === item.name) continue;
      const key = Library.#sugKey(sug);
      let g = groups.get(key);
      if (!g) {
        g = { tags: sug, ids: [], items: [], bytes: 0 };
        groups.set(key, g);
      }
      g.ids.push(item.id);
      g.bytes += item.size || 0;
      if (g.items.length < 8) {
        const view = this.itemView(item);
        g.items.push({
          id: item.id, name: item.name, origName: view.origName,
          kind: item.kind, kindLabel: view.kindLabel, sizeText: view.sizeText,
          target: this.preview(item, sug).file,
        });
      }
    }
    const list = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
    return { ok: true, count: list.length, itemCount: list.reduce((n, g) => n + g.ids.length, 0), groups: list };
  }

  /**
   * 弹窗里"标签勾选框"改动之后，重算每条的预览名。
   *
   * 为什么放在服务端：命名要遵守 UTF-8 字节预算和绝对路径长度约束
   * （`targetNameFor` 里那套迭代收缩）。前端再实现一份早晚会和这里算得不一样，
   * 所以只让它把"用户勾了哪些标签"传上来，名字由这里算。
   *
   * @param {Array<{id: string, tags: string[]}>} pairs
   * @returns {{ok: boolean, previews: Array<object>}}
   */
  previewSuggestions(pairs = []) {
    const byId = new Map(this.db.items().map((i) => [i.id, i]));
    const previews = [];
    for (const p of pairs) {
      const id = String((p && p.id) || '');
      const item = byId.get(id);
      if (!item) { previews.push({ id, target: null, reason: '素材不存在' }); continue; }
      const raw = Array.isArray(p.tags) ? p.tags : [];
      const bad = raw.map((t) => validateTag(t)).find((v) => !v.ok);
      if (bad) { previews.push({ id, target: null, reason: bad.reason }); continue; }
      const tags = uniqueTags(raw);
      const pv = this.preview(item, tags);
      previews.push({
        id, target: pv.file, tags,
        droppedTags: pv.droppedTags || [],
        bytes: pv.bytes, pathOk: pv.pathOk,
      });
    }
    return { ok: true, previews };
  }

  /**
   * 采纳建议：把认出来的标签正式打上（于是文件名也会变成规范的「标签-uuid.扩展名」）。
   * @param {string[]} ids            要采纳的素材
   * @param {object} [opts]
   * @param {string[]} [opts.tags]    只采纳这个标签组合的素材；不给就采纳传入 ids 的全部
   * @param {string[]} [opts.ignore]  这些素材按「不用了」处理
   * @param {object} [opts.tagMap]    `{ [id]: string[] }`：这一条只采纳其中这几个标签
   *                                  （弹窗里用户可以逐个标签取消勾选）
   */
  async acceptSuggestions(ids = [], opts = {}) {
    const byId = new Map(this.db.items().map((i) => [i.id, i]));
    const wantKey = opts.tags && opts.tags.length ? Library.#sugKey(opts.tags) : null;
    const accepted = [];
    const skipped = [];
    const failed = [];
    const droppedTags = [];

    await this.batch(async () => {
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) { failed.push({ id, reason: '素材不存在' }); continue; }
        const sug = item.tagSuggest;
        if (!sug || !sug.length) { skipped.push(id); continue; }
        if (wantKey && Library.#sugKey(sug) !== wantKey) { skipped.push(id); continue; }

        // 用户可能在弹窗里逐条取消了某些标签的勾选：那就只采纳剩下的那几个。
        // 全取消 = 这条等于没被选上（跳过，别把文件名动了又什么都不打）。
        let use = sug;
        if (opts.tagMap && Object.prototype.hasOwnProperty.call(opts.tagMap, id)) {
          const picked = Array.isArray(opts.tagMap[id]) ? opts.tagMap[id] : [];
          const bad = picked.map((t) => validateTag(t)).find((v) => !v.ok);
          if (bad) { failed.push({ id, reason: bad.reason }); continue; }
          // 只允许从"本文件识别出来的标签"里挑，不能顺手塞进来别的标签
          const allowed = new Set(sug.map(foldTag));
          use = uniqueTags(picked.filter((t) => allowed.has(foldTag(t))));
          if (!use.length) { skipped.push(id); continue; }
        }

        const prevTags = [...(item.tags || [])];
        const merged = uniqueTags([...prevTags, ...use]);
        const written = this.db.setTags(item.id, merged);
        if (!written.ok) { failed.push({ id, reason: written.reason }); continue; }
        const r = await this.renameItem(written.item);
        if (!r.ok) { this.db.setTags(item.id, prevTags); failed.push({ id, reason: r.reason }); continue; }
        // 标签太多塞不进文件名时会丢末尾的标签，得如实告诉用户，不能悄悄丢
        const built = this.targetNameFor(written.item, merged, written.item.id);
        if (built.droppedTags && built.droppedTags.length) droppedTags.push({ id, name: r.name, dropped: built.droppedTags });
        accepted.push({ id, name: r.name, changed: !!r.changed, tags: merged });
      }
    });
    rebuildTags(this.db.db);
    // 采纳之后这些素材已经有标签了，建议列表要重新算（否则弹窗里还留着已经处理过的条目）
    await this.scan({ rename: false, prune: false });
    return {
      ok: failed.length === 0,
      accepted: accepted.length,
      acceptedItems: accepted,
      skipped: skipped.length,
      droppedTags,
      failures: failed,
      remaining: this.suggestions().count,
      stats: this.db.stats(),
      tags: this.db.tagList(),
    };
  }

  /** 把这些素材的建议标成「不用了」，以后不再弹（除非文件名又变了） */
  async ignoreSuggestions(ids = []) {
    const byId = new Map(this.db.items().map((i) => [i.id, i]));
    let ignored = 0;
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) continue;
      item.tagSuggestIgnored = true;
      item.tagSuggestIgnoredName = item.name;
      item.updatedAt = util.nowIso();
      ignored += 1;
    }
    await this.db.save();
    return { ok: true, ignored, remaining: this.suggestions().count };
  }

  itemView(item, opts = {}) {
    const abs = this.db.absOf(item);
    return {
      id: item.id,
      name: item.name,
      rel: item.rel,
      // 入库时用户给的原始名字。打了标签之后 name 会变成「标签-uuid.扩展名」，
      // 这个字段是唯一还能看出"这原本是哪个文件"的线索，界面三处都要用它。
      origName: item.origName || item.name,
      // 界面据此把还没打标签的素材标成「待分类」
      untagged: !(item.tags || []).length,
      dir: util.toPosix(path.dirname(abs)),
      size: item.size,
      mtimeMs: item.mtimeMs,
      kind: item.kind,
      mime: item.mime,
      tags: item.tags || [],
      inferred: !!item.inferred,
      // 「从文件名里认出、还没确认」的标签候选；界面据此弹窗问用户要不要采纳
      tagSuggest: item.tagSuggest && item.tagSuggest.length ? item.tagSuggest : null,
      addedAt: item.addedAt,
      updatedAt: item.updatedAt,
      playable: util.browserPlayable(item.name),
      sizeText: util.humanBytes(item.size),
      kindLabel: KIND_LABEL[item.kind] || '其它',
      url: `/api/media/${item.id}`,
      // 带版本号：缩略图按 mtime 重算，源文件一改 mtime 就变，浏览器不会继续拿一天前那张旧封面
      //（/api/thumb 的响应是 max-age=86400，不带这个参数改了文件也看不出变化）。
      thumbUrl: `/api/thumb/${item.id}?v=${item.mtimeMs || 0}`,
      downloadUrl: `/api/media/${item.id}?dl=1`,
      ...(opts.extra || {}),
    };
  }
}

module.exports = { Library, KIND_LABEL };
