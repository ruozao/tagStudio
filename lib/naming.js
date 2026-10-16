'use strict';
/**
 * naming.js — 「标签1-标签2-uuid.格式」的命名规则。
 *
 * 规则（会被 verify.js 逐条验证）：
 *   1. 扩展名原样保留（含 .tar.gz 这种双扩展、无扩展名两种情况）。
 *   2. uuid 是 32 位十六进制（uuid4 去掉横线），全局唯一 —— 也就是同库内不可能重名。
 *   3. 多个标签按传入顺序用「-」连接（第一个是主要特点）；标签内部不允许出现「-」，所以可以被唯一解析。
 *   4. 整个文件名按 **UTF-8 字节** 预算（默认 180 字节）裁剪：
 *      中文一字 3 字节，NTFS 单个文件名上限是 255 字节，而资源管理器/对拷设备还吃 MAX_PATH 260。
 *      裁剪时优先保证 uuid 和扩展名完整，然后从末尾丢标签，最后才截断最长的那一个标签。
 *   5. 没有标签的素材不重命名（保持原名，等用户打标签）。
 */

const path = require('path');
const { bbytes, truncateChars, truncateBytes, chars } = require('./util');
const { uniqueTags } = require('./tags');

const DEFAULT_BUDGET_BYTES = 180;
const SEP = '-';

/** 无标签时的占位段；保证「一定有后缀」并且一眼能看出是没打标签的素材。 */
const UNTAGGED_SEGMENT = '未分类';

/**
 * 取扩展名。与 path.extname 不同的是：dotfile（.gitignore）返回 ''，
 * 而 a.mp4.aria2 / a.tar.gz 这类返回最后一段（.aria2 / .gz），保持原样即可。
 */
function originalExt(filename) {
  const base = path.basename(String(filename));
  const ext = path.extname(base);
  if (!ext) return '';
  if (base.slice(0, base.length - ext.length) === '') return '';   // 纯 dotfile
  return ext;
}

