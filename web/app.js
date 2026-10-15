/* tagStudio 前端 —— 原生 JS，无框架、无构建步骤。
   设计约定：
     · 库里唯一的真相是磁盘文件名（标签-uuid.扩展名），db.json 只是索引；
     · 所以前端每次改动后都重新拿一遍标签列表与统计，不自己算。
*/
'use strict';

// ---------------------------------------------------------------- 小工具

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = (s) => String(s === undefined || s === null ? '' : s);

function humanBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
}
const KIND_ICON = { video: '🎬', audio: '🎵', image: '🖼️', other: '📄' };

let toastTimer = null;
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${kind ? ' ' + kind : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 7000 : 3200);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error(`连不上本地服务：${err.message}`);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data || {};
}

const splitTags = (s) => String(s || '')
  .split(/[,，;；|\n\t]+/)
  .map((x) => x.trim())
  .filter(Boolean);

// ---------------------------------------------------------------- 状态

const S = {
  ready: false,
  root: '',
  rootMeta: null,
  ffmpeg: null,
  thresholds: { nameBudgetBytes: 180, maxTagChars: 40, maxAbsPathChars: 250 },
  stats: null,
  tags: [],
  collections: [],
  items: [],
  total: 0,
  offset: 0,
  limit: 200,
  filters: { tags: [], any: [], kind: '', untagged: false, q: '', sort: 'added-desc' },
  selection: new Set(),
  lastClickedId: null,
  tagRenaming: null,
  defaultExportRoot: null,
  scanInterval: 0,
  lastScan: null,
  suggest: { count: 0, itemCount: 0, groups: [] },
  busy: false,
};
let tagSearchTerm = '';
let exportScope = { mode: 'selected' };
let currentJob = null;
let jobES = null;

// ---------------------------------------------------------------- 启停

async function init() {
  await refreshState();
  bindEvents();
  if (!S.ready) {
    $('#boot').hidden = false;
    $('#bootPath').focus();
    return;
  }
  $('#boot').hidden = true;
  await Promise.all([refreshTags(), loadItems()]);
  await refreshSuggestions();
  // 冷启动时如果文件名里认得出标签，直接问用户一次（这是「自动识别」最主要的时机）
  if (S.suggest.itemCount) openSuggestions();
}

async function refreshState() {
  const st = await api('/api/state');
  S.ready = !!st.ready;
  S.root = st.root || '';
  S.rootMeta = st.rootMeta || null;
  S.ffmpeg = st.ffmpeg || null;
  S.thresholds = st.thresholds || S.thresholds;
  S.stats = st.stats || null;
  S.defaultExportRoot = st.defaultExportRoot || null;
  S.scanInterval = st.scanInterval || 0;
  S.lastScan = st.lastScan || null;
  S.recentRoots = Array.isArray(st.recentRoots) ? st.recentRoots : [];
  renderHeader();
}

function renderHeader() {
  $('#rootPath').textContent = S.ready ? S.root : '未选择素材库';
  $('#rootPath').title = S.ready ? `${S.root}\n点这里换一个素材文件夹` : '点这里选择素材文件夹';
  renderRootSelect();
  if (!$('#expDest').value) $('#expDest').value = S.defaultExportRoot || '';
  $('#setExportRoot').value = localStorage.getItem('tagstudio.exportRoot') || '';
  $('#settingsBtn').title = S.ffmpeg && S.ffmpeg.path ? `ffmpeg: ${S.ffmpeg.path}` : '未找到 ffmpeg（视频缩略图不可用）';
  renderStats();
}

/**
 * 顶栏那个「快速切换到用过的文件夹」下拉框。
 * 只列服务端记住的、真正打开成功过的目录（存在 config.json 里，重启也还在）。
 */
function renderRootSelect() {
  const sel = $('#rootSelect');
  if (!sel) return;
  const recent = (S.recentRoots || []).filter((p) => p);
  sel.innerHTML = '';
  const add = (value, label) => {
    const o = el('option', null, label);
    o.value = value;
    o.title = value;
    sel.appendChild(o);
  };
  if (S.ready) add(S.root, `当前：${shortPath(S.root)}`);
  for (const p of recent) {
    if (S.ready && pathKey(p) === pathKey(S.root)) continue;
    add(p, shortPath(p));
  }
  add('__pick__', '选择其他文件夹…');
  sel.value = S.ready ? S.root : '__pick__';
}

/** 路径比较用：Windows 不区分大小写，末尾的分隔符也不该算差异 */
function pathKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

/** 下拉框里只显示最后两级目录，太长的路径会把下拉框撑爆 */
function shortPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…\\' + parts.slice(-2).join('\\');
}

function renderStats() {
  const box = $('#stats');
  box.innerHTML = '';
  const st = S.stats;
  if (!st) { box.appendChild(el('div', 'muted small', '尚未打开素材库')); return; }
  const add = (label, value) => {
    const d = el('div', 'stat');
    d.appendChild(el('b', null, String(value)));
    d.appendChild(el('span', 'muted', label));
    box.appendChild(d);
  };
  add('素材总数', st.total);
  add('已打标签', st.tagged);
  add('未打标签', st.untagged);
  add('标签数', st.tags);
  const kinds = [
    ['视频', st.byKind.video], ['音频', st.byKind.audio],
    ['图片', st.byKind.image], ['其它', st.byKind.other],
  ].filter(([, n]) => n > 0);
  const d = el('div', 'stat');
  d.style.gridColumn = '1 / -1';
  d.appendChild(el('span', 'muted', kinds.length ? kinds.map(([k, n]) => `${k} ${n}`).join(' · ') : '还没有素材'));
  d.appendChild(el('span', 'muted small', `占用 ${humanBytes(st.bytes)}`));
  box.appendChild(d);
}

// ---------------------------------------------------------------- 标签面板

async function refreshTags() {
  const data = await api('/api/tags');
  S.tags = data.tags || [];
  S.collections = data.collections || [];
  renderCollections();
  renderTagList();
}

function renderCollections() {
  const box = $('#collections');
  box.innerHTML = '';
  if (!S.collections.length) {
    box.appendChild(el('div', 'muted small', '把常用的标签组合存下来，一键切换筛选。'));
    return;
  }
  for (const c of S.collections) {
    const row = el('div', 'collection');
    row.title = `筛选：${(c.tags || []).join(' + ')}`;
    row.appendChild(el('span', 'cname', c.name));
    row.appendChild(el('span', 'ctags', (c.tags || []).join('+')));
    const del = el('span', 'del', '✕');
    del.title = '删除这个合集（不会动素材）';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      await api('/api/collections', { method: 'POST', body: { collections: S.collections.filter((x) => x.name !== c.name) } });
      await refreshTags();
    };
    row.appendChild(del);
    row.onclick = () => {
      S.filters.tags = [...(c.tags || [])];
      S.filters.any = [];
      S.filters.untagged = false;
      S.offset = 0;
      loadItems();
    };
    box.appendChild(row);
  }
}

