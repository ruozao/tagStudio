'use strict';
/**
 * db.js — 库的持久层（纯 JSON 文件，零依赖）。
 *
 * 为什么不用 SQLite：本机没有可用的编译工具链保证，而 node:sqlite 在部分 Node 版本上
 * 需要 flag。几千~几万条素材的元数据用一个 JSON 文件 + 原子写完全够用，
 * 换来的好处是这个应用**零依赖**，复制文件夹就能跑。
 *
 * db.json 结构：
 * {
 *   schema: 1,
 *   library: { root, createdAt, updatedAt },
 *   items: { <uuid32>: {rel,name,size,mtimeMs,kind,mime,tags[],inferred?,addedAt,updatedAt} },
 *   tags:  { <foldedTag>: {name,count} },
 *   collections: [ {name, tags[]} ],
 *   stats: { lastScanAt }
 * }
 */

const path = require('path');
const fsp = require('fs').promises;
const util = require('./util');
const naming = require('./naming');
const { validateTags, sortTags, foldTag, normalizeTag, splitTagInput } = require('./tags');

const SCHEMA = 1;
const README_TEMPLATE = `# 把要分类的媒体文件放进这个文件夹

- 支持的素材：视频（mp4/mkv/mov/webm/avi…）、音频（mp3/m4a/flac/wav…）、图片（jpg/png/gif/webp…）
- 子文件夹会被递归扫描；文件夹结构不影响标签，只影响文件在库里的相对路径。
- 打标签后本工具会就地把文件重命名为 \`标签1-标签2-uuid.格式\`（uuid 全局唯一，扩展名原样保留）。
- **没打标签的素材不会改名**，保持你原来起的名字 —— 这样你在打标签时还能照着原名判断。
  「哪些还没分类」在界面上用左边的「未打标签」筛选来看。
- \`.mtag/\` 是本工具自己的元数据目录，不要手动改，也不需要备份（标签存在里面，但素材文件本身可以随时重新扫回来）。
`;

function createItem({ id, rel, name, size, mtimeMs, kind, tags, inferred, origName }) {
  const now = util.nowIso();
  return {
    id: String(id).toLowerCase(),
    rel,
    name,
    // 入库时的原始文件名，只记一次、之后不再变化：
    // 导出时的「原始文件名」模式靠它，否则素材早就被改成本工具的名字了，拿不回原名。
    origName: origName || name,
    size,
    mtimeMs,
    kind: kind || util.classify(name),
    mime: util.mimeFor(name),
    tags: Array.isArray(tags) ? tags : [],
    inferred: !!inferred,
    addedAt: now,
    updatedAt: now,
  };
}

function rebuildTags(db) {
  const map = new Map();
  for (const item of Object.values(db.items)) {
    for (const tag of item.tags || []) {
      const key = foldTag(tag);
      if (!key) continue;
      const prev = map.get(key);
      if (prev) prev.count += 1;
      else map.set(key, { name: normalizeTag(tag), count: 1 });
    }
  }
  db.tags = {};
  for (const key of [...map.keys()].sort()) db.tags[key] = map.get(key);
  return db.tags;
}

class Database {
  constructor(metaRoot) {
    this.metaRoot = metaRoot;
    this.file = path.join(metaRoot, 'db.json');
    this.db = null;
    /** load() 发现 db.json 坏掉时填这里（{file, quarantinedTo, reason}），同时会抛错 */
    this.corrupt = null;
  }

  static async ensureLibraryRoot(root) {
    await util.ensureDir(root);
    const metaRoot = path.join(root, util.META_DIRNAME);
    await util.ensureDir(metaRoot);
    await util.ensureDir(path.join(metaRoot, util.THUMB_DIRNAME));
    await util.ensureDir(path.join(metaRoot, util.EXPORT_DIRNAME));
    await util.ensureDir(path.join(metaRoot, 'journal'));
    // 说明文件放进 .mtag/ 而不是库根目录：库根目录是用户的素材地盘，
    // 往那里写一个 .md 会被扫描当成素材收进库（还会被改名成「未分类-uuid.md」），
    // 既多余又会让用户困惑「这东西哪来的」。.mtag 是扫描时明确跳过的目录。
    const readme = path.join(metaRoot, '把素材放这里.md');
    if (!(await util.exists(readme))) await fsp.writeFile(readme, README_TEMPLATE, 'utf8');
    return metaRoot;
  }

