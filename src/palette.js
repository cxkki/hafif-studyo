// Command palette (Ctrl+K / Ctrl+Shift+P) and header language picker.
// Wiring: import { initPalette, registerAction } from './palette.js'; initPalette({ openTour }) after UI is built.
// ctx (all optional): { openTour(), openLive(), openAssistant(), actions: [{id,title,keywords,run}] }
import { t, LANGUAGES, currentLanguage, setLanguage } from './i18n.js';
import { store, toast } from './util.js';

const registry = new Map(); // id -> action
let ctxRef = {};
let ovl = null;

/** Register a command: { id, title, keywords?, group?, run() }. Replaces an existing id. */
export function registerAction(a) {
  if (a && a.id && typeof a.run === 'function') registry.set(a.id, a);
}

const q = (sel) => document.querySelector(sel);
const click = (sel) => () => { const el = q(sel); if (el) { el.click(); return true; } return false; };

function builtins() {
  const L = [];
  const add = (id, title, keywords, run, group) => L.push({ id, title, keywords, run, group });
  const G = { mode: t('pal.g.mode', 'Mode'), video: t('pal.g.video', 'Video') };
  // Static t() keys (not built from variables) so tools/i18n-extract.mjs can find them.
  const modes = [
    ['m3d', t('pal.mode.m3d', 'Switch to: 3D modelling'), '3d model'],
    ['mvid', t('pal.mode.mvid', 'Switch to: Video editing'), 'video edit'],
    ['mweb', t('pal.mode.mweb', 'Switch to: Web builder'), 'web site'],
  ];
  for (const [m, title, kw] of modes) add('mode.' + m, title, kw, click(`.tabs button[data-tab="${m}"]`), G.mode);
  const shapeTitles = {
    cube: t('pal.add.cube', 'Add 3D shape: cube'),
    sphere: t('pal.add.sphere', 'Add 3D shape: sphere'),
    cylinder: t('pal.add.cylinder', 'Add 3D shape: cylinder'),
    cone: t('pal.add.cone', 'Add 3D shape: cone'),
    wedge: t('pal.add.wedge', 'Add 3D shape: wedge'),
    torus: t('pal.add.torus', 'Add 3D shape: torus'),
    capsule: t('pal.add.capsule', 'Add 3D shape: capsule'),
    plane: t('pal.add.plane', 'Add 3D shape: ground plane'),
  };
  const kws = { wedge: 'ramp', torus: 'donut ring', plane: 'ground floor' };
  for (const s of Object.keys(shapeTitles)) {
    add('3d.add.' + s, shapeTitles[s], s + ' ' + (kws[s] || '') + ' shape add', () => {
      click('.tabs button[data-tab="m3d"]')(); click(`[data-add="${s}"]`)();
    }, '3D');
  }
  add('3d.png', t('pal.png', 'Render PNG'), 'image picture screenshot', () => { click('.tabs button[data-tab="m3d"]')(); click('#d-png')(); }, '3D');
  add('vid.text', t('pal.vtext', 'Add text to video'), 'title caption', () => { click('.tabs button[data-tab="mvid"]')(); click('#v-text')(); }, G.video);
  add('vid.media', t('pal.vmedia', 'Add media to video'), 'import clip image audio', () => { click('.tabs button[data-tab="mvid"]')(); click('#v-import')(); }, G.video);
  add('vid.export', t('pal.vexport', 'Export video'), 'render mp4 save', () => { click('.tabs button[data-tab="mvid"]')(); click('#v-export')(); }, G.video);
  add('templates', t('pal.templates', 'Templates gallery'), 'new project template sablon', click('#templatesBtn'));
  add('recipe', t('pal.recipe', 'Run a recipe file'), 'tarif agents', click('#runRecipeBtn'));
  add('live', t('pal.live', 'Open / close live project'), 'proje.json ai agents canli', () => {
    if (ctxRef.openLive) ctxRef.openLive();
  });
  add('assistant', t('pal.assistant', 'Open AI assistant'), 'ai chat claude', () => {
    if (ctxRef.openAssistant) ctxRef.openAssistant();
    else if (!click('#aiBtn')()) document.dispatchEvent(new CustomEvent('hs:assistant-open'));
  });
  add('eco', t('pal.eco', 'Toggle eco mode'), 'performance low power', click('#eco'));
  add('outdir', t('pal.outdir', 'Open outputs folder'), 'output files', click('#outDirBtn'));
  add('help', t('pal.help', 'Help and shortcuts'), 'keyboard keys', click('#helpBtn'));
  add('tour', t('pal.tour', 'Show tour'), 'welcome intro onboarding', () => ctxRef.openTour && ctxRef.openTour());
  for (const l of LANGUAGES) {
    add('lang.' + l.code, t('pal.lang', 'Language: {name}', { name: l.name }), 'language ' + l.code, () => setLanguage(l.code), t('pal.g.lang', 'Language'));
  }
  return L;
}

function all() {
  const m = new Map();
  for (const a of builtins()) m.set(a.id, a);
  for (const a of registry.values()) m.set(a.id, a);
  for (const a of ctxRef.actions || []) m.set(a.id, a);
  return [...m.values()];
}