function renderTagList() {
  const box = $('#tagList');
  box.innerHTML = '';
  const term = tagSearchTerm.trim().toLowerCase();
  const list = term ? S.tags.filter((t) => t.name.toLowerCase().includes(term)) : S.tags;
  if (!list.length) {
    box.appendChild(el('div', 'muted small', S.tags.length ? '没有匹配的标签' : '还没有标签。选中素材，在下面的输入框里敲标签即可。'));
    return;
  }
  for (const t of list) {
    const on = S.filters.tags.some((x) => x.toLowerCase() === t.name.toLowerCase());
    const onAny = S.filters.any.some((x) => x.toLowerCase() === t.name.toLowerCase());
    const row = el('div', `tag-row${on ? ' on' : ''}${onAny ? ' on any' : ''}`);
    row.title = '左键：必须包含此标签（AND，可多选叠加）\n右键：任一命中即可（OR）';
    row.appendChild(el('span', 'tname', t.name));
    row.appendChild(el('span', 'tcount', String(t.count)));

    const edit = el('span', 'tact', '✎');
    edit.title = '全局重命名 / 合并这个标签';
    edit.onclick = (ev) => { ev.stopPropagation(); startTagRename(t); };
    row.appendChild(edit);

    const del = el('span', 'tact', '🗑');
    del.title = '从所有素材上摘掉这个标签（不删素材）';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`把标签「${t.name}」从 ${t.count} 个素材上摘掉？素材文件会重命名，但不会被删除。`)) return;
      try {
        const res = await api('/api/tags/delete', { method: 'POST', body: { name: t.name } });
        S.filters.tags = S.filters.tags.filter((x) => x.toLowerCase() !== t.name.toLowerCase());
        toast(`已摘掉标签「${t.name}」，影响 ${res.affected} 个素材`, 'ok');
        await afterMutation();
      } catch (err) { toast(err.message, 'err'); }
    };
    row.appendChild(del);

    row.onclick = () => toggleFilterTag(t.name, false);
    row.oncontextmenu = (ev) => { ev.preventDefault(); toggleFilterTag(t.name, true); };
    box.appendChild(row);
  }
}

function toggleFilterTag(name, asAny) {
  const key = name.toLowerCase();
  const drop = (arr) => arr.filter((x) => x.toLowerCase() !== key);
  if (S.tagRenaming && S.tagRenaming.from.toLowerCase() === key) return;
  const inAnd = S.filters.tags.some((x) => x.toLowerCase() === key);
  const inAny = S.filters.any.some((x) => x.toLowerCase() === key);
  if (asAny) {
    S.filters.any = inAny ? drop(S.filters.any) : [...drop(S.filters.any), name];
    if (!inAny) S.filters.tags = drop(S.filters.tags);
  } else {
    S.filters.tags = inAnd ? drop(S.filters.tags) : [...drop(S.filters.tags), name];
    if (!inAnd) S.filters.any = drop(S.filters.any);
  }
  S.offset = 0;
  renderTagList();
  loadItems();
}

function startTagRename(t) {
  S.tagRenaming = { from: t.name };
  const row = [...document.querySelectorAll('.tag-row')].find((n) => n.querySelector('.tname').textContent === t.name);
  if (!row) return;
  row.innerHTML = '';
  const input = el('input', 'tag-search');
  input.value = t.name;
  input.style.margin = '0';
  const ok = el('button', 'btn tiny primary', '改');
  const cancel = el('button', 'btn tiny ghost', '×');
  const wrap = el('div', 'row');
  wrap.style.flex = '1';
  wrap.append(input, ok, cancel);
  row.appendChild(wrap);
  input.focus();
  input.select();

  const commit = async () => {
    const to = input.value.trim();
    S.tagRenaming = null;
    if (!to || to.toLowerCase() === t.name.toLowerCase()) { renderTagList(); return; }
    try {
      const res = await api('/api/tags/rename', { method: 'POST', body: { from: t.name, to } });
      if (!res.ok) throw new Error(res.reason || '改名失败');
      S.filters.tags = S.filters.tags.map((x) => (x.toLowerCase() === t.name.toLowerCase() ? to : x));
      S.filters.any = S.filters.any.map((x) => (x.toLowerCase() === t.name.toLowerCase() ? to : x));
      toast(`「${t.name}」→「${to}」，改了 ${res.renamed ? res.renamed.length : 0} 个素材`, 'ok');
      await afterMutation();
    } catch (err) { toast(err.message, 'err'); renderTagList(); }
  };
  ok.onclick = commit;
  cancel.onclick = () => { S.tagRenaming = null; renderTagList(); };
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') { S.tagRenaming = null; renderTagList(); }
  };
}

// ---------------------------------------------------------------- 素材列表

function queryString() {
  const p = new URLSearchParams();
  for (const t of S.filters.tags) p.append('tag', t);
  for (const t of S.filters.any) p.append('any', t);
  if (S.filters.kind) p.set('kind', S.filters.kind);
  if (S.filters.untagged) p.set('untagged', '1');
  if (S.filters.q) p.set('q', S.filters.q);
  p.set('sort', S.filters.sort);
  p.set('offset', String(S.offset));
  p.set('limit', String(S.limit));
  return p.toString();
}

async function loadItems() {
  if (!S.ready) return;
  S.busy = true;
  try {
    const data = await api(`/api/items?${queryString()}`);
    S.items = data.items || [];
    S.total = data.total || 0;
    renderFilterBar();
    renderGrid();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    S.busy = false;
  }
}

function renderFilterBar() {
  const box = $('#activeFilters');
  box.innerHTML = '';
  if (!S.filters.tags.length && !S.filters.any.length && !S.filters.kind && !S.filters.untagged && !S.filters.q) {
    box.appendChild(el('span', 'muted small', '未筛选（显示全部素材）'));
  }
  const pill = (text, cls, onRemove) => {
    const p = el('span', `fpill${cls ? ' ' + cls : ''}`);
    p.appendChild(el('span', null, text));
    const x = el('span', 'x', '✕');
    x.onclick = onRemove;
    p.appendChild(x);
    box.appendChild(p);
  };
  for (const t of S.filters.tags) pill(`必须：${t}`, '', () => toggleFilterTag(t, false));
  for (const t of S.filters.any) pill(`任一：${t}`, 'any', () => toggleFilterTag(t, true));
  if (S.filters.kind) pill(`类型：${({ video: '视频', audio: '音频', image: '图片', other: '其它' })[S.filters.kind]}`, '', () => { S.filters.kind = ''; $('#kindFilter').value = ''; loadItems(); });
  if (S.filters.untagged) pill('只看未打标签', '', () => { S.filters.untagged = false; loadItems(); });
  if (S.filters.q) pill(`搜索：${S.filters.q}`, '', () => { S.filters.q = ''; $('#search').value = ''; loadItems(); });

  const shown = S.items.length;
  const range = S.total ? `${S.offset + 1}–${S.offset + shown}` : '0';
  $('#countLabel').textContent = S.total > shown ? `显示 ${range} / 共 ${S.total} 项（翻页看更多）` : `共 ${S.total} 项`;
  $('#selectAllBtn').textContent = shown && S.items.every((i) => S.selection.has(i.id)) ? '取消全选本页' : '全选本页';
}

function renderGrid() {
  const grid = $('#grid');
  const empty = $('#empty');
  grid.innerHTML = '';
  if (!S.items.length) {
    empty.hidden = false;
    empty.innerHTML = '';
    empty.appendChild(el('h3', null, S.stats && S.stats.total ? '这个筛选下没有素材' : '这个文件夹里还没有素材'));
    empty.appendChild(el('p', 'muted', S.stats && S.stats.total
      ? '试试清空筛选，或者换一组标签。'
      : '把视频/音频/图片复制进素材文件夹，然后点右上角「重新扫描」。'));
    return;
  }
  empty.hidden = true;

  for (const item of S.items) grid.appendChild(renderCard(item));

  if (S.total > S.offset + S.items.length || S.offset > 0) {
    const more = el('div');
    more.style.gridColumn = '1 / -1';
    more.style.display = 'flex';
    more.style.justifyContent = 'center';
    more.style.gap = '8px';
    more.style.padding = '8px';
    if (S.offset > 0) {
      const prev = el('button', 'btn tiny', '← 上一页');
      prev.onclick = () => { S.offset = Math.max(0, S.offset - S.limit); loadItems(); };
      more.appendChild(prev);
    }
    if (S.total > S.offset + S.items.length) {
      const next = el('button', 'btn tiny', '下一页 →');
      next.onclick = () => { S.offset += S.limit; loadItems(); };
      more.appendChild(next);
    }
    const label = el('span', 'muted small', `${S.offset + 1}–${S.offset + S.items.length} / ${S.total}`);
    label.style.alignSelf = 'center';
    more.appendChild(label);
    grid.appendChild(more);
  }
  renderSelBar();
}