function stemOf(filename) {
  const base = path.basename(String(filename));
  const ext = originalExt(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

function joinTags(sortedTags) {
  return sortedTags.join(SEP);
}

function fitBudget(orderedTags, ext, id, budget = DEFAULT_BUDGET_BYTES) {
  const suffix = SEP + id + ext;                 // 不可变部分
  const sepBytes = bbytes(SEP);
  let tags = [...orderedTags];
  const dropped = [];
  const sizeOf = (arr) => arr.reduce((n, t) => n + bbytes(t) + sepBytes, 0);
  let used = sizeOf(tags) + bbytes(id) + bbytes(ext);

  // 先从末尾丢标签：末尾是次要特点，主要特点留在最前面
  while (tags.length > 0 && used > budget) {
    const removed = tags.pop();
    dropped.unshift(removed);
    used = sizeOf(tags) + bbytes(id) + bbytes(ext);
  }

  // 只剩一个标签还是超预算：按字节截断它
  if (used > budget && tags.length === 1) {
    const allowed = budget - bbytes(id) - bbytes(ext) - sepBytes;
    const cut = truncateBytes(tags[0], Math.max(1, allowed));
    if (cut) {
      tags = [cut];
      used = sizeOf(tags) + bbytes(id) + bbytes(ext);
    }
  }

  if (used > budget) {
    // 极端情况：预算比 uuid+ext 还小 —— 只留 uuid+ext，保证仍然合法
    return { tags: [], dropped: [...orderedTags], name: id + ext };
  }
  return { tags, dropped, name: (tags.length ? tags.join(SEP) + SEP : '') + id + ext };
}

/**
 * 生成文件名。
 *
 * **没打标签时保持原名不动**（这一点很重要）：用户往往是靠"原来的文件名"
 * 来判断该打什么标签的（`2024-08-23 直播录屏.mp4` 一眼就知道是什么），
 * 如果一打开文件夹就把它改成 `未分类-<uuid>.mp4`，那个判断依据当场就没了。
 * 所以：没标签 → 原样返回；有标签 → `标签1-标签2-<uuid>.扩展名`。
 *
 * @param {{id: string, originalName?: string, ext?: string, tags?: string[]}} opts
 * @returns {{name: string, fullName: string, droppedTags: string[], originalExt: string, tagged: boolean}}
 */
function buildName(opts = {}) {
  const id = String(opts.id || '').toLowerCase();
  const ext = opts.ext != null ? String(opts.ext) : originalExt(opts.originalName || '');
  const rawTags = uniqueTags(Array.isArray(opts.tags) ? opts.tags : []);
  const tagged = rawTags.length > 0;

  if (!tagged) {
    // 原名保留：只保证"有名字"（极端情况下 fileName 为空就退回 id+ext）。
    const original = String(opts.originalName || '').trim();
    const name = original || (id + ext);
    return {
      name: path.basename(name),
      fullName: path.basename(name),
      droppedTags: [],
      originalExt: ext,
      tagged: false,
    };
  }

  const fitted = fitBudget(rawTags, ext, id, opts.budget || DEFAULT_BUDGET_BYTES);
  return {
    name: fitted.name,
    fullName: fitted.name,
    droppedTags: fitted.dropped,
    originalExt: ext,
    tagged: true,
  };
}

/**
 * 反向解析：从文件名里取回 uuid（若有）。用于「把外部改名后的文件认回来」的兜底。
 * 只认本工具生成的两种形态：主干恰好是 uuid，或以「-uuid」结尾。
 * 用户原名里夹带的 32 位 hex（`IMG_<md5>.jpg` 这类下载/聊天软件导出的名字）不算，
 * 否则会把它当成 uuid 从原名里剥掉，未打标签的文件就被改成 `IMG_.jpg`。
 */
const UUID_RE = /(?:^|-)([0-9a-f]{32})$/i;

function parseIdFromName(filename) {
  const base = path.basename(String(filename));
  const stem = stemOf(base);
  const m = UUID_RE.exec(stem);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 从「标签1-标签2-uuid.ext」里取回标签（仅在文件名严格符合本工具格式时有效）
 */
function parseTagsFromName(filename) {
  const base = path.basename(String(filename));
  const ext = originalExt(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const id = parseIdFromName(base);
  if (!id) return null;
  const prefix = stem.slice(0, stem.length - id.length);
  if (!prefix.endsWith(SEP)) return null;
  const tagsPart = prefix.slice(0, prefix.length - SEP.length);
  if (!tagsPart) return [];
  // 「未分类」是占位符不是标签：它是「这个素材还没打标签」的标记，
  // 如果把它当标签读回来，未分类素材就会一直背着这个假标签。
  if (tagsPart === UNTAGGED_SEGMENT) return [];
  return tagsPart.split(SEP);
}

/**
 * 「像是被本工具打过标签、但还没有 uuid」的文件名 → 取出其中的标签；不像则返回 null。
 *
 * 用途：把以前用本工具（旧版本）打过标签、或者从别的设备上按同样规则命名过的素材
 * 再导进来时，自动认出「这不是随便起的名字，这几个是标签」，然后**问用户**要不要采纳。
 * 之所以要问：`2024-08-23 直播录屏.mp4` 这种名字也是用 `-` 连的，光看名字分不清
 * 是标签还是文件名的一部分，只有用户知道。
 *
 * @param {string} filename
 * @param {{validate?: (t: string) => {ok: boolean}}} [opts] 用 validateTag 判断每段是不是合法标签
 * @returns {string[]|null}
 */
function parseTagSuggestion(filename, opts = {}) {
  const base = path.basename(String(filename));
  if (parseIdFromName(base)) return null;               // 已经有 uuid 了，走正常的反解
  const stem = stemOf(base);
  if (!stem) return null;                               // 形如 .gitignore
  const parts = stem.split(SEP);
  if (parts.length < 2) return null;                    // 至少两段才谈得上「标签组合」
  const check = opts.validate || (() => ({ ok: true }));
  const tags = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) return null;                                // 空段（`a--b` / 前导或尾随 `-`）
    if (!check(t).ok) return null;                      // 含 `.`、非法字符、Windows 保留名、超长
    tags.push(t);
  }
  // 「未分类-轻语.mp4」这种：未分类是占位符不是标签，整条建议作废
  if (tags.some((t) => t === UNTAGGED_SEGMENT)) return null;
  return tags;
}

module.exports = {
  DEFAULT_BUDGET_BYTES,
  SEP,
  UNTAGGED_SEGMENT,
  originalExt,
  stemOf,
  joinTags,
  buildName,
  parseIdFromName,
  parseTagsFromName,
  parseTagSuggestion,
  fitBudget,
  charLen: (s) => chars(s).length,
  truncateChars,
};
