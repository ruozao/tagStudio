'use strict';
/**
 * tags.js — 标签的规范化、校验、排序。
 *
 * 为什么标签要这么严格：标签会直接变成文件名的一段（标签1-标签2-uuid.ext），
 * 所以任何在 Windows 文件名里非法的字符都必须在这一层挡掉，而不是等 rename 失败。
 */

const RESERVED_BASE = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_TAG_CHARS = 40;

/** 允许的字符：各种文字（含中文）、数字、空格，加一组「跨设备都安全」的符号。
 *  故意不含 - 和 . —— 前者是标签分隔符，后者会破坏扩展名识别。 */
const ALLOWED_EXTRA = new Set([...' _+()[]{}&@#!$\'’“”·、，。？！《》〈〉「」【】']);
const ALLOWED_RE = /[\p{L}\p{N}\p{M}]/u;

function normalizeTag(input) {
  return String(input == null ? '' : input)
    .normalize('NFC')
    .replace(/[\s\u3000]+/g, ' ')     // 含全角空格
    .trim();
}

function foldTag(input) {
  return normalizeTag(input).toLowerCase();
}

function charCount(s) {
  return Array.from(String(s)).length;
}

function validateTag(input) {
  const tag = normalizeTag(input);
  if (!tag) return { ok: false, reason: '标签不能为空' };
  if (charCount(tag) > MAX_TAG_CHARS) {
    return { ok: false, reason: `标签最多 ${MAX_TAG_CHARS} 个字符（当前 ${charCount(tag)}）` };
  }
  if (/^[. ]|[. ]$/.test(tag)) return { ok: false, reason: '标签首尾不能是点或空格' };
  for (const ch of tag) {
    if (ALLOWED_RE.test(ch) || ALLOWED_EXTRA.has(ch)) continue;
    if (ch === '-') return { ok: false, reason: '标签不能包含「-」，它是标签之间的分隔符' };
    if (ch === '.') return { ok: false, reason: '标签不能包含「.」，它会破坏扩展名' };
    return { ok: false, reason: `标签不能包含字符「${ch}」（文件名不安全的字符）` };
  }
  if (RESERVED_BASE.has(tag.toUpperCase())) {
    return { ok: false, reason: `「${tag}」是 Windows 保留设备名，请换一个` };
  }
  return { ok: true, tag };
}

function validateTags(list) {
  if (!Array.isArray(list)) return { ok: false, reason: '标签必须是数组' };
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = validateTag(raw);
    if (!v.ok) return v;
    const key = foldTag(v.tag);
    if (seen.has(key)) continue;                 // 同一个标签写了两遍：静默去重
    seen.add(key);
    out.push(v.tag);
  }
  return { ok: true, tags: out };
}

/** 稳定排序：按大小写不敏感的码点序。命名与展示都用它，保证同一组标签永远得到同一个名字。 */
function sortTags(list) {
  return [...list].sort((a, b) => {
    const ka = foldTag(a);
    const kb = foldTag(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

/** 把用户在「标签编辑器」里敲的一行文本拆成标签数组；半角/全角逗号、分号、竖线、换行都能当分隔符。 */
function splitTagInput(text) {
  return String(text == null ? '' : text)
    .split(/[,，;；|\n\r\t]+/)
    .map((s) => normalizeTag(s))
    .filter(Boolean);
}

function tagsEqual(a, b) {
  const A = sortTags(Array.from(new Set((a || []).map(foldTag))));
  const B = sortTags(Array.from(new Set((b || []).map(foldTag))));
  if (A.length !== B.length) return false;
  return A.every((v, i) => v === B[i]);
}

module.exports = {
  MAX_TAG_CHARS,
  normalizeTag,
  foldTag,
  validateTag,
  validateTags,
  sortTags,
  splitTagInput,
  tagsEqual,
  charCount,
};