function renderCard(item) {
  const card = el('div', `card${S.selection.has(item.id) ? ' sel' : ''}`);
  card.dataset.id = item.id;

  const thumb = el('div', 'thumb');
  if (item.kind === 'audio') {
    thumb.appendChild(el('div', 'ph', '🎵'));
  } else {
    const img = el('img');
    img.loading = 'lazy';
    img.alt = item.name;
    img.src = item.thumbUrl;
    img.onerror = () => {
      img.remove();
      if (!thumb.querySelector('.ph')) thumb.appendChild(el('div', 'ph', KIND_ICON[item.kind] || '📄'));
    };
    thumb.appendChild(img);
  }
  thumb.appendChild(el('div', 'badge', item.kindLabel));
  // 还没打标签的素材：在缩略图上再盖一个显眼的「待分类」角标。
  // 这类素材的文件名没被改过（还是用户原来的名字），所以单看文件名看不出"进库了没有"，
  // 需要这个角标告诉他们"这条还没处理"。
  if (!item.tags.length) thumb.appendChild(el('div', 'badge pending', '待分类'));
  const check = el('div', 'check', '✓');
  check.title = '勾选（用于批量打标签 / 导出）';
  check.onclick = (ev) => { ev.stopPropagation(); toggleSelect(item.id, ev.shiftKey); };
  thumb.appendChild(check);
  card.appendChild(thumb);

  const body = el('div', 'body');
  const name = el('div', 'name', item.name);
  name.title = `${item.rel}\n${item.sizeText}`;
  body.appendChild(name);

  // 打过标签之后 name 已经是「标签-uuid.扩展名」了，把入库时的原名再显示一行。
  // 没打标签时 name 就是原名，不用重复显示。
  const orig = String(item.origName || '');
  if (orig && orig !== item.name) {
    const origEl = el('div', 'origname', orig);
    origEl.title = '入库时的原始文件名（不会被改掉，导出时可选「原始文件名」模式）';
    body.appendChild(origEl);
  }

  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, item.sizeText));
  meta.appendChild(el('span', null, item.inferred ? '按文件名推断' : ''));
  body.appendChild(meta);

  const tags = el('div', 'tags');
  if (item.tags.length) {
    for (const t of item.tags) {
      const chip = el('span', 'tagmini', t);
      chip.title = `只留这个标签的素材`;
      chip.onclick = (ev) => { ev.stopPropagation(); S.filters.tags = [t]; S.filters.any = []; S.filters.untagged = false; S.offset = 0; renderTagList(); loadItems(); };
      tags.appendChild(chip);
    }
  } else {
    tags.appendChild(el('span', 'tagmini none', '待分类'));
  }
  body.appendChild(tags);

  // 文件名里认出了标签候选：卡片上给一条，点了打开确认弹窗
  if (item.tagSuggest && item.tagSuggest.length) {
    const hint = el('div', 'sugchip', `文件名像标签：${item.tagSuggest.join('、')} —— 点这里认成标签`);
    hint.title = '识别到的只是「可能的」标签（有些文件名本来就带连字符），确认后才会真的打上并改名';
    hint.onclick = (ev) => { ev.stopPropagation(); openSuggestions(); };
    body.appendChild(hint);
  }
  card.appendChild(body);

  card.onclick = (ev) => {
    if (ev.ctrlKey || ev.metaKey) { toggleSelect(item.id, false); return; }
    openEditor(item);
  };
  return card;
}

function toggleSelect(id, shift) {
  if (shift && S.lastClickedId) {
    const ids = S.items.map((i) => i.id);
    const a = ids.indexOf(S.lastClickedId);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) S.selection.add(ids[i]);
    }
  } else {
    if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id);
  }
  S.lastClickedId = id;
  updateCardState();
}

function updateCardState() {
  for (const card of document.querySelectorAll('.card')) {
    card.classList.toggle('sel', S.selection.has(card.dataset.id));
  }
  renderSelBar();
  renderFilterBar();
}

function renderSelBar() {
  const bar = $('#selbar');
  if (!S.selection.size) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#selCount').textContent = String(S.selection.size);
  const chosen = S.items.filter((i) => S.selection.has(i.id));
  const bytes = chosen.reduce((n, i) => n + (i.size || 0), 0);
  $('#selBytes').textContent = `/ 本页已知 ${humanBytes(bytes)}（翻页的选择也会一起处理）`;

  // 批量面板也要看得见"这些原本是哪个文件"：打了标签之后卡片上显示的是
  // 「标签-uuid.扩展名」，一次选了十几个就分不清谁是谁了。
  const origEl = $('#selOrig');
  const names = chosen.map((i) => String(i.origName || i.name)).filter(Boolean);
  if (!names.length) {
    origEl.hidden = true;
  } else {
    const shown = names.slice(0, 3).join(' | ');
    origEl.textContent = names.length > 3
      ? `原名：${shown} …等 ${names.length} 个`
      : `原名：${shown}`;
    origEl.title = names.join('\n');
    origEl.hidden = false;
  }
}

async function afterMutation() {
  await Promise.all([refreshState(), refreshTags()]);
  await refreshSuggestions();
  await loadItems();
}

// ------------------------------------------- 从文件名认出旧标签（「tag1-tag2.mp4」）
//
// 以前用本工具打过标签、或从别的设备按同样规则命名过的素材，文件名里就带着标签。
// 但「2024-08-23 直播录屏.mp4」这种名字长得一模一样，程序分不清前两段是标签还是日期，
// 所以只提建议，采不采纳由用户在弹窗里点。

async function refreshSuggestions() {
  if (!S.ready) return { count: 0, itemCount: 0, groups: [] };
  try {
    S.suggest = await api('/api/suggestions');
  } catch {
    S.suggest = { count: 0, itemCount: 0, groups: [] };
  }
  renderSuggestChip();
  // 弹窗开着但已经没事可确认了（比如后台轮询把最后一组也处理掉了、或者用户在别处清空了标签）：
  // 自己合上，别留一个空框在那儿。
  const dlg = $('#suggestDlg');
  if (dlg && dlg.open && !(S.suggest && S.suggest.itemCount)) dlg.close();
  return S.suggest;
}

function renderSuggestChip() {
  const chip = $('#suggestChip');
  if (!chip) return;
  const n = S.suggest ? S.suggest.itemCount : 0;
  if (!S.ready || !n) { chip.hidden = true; chip.textContent = ''; return; }
  chip.hidden = false;
  chip.textContent = `认出 ${n} 个文件名里的标签`;
  chip.title = '这些素材的文件名长得像「标签1-标签2.扩展名」。点开看要不要认成标签。';
}

// 弹窗里勾中的素材 id。默认全勾上 —— 大多数情况下这一堆名字确实是以前打的标签，
// 用户要做的只是"把个别不像的去掉"，所以默认选中比默认不选省事得多。
const sugChecked = new Set();
// 用户手动动过勾选的 id：重绘时不再自动勾回来（见 openSuggestions）
const sugTouched = new Set();
// 每组"要采纳哪几个标签"的勾选：groupKey -> Set(标签)。默认全勾。
// 组里的标签是在组头上逐个勾的（"直播录屏"这种不像标签的可以直接取消）。
const sugTags = new Map();
// 用户手动动过的标签（groupKey\u0001标签）：重绘时不再自动勾回来
const sugTagTouched = new Set();