  async load(root) {
    // 先看目录里到底有没有 db.json —— readJson 在"文件不存在"和"文件读不动/解析不了"
    // 两种情况都给 fallback，分不清就等于把「损坏」当成「新建库」：
    // 接着 save() 会把空库覆盖写回去，用户的标签就永久没了。
    const exists = await util.statOrNull(this.file);
    if (!exists) {
      return this.reset(root);                       // 头一次开库，正常新建
    }

    this.corrupt = null;
    const data = await util.readJson(this.file, null);
    if (!data || data.schema !== SCHEMA) {
      // 文件确实在那儿，却读不出一个像样的库。**绝不覆盖**：把坏文件挪到一边留证，
      // 然后抛出异常让上层拒绝打开这个库 —— 宁可打不开，也不能把标签悄悄清空。
      const quarantined = `${this.file}.损坏-${util.hex32().slice(0, 8)}`;
      let quarantinedTo = null;
      try {
        await fsp.rename(this.file, quarantined);
        quarantinedTo = quarantined;
      } catch {
        // 连挪都挪不动（被锁住/没权限）——那更说明不该动它，保持原样就好
      }
      this.corrupt = {
        file: this.file,
        quarantinedTo,
        reason: data === null ? '文件读不出来或不是合法 JSON' : `schema 对不上（期望 ${SCHEMA}，实际 ${data.schema}）`,
      };
      const err = new Error(
        `元数据文件损坏，已拒绝打开这个库以免清空标签：${this.corrupt.reason}` +
        (quarantinedTo ? `。坏文件已挪到 ${quarantinedTo}` : '。文件挪不动，保持原样未改动')
      );
      err.code = 'DB_CORRUPT';
      throw err;
    }
    if (!data.items) data.items = {};
    if (!data.tags) data.tags = {};
    if (!Array.isArray(data.collections)) data.collections = [];
    if (!data.stats) data.stats = { lastScanAt: null };
    data.library = data.library || {};
    data.library.root = path.resolve(root);       // 库可以整体搬走，root 以启动参数为准
    this.db = data;
    return this.db;
  }

  /** 建一个全新的空库（只在"目录里确实没有 db.json"时才该走这里） */
  async reset(root) {
    this.db = {
      schema: SCHEMA,
      library: { root: path.resolve(root), createdAt: util.nowIso(), updatedAt: util.nowIso() },
      items: {},
      tags: {},
      collections: [],
      stats: { lastScanAt: null },
    };
    await this.save();
    return this.db;
  }

  async save() {
    this.db.library.updatedAt = util.nowIso();
    await util.writeJsonAtomic(this.file, this.db);
  }

  // ------------------------------------------------------------ 查询

  items() {
    return Object.values(this.db.items);
  }

  get(id) {
    return this.db.items[String(id || '').toLowerCase()] || null;
  }

  put(item) {
    this.db.items[item.id] = item;
    return item;
  }

  remove(id) {
    delete this.db.items[String(id || '').toLowerCase()];
  }

  absOf(item) {
    return util.absFrom(this.db.library.root, item.rel);
  }

