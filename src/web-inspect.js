// Web önizleme denetçisi: Seç aracı (üzerine gelince çerçeve, tıklayınca seçim), özellik paneli,
// düzenlemelerin site dosyalarına yazılması (HTML + hs-custom.css) ve geri alma.
// Çerçeve kutuları ANA belgede iframe'in üstüne çizilir; siteye stil enjekte edilmez.
// Boşta hiçbir döngü/zamanlayıcı yok: iframe dinleyicileri yalnızca Seç aracı açıkken takılır.
import { toast, esc, clamp, bus } from './util.js';
import * as platform from './platform.js';
import { t } from './i18n.js';

const CUSTOM_CSS = 'hs-custom.css';
const ID_PREFIX = 'hse-'; // "hs-" önekli öğeleri canlı motor yok sayar; bu yüzden farklı önek
const MAX_UNDO = 30;
const SAVE_DEBOUNCE = 350;
const NO_TEXT = new Set(
  'img input br hr video audio canvas svg iframe select textarea meta link script style picture object embed source track wbr area map noscript template'.split(' ')
);
const FONTS = [
  'system-ui', 'Segoe UI', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Candara', 'Franklin Gothic Medium',
  'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Palatino Linotype', 'Book Antiqua',
  'Courier New', 'Consolas', 'Lucida Console', 'Impact', 'Comic Sans MS', 'Segoe Print',
  'sans-serif', 'serif', 'monospace', 'cursive',
];
const GENERIC = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive']);
const SERIF = new Set(['georgia', 'cambria', 'times new roman', 'garamond', 'palatino linotype', 'book antiqua']);
const MONO = new Set(['courier new', 'consolas', 'lucida console']);
const CURSIVE = new Set(['comic sans ms', 'segoe print']);
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const sigOf = (e) => norm(e.textContent).slice(0, 400);
// Öğe kimliği için betiklerin nadiren değiştirdiği öznitelikler (boş metinli öğelerde — img vb. — tek doğrulama bunlardır).
// Betiğin eklediği/kaldırdığı öznitelik (tembel yükleme, araç ipucu kitaplıkları) çelişki sayılmaz; yalnızca iki farklı değer çelişir.
const FP_ATTRS = ['src', 'href', 'alt', 'name', 'type', 'for', 'action'];
const fpOf = (e) => FP_ATTRS.map((a) => e.getAttribute(a));
const fpSame = (a, b) => a.every((v, i) => v == null || b[i] == null || v === b[i]);
const clsSet = (e) => (e.getAttribute('class') || '').split(/\s+/).filter((c) => c && !c.startsWith('hs-'));
/** Uygulamanın kendi öğeleri (id "hs-…") yol sayımına girmez. */
const ownNode = (c) => !!c.id && c.id.startsWith('hs-');
const firstFont = (ff) => String(ff || '').split(',')[0].replace(/["']/g, '').trim();
const alphaOf = (c) => {
  if (!c || c === 'transparent') return 0;
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return 1;
  const p = m[1].split(/[ ,/]+/).filter(Boolean);
  return p.length > 3 ? parseFloat(p[3]) : 1;
};
const toHex = (c) => {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#000000';
  const [r, g, b] = m[1].split(/[ ,/]+/).filter(Boolean).map((v) => clamp(Math.round(parseFloat(v)) || 0, 0, 255));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const fontValue = (name) => {
  if (!name) return '';
  if (GENERIC.has(name)) return name;
  const k = name.toLowerCase();
  const gen = SERIF.has(k) ? 'serif' : MONO.has(k) ? 'monospace' : CURSIVE.has(k) ? 'cursive' : 'sans-serif';
  return `"${name.replace(/["\\]/g, '')}", ${gen}`;
};
/** Değer CSS dosyasına güvenle yazılabilir mi (kural dışına taşmasın). */
const safeVal = (v) => !/[{};<>]/.test(String(v));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const depthPrefix = (rel) => '../'.repeat(Math.max(0, String(rel).split('/').length - 1));

/** HTML'i yeniden yazar; özgün <!doctype> korunur (biçim normalleşir). */
function serialize(doc, orig) {
  const m = /^\uFEFF?\s*(<!doctype[^>]*>)/i.exec(orig);
  const dt = m ? m[1] : doc.doctype ? '<!DOCTYPE html>' : '';
  return (dt ? dt + '\n' : '') + doc.documentElement.outerHTML + '\n';
}

/** hs-custom.css içinde tek seçicinin kuralını günceller (props null → kural silinir; boş değer → özellik silinir). */
function upsertRule(css, selector, props) {
  const re = new RegExp('(^|\\n)' + escRe(selector) + '\\s*\\{([^}]*)\\}[ \\t]*\\n?');
  const m = re.exec(css);
  const decl = new Map();
  if (m && props)
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':');
      if (i > 0) decl.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
    }
  for (const [p, v] of props || []) {
    if (v && safeVal(v)) decl.set(p, v);
    else decl.delete(p);
  }
  const block = decl.size ? `${selector} {\n${[...decl].map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}\n` : '';
  if (m) return (css.slice(0, m.index) + m[1] + block + css.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n');
  if (!block) return css;
  return css.replace(/\s*$/, '') + (css.trim() ? '\n\n' : '') + block;
}

const ruleSel = (id) => `html body #${CSS.escape(id)}`;
const CSS_HEAD = '/* Hafif Studyo: edits made with the web inspector (one rule per element). */\n';

function stripIds(root) {
  root.removeAttribute?.('id');
  for (const e of root.querySelectorAll?.('[id]') || []) e.removeAttribute('id');
}

/**
 * ctx: { stage, panel, frame(), busy(), relOf(doc), canWrite(rel), read(rel), exists(rel),
 *        write(rel, data, base, quiet), remove(rel, base), watching(), reload(), onState(on) }
 */
export function createInspector(ctx) {
  let on = false;
  let att = null; // {ac, frame, doc, win}
  let hoverEl = null;
  let sel = null; // {el, tag, id, path, text, file, textOnly, inline: Map}
  let pend = null; // {sel, style: Map, text, attrs}
  let pendT = 0;
  let queue = Promise.resolve();
  let warnedPreview = false;
  const undoStack = [];
  let hov = null;
  let box = null;

  const P = ctx.panel;

  function ensureBoxes() {
    if (hov) return;
    hov = document.createElement('div');
    hov.className = 'w-hov';
    hov.hidden = true;
    box = document.createElement('div');
    box.className = 'w-selb';
    box.hidden = true;
    box.innerHTML = '<span></span>';
    ctx.stage.append(hov, box);
  }
  const hideBoxes = () => {
    if (hov) hov.hidden = true;
    if (box) box.hidden = true;
  };

  // ------------------------------------------------------------ seçim tanımı / bulma

  function describe(e) {
    const doc = e.ownerDocument;
    if (!doc?.body || e === doc.body || !doc.body.contains(e)) return null;
    const path = [];
    for (let n = e; n !== doc.body; n = n.parentElement) {
      const p = n.parentElement;
      if (!p) return null;
      let i = 0;
      for (const c of p.children) {
        if (c.localName === n.localName && !ownNode(c)) i++;
        if (c === n) break;
      }
      path.unshift({ tag: n.localName, i });
    }
    const par = e.parentElement;
    return {
      el: e,
      tag: e.localName,
      id: e.id && !e.id.startsWith('hs-') ? e.id : '',
      path,
      text: sigOf(e),
      fp: fpOf(e),
      cls: clsSet(e),
      ptext: par && par !== doc.body ? sigOf(par) : null,
      file: ctx.relOf(doc),
      textOnly: !e.children.length && !NO_TEXT.has(e.localName),
      inline: new Map(),
    };
  }

  /** Kaynak (ya da yeni yüklenen) belgede aynı öğe: önce id, sonra etiket + nth-of-type zinciri; metin eşleşmesiyle doğrulanır. */
  function locate(doc, s, checkText = true) {
    if (!doc?.body) return null;
    let n = s.id ? doc.getElementById(s.id) : null;
    if (n && n.localName !== s.tag) n = null;
    if (!n) {
      n = doc.body;
      for (const st of s.path) {
        let k = 0;
        let f = null;
        for (const c of n.children)
          if (c.localName === st.tag && !ownNode(c) && ++k === st.i) {
            f = c;
            break;
          }
        n = f;
        if (!n) return null;
      }
    }
    if (!n || n === doc.body || n.localName !== s.tag) return null;
    if (checkText && sigOf(n) !== s.text) return null;
    return n;
  }

  /** Aynı öğe mi? (etiket + metin + kimlik öznitelikleri + sınıf örtüşmesi) */
  function same(n, s) {
    if (!n || n.localName !== s.tag || sigOf(n) !== s.text || !fpSame(fpOf(n), s.fp)) return false;
    const c = clsSet(n);
    return !c.length || !s.cls.length || c.some((x) => s.cls.includes(x));
  }

  /**
   * Kaynak dosyada düzenlenecek öğe. Yapısal yol, sitenin betikleri canlı DOM'a öğe eklediyse kayabilir;
   * bu yüzden önce kaynakta tek bir eşleşme aranır, birden çoksa yol + üst öğe metniyle seçilir. Emin olunamazsa null.
   */
  function locateSrc(doc, s) {
    if (!doc?.body) return null;
    if (s.id) {
      const n = doc.getElementById(s.id);
      if (n) return same(n, s) ? n : null;
    }
    const cands = [...doc.body.getElementsByTagName(s.tag)].filter((n) => same(n, s));
    if (cands.length === 1) return cands[0];
    if (!cands.length) return null;
    const n = locate(doc, s, false);
    if (!n || !cands.includes(n)) return null;
    const p = n.parentElement;
    if (s.ptext != null && (!p || p === doc.body || sigOf(p) !== s.ptext)) return null;
    return n;
  }

  const cssSelector = (s) =>
    s.id ? '#' + CSS.escape(s.id) : 'body' + s.path.map((p) => ` > ${p.tag}:nth-of-type(${p.i})`).join('');

  function shortPath(e) {
    const out = [];
    for (let n = e, k = 0; n && n.localName !== 'body' && k < 3; n = n.parentElement, k++) {
      const id = n.id && !n.id.startsWith('hs-') ? '#' + n.id : '';
      const cls = !id && typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/)[0] : '';
      out.unshift(n.localName + id + cls);
    }
    return out.join(' › ');
  }

  // ------------------------------------------------------------ iframe dinleyicileri

  const curDoc = () => att?.doc || null;
  /** Ekranda görünen önizleme belgesi (Seç aracı kapalıyken de). */
  const shownDoc = () => {
    try {
      const d = ctx.frame().contentDocument;
      return d && !/^about:/i.test(d.URL || '') ? d : null;
    } catch {
      return null;
    }
  };

  function detach() {
    if (att) att.ac.abort();
    att = null;
    hoverEl = null;
  }

  function attach() {
    detach();
    if (!on) return hideBoxes();
    ensureBoxes();
    const f = ctx.frame();
    const ac = new AbortController();
    att = { ac, frame: f, doc: null, win: null };
    f.addEventListener('load', () => attach(), { signal: ac.signal });
    if (ctx.busy()) return hideBoxes();
    let doc = null;
    let win = null;
    try {
      doc = f.contentDocument;
      win = f.contentWindow;
    } catch {}
    if (!doc?.body || !win || /^about:/i.test(doc.URL || '')) return hideBoxes();
    att.doc = doc;
    att.win = win;
    const o = { capture: true, signal: ac.signal };
    doc.addEventListener('mousemove', onMove, o);
    doc.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) {
        hoverEl = null;
        reposition();
      }
    }, o);
    for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'submit']) doc.addEventListener(ev, swallow, o);
    doc.addEventListener('click', onClick, o);
    doc.addEventListener('keydown', onFrameKey, o);
    win.addEventListener('scroll', reposition, { passive: true, signal: ac.signal });
    win.addEventListener('resize', reposition, { signal: ac.signal });
    // Sayfa yenilendi / değişti: seçimi yeni belgede yeniden bul.
    if (sel && sel.el.ownerDocument !== doc) {
      flush();
      const n = locate(doc, sel, false);
      sel = n ? describe(n) : null;
      render();
    }
    reposition();
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  }

  function pickTarget(tg) {
    const doc = curDoc();
    let e = tg?.nodeType === 1 ? tg : tg?.parentElement;
    if (!e || !doc) return null;
    if (e.closest('svg')) {
      let s = e.closest('svg');
      while (s.parentElement?.closest('svg')) s = s.parentElement.closest('svg');
      e = s;
    }
    if (e.closest('[id^="hs-"]')) return null; // uygulamanın kendi katmanları
    if (e === doc.body || e === doc.documentElement || e.closest('head')) return null;
    return e;
  }

  function onMove(e) {
    const tg = pickTarget(e.target);
    if (tg === hoverEl) return;
    hoverEl = tg;
    reposition();
  }

  function onClick(e) {
    swallow(e);
    const tg = pickTarget(e.target);
    if (tg) select(tg);
  }

  function onFrameKey(e) {
    const tg = e.target;
    if (tg?.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(tg?.tagName || '') && tg.type !== 'checkbox' && tg.type !== 'range')) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && k === 'z') {
      e.preventDefault();
      undo();
    } else if (k === 'escape') {
      e.preventDefault();
      select(null);
    } else if (k === 'v' && !ctrl && !e.altKey) {
      e.preventDefault();
      toggle(false);
    }
  }

  // ------------------------------------------------------------ kutular

  function place(div, e, label) {
    const f = att?.frame;
    if (!div || !e || !f || !e.isConnected || e.ownerDocument !== att.doc) {
      if (div) div.hidden = true;
      return;
    }
    const s = f.getBoundingClientRect().width / (f.offsetWidth || 1);
    const r = e.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      div.hidden = true;
      return;
    }
    const W = ctx.stage.clientWidth;
    const H = ctx.stage.clientHeight;
    const x1 = clamp(f.offsetLeft + r.left * s, -4, W + 4);
    const y1 = clamp(f.offsetTop + r.top * s, -4, H + 4);
    const x2 = clamp(f.offsetLeft + r.right * s, -4, W + 4);
    const y2 = clamp(f.offsetTop + r.bottom * s, -4, H + 4);
    if (x2 - x1 < 1 || y2 - y1 < 1) {
      div.hidden = true;
      return;
    }
    div.style.cssText = `left:${x1}px;top:${y1}px;width:${x2 - x1}px;height:${y2 - y1}px`;
    if (label != null) {
      const sp = div.firstElementChild;
      sp.textContent = `${label}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
      div.classList.toggle('in', y1 < 20);
    }
    div.hidden = false;
  }

  function reposition() {
    if (!on || !att?.doc) return hideBoxes();
    if (sel && !sel.el.isConnected) {
      const n = locate(att.doc, sel, false);
      if (n) {
        sel = describe(n);
        render();
      } else select(null);
    }
    place(hov, hoverEl && hoverEl !== sel?.el ? hoverEl : null);
    place(box, sel?.el || null, sel ? shortPath(sel.el) : null);
  }

  // ------------------------------------------------------------ seçim + panel

  function select(e) {
    if (e && sel && e === sel.el) return;
    flush();
    sel = e ? describe(e) : null;
    render();
    reposition();
  }

  function render() {
    P.hidden = !on;
    if (!on) {
      P.textContent = '';
      return;
    }
    if (!sel) {
      P.innerHTML = `<div class="wi-head"><b>${esc(t('web.insp.title', 'Inspector'))}</b><button class="wi-x" data-act="close" title="${esc(t('web.insp.closeTip', 'Close the select tool (V)'))}">×</button></div>
<p class="wi-hint">${esc(t('web.insp.hint', 'Hover the preview and click an element to edit it.'))}</p>
<p class="wi-foot">${esc(t('web.insp.keys', 'V select tool · Esc deselect · Ctrl+Z undo'))}</p>`;
      return;
    }
    const e = sel.el;
    const win = e.ownerDocument?.defaultView;
    if (!win || !e.isConnected) {
      sel = null;
      return render();
    }
    const cs = win.getComputedStyle(e);
    const A = (k, d) => esc(t(k, d));
    const bgA = alphaOf(cs.backgroundColor);
    const curFont = firstFont(cs.fontFamily);
    const inList = FONTS.some((f) => f.toLowerCase() === curFont.toLowerCase());
    const fontOpts =
      (inList ? '' : `<option value="" selected>${esc(curFont || t('web.insp.fontCur', '(current)'))}</option>`) +
      FONTS.map((f) => `<option value="${esc(f)}"${f.toLowerCase() === curFont.toLowerCase() ? ' selected' : ''}>${esc(f)}</option>`).join('');
    const fw = String(cs.fontWeight);
    const wOpts = WEIGHTS.map((w) => `<option${w === fw ? ' selected' : ''}>${w}</option>`).join('');
    const isImg = sel.tag === 'img';
    const writable = ctx.canWrite(sel.file);
    P.innerHTML = `<div class="wi-head"><b class="wi-tag">&lt;${esc(sel.tag)}&gt;</b><span class="wi-path" title="${esc(cssSelector(sel))}">${esc(shortPath(e))}</span><button class="wi-x" data-act="deselect" title="${A('web.insp.deselect', 'Deselect (Esc)')}">×</button></div>
<div class="wi-body">
${sel.textOnly ? `<label class="wi-lbl" for="wi-text">${A('web.insp.text', 'Text')}</label><textarea id="wi-text" data-k="text" rows="3" spellcheck="false">${esc(e.textContent)}</textarea>` : ''}
<div class="wi-row"><label>${A('web.insp.color', 'Text colour')}</label><span class="wi-col"><input type="color" data-k="color" value="${toHex(cs.color)}"><code data-o="color">${toHex(cs.color)}</code></span></div>
<div class="wi-row"><label>${A('web.insp.bg', 'Background')}</label><span class="wi-col"><input type="color" data-k="bg" value="${bgA > 0.02 ? toHex(cs.backgroundColor) : '#ffffff'}"><code data-o="bg">${bgA > 0.02 ? toHex(cs.backgroundColor) : esc(t('web.insp.none', 'none'))}</code><button class="wi-mini" data-act="bg-none" title="${A('web.insp.bgNone', 'No background')}">∅</button></span></div>
<div class="wi-row"><label>${A('web.insp.size', 'Font size')}</label><span class="wi-num"><input type="number" data-k="fs" min="1" max="400" step="1" value="${Math.round(parseFloat(cs.fontSize) || 16)}"><i>px</i></span></div>
<div class="wi-row"><label>${A('web.insp.weight', 'Font weight')}</label><select data-k="fw">${wOpts}</select></div>
<div class="wi-row"><label>${A('web.insp.font', 'Font')}</label><select data-k="ff">${fontOpts}</select></div>
<div class="wi-row"><label>${A('web.insp.pad', 'Padding')}</label><input type="text" data-k="pad" spellcheck="false" value="${esc(cs.padding)}" placeholder="12px 20px"></div>
<div class="wi-row"><label>${A('web.insp.radius', 'Corner radius')}</label><span class="wi-num"><input type="number" data-k="br" min="0" step="1" value="${Math.round(parseFloat(cs.borderTopLeftRadius) || 0)}"><i>px</i></span></div>
${isImg ? `<div class="wi-sep"></div>
<div class="wi-row"><label>${A('web.insp.src', 'Image')}</label><span class="wi-src"><input type="text" data-o="src" readonly value="${esc(e.getAttribute('src') || '')}"><button class="wi-mini" data-act="img">${A('web.insp.choose', 'Choose…')}</button></span></div>
<div class="wi-row"><label>${A('web.insp.alt', 'Alt text')}</label><input type="text" data-k="alt" value="${esc(e.getAttribute('alt') || '')}"></div>` : ''}
</div>
<div class="wi-acts">
<button class="pri" data-act="apply" title="${A('web.insp.applyTip', 'Save pending edits to the site files now')}">${A('web.insp.apply', 'Apply')}</button>
<button data-act="reset" title="${A('web.insp.resetTip', 'Remove the inspector rule for this element (hs-custom.css)')}">${A('web.insp.reset', 'Reset style')}</button>
<button data-act="dup">${A('web.insp.dup', 'Duplicate element')}</button>
<button data-act="del" class="wi-danger">${A('web.insp.del', 'Delete element')}</button>
<button data-act="ai" class="wi-ai">${A('web.insp.ai', 'Ask AI about this')}</button>
</div>
<p class="wi-foot">${writable ? A('web.insp.footSave', 'Edits are saved to the site files. Ctrl+Z undoes.') : A('web.insp.footPreview', 'Edits stay in the preview only (no site folder).')}</p>`;
  }

  // ------------------------------------------------------------ düzenleme (önizleme + bekleyen kayıt)

  function stage() {
    if (!pend || pend.sel !== sel) {
      flush();
      pend = { sel, style: new Map(), text: undefined, attrs: {} };
    }
    return pend;
  }
  function schedule(ms = SAVE_DEBOUNCE) {
    clearTimeout(pendT);
    pendT = setTimeout(flush, ms);
  }
  /** Bekleyen düzenlemeyi kuyruğa alır (sıralı yazma). */
  function flush() {
    clearTimeout(pendT);
    pendT = 0;
    const p = pend;
    pend = null;
    if (!p || (!p.style.size && p.text === undefined && !Object.keys(p.attrs).length)) return queue;
    return enqueue(() => persist(p));
  }
  function enqueue(fn) {
    queue = queue.then(fn).catch((e) => {
      console.error('inspector', e);
      toast(t('web.insp.err', 'Could not save the edit: {msg}', { msg: e?.message || e }), 5000);
    });
    return queue;
  }

  function previewStyle(prop, v) {
    const e = sel.el;
    if (!sel.inline.has(prop)) sel.inline.set(prop, [e.style.getPropertyValue(prop), e.style.getPropertyPriority(prop)]);
    if (v) e.style.setProperty(prop, v, 'important');
    else restoreInline(sel, prop, false);
    stage().style.set(prop, v);
    reposition();
  }

  /** Önizleme için konan satır içi değeri sitenin özgün değerine döndürür. */
  function restoreInline(s, prop, forget = true) {
    const o = s.inline.get(prop);
    if (!o) return;
    if (forget) s.inline.delete(prop);
    const st = s.el.style;
    if (o[0]) st.setProperty(prop, o[0], o[1]);
    else st.removeProperty(prop);
    if (!s.el.getAttribute('style')) s.el.removeAttribute('style');
  }

  function padValue(v) {
    const s = String(v).trim();
    if (!s) return '';
    const px = s.split(/\s+/).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? x + 'px' : x)).join(' ');
    return CSS.supports('padding', px) && safeVal(px) ? px : null;
  }

  function onField(ev, commit) {
    const tg = ev.target;
    const k = tg.dataset?.k;
    if (!k || !sel) return;
    const v = tg.value;
    tg.classList.remove('bad');
    switch (k) {
      case 'text':
        if (!sel.textOnly) return;
        sel.el.textContent = v;
        stage().text = v;
        reposition();
        break;
      case 'color':
      case 'bg': {
        previewStyle(k === 'color' ? 'color' : 'background-color', v);
        const o = P.querySelector(`[data-o="${k}"]`);
        if (o) o.textContent = v;
        break;
      }
      case 'fs':
        if (v !== '' && !(+v > 0)) return tg.classList.add('bad');
        previewStyle('font-size', v === '' ? '' : clamp(+v, 1, 999) + 'px');
        break;
      case 'fw':
        previewStyle('font-weight', v);
        break;
      case 'ff':
        previewStyle('font-family', fontValue(v));
        break;
      case 'pad': {
        const x = padValue(v);
        if (x === null) return tg.classList.add('bad');
        previewStyle('padding', x);
        break;
      }
      case 'br':
        if (v !== '' && !(+v >= 0)) return tg.classList.add('bad');
        previewStyle('border-radius', v === '' ? '' : clamp(+v, 0, 9999) + 'px');
        break;
      case 'alt':
        sel.el.setAttribute('alt', v);
        stage().attrs.alt = v;
        break;
      default:
        return;
    }
    if (commit) schedule();
  }

  P.addEventListener('input', (e) => onField(e, false));
  P.addEventListener('change', (e) => onField(e, true));
  P.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName === 'TEXTAREA') {
      e.target.blur();
      flush();
    } else if (e.key === 'Escape') {
      e.target.blur?.();
      select(null);
    }
  });
  P.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return toggle(false);
    if (act === 'deselect') return select(null);
    if (!sel) return;
    if (act === 'apply') flush();
    else if (act === 'bg-none') {
      previewStyle('background-color', 'transparent');
      const o = P.querySelector('[data-o="bg"]');
      if (o) o.textContent = t('web.insp.none', 'none');
      schedule(0);
    } else if (act === 'reset') resetStyle();
    else if (act === 'dup') duplicate();
    else if (act === 'del') remove();
    else if (act === 'ai') askAi();
    else if (act === 'img') chooseImage();
  });

  // ------------------------------------------------------------ yazma

  function previewOnly() {
    if (warnedPreview) return;
    warnedPreview = true;
    toast(t('web.insp.previewOnly', 'Edits stay in the preview only: no site folder to write to (browser version or a web address).'), 5000);
  }

  function ensureLink(doc, htmlRel) {
    const has = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')].some((l) =>
      /(^|\/)hs-custom\.css$/i.test(l.getAttribute('href').split(/[?#]/)[0])
    );
    if (has) return false;
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', depthPrefix(htmlRel) + CUSTOM_CSS);
    const head = doc.head || doc.documentElement;
    head.appendChild(doc.createTextNode('  '));
    head.appendChild(link);
    head.appendChild(doc.createTextNode('\n'));
    return true;
  }

  function newId(doc) {
    let n = 0;
    for (const e of doc.querySelectorAll(`[id^="${ID_PREFIX}"]`)) n = Math.max(n, +e.id.slice(ID_PREFIX.length) || 0);
    for (const e of shownDoc()?.querySelectorAll(`[id^="${ID_PREFIX}"]`) || []) n = Math.max(n, +e.id.slice(ID_PREFIX.length) || 0);
    return ID_PREFIX + (n + 1);
  }

  /**
   * Bir düzenleme grubunu kaynak dosyalara yazar.
   * Dönüş: true (yazıldı), 'preview' (yazılamaz, yalnızca önizleme), false (reddedildi).
   */
  async function persist(p) {
    const s = p.sel;
    if (!ctx.canWrite(s.file)) {
      previewOnly();
      return 'preview';
    }
    const html = await ctx.read(s.file);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const n = locateSrc(doc, s);
    if (!n) {
      toast(t('web.insp.noMatch', 'This element could not be matched in {file} (the page may have been changed by its scripts or by the AI). Nothing was written.', { file: s.file }), 6000);
      return false;
    }
    let changed = false;
    if (p.text !== undefined) {
      if (n.children.length) {
        toast(t('web.insp.notText', 'This element contains other elements in the source; its text was not written.'), 5000);
        return false;
      }
      n.textContent = p.text;
      changed = true;
    }
    for (const [k, v] of Object.entries(p.attrs || {})) {
      if (v == null) n.removeAttribute(k);
      else n.setAttribute(k, v);
      changed = true;
    }
    const sheet = [];
    for (const [prop, v] of p.style || []) {
      if (n.style.getPropertyValue(prop)) {
        // Kaynakta satır içi değer var: kural onu yenemez, değer style özniteliğine yazılır.
        if (v) n.style.setProperty(prop, v);
        else n.style.removeProperty(prop);
        if (!n.getAttribute('style')) n.removeAttribute('style');
        changed = true;
        s.inline.delete(prop);
      } else sheet.push([prop, v]);
    }
    let cssW = null;
    let id = n.id || '';
    if (sheet.length || p.reset) {
      if (!id && sheet.length) {
        id = newId(doc);
        n.id = id;
        changed = true;
      }
      if (id) {
        if (sheet.length && ensureLink(doc, s.file)) changed = true;
        const before = (await ctx.exists(CUSTOM_CSS)) ? await ctx.read(CUSTOM_CSS) : null;
        const next = upsertRule(before ?? CSS_HEAD, ruleSel(id), p.reset ? null : sheet);
        if (next !== (before ?? '')) cssW = { rel: CUSTOM_CSS, before, text: next };
      }
    }
    if (p.op === 'delete') {
      n.remove();
      changed = true;
    } else if (p.op === 'dup') {
      const c = n.cloneNode(true);
      stripIds(c);
      n.after(c);
      p.cloneStyle = c.getAttribute('style'); // kaynaktaki kopyanın satır içi stili (önizleme kopyası buna eşitlenir)
      changed = true;
    }
    const out = changed ? serialize(doc, html) : null;
    // Seçili öğe hâlâ ekrandaki belgedeyse önizleme zaten güncel: yazma "sessiz" yapılır (ajanlar yeniden oynatmaz).
    const quiet = s.el.isConnected && s.el.ownerDocument === shownDoc();
    const entry = [];
    if (cssW) {
      await ctx.write(cssW.rel, cssW.text, cssW.before, quiet);
      entry.push({ rel: cssW.rel, before: cssW.before, after: cssW.text });
    }
    if (out != null && out !== html) {
      await ctx.write(s.file, out, html, quiet);
      entry.push({ rel: s.file, before: html, after: out });
    }
    if (entry.length) {
      undoStack.push(entry);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    }
    // Canlı belgeyi kaynakla eşitle.
    if (id && s.el.isConnected && !s.el.id) s.el.id = id;
    if (id) s.id = id;
    if (p.op !== 'delete') {
      s.text = sigOf(n);
      s.fp = fpOf(n);
      const par = n.parentElement;
      s.ptext = par && par !== doc.body ? sigOf(par) : null;
    }
    if (cssW && quiet) syncLiveCss(s, sheet, p.reset);
    if (!quiet && entry.length && !ctx.watching()) await ctx.reload();
    return true;
  }

  /** Ekrandaki belgede hs-custom.css bağlantısını tazeler; yüklenince önizleme satır içi değerleri kaldırılır. */
  function syncLiveCss(s, props, reset) {
    const doc = s.el.ownerDocument;
    if (!doc?.head || doc !== shownDoc()) return;
    let link = [...doc.querySelectorAll('link[rel~="stylesheet"]')].find((l) => {
      try {
        return /\/hs-custom\.css$/i.test(new URL(l.href, doc.baseURI).pathname);
      } catch {
        return false;
      }
    });
    if (!link) {
      link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('href', depthPrefix(s.file) + CUSTOM_CSS);
      doc.head.appendChild(link);
    }
    const done = () => {
      const keys = reset ? [...s.inline.keys()] : props.map(([p]) => p);
      for (const prop of keys) {
        if (pend?.sel === s && pend.style.has(prop)) continue; // bu arada yeni değer girildi
        restoreInline(s, prop);
      }
      reposition();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    try {
      const u = new URL(link.href, doc.baseURI);
      u.searchParams.set('hs', Date.now());
      link.href = u.href;
    } catch {
      done();
    }
  }

  function resetStyle() {
    const s = sel;
    if (pend?.sel === s) {
      clearTimeout(pendT);
      pend = null;
    }
    for (const prop of [...s.inline.keys()]) restoreInline(s, prop);
    enqueue(async () => {
      const r = await persist({ sel: s, style: new Map(), attrs: {}, reset: true });
      if (r !== false && sel === s) render();
      reposition();
    });
  }

  function remove() {
    const s = sel;
    flush();
    enqueue(async () => {
      const r = await persist({ sel: s, style: new Map(), attrs: {}, op: 'delete' });
      if (r === false) return;
      if (sel === s) {
        sel = null;
        render();
      }
      s.el.remove();
      hoverEl = null;
      reposition();
    });
  }

  function duplicate() {
    const s = sel;
    flush();
    enqueue(async () => {
      const p = { sel: s, style: new Map(), attrs: {}, op: 'dup' };
      const r = await persist(p);
      if (r === false || !s.el.isConnected) return;
      const c = s.el.cloneNode(true);
      stripIds(c);
      // Kopyada id yok: hs-custom.css kuralı ona uymaz; önizleme kaydedilenle aynı görünsün (önizleme !important değerleri taşınmaz).
      if (p.cloneStyle) c.setAttribute('style', p.cloneStyle);
      else if (p.cloneStyle !== undefined) c.removeAttribute('style');
      s.el.after(c);
      reposition();
    });
  }

  async function chooseImage() {
    const s = sel;
    const files = await platform.openFiles('image/*', false, t('web.insp.pickImg', 'Choose an image'));
    const f = files?.[0];
    if (!f || sel !== s) return;
    if (!ctx.canWrite(s.file)) {
      s.el.removeAttribute('srcset');
      s.el.src = URL.createObjectURL(f);
      previewOnly();
      return;
    }
    flush();
    enqueue(async () => {
      const name = String(f.name || 'image.png').replace(/[\\/:*?"<>|#%]+/g, '_').replace(/\s+/g, '-') || 'image.png';
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let rel = 'img/' + name;
      for (let k = 2; (await ctx.exists(rel)) && k < 500; k++) rel = `img/${stem}-${k}${ext}`;
      await ctx.write(rel, f, null, true);
      const src = depthPrefix(s.file) + rel;
      const attrs = { src };
      if (s.el.hasAttribute('srcset')) attrs.srcset = null;
      const r = await persist({ sel: s, style: new Map(), attrs });
      if (r === false) return;
      if (s.el.isConnected) {
        s.el.removeAttribute('srcset');
        s.el.setAttribute('src', src);
      }
      if (sel === s) {
        const o = P.querySelector('[data-o="src"]');
        if (o) o.value = src;
      }
      toast(t('web.insp.imgCopied', 'Image copied into the site: {rel}', { rel }), 3500);
    });
  }

  function askAi() {
    const e = sel.el;
    const detail = {
      kind: 'web-element',
      file: sel.file || '',
      selector: cssSelector(sel),
      tag: sel.tag,
      text: norm(e.textContent).slice(0, 200),
      html: String(e.outerHTML || '').slice(0, 800),
    };
    bus.dispatchEvent(new CustomEvent('ai-context', { detail }));
    bus.dispatchEvent(new CustomEvent('ai-open'));
  }

  function undo() {
    if (ctx.busy()) {
      // yapılış / canlı işlem sürerken dosya geri yazılmaz (motorun oynattığı değişiklikle yarışmasın)
      toast(t('web.insp.busy', 'Wait until the current build finishes.'));
      return queue;
    }
    flush();
    return enqueue(async () => {
      const entry = undoStack.pop();
      if (!entry) {
        toast(t('web.insp.nothingUndo', 'Nothing to undo'));
        return;
      }
      if (!ctx.canWrite(entry[0].rel)) return;
      // Dosya o yazmadan sonra başkası (yapay zekâ, editör) tarafından değiştirildiyse eski metin geri yazılmaz:
      // aksi hâlde sonraki değişiklikler sessizce silinirdi. Daha eski adımlar da artık geçersizdir.
      const curs = [];
      for (const w of entry) curs.push((await ctx.exists(w.rel)) ? await ctx.read(w.rel) : null);
      const eol = (x) => (x == null ? x : String(x).replace(/\r\n/g, '\n'));
      if (entry.some((w, i) => eol(curs[i]) !== eol(w.after))) {
        undoStack.length = 0;
        toast(t('web.insp.undoStale', 'Cannot undo: the file was changed after this edit (by the AI or another program).'), 5000);
        return;
      }
      for (const [i, w] of [...entry.entries()].reverse()) {
        const cur = curs[i];
        if (w.before == null) {
          if (cur != null) await ctx.remove(w.rel, cur);
        } else await ctx.write(w.rel, w.before, cur, true);
      }
      await ctx.reload();
      // Yeniden yüklenen belgede seçimi tazele (metin imzası kaynağın geri alınmış hâline göre).
      const doc = curDoc();
      if (sel && doc) {
        const n = locate(doc, sel, false);
        sel = n ? describe(n) : null;
        render();
        reposition();
      }
      toast(t('web.insp.undone', 'Edit undone'));
    });
  }

  // ------------------------------------------------------------ dış arayüz

  function toggle(v = !on) {
    v = !!v;
    if (v === on) return;
    if (v && ctx.busy()) {
      toast(t('web.insp.busy', 'Wait until the current build finishes.'));
      return;
    }
    on = v;
    if (!on) {
      flush();
      sel = null;
      detach();
      hideBoxes();
    } else {
      P.classList.remove('wi-busy');
      attach();
    }
    render();
    ctx.onState(on);
  }

  return {
    get on() {
      return on;
    },
    toggle,
    undo,
    select: (e) => select(e),
    /** iframe değişti (yer değiştirme / boşaltma): dinleyiciler yeni belgeye taşınır. */
    frameChanged() {
      if (on) attach();
    },
    /** Meşguliyet durumu değişti (yapılış / kayıt / canlı işlem). */
    sync() {
      if (!on) return;
      const busy = ctx.busy();
      P.classList.toggle('wi-busy', busy); // yapılış/canlı işlem sürerken panel düzenlenemez
      if (busy && att?.doc) attach();
      else if (!busy && (!att || !att.doc || att.frame !== ctx.frame())) attach();
    },
    reposition,
    deactivate() {
      if (on) toggle(false);
    },
  };
}