function sugGroupKey(g) { return g.tags.join('\u0001'); }

/** 这一组里勾上的标签（按组头里的顺序） */
function sugTagsOf(group) {
  const set = sugTags.get(sugGroupKey(group)) || new Set();
  return group.tags.filter((t) => set.has(t));
}

/** 能被采纳的素材：所在组至少还有一个标签勾着。标签全取消的组，整组不参与。 */
function sugSelectableIds() {
  const out = [];
  for (const g of (S.suggest && S.suggest.groups) || []) {
    if (!sugTagsOf(g).length) continue;
    for (const id of g.ids) out.push(id);
  }
  return out;
}

/** 把勾选状态同步到界面：数量文字、两个全选框的勾/半勾、采纳按钮可用性 */
function renderSugSelection() {
  const ids = sugSelectableIds();
  const total = ids.length;
  const picked = ids.filter((id) => sugChecked.has(id)).length;

  const cnt = $('#sugCount');
  if (cnt) {
    cnt.textContent = total
      ? `已勾选 ${picked} / ${total} 个`
      : '这些标签全被你取消了，没有可采纳的';
  }

  const all = $('#sugAll');
  if (all) {
    all.disabled = total === 0;
    all.checked = total > 0 && picked === total;
    all.indeterminate = picked > 0 && picked < total;
  }
  for (const box of document.querySelectorAll('#sugList .suggroup')) {
    const key = box.dataset.group;
    const g = (S.suggest.groups || []).find((x) => sugGroupKey(x) === key);
    const gids = g ? g.ids : [];
    const tagsOn = g ? sugTagsOf(g).length > 0 : true;
    // 标签全取消的组整体灰掉：这一组点了也不会被改
    box.classList.toggle('off', !tagsOn);
    const off = box.querySelector('.sugtagnote');
    if (off) off.hidden = tagsOn;

    // 逐条的勾选框一律以 sugChecked 为准。点组头的「整组」只改了数据，
    // 如果不在这里回写，用户看到的会是"点了整组但每条都没勾上"。
    for (const cb of box.querySelectorAll('.sugpick')) {
      cb.checked = sugChecked.has(cb.dataset.id);
      cb.disabled = !tagsOn;
    }
    const box2 = box.querySelector('.sugall');
    if (box2 && gids.length) {
      const n = gids.filter((id) => sugChecked.has(id)).length;
      box2.disabled = !tagsOn;
      box2.checked = tagsOn && n === gids.length;
      box2.indeterminate = tagsOn && n > 0 && n < gids.length;
    }
  }

  const btn = $('#sugAccept');
  if (btn) {
    btn.disabled = picked === 0;
    btn.textContent = picked ? `采纳勾选的 ${picked} 个` : '采纳勾选的（先勾几个）';
  }
  const ig = $('#sugIgnoreSel');
  if (ig) {
    ig.disabled = picked === 0;
    ig.textContent = picked ? `勾选的 ${picked} 个别再问` : '勾选的都别再问';
  }
  const allBtn = $('#sugIgnore');
  if (allBtn) allBtn.disabled = ids.length === 0;
}

let sugPreviewTimer = null;

/** 标签勾选一变，把每条的目标文件名重新算一遍（命名规则在服务端，别在前端重写一份） */
function scheduleTagPreview() {
  if (sugPreviewTimer) clearTimeout(sugPreviewTimer);
  sugPreviewTimer = setTimeout(() => {
    sugPreviewTimer = null;
    refreshTagPreviews().catch(() => { /* 预览失败不影响勾选，静默即可 */ });
  }, 120);
}

async function refreshTagPreviews() {
  const pairs = [];
  for (const g of (S.suggest && S.suggest.groups) || []) {
    const tags = sugTagsOf(g);
    if (!tags.length) continue;
    for (const it of g.items) pairs.push({ id: it.id, tags });
  }
  if (!pairs.length) return;
  const res = await api('/api/suggestions/preview', { method: 'POST', body: { items: pairs } });
  for (const pv of res.previews || []) {
    const row = document.querySelector(`#sugList .sugitem[data-id="${pv.id}"]`);
    if (!row) continue;
    const nameEl = row.querySelector('.sugnew');
    if (nameEl) nameEl.textContent = pv.target || '（没选标签）';
    const dropEl = row.querySelector('.sugdrop');
    if (dropEl) {
      const dropped = pv.droppedTags || [];
      dropEl.hidden = !dropped.length;
      dropEl.textContent = dropped.length ? `标签太多塞不进文件名，会去掉：${dropped.join('、')}` : '';
    }
  }
}

async function openSuggestions() {
  const data = await refreshSuggestions();
  const list = $('#sugList');
  list.innerHTML = '';

  // 勾选状态跟着 id 走：还在列表里的保留用户的选择，新出现的默认勾上。
  // 这样「采纳勾选的」之后弹窗重绘，剩下那几条还是原来那个没勾的状态。
  const live = new Set(data.groups.flatMap((g) => g.ids));
  for (const id of [...sugChecked]) if (!live.has(id)) sugChecked.delete(id);
  for (const id of live) if (!sugChecked.has(id) && !sugTouched.has(id)) sugChecked.add(id);
  for (const id of [...sugTouched]) if (!live.has(id)) sugTouched.delete(id);

  // 标签勾选同样跟着组走：老组保留用户的选择，新出现的标签默认勾上
  const liveKeys = new Set(data.groups.map((g) => sugGroupKey(g)));
  for (const key of [...sugTags.keys()]) if (!liveKeys.has(key)) sugTags.delete(key);
  for (const g of data.groups) {
    const key = sugGroupKey(g);
    const prev = sugTags.get(key) || new Set();
    const next = new Set();
    for (const t of g.tags) {
      const tid = `${key}\u0001${t}`;
      if (sugTagTouched.has(tid)) { if (prev.has(t)) next.add(t); }
      else next.add(t);
    }
    sugTags.set(key, next);
  }
  for (const tid of [...sugTagTouched]) {
    const key = tid.slice(0, tid.indexOf('\u0001'));
    if (!liveKeys.has(key)) sugTagTouched.delete(tid);
  }

  if (!data.itemCount) {
    list.appendChild(el('div', 'muted', '没有需要确认的了。'));
  } else {
    for (const g of data.groups) {
      const key = sugGroupKey(g);
      const box = el('div', 'suggroup');
      box.dataset.group = key;

      const head = el('div', 'sughead');
      // 一组的标签一样，所以这组一起勾最省事；想只采纳其中几个就在标签上逐个勾
      const gAll = el('label', 'sugallbox');
      const gAllInput = el('input');
      gAllInput.type = 'checkbox';
      gAllInput.className = 'sugall';
      gAllInput.onchange = () => {
        for (const id of g.ids) {
          if (gAllInput.checked) { sugChecked.add(id); sugTouched.delete(id); }
          else { sugChecked.delete(id); sugTouched.add(id); }
        }
        renderSugSelection();
      };
      gAll.append(gAllInput, document.createTextNode(' 整组'));
      head.appendChild(gAll);

      // 认出来的标签本身也是一个个勾选框：不想要的标签直接取消，
      // 比如 `助眠-直播录屏-轻语.mp3` 里只想要「助眠」和「轻语」。
      const tagWrap = el('div', 'sugtags');
      for (const t of g.tags) {
        const lab = el('label', 'tagpick');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.className = 'sugtag';
        cb.dataset.tag = t;
        cb.checked = (sugTags.get(key) || new Set()).has(t);
        cb.onchange = () => {
          const set = sugTags.get(key) || new Set();
          if (cb.checked) { set.add(t); sugTagTouched.delete(`${key}\u0001${t}`); }
          else { set.delete(t); sugTagTouched.add(`${key}\u0001${t}`); }
          sugTags.set(key, set);
          renderSugSelection();
          scheduleTagPreview();
        };
        lab.append(cb, el('span', 'tagpickname', t));
        tagWrap.appendChild(lab);
      }
      head.appendChild(tagWrap);
      head.appendChild(el('span', 'muted small', `${g.ids.length} 个素材 · ${humanBytes(g.bytes)}`));
      box.appendChild(head);

      const tagNote = el('div', 'sugtagnote muted small', '这一组的标签都取消了 —— 这一组不会被改动，文件名保持原样。');
      tagNote.hidden = true;
      box.appendChild(tagNote);

      const items = el('div', 'sugitems');
      for (const it of g.items) {
        const row = el('div', 'sugitem');
        row.dataset.id = it.id;
        const cb = el('input');
        cb.type = 'checkbox';
        cb.className = 'sugpick';
        cb.dataset.id = it.id;
        cb.checked = sugChecked.has(it.id);
        cb.onchange = () => {
          if (cb.checked) { sugChecked.add(it.id); sugTouched.delete(it.id); }
          else { sugChecked.delete(it.id); sugTouched.add(it.id); }
          renderSugSelection();
        };
        row.appendChild(cb);
        row.appendChild(el('span', 'sugkind', it.kindLabel));
        const names = el('div', 'sugnames');
        names.appendChild(el('div', 'sugold', it.origName || it.name));
        const arrow = el('span', 'sugarrow', '→');
        const newName = el('span', 'sugnew', it.target);
        const line = el('div', 'sugnewline');
        line.append(arrow, newName);
        names.appendChild(line);
        const drop = el('div', 'sugdrop muted small');
        drop.hidden = true;
        names.appendChild(drop);
        row.appendChild(names);
        items.appendChild(row);
      }
      if (g.ids.length > g.items.length) {
        items.appendChild(el('div', 'muted small', `…另外还有 ${g.ids.length - g.items.length} 个同类素材（一起勾/一起不勾）`));
      }
      box.appendChild(items);
      list.appendChild(box);
    }
  }

  if (!$('#suggestDlg').open) $('#suggestDlg').showModal();
  renderSugSelection();
}