  tagList() {
    return Object.entries(this.db.tags)
      .map(([key, v]) => ({ key, name: v.name, count: v.count }))
      .sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : 1));
  }

  /** 过滤：tags 全部命中（AND）/ any 命中其一（OR）/ kind / 未打标签 / 关键词 */
  query({ tags = [], any = [], kind = '', untagged = false, q = '', ids = null, limit = 0, offset = 0, sort = 'added-desc' } = {}) {
    const andKeys = tags.map(foldTag).filter(Boolean);
    const anyKeys = any.map(foldTag).filter(Boolean);
    const needle = String(q || '').toLowerCase();
    const idSet = ids ? new Set(ids.map((s) => String(s).toLowerCase())) : null;
    let out = this.items().filter((item) => {
      if (idSet && !idSet.has(item.id)) return false;
      if (kind && item.kind !== kind) return false;
      const itemKeys = new Set((item.tags || []).map(foldTag));
      if (untagged && itemKeys.size > 0) return false;
      for (const key of andKeys) if (!itemKeys.has(key)) return false;
      if (anyKeys.length && !anyKeys.some((key) => itemKeys.has(key))) return false;
      if (needle) {
        // 关键词也要能命中**原始文件名**：素材一旦打了标签就会被改名成「标签-uuid.扩展名」，
        // 用户想找的往往是"我当初拷进来的那个名字"，而不是那串 uuid。
        const hay = `${item.name}\n${item.rel}\n${item.origName || ''}\n${(item.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    out = sortItems(out, sort);
    const total = out.length;
    if (offset) out = out.slice(offset);
    if (limit > 0) out = out.slice(0, limit);
    return { total, items: out };
  }

  // ------------------------------------------------------------ 变更

  /** 打标签：校验 + 去重 + 排序存库（不负责改名，改名在 library.js） */
  setTags(id, rawTags) {
    const v = validateTags(rawTags);
    if (!v.ok) return v;
    const item = this.get(id);
    if (!item) return { ok: false, reason: '素材不存在', code: 404 };
    item.tags = sortTags(v.tags);
    item.inferred = false;
    item.updatedAt = util.nowIso();
    rebuildTags(this.db);
    return { ok: true, item };
  }

  addTags(id, rawTags) {
    const item = this.get(id);
    if (!item) return { ok: false, reason: '素材不存在', code: 404 };
    const merged = new Set([...(item.tags || []).map(foldTag)]);
    const added = [];
    for (const raw of splitTagInput(Array.isArray(rawTags) ? rawTags.join(',') : rawTags)) {
      const key = foldTag(raw);
      if (merged.has(key)) continue;
      merged.add(key);
      added.push(raw);
    }
    return this.setTags(id, [...(item.tags || []), ...added]);
  }

  removeTags(id, rawTags) {
    const item = this.get(id);
    if (!item) return { ok: false, reason: '素材不存在', code: 404 };
    const drop = new Set((Array.isArray(rawTags) ? rawTags : [rawTags]).map(foldTag));
    return this.setTags(id, (item.tags || []).filter((t) => !drop.has(foldTag(t))));
  }

  setCollections(list) {
    if (!Array.isArray(list)) return { ok: false, reason: 'collections 必须是数组' };
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const name = normalizeTag(entry.name);
      if (!name) continue;
      const tags = sortTags(Array.from(new Set((entry.tags || []).map(normalizeTag).filter(Boolean))));
      out.push({ name, tags });
    }
    this.db.collections = out;
    return { ok: true, collections: out };
  }

  collections() {
    return this.db.collections || [];
  }

  stats() {
    const items = this.items();
    const byKind = { video: 0, audio: 0, image: 0, other: 0 };
    let tagged = 0;
    let bytes = 0;
    for (const item of items) {
      byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      if ((item.tags || []).length) tagged += 1;
      bytes += item.size || 0;
    }
    return {
      total: items.length,
      tagged,
      untagged: items.length - tagged,
      byKind,
      bytes,
      tags: Object.keys(this.db.tags).length,
      lastScanAt: this.db.stats.lastScanAt,
      root: this.db.library.root,
    };
  }
}

function sortItems(items, sort) {
  const arr = [...items];
  switch (sort) {
    case 'name-asc':
      return arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    case 'name-desc':
      return arr.sort((a, b) => b.name.localeCompare(a.name, 'zh'));
    case 'size-desc':
      return arr.sort((a, b) => (b.size || 0) - (a.size || 0));
    case 'size-asc':
      return arr.sort((a, b) => (a.size || 0) - (b.size || 0));
    case 'mtime-desc':
      return arr.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    case 'tags-desc':
      return arr.sort((a, b) => (b.tags || []).length - (a.tags || []).length);
    case 'tags-asc':
      return arr.sort((a, b) => (a.tags || []).length - (b.tags || []).length);
    case 'added-asc':
      return arr.sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
    case 'added-desc':
    default:
      return arr.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  }
}

module.exports = {
  SCHEMA,
  Database,
  createItem,
  rebuildTags,
  sortItems,
  README_TEMPLATE,
  naming,
};