/** Subsequence fuzzy match; returns {score, idx[]} or null. */
function fuzzy(needle, hay) {
  const n = needle.toLowerCase(), h = String(hay).toLowerCase();
  const sub = h.indexOf(n);
  if (sub >= 0) return { score: 100 - sub, idx: [...Array(n.length).keys()].map((i) => i + sub) };
  const idx = []; let p = 0, score = 0, last = -2;
  for (const ch of n) {
    if (ch === ' ') continue;
    const f = h.indexOf(ch, p);
    if (f < 0) return null;
    score += f === last + 1 ? 3 : 1; last = f; idx.push(f); p = f + 1;
  }
  return { score, idx };
}

function search(query) {
  const recent = store.get('palRecent', []);
  const items = all();
  if (!query.trim()) {
    const rank = (a) => { const i = recent.indexOf(a.id); return i < 0 ? 999 : i; };
    return items.map((a) => ({ a, idx: [] })).sort((x, y) => rank(x.a) - rank(y.a));
  }
  const out = [];
  for (const a of items) {
    const m = fuzzy(query, a.title);
    if (m) out.push({ a, idx: m.idx, s: m.score + 50 });
    else {
      const k = fuzzy(query, a.keywords || '');
      if (k) out.push({ a, idx: [], s: k.score });
    }
  }
  return out.sort((x, y) => y.s - x.s);
}

function hl(title, idx) {
  const set = new Set(idx);
  let s = '';
  [...title].forEach((c, i) => {
    const e = c.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]));
    s += set.has(i) ? '<mark>' + e + '</mark>' : e;
  });
  return s;
}

export function closePalette() { if (ovl) { ovl.remove(); ovl = null; } }

export function openPalette() {
  if (ovl) return closePalette();
  ovl = document.createElement('div');
  ovl.className = 'ovl pal-ovl';
  ovl.innerHTML = '<div class="card pal-card" role="dialog" aria-modal="true"><input class="pal-in" type="text" spellcheck="false" autocomplete="off"><ul class="pal-list" role="listbox"></ul><div class="pal-foot"></div></div>';
  const input = ovl.querySelector('input'), list = ovl.querySelector('ul');
  input.placeholder = t('pal.placeholder', 'Type a command...');
  ovl.querySelector('.pal-foot').textContent = t('pal.hint', 'Up/Down to move, Enter to run, Esc to close');
  let res = [], sel = 0;
  const run = (i) => {
    const r = res[i]; if (!r) return;
    store.set('palRecent', [r.a.id, ...store.get('palRecent', []).filter((x) => x !== r.a.id)].slice(0, 8));
    closePalette();
    if (ctxRef.isBusy && ctxRef.isBusy()) return toast(t('pal.busy', 'A job or export is running; try again when it finishes'));
    try { r.a.run(); } catch (e) { console.error(e); }
  };
  const render = () => {
    res = search(input.value);
    sel = Math.min(sel, Math.max(0, res.length - 1));
    list.textContent = '';
    if (!res.length) {
      const li = document.createElement('li');
      li.className = 'pal-empty';
      li.textContent = t('pal.none', 'No matching commands');
      list.appendChild(li);
    }
    res.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'pal-item' + (i === sel ? ' sel' : '');
      li.setAttribute('role', 'option');
      li.innerHTML = '<span class="pal-t">' + hl(r.a.title, r.idx) + '</span><span class="pal-g"></span>';
      li.lastChild.textContent = r.a.group || '';
      li.onmousedown = (e) => { e.preventDefault(); run(i); };
      list.appendChild(li);
    });
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  ovl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(res.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  ovl.addEventListener('mousedown', (e) => { if (e.target === ovl) closePalette(); });
  document.body.appendChild(ovl);
  render();
  input.focus();
}

function initLangPicker() {
  const top = q('header.top');
  if (!top || q('.lang-wrap')) return;
  const cur = LANGUAGES.find((l) => l.code === currentLanguage()) || LANGUAGES[0];
  const wrap = document.createElement('div');
  wrap.className = 'lang-wrap';
  wrap.innerHTML = '<button class="lang-btn" aria-haspopup="menu"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg><span></span></button><div class="lang-menu" role="menu" hidden></div>';
  const btn = wrap.firstChild, menu = wrap.lastChild;
  btn.title = t('pal.langTitle', 'Language');
  btn.lastChild.textContent = cur.code.toUpperCase();
  for (const l of LANGUAGES) {
    const b = document.createElement('button');
    b.textContent = l.name;
    if (l.code === cur.code) b.className = 'on';
    b.onclick = () => { menu.hidden = true; if (l.code !== cur.code) setLanguage(l.code); };
    menu.appendChild(b);
  }
  const close = (e) => { if (!wrap.contains(e.target)) { menu.hidden = true; document.removeEventListener('mousedown', close); } };
  btn.onclick = () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) document.addEventListener('mousedown', close);
  };
  const help = q('#helpBtn');
  top.insertBefore(wrap, help ? help.nextSibling : null);
}

export function initPalette(ctx = {}) {
  ctxRef = ctx;
  initLangPicker();
  document.addEventListener('keydown', (e) => {
    // e.code = physical key, so it also works on non-Latin layouts; e.key kept as a fallback.
    const k = e.key.toLowerCase();
    const isK = e.code === 'KeyK' || k === 'k';
    const isP = e.code === 'KeyP' || k === 'p';
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (isK || (e.shiftKey && isP))) {
      e.preventDefault();
      if (!ovl && ctxRef.isBusy && ctxRef.isBusy()) return toast(t('pal.busy', 'A job or export is running; try again when it finishes'));
      openPalette();
    }
  });
}