function describeAcceptResult(res) {
  const parts = [`已认成标签并改名 ${res.accepted} 个`];
  if (res.skipped) parts.push(`跳过 ${res.skipped} 个`);
  if (res.failures && res.failures.length) parts.push(`失败 ${res.failures.length} 个`);
  if (res.droppedTags && res.droppedTags.length) parts.push(`有 ${res.droppedTags.length} 个标签太多塞不进文件名、被去掉了`);
  if (res.remaining) parts.push(`还剩 ${res.remaining} 组待确认`);
  return parts.join('，');
}

/** 采纳：只处理勾中的那些素材，每条只采纳它那一组里还勾着的标签。 */
async function acceptSuggestion() {
  const selectable = new Set(sugSelectableIds());
  const items = [];
  for (const g of (S.suggest && S.suggest.groups) || []) {
    const tags = sugTagsOf(g);
    if (!tags.length) continue;
    for (const id of g.ids) {
      if (!selectable.has(id) || !sugChecked.has(id)) continue;
      items.push({ id, tags });
    }
  }
  if (!items.length) { toast('先勾几个要采纳的', 'err'); return; }
  try {
    const res = await api('/api/suggestions/accept', { method: 'POST', body: { items } });
    toast(describeAcceptResult(res), res.failures && res.failures.length ? 'err' : 'ok');
    await afterMutation();
    if (!S.suggest.itemCount) $('#suggestDlg').close();
    else await openSuggestions();
  } catch (err) { toast(err.message, 'err'); }
}

/** 忽略：不带 ids = 全部。"别再问"按钮只处理勾中的那些。 */
async function ignoreSuggestion(ids) {
  try {
    const body = Array.isArray(ids) && ids.length ? { ids } : {};
    await api('/api/suggestions/ignore', { method: 'POST', body });
    await afterMutation();
    if (!S.suggest.itemCount) {
      $('#suggestDlg').close();
      toast('好，以后不再为这些文件名弹窗（文件没动过）', 'ok');
    } else {
      await openSuggestions();
    }
  } catch (err) { toast(err.message, 'err'); }
}

// ---------------------------------------------------------------- 标签编辑器

let editorItem = null;
let editorPreviewTimer = null;

async function openEditor(item) {
  editorItem = item;
  const dlg = $('#editor');
  $('#editorTitle').textContent = item.name;
  // 改过名之后标题就是一串「标签-uuid.扩展名」了，这里补一行入库时的原名。
  const origEl = $('#editorOrig');
  const orig = String(item.origName || '');
  if (orig && orig !== item.name) {
    origEl.textContent = `原始文件名：${orig}`;
    origEl.title = '入库时的原始文件名，导出时可以选「原始文件名」模式用它';
    origEl.hidden = false;
  } else {
    origEl.textContent = '';
    origEl.hidden = true;
  }
  $('#editorTags').value = item.tags.join(', ');
  $('#editorMsg').textContent = '';
  $('#editorMsg').className = 'msg';

  const media = $('#editorMedia');
  media.innerHTML = '';
  if (item.kind === 'video') {
    const v = el('video');
    v.controls = true;
    v.preload = 'metadata';
    v.src = item.url;
    media.appendChild(v);
  } else if (item.kind === 'audio') {
    const a = el('audio');
    a.controls = true;
    a.preload = 'metadata';
    a.src = item.url;
    media.appendChild(a);
  } else if (item.kind === 'image') {
    const img = el('img');
    img.src = item.url;
    media.appendChild(img);
  } else {
    media.appendChild(el('div', 'muted small', '这种格式没法在这里预览，但标签和重命名照样生效。'));
  }

  const prev = $('#editorPreview');
  prev.innerHTML = '';
  prev.appendChild(el('span', 'muted', '文件名预览：'));
  prev.appendChild(document.createTextNode(item.name));

  renderSuggest(item.tags);
  updatePreview();
  if (!dlg.open) dlg.showModal();
  $('#editorTags').focus();
}

function renderSuggest(selected) {
  const box = $('#editorSuggest');
  box.innerHTML = '';
  const sel = new Set((selected || []).map((t) => t.toLowerCase()));
  const list = S.tags.filter((t) => !sel.has(t.name.toLowerCase())).slice(0, 40);
  if (!list.length) { box.appendChild(el('span', 'muted small', '还没有别的标签可用')); return; }
  for (const t of list) {
    const c = el('button', 'chip', `+ ${t.name}`);
    c.type = 'button';
    c.title = `库里已有 ${t.count} 个素材用这个标签`;
    c.onclick = () => {
      const next = [...splitTags($('#editorTags').value), t.name];
      const seen = new Set();
      $('#editorTags').value = next.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(', ');
      renderSuggest(splitTags($('#editorTags').value));
      updatePreview();
    };
    box.appendChild(c);
  }
}

function updatePreview() {
  clearTimeout(editorPreviewTimer);
  editorPreviewTimer = setTimeout(async () => {
    if (!editorItem) return;
    const tags = splitTags($('#editorTags').value);
    const msg = $('#editorMsg');
    try {
      const res = await api(`/api/items/${editorItem.id}/preview`, { method: 'POST', body: { tags } });
      const p = res.preview;
      const prev = $('#editorPreview');
      prev.innerHTML = '';
      prev.appendChild(el('span', 'muted', '保存后会重命名为：'));
      prev.appendChild(el('code', null, p.file));
      const lines = [`${p.bytes} 字节文件名 · 完整路径 ${p.pathChars} 字符`];
      if (p.droppedTags.length) lines.push(`⚠ 文件名太长，这些标签放不下：${p.droppedTags.join('、')}`);
      if (!p.pathOk) lines.push('⚠ 路径超过 250 字符，建议把素材文件夹挪浅一点');
      const note = el('div', 'small');
      note.style.marginTop = '4px';
      note.style.color = (p.droppedTags.length || !p.pathOk) ? 'var(--warn)' : 'var(--fg3)';
      note.textContent = lines.join('；');
      prev.appendChild(note);
      msg.textContent = '';
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    }
  }, 180);
}

async function saveEditor() {
  if (!editorItem) return;
  const tags = splitTags($('#editorTags').value);
  const id = editorItem.id;
  try {
    const res = await api(`/api/items/${id}/tags`, { method: 'POST', body: { mode: 'set', tags } });
    const rn = res.rename || {};
    toast(rn.changed ? `已重命名为 ${rn.name}` : '标签已保存（文件名没变）', 'ok');
    $('#editor').close();
    editorItem = null;
    await afterMutation();
  } catch (err) {
    $('#editorMsg').className = 'msg err';
    $('#editorMsg').textContent = err.message;
  }
}

// ---------------------------------------------------------------- 批量操作

async function bulk(mode, field, value) {
  const ids = [...S.selection];
  if (!ids.length) { toast('先勾选一些素材', 'err'); return; }
  const tags = splitTags(value);
  if (!tags.length) { toast('标签不能为空', 'err'); return; }
  try {
    const res = await api('/api/items/bulk', { method: 'POST', body: { ids, mode, [field]: value } });
    const failed = res.failures || [];
    const renamed = (res.results || []).filter((r) => r.rename && r.rename.changed).length;
    toast(`成功 ${res.count} 个（其中 ${renamed} 个文件被重命名）${failed.length ? `，失败 ${failed.length} 个` : ''}`, failed.length ? 'err' : 'ok');
    if (failed.length) console.warn('失败明细', failed);
    await afterMutation();
  } catch (err) { toast(err.message, 'err'); }
}

// ---------------------------------------------------------------- 导出

function openExport() {
  const dlg = $('#exportDlg');
  const box = $('#exportScope');
  box.innerHTML = '';
  const selectedCount = S.selection.size;
  const filterDesc = describeFilter();
  const options = [];
  if (selectedCount) options.push({ key: 'selected', label: `已勾选的 ${selectedCount} 个素材` });
  options.push({ key: 'filter', label: `当前筛选的全部 ${S.total} 个素材${filterDesc ? `（${filterDesc}）` : ''}` });
  if (selectedCount) options.push({ key: 'all', label: `库里全部 ${S.stats ? S.stats.total : '?'} 个素材` });
  if (!options.some((o) => o.key === exportScope.mode)) exportScope.mode = options[0].key;
  for (const o of options) {
    const lab = el('label', 'radio scope-option');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'expScope';
    radio.value = o.key;
    radio.checked = exportScope.mode === o.key;
    radio.onchange = () => { exportScope.mode = o.key; updateExpEstimate(); };
    // 文字单独包一层：.radio 自己就是 flex 容器，直接把长文本塞进去会让
    // 换行后的第二行从"文字左边"开始，而不是对齐到第一行文字，看着很别扭。
    // 用 grid 把 radio 和文字分成两列就能对齐。
    lab.append(radio, el('span', 'scope-text', o.label));
    box.appendChild(lab);
  }

  $('#expDest').value = $('#expDest').value || S.defaultExportRoot || '';
  $('#expSubdir').placeholder = `导出-${stamp()}`;
  $('#expLog').textContent = '';
  $('#expResult').innerHTML = '';
  $('#expBar').style.width = '0%';
  $('#expCancel').hidden = true;
  $('#expStart').disabled = false;
  updateExpEstimate();
  if (!dlg.open) dlg.showModal();
}

function describeFilter() {
  const bits = [];
  if (S.filters.tags.length) bits.push('必须 ' + S.filters.tags.join('+'));
  if (S.filters.any.length) bits.push('任一 ' + S.filters.any.join('/'));
  if (S.filters.kind) bits.push('类型 ' + S.filters.kind);
  if (S.filters.untagged) bits.push('未打标签');
  if (S.filters.q) bits.push('搜索 ' + S.filters.q);
  return bits.join('，');
}

async function updateExpEstimate() {
  const box = $('#expReview');
  box.innerHTML = '';
  try {
    // review 接口的语义：给了 ids 就只体检这些；没给 ids 就体检整个库。
    // 所以「当前筛选」这一档要先把筛选结果拉出来，否则会体检成整库。
    let ids = null;
    if (exportScope.mode === 'selected') ids = [...S.selection];
    else if (exportScope.mode === 'filter') {
      const r = await api(`/api/items?${queryString().replace(/&?offset=\d+/, '&offset=0')}`);
      ids = (r.items || []).map((i) => i.id);
    }
    const res = await api('/api/export/review', { method: 'POST', body: ids ? { ids } : {} });
    const add = (k, v) => { box.appendChild(el('div', 'k', k)); box.appendChild(el('div', 'v', v)); };
    add('将复制', `${res.count} 个文件，共 ${humanBytes(res.totalBytes)}`);
    add('缺失源文件', res.missing.length ? `${res.missing.length} 个（会被跳过）` : '无');
    add('超长路径', res.longPaths.length ? `${res.longPaths.length} 个（接近 250 字符上限）` : '无');
    add('被截断的标签', res.droppedTags.length ? `${res.droppedTags.length} 个素材的标签放不进文件名` : '无');
  } catch (err) {
    box.appendChild(el('div', 'v', `体检失败：${err.message}`));
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function startExport() {
  const dest = $('#expDest').value.trim();
  if (!dest) { toast('请先选导出目标文件夹', 'err'); return; }
  const nameMode = (document.querySelector('input[name=nameMode]:checked') || {}).value || 'tagged';
  const subdir = $('#expSubdir').value.trim();
  const makeZip = $('#expZip').checked;
  const body = {
    destRoot: dest,
    subdir: subdir || null,
    nameMode,
    makeZip,
  };
  if (exportScope.mode === 'selected') body.ids = [...S.selection];
  else if (exportScope.mode === 'filter') {
    // 当前没有加任何筛选时 filter 是空对象；空筛选 = 不限制，服务端会按"整个库"处理。
    // 这里也把空对象去掉，语义更直白。
    const f = { ...S.filters };
    const hasFilter = (f.tags && f.tags.length) || (f.any && f.any.length) || f.kind || f.untagged || f.q;
    if (hasFilter) body.filter = f;
  }
  // mode === 'all'：既不给 ids 也不给 filter，服务端会把整个库导出去。
  // （以前这里传的是 S.items.map(...)，而那只是"当前这一页"的素材，翻页后就会漏。）

  try {
    const res = await api('/api/export/start', { method: 'POST', body });
    currentJob = res.job;
    $('#expStart').disabled = true;
    $('#expCancel').hidden = false;
    followJob(res.job.id);
  } catch (err) { toast(err.message, 'err'); }
}

function followJob(id) {
  if (jobES) { jobES.close(); jobES = null; }
  const es = new EventSource(`/api/export/${id}/events`);
  jobES = es;
  es.addEventListener('progress', (ev) => { try { renderJob(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ } });
  es.addEventListener('end', (ev) => {
    try { renderJob(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ }
    es.close();
    jobES = null;
    $('#expStart').disabled = false;
    $('#expCancel').hidden = true;
    afterMutation();
  });
  es.onerror = () => {
    es.close();
    jobES = null;
    $('#expStart').disabled = false;
    $('#expCancel').hidden = true;
  };
}

function renderJob(job) {
  if (!job) return;
  currentJob = job;
  const pct = job.bytesTotal ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100) : (job.count ? (job.done / job.count) * 100 : 0);
  $('#expBar').style.width = `${pct.toFixed(1)}%`;
  const log = $('#expLog');
  if (job.lastLog) {
    log.textContent += `${job.lastLog}\n`;
    log.scrollTop = log.scrollHeight;
  }
  const box = $('#expResult');
  box.innerHTML = '';
  const line = (k, v, color) => {
    const d = el('div', 'small');
    if (color) d.style.color = color;
    d.textContent = `${k}：${v}`;
    box.appendChild(d);
  };
  line('状态', ({ queued: '排队中', running: '复制中', done: '完成', cancelled: '已取消', error: '出错' })[job.status] || job.status);
  line('进度', `${job.done} / ${job.count} 个文件 · ${humanBytes(job.bytesDone)} / ${humanBytes(job.bytesTotal)}`);
  if (job.destDir) line('目标目录', job.destDir);
  if (job.failed && job.failed.length) line('失败', `${job.failed.length} 个（见日志）`, 'var(--err)');
  if (job.status === 'done') {
    const links = el('div', 'row');
    links.style.marginTop = '6px';
    const openBtn = el('button', 'btn tiny', '打开目标文件夹');
    openBtn.onclick = () => { navigator.clipboard.writeText(job.destDir).then(() => toast('路径已复制到剪贴板，粘贴到资源管理器地址栏即可', 'ok')); };
    links.appendChild(openBtn);
    if (job.manifestUrl) {
      const a = el('a', 'btn tiny', '下载清单 CSV');
      a.href = job.manifestUrl;
      links.appendChild(a);
    }
    if (job.zipUrl) {
      const a = el('a', 'btn tiny', `下载 zip`);
      a.href = job.zipUrl;
      links.appendChild(a);
    }
    box.appendChild(links);
  }
  if (job.error) line('错误', job.error, 'var(--err)');
}

// ---------------------------------------------------------------- 目录浏览

let browserTarget = null;
let browserPath = '';
// 用目录浏览器选好、但还没确认切换的库目录（确认前不动当前库）
let pendingRoot = '';

function openBrowser(target, startPath) {
  browserTarget = target;
  browserPath = startPath || S.rootMeta && S.rootMeta.drive || '';
  const dlg = $('#browser');
  if (!dlg.open) dlg.showModal();
  loadDrives().then(() => listDir(browserPath));
}

async function loadDrives() {
  const sel = $('#brDrives');
  if (sel.options.length) return;
  try {
    const res = await api('/api/fs/drives');
    sel.innerHTML = '';
    for (const d of res.drives) {
      const o = el('option', null, d.name);
      o.value = d.path;
      sel.appendChild(o);
    }
    const home = el('option', null, `用户目录 (${res.home})`);
    home.value = res.home;
    sel.appendChild(home);
  } catch (err) { toast(err.message, 'err'); }
}

async function listDir(p) {
  if (!p) return;
  try {
    const res = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    browserPath = res.path;
    $('#brPath').textContent = `${res.path}   （这里能扫到 ${res.mediaCount} 个媒体文件）`;
    const box = $('#brList');
    box.innerHTML = '';
    if (!res.dirs.length) box.appendChild(el('div', 'muted small', '（没有子文件夹）'));
    for (const d of res.dirs) {
      const row = el('div', 'dirrow');
      row.appendChild(el('span', null, '📁'));
      row.appendChild(el('span', null, d.name));
      row.onclick = () => listDir(d.path);
      box.appendChild(row);
    }
    const sel = $('#brDrives');
    for (const o of sel.options) if (res.path.startsWith(o.value)) { sel.value = o.value; break; }
    $('#brUp').disabled = !res.parent;
  } catch (err) { toast(err.message, 'err'); }
}

async function pickNative(target, startPath) {
  try {
    const res = await api('/api/fs/pick-folder', { method: 'POST', body: { start: startPath || S.root || '' } });
    if (res.cancelled || !res.path) return;
    applyPicked(target, res.path);
  } catch (err) {
    toast(`系统对话框不可用（${err.message}），请用页面里的目录浏览`, 'err');
  }
}

function applyPicked(target, p) {
  if (target === 'boot') { $('#bootPath').value = p; }
  else if (target === 'root') { pendingRoot = p; }
  else if (target === 'export') { $('#expDest').value = p; }
  else if (target === 'exportDefault') { $('#setExportRoot').value = p; }
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  $('#suggestChip').onclick = () => openSuggestions();
  $('#sugClose').onclick = () => $('#suggestDlg').close();
  $('#sugAccept').onclick = () => acceptSuggestion();
  $('#sugIgnore').onclick = () => ignoreSuggestion(null);
  $('#sugIgnoreSel').onclick = () => ignoreSuggestion(sugSelectableIds().filter((id) => sugChecked.has(id)));
  $('#sugAll').onchange = (ev) => {
    const ids = sugSelectableIds();
    sugChecked.clear();
    if (ev.target.checked) {
      sugTouched.clear();
      for (const id of ids) sugChecked.add(id);
    } else {
      for (const id of ids) sugTouched.add(id);
    }
    renderSugSelection();
  };
  // 启动
  $('#bootGo').onclick = bootFromInput;
  $('#bootPath').onkeydown = (ev) => { if (ev.key === 'Enter') bootFromInput(); };
  $('#bootBrowse').onclick = () => openBrowser('boot', $('#bootPath').value || S.root);

  // 顶栏
  let searchTimer = null;
  $('#search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.filters.q = $('#search').value.trim();
      S.offset = 0;
      loadItems();
    }, 250);
  };
  $('#kindFilter').onchange = () => { S.filters.kind = $('#kindFilter').value; S.offset = 0; loadItems(); };
  $('#sortSelect').onchange = () => { S.filters.sort = $('#sortSelect').value; S.offset = 0; loadItems(); };
  $('#rescanBtn').onclick = async () => {
    const btn = $('#rescanBtn');
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const res = await api('/api/scan', { method: 'POST' });
      toast(`扫描完成：新增 ${res.added}，移除记录 ${res.removed}，改名 ${res.renamed}${res.suggested ? `，认出 ${res.suggested} 组文件名标签` : ''}`, 'ok');
      await afterMutation();
      if (S.suggest.itemCount) openSuggestions();
    } catch (err) { toast(err.message, 'err'); } finally {
      btn.disabled = false;
      btn.textContent = '重新扫描';
    }
  };
  $('#exportBtn').onclick = openExport;
  $('#settingsBtn').onclick = () => { renderSettings(); if (!$('#settings').open) $('#settings').showModal(); };

  // 侧栏快捷
  for (const chip of document.querySelectorAll('[data-quick]')) {
    chip.onclick = () => {
      const q = chip.dataset.quick;
      if (q === 'all') { S.filters = { ...S.filters, tags: [], any: [], kind: '', untagged: false, q: '' }; $('#search').value = ''; $('#kindFilter').value = ''; }
      if (q === 'untagged') { S.filters = { ...S.filters, tags: [], any: [], untagged: true, kind: '' }; }
      if (q === 'clear') { S.filters = { tags: [], any: [], kind: '', untagged: false, q: '', sort: S.filters.sort }; $('#search').value = ''; $('#kindFilter').value = ''; }
      S.offset = 0;
      renderTagList();
      loadItems();
    };
  }
  $('#tagSearch').oninput = () => { tagSearchTerm = $('#tagSearch').value; renderTagList(); };
  $('#newCollection').onclick = async () => {
    if (!S.filters.tags.length) { toast('先点几个标签作为筛选，再存合集', 'err'); return; }
    const name = prompt('合集名字（例如「助眠」「素材待剪」）', S.filters.tags.join('+'));
    if (!name) return;
    const next = S.collections.filter((c) => c.name !== name).concat([{ name, tags: [...S.filters.tags] }]);
    try {
      await api('/api/collections', { method: 'POST', body: { collections: next } });
      await refreshTags();
      toast('合集已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  // 选择
  $('#selectAllBtn').onclick = () => {
    const all = S.items.every((i) => S.selection.has(i.id));
    for (const i of S.items) { if (all) S.selection.delete(i.id); else S.selection.add(i.id); }
    updateCardState();
  };
  $('#clearSelBtn').onclick = () => { S.selection.clear(); updateCardState(); };
  $('#selClear').onclick = () => { S.selection.clear(); updateCardState(); };
  $('#bulkAdd').onclick = () => bulk('add', 'add', $('#bulkTags').value);
  $('#bulkRemoveBtn').onclick = () => bulk('remove', 'remove', $('#bulkRemove').value);
  $('#selExport').onclick = () => { exportScope = { mode: 'selected' }; openExport(); };

  // 编辑器
  $('#editorSave').onclick = saveEditor;
  $('#editorCancel').onclick = () => { $('#editor').close(); editorItem = null; };
  $('#editorClear').onclick = () => { $('#editorTags').value = ''; renderSuggest([]); updatePreview(); };
  $('#editorTags').oninput = () => { renderSuggest(splitTags($('#editorTags').value)); updatePreview(); };
  $('#editorTags').onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveEditor(); }
  };
  $('#editor').addEventListener('close', () => {
    const v = $('#editorMedia').querySelector('video, audio');
    if (v) v.pause();
  });

  // 导出
  $('#expBrowse').onclick = () => openBrowser('export', $('#expDest').value || S.defaultExportRoot);
  $('#expStart').onclick = startExport;
  $('#expCancel').onclick = async () => {
    if (!currentJob) return;
    try { await api(`/api/export/${currentJob.id}/cancel`, { method: 'POST' }); } catch (err) { toast(err.message, 'err'); }
  };
  $('#expClose').onclick = () => { $('#exportDlg').close(); };

  // 顶栏：换素材文件夹 / 快速切换到用过的文件夹
  $('#rootPath').onclick = () => openBrowser('root', S.root || '');
  $('#rootSelect').onchange = async (ev) => {
    const v = ev.target.value;
    if (v === '__pick__') { openBrowser('root', S.root || ''); return; }
    if (!v || pathKey(v) === pathKey(S.root)) { renderRootSelect(); return; }
    await boot(v);
  };

  // 设置
  $('#setSave').onclick = () => {
    const exportRoot = $('#setExportRoot').value.trim();
    localStorage.setItem('tagstudio.exportRoot', exportRoot);
    if (exportRoot) $('#expDest').value = exportRoot;
    $('#settings').close();
  };
  $('#setClose').onclick = () => $('#settings').close();

  // 浏览器
  $('#brDrives').onchange = () => listDir($('#brDrives').value);
  $('#brUp').onclick = async () => {
    try {
      const res = await api(`/api/fs/list?path=${encodeURIComponent(browserPath)}`);
      if (res.parent) listDir(res.parent);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#brCancel').onclick = () => { pendingRoot = ''; $('#browser').close(); };
  $('#brPick').onclick = () => {
    if (!browserPath) return;
    applyPicked(browserTarget, browserPath);
    $('#browser').close();
    if (browserTarget === 'boot') bootFromInput();
    else if (browserTarget === 'root') confirmPendingRoot();
  };
  $('#brNative').onclick = async () => {
    $('#browser').close();
    await pickNative(browserTarget, browserPath);
    if (browserTarget === 'boot' && $('#bootPath').value) bootFromInput();
    else if (browserTarget === 'root') confirmPendingRoot();
  };

  // 快捷键
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (ev.key === 'Escape' && !typing && !document.querySelector('dialog[open]')) {
      S.filters = { tags: [], any: [], kind: '', untagged: false, q: '', sort: S.filters.sort };
      $('#search').value = '';
      $('#kindFilter').value = '';
      renderTagList();
      loadItems();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a' && !typing) {
      ev.preventDefault();
      $('#selectAllBtn').click();
    }
    if (ev.key === 'f' && !typing && !ev.ctrlKey && !ev.metaKey) { $('#search').focus(); }
  });
}

function renderSettings() {
  $('#setExportRoot').value = localStorage.getItem('tagstudio.exportRoot') || '';
  const info = $('#setInfo');
  info.innerHTML = '';
  const add = (k, v) => { info.appendChild(el('div', 'k', k)); info.appendChild(el('div', 'v', v)); };
  add('元数据目录', S.rootMeta ? S.rootMeta.metaDir : '—');
  add('ffmpeg', S.ffmpeg && S.ffmpeg.path ? S.ffmpeg.path : '未找到（视频缩略图会显示占位图标）');
  add('文件名预算', `${S.thresholds.nameBudgetBytes} 字节（uuid 和扩展名不裁剪）`);
  add('标签长度上限', `${S.thresholds.maxTagChars} 字符，且不能含「-」和「.」`);
  add('路径上限', `${S.thresholds.maxAbsPathChars} 字符`);
  add('自动扫描', S.scanInterval ? `每 ${Math.round(S.scanInterval / 1000)} 秒` : '关闭（只在手动点「重新扫描」时扫）');
  if (S.lastScan) add('上次扫描', `${S.lastScan.scannedAt}（新增 ${S.lastScan.added}，移除 ${S.lastScan.removed}，改名 ${S.lastScan.renamed}）`);
}

async function bootFromInput() {
  const root = $('#bootPath').value.trim();
  if (!root) { $('#bootMsg').textContent = '请填一个文件夹路径'; return; }
  await boot(root);
}

/** 顶栏选完文件夹之后：没变就只是把下拉框复位，真换了才切库 */
async function confirmPendingRoot() {
  const p = pendingRoot;
  pendingRoot = '';
  if (!p || pathKey(p) === pathKey(S.root)) { renderRootSelect(); return; }
  await boot(p);
}

async function boot(root) {
  const msg = $('#bootMsg');
  msg.className = 'msg';
  msg.textContent = '正在打开…';
  try {
    const res = await api('/api/library/boot', { method: 'POST', body: { root } });
    $('#boot').hidden = true;
    $('#settings').close();
    toast(`已打开素材库（${res.stats.total} 个素材，本次扫描新增 ${res.scan ? res.scan.added : 0}）`, 'ok');
    S.selection.clear();
    S.offset = 0;
    await afterMutation();
    msg.textContent = '';
    // 刚打开的文件夹里如果有「标签1-标签2.ext」这种文件名，弹窗问用户要不要认成标签
    if (S.suggest.itemCount) openSuggestions();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    if (!S.ready) $('#boot').hidden = false;
  }
}

init().catch((err) => {
  $('#boot').hidden = false;
  $('#bootMsg').className = 'msg err';
  $('#bootMsg').textContent = `初始化失败：${err.message}`;
});
