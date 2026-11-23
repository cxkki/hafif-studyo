// Web Yapılışı modu: Claude'un yaptığı bir siteyi, ajanlar sıfırdan kuruyormuş gibi oynatır ve videoya kaydeder.
// Sitenin dosyalarına hiçbir şey yazılmaz; tüm efekt çalışma anında iframe DOM'u üzerinde
// geçici öznitelik/stil ile yapılır ve iş bitince geri alınır.
import { $, toast, sleep, clamp, baseName, extOf, store, pickMime, esc, busy, isTyping } from './util.js';
import * as platform from './platform.js';
import { agents } from './agents.js';
import { t } from './i18n.js';
import { createInspector } from './web-inspect.js';

const VIEWS = {
  vertical: { w: 430, h: 764, out: { w: 1080, h: 1920 } },
  horizontal: { w: 1280, h: 720, out: { w: 1920, h: 1080 } },
};
// Önizleme cihaz boyutları (CSS px). "fit" = video yönelimi (VIEWS); kayıtta her zaman kayıt yönelimi geçerlidir.
const DEVICES = {
  phone: { w: 390, h: 844 },
  tablet: { w: 768, h: 1024 },
  desktop: { w: 1280, h: 800 },
};
const OWN_MS = 6000; // denetçinin yazdığı ikili dosyalar bu süre boyunca izleyicide yok sayılır
const EXAMPLE_URL = '../ornekler/site-ornek/index.html';
const MOUNT = '/__site';
const MAX_LAYERS = 400;
const SLOW_CHARS = 40; // ilk bu kadar harf tek tek yazılır, kalanı parça parça
const CHUNK = 7;
const NOH = { update() {}, done() {}, remove() {} };

const set = (s) => new Set(s.split(' '));
const SKIP = set('script style link meta noscript template br wbr head title base source track param option optgroup datalist area map dialog');
const MEDIA = set('img svg canvas video picture iframe object embed audio');
const CONTROLS = set('input textarea select progress meter hr');
const TEXTY = set(
  'h1 h2 h3 h4 h5 h6 p a button li label span small strong em b i u s blockquote figcaption dt dd td th caption legend summary code pre time mark cite q sub sup abbr kbd del ins'
);
const SEMANTIC = set('section header footer nav main article aside form');
const BLOCKISH = 'h1,h2,h3,h4,h5,h6,p,div,section,article,ul,ol,li,figure,table,form,header,footer,nav,main,aside,blockquote,canvas,video,dl,pre';

// Çalışma anında iframe'e eklenen geçici stiller.
const VIEW_CSS =
  'html{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
const BUILD_CSS =
  'html{scroll-behavior:auto!important}' +
  '[data-hs-h]{visibility:hidden!important}' +
  '[data-hs-raw]{filter:grayscale(1) contrast(.92)!important}' +
  '[data-hs-raw],[data-hs-raw] *{font-family:Consolas,"Cascadia Mono","Courier New",monospace!important}';

const A = (k, d, p) => esc(t(k, d, p));
const template = () => `
<div class="bar">
  <button id="w-pick" title="${A('web.pick.tip', 'Choose the site folder that contains index.html')}">${t('web.pick', 'Choose site folder')}</button>
  <span id="w-path" class="w-path">${t('web.noSite', 'No site selected')}</span>
  <div class="sep"></div>
  <select id="w-orient" title="${A('web.orient.tip', 'View and video orientation')}">
    <option value="vertical">${t('web.orient.v', 'Vertical 1080×1920')}</option>
    <option value="horizontal">${t('web.orient.h', 'Horizontal 1920×1080')}</option>
  </select>
  <select id="w-count" title="${A('web.count.tip', 'Number of agents')}">
    <option value="10">${t('web.count', '{n} agents', { n: 10 })}</option>
    <option value="20">${t('web.count', '{n} agents', { n: 20 })}</option>
  </select>
  <select id="w-speed" title="${A('web.speed.tip', 'Build speed')}">
    <option value="1x">${t('web.speed', 'Speed {x}', { x: '1x' })}</option>
    <option value="2x">${t('web.speed', 'Speed {x}', { x: '2x' })}</option>
    <option value="5x">${t('web.speed', 'Speed {x}', { x: '5x' })}</option>
    <option value="instant">${t('web.speed.instant', 'Instant')}</option>
  </select>
  <div class="sep"></div>
  <button id="w-live" title="${A('web.live.tip', 'Show every change live with the agents as Claude writes files to this folder')}">${t('web.live', 'Watch live')}</button>
  <label class="w-chk" title="${A('web.liveRec.tip', 'Record the live session as a video')}"><input type="checkbox" id="w-live-rec">${t('web.liveRec', 'Record')}</label>
  <button id="w-live-stop" class="w-live-stop" hidden>${t('web.liveStop', 'End live')}</button>
  <div class="spacer"></div>
  <button id="w-play">${t('web.play', 'Play build')}</button>
  <button id="w-rec" class="pri">${t('web.rec', 'Record as video')}</button>
</div>
<div class="w-pv" role="toolbar" aria-label="${A('web.pv.label', 'Preview')}">
  <div class="w-seg" role="group" aria-label="${A('web.dev.label', 'Preview size')}">
    <button data-dev="fit" title="${A('web.dev.fit.tip', 'Fit the stage (video orientation)')}">${t('web.dev.fit', 'Fit')}</button>
    <button data-dev="phone" title="390 × 844">${t('web.dev.phone', 'Phone')}</button>
    <button data-dev="tablet" title="768 × 1024">${t('web.dev.tablet', 'Tablet')}</button>
    <button data-dev="desktop" title="1280 × 800">${t('web.dev.desktop', 'Desktop')}</button>
  </div>
  <span class="w-pv-size" id="w-pv-size"></span>
  <div class="sep"></div>
  <button id="w-sel" class="w-selbtn" aria-pressed="false" title="${A('web.sel.tip', 'Click an element in the preview to edit it (V)')}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5l9.5 5-4.2 1.1L6.6 13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>${t('web.sel', 'Select')}</button>
  <div class="spacer"></div>
  <button id="w-reload" title="${A('web.reload.tip', 'Reload the site preview')}">${t('web.reload', 'Reload preview')}</button>
  <button id="w-open" title="${A('web.openBrowser.tip', 'Open the page in your web browser')}">${t('web.openBrowser', 'Open in browser')}</button>
</div>
<div class="w-area" id="w-area">
  <div class="w-stage" id="web-stage">
    <iframe id="w-frame" title="${A('web.frame', 'Site preview')}" tabindex="-1"></iframe>
    <iframe id="w-frame2" class="w-back" title="${A('web.frame.back', 'Site preview (back)')}" tabindex="-1" aria-hidden="true"></iframe>
    <div class="w-fx" id="w-fx"></div>
    <div class="w-shield" id="w-shield" hidden></div>
    <div class="w-wait" id="w-wait" hidden>
      <div class="w-wait-c">
        <svg class="w-intro-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 8.5h19" stroke="currentColor" stroke-width="1.6"/><circle cx="5.3" cy="6.3" r=".8" fill="currentColor"/><circle cx="7.8" cy="6.3" r=".8" fill="currentColor"/><path d="M8 13.5h8M8 16.5h5" stroke="#d97757" stroke-width="1.6" stroke-linecap="round"/></svg>
        <div class="w-intro-t">${t('web.wait.title', 'Waiting for Claude…')}</div>
        <div class="w-intro-s" id="w-wait-s"></div>
      </div>
    </div>
    <div class="w-note" id="w-note" hidden><b>Claude</b><span id="w-note-t"></span></div>
    <div class="w-log" id="w-log" hidden></div>
    <div class="w-intro" id="w-intro" hidden>
      <div class="w-scanline"></div>
      <div class="w-intro-c">
        <svg class="w-intro-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 8.5h19" stroke="currentColor" stroke-width="1.6"/><circle cx="5.3" cy="6.3" r=".8" fill="currentColor"/><circle cx="7.8" cy="6.3" r=".8" fill="currentColor"/><path d="m9.5 12.5-2.5 2.2 2.5 2.2M14.5 12.5l2.5 2.2-2.5 2.2" fill="none" stroke="#4f8cff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div class="w-intro-t"><span id="w-intro-t">${t('web.intro.scan', 'Scanning page')}</span><span class="w-dots"></span></div>
        <div class="w-intro-s" id="w-intro-s"></div>
      </div>
    </div>
    <div class="w-empty" id="w-empty">
      <div>
        <b>${t('web.empty.title', 'Web Build')}</b>
        <p>${t('web.empty.text', 'Choose the folder of the site Claude built. The site is played back layer by layer as if the agents were building it from scratch; you can record it as a vertical or horizontal video.')}</p>
        <p class="w-dim">${t('web.empty.note', 'Nothing is added to the site files.')}</p>
        <button id="w-example" hidden>${t('web.example', 'Open example site')}</button>
      </div>
    </div>
  </div>
</div>
<aside class="w-insp" id="w-insp" hidden aria-label="${A('web.insp.title', 'Inspector')}"></aside>`;

// ------------------------------------------------------------------ küçük yardımcılar

const alphaOf = (c) => {
  if (!c || c === 'transparent') return 0;
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return 1;
  const p = m[1].split(/[ ,/]+/).filter(Boolean);
  return p.length > 3 ? parseFloat(p[3]) : 1;
};
const toHex = (c) => {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return c || '';
  const [r, g, b] = m[1].split(/[ ,/]+/).filter(Boolean).map((v) => clamp(Math.round(parseFloat(v)), 0, 255));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const firstFont = (ff) => String(ff || '').split(',')[0].replace(/["']/g, '').trim() || 'sans-serif';
const hasDirectText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.nodeValue));
const safeName = (s) => String(s || 'site').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-').trim() || 'site';
const q = (s) => `"${String(s).replace(/\//g, '\\')}"`;
const frames = (n = 2) =>
  new Promise((res) => {
    const step = () => (--n <= 0 ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function boxLooking(cs) {
  if (alphaOf(cs.backgroundColor) > 0.04) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
    if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && alphaOf(cs['border' + s + 'Color']) > 0.04)
      return true;
  }
  return false;
}

// ------------------------------------------------------------------ canlı mod: saf yardımcılar

const LIVE_DEBOUNCE = 400; // bir yazma birden çok olay üretir; bu süre sessizlik olunca grup işlenir
const LIVE_MAX_WAIT = 2000; // aralıksız olay akışında bile en geç bu kadar sonra işlenir
const LIVE_IDLE_MS = 20 * 60 * 1000;
const LIVE_REST_MS = 5000; // iş bitince ajanlar bu kadar sonra kenara çekilir (boşta döngü kalmasın)
const LIVE_CIRCLE_MS = 45000; // bekleme ekranında ajanların daire çizme süresi
const LIVE_MAX_TEXT = 600000;
const SNAP_MAX = 3000;
const TEXT_EXT = set('html htm css js mjs cjs json svg txt md xml');
const IMG_EXT = set('png jpg jpeg gif webp avif svg ico bmp');
const IGNORE_EXT = set(
  'mp4 webm mov mkv avi m4v wmv mp3 wav ogg m4a aac flac opus zip 7z rar gz tar exe dll msi iso psd blend tmp temp swp crswap part crdownload lock log bak'
);

function kindOf(rel) {
  const e = extOf(rel);
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'css') return 'css';
  if (e === 'js' || e === 'mjs' || e === 'cjs') return 'js';
  if (IMG_EXT.has(e)) return 'img';
  return 'other';
}

/** Gizli dosyalar, geçici dosyalar, uzantısızlar (klasörler) ve büyük ikili dosyalar yok sayılır. */
function ignoredRel(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p.startsWith('.') || p.startsWith('~$') || p === 'node_modules')) return true;
  const name = parts[parts.length - 1];
  if (/~$/.test(name) || /\.(tmp|temp)(\.\d+)?$/i.test(name) || /\.tmp\./i.test(name)) return true;
  const e = extOf(name);
  return !e || IGNORE_EXT.has(e);
}

/** İzleyici olayından klasöre göreli yol ("css/style.css"). */
function relOf(dir, filename, evDir) {
  const f = String(filename || '').replace(/\\/g, '/');
  if (!f) return '';
  const full = /^([a-zA-Z]:\/|\/)/.test(f) ? f : (evDir ? String(evDir).replace(/\\/g, '/').replace(/\/+$/, '') : dir) + '/' + f.replace(/^\/+/, '');
  const base = dir.toLowerCase() + '/';
  return (full.toLowerCase().startsWith(base) ? full.slice(base.length) : f).replace(/^\/+/, '');
}

/** Basit satır farkı: ortak baş/son kırpılır, ortası LCS ile karşılaştırılır. Eklenen/değişen satırları döner. */
function lineDiff(oldT, newT) {
  const A = oldT ? oldT.replace(/\r\n?/g, '\n').split('\n') : [];
  const B = newT ? newT.replace(/\r\n?/g, '\n').split('\n') : [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a = A.slice(s, A.length - e);
  const b = B.slice(s, B.length - e);
  let lines = [];
  let lcs = 0;
  if (a.length && b.length && a.length * b.length <= 1e6) {
    const W = b.length + 1;
    const dp = new Int32Array((a.length + 1) * W);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    let i = 0;
    let j = 0;
    while (j < b.length) {
      if (i < a.length && a[i] === b[j]) {
        i++;
        j++;
        lcs++;
      } else if (i < a.length && dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
      else lines.push(b[j++]);
    }
  } else lines = b.slice();
  // Dosya sonundaki boş satır "eklenen satır" sayılmasın.
  const add = lines.filter((l, k) => l !== '' || k < lines.length - 1).length;
  return { add, del: a.length - lcs, lines };
}

const clsOf = (e) => (e.getAttribute('class') || '').trim().split(/\s+/).filter((c) => c && !c.startsWith('hs-')).sort().join('.');

/** iframe belgesinin öğe ağacı: etiket/id/class, kendi metni, görünürlük, kutu ve stil imzası. */
function snapshot(doc, win) {
  const nodes = [];
  if (!doc?.body || !win) return nodes;
  const add = (c, pi) => {
    const cs = win.getComputedStyle(c);
    const b = c.getBoundingClientRect();
    let tn = 0;
    let text = '';
    for (const nd of c.childNodes)
      if (nd.nodeType === 3 && /\S/.test(nd.nodeValue)) {
        tn++;
        text += nd.nodeValue + ' ';
      }
    nodes.push({
      i: nodes.length,
      el: c,
      tag: c.localName,
      id: c.id || '',
      cls: clsOf(c),
      parent: pi,
      kids: [],
      text: text.replace(/\s+/g, ' ').trim(),
      tn,
      shown: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01 && b.width >= 2 && b.height >= 2,
      r: { x: b.left, y: b.top, w: b.width, h: b.height },
      st: {
        color: cs.color,
        bg: cs.backgroundColor,
        ff: cs.fontFamily,
        fs: cs.fontSize,
        br: cs.borderRadius,
        pad: cs.padding,
        disp: cs.display,
        w: Math.round(b.width),
        h: Math.round(b.height),
      },
    });
    if (pi >= 0) nodes[pi].kids.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const walk = (e, pi) => {
    for (const c of e.children) {
      if (nodes.length >= SNAP_MAX) {
        // Kesim: son eklenen düğüm ve ataları işaretlenir; diffTrees bunların kuyruğunu karşılaştırmaz.
        if (!nodes.truncated) {
          nodes.truncated = true;
          for (let i = nodes.length - 1; i >= 0 && !nodes[i].trunc; i = nodes[i].parent) nodes[i].trunc = true;
        }
        return;
      }
      const tag = c.localName;
      if (SKIP.has(tag) || (c.id && c.id.startsWith('hs-'))) continue;
      const i = add(c, pi);
      if (!MEDIA.has(tag) || tag === 'picture') walk(c, i);
    }
  };
  walk(doc.body, add(doc.body, -1));
  return nodes;
}

/** Kardeş listelerini hizalar (ağırlıklı LCS). Eşleşme için etiket + id aynı olmalı; class/metin/çocuk sayısı puanı artırır. */
function align(ak, bk, A, B) {
  const n = ak.length;
  const m = bk.length;
  if (!n || !m) return [];
  const score = (x, y) => {
    const a = A[x];
    const b = B[y];
    if (a.tag !== b.tag || a.id !== b.id) return 0;
    return 1 + (a.cls === b.cls ? 2 : 0) + (a.text === b.text ? 2 : 0) + (a.kids.length === b.kids.length ? 1 : 0);
  };
  const out = [];
  if (n * m > 160000) {
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      let k = j;
      while (k < m && k - j < 50 && !score(ak[i], bk[k])) k++;
      if (k < m && score(ak[i], bk[k])) {
        out.push([ak[i], bk[k]]);
        j = k + 1;
      }
    }
    return out;
  }
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = score(ak[i - 1], bk[j - 1]);
      let v = Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
      if (s) v = Math.max(v, dp[(i - 1) * W + j - 1] + s);
      dp[i * W + j] = v;
    }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = score(ak[i - 1], bk[j - 1]);
    if (s && dp[i * W + j] === dp[(i - 1) * W + j - 1] + s) {
      out.push([ak[--i], bk[--j]]);
    } else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) i--;
    else j--;
  }
  return out.reverse();
}

/**
 * Önceki / yeni ağaç farkı: eklenen (üst düzey) öğeler, kaldırılanlar, metni değişenler ve
 * hesaplanmış stili değişenler (kalıtımla gelen renk/font değişiklikleri yalnızca kaynağında sayılır).
 */
function diffTrees(A, B, cssChanged) {
  const out = { added: [], removed: [], edits: [], styles: [] };
  if (!B.length) return out;
  if (!A.length) {
    out.added = B[0].kids.map((k) => B[k]);
    return out;
  }
  const pairs = [];
  const bOfA = new Map();
  const rec = (ai, bi) => {
    pairs.push([ai, bi]);
    bOfA.set(ai, bi);
    const a = A[ai];
    const b = B[bi];
    const m = align(a.kids, b.kids, A, B);
    const ua = new Set(m.map((p) => p[0]));
    const ub = new Set(m.map((p) => p[1]));
    // SNAP_MAX kesimi: son eşleşen çiftten sonraki eşleşmeyenler kesimin sonucudur (sahte ekleme/silme sayılmaz).
    const cut = a.trunc || b.trunc;
    const lp = m[m.length - 1];
    const la = cut ? (lp ? a.kids.indexOf(lp[0]) : -1) : Infinity;
    const lb = cut ? (lp ? b.kids.indexOf(lp[1]) : -1) : Infinity;
    b.kids.forEach((y, k) => {
      if (!ub.has(y) && k <= lb) out.added.push(B[y]);
    });
    a.kids.forEach((x, k) => {
      if (!ua.has(x) && k <= la) out.removed.push(A[x]);
    });
    for (const [x, y] of m) rec(x, y);
  };
  rec(0, 0);
  // Yapısı değişen öğelerin ataları: boyut farkı onların sonucudur, ayrıca "boyut" değişikliği sayılmaz.
  const dirty = new Set();
  const up = (bi) => {
    for (let i = bi; i != null && i >= 0 && !dirty.has(i); i = B[i].parent) dirty.add(i);
  };
  for (const b of out.added) up(b.parent);
  for (const a of out.removed) up(bOfA.get(a.parent));
  for (const [ai, bi] of pairs) {
    const a = A[ai];
    const b = B[bi];
    if (a.text !== b.text && b.shown && b.text) {
      out.edits.push({ a, b });
      up(bi);
    }
  }
  const cats = new Map();
  for (const [ai, bi] of pairs) {
    const a = A[ai];
    const b = B[bi];
    if (!a.shown || !b.shown) continue;
    const pa = a.parent >= 0 ? A[a.parent] : null;
    const pb = b.parent >= 0 ? B[b.parent] : null;
    const inh = (k) => pa && pb && pa.st[k] === a.st[k] && pb.st[k] === b.st[k];
    const c = [];
    if ((a.st.color !== b.st.color && !inh('color')) || a.st.bg !== b.st.bg) c.push('renk');
    if ((a.st.ff !== b.st.ff && !inh('ff')) || (a.st.fs !== b.st.fs && !inh('fs'))) c.push('font');
    if (a.st.br !== b.st.br || a.st.pad !== b.st.pad || a.st.disp !== b.st.disp) c.push('düzen');
    else if (cssChanged && !dirty.has(bi) && (Math.abs(a.st.w - b.st.w) > 2 || Math.abs(a.st.h - b.st.h) > 2)) {
      const pc = cats.get(b.parent);
      if (!pc || !(pc.includes('boyut') || pc.includes('düzen'))) c.push('boyut');
    }
    if (c.length) {
      cats.set(bi, c);
      out.styles.push({ a, b, cats: c });
    }
  }
  return out;
}

/** Öğeye eski değerleri geçici !important satır içi stil olarak sabitler; dönen fonksiyon geri alır. */
function pinStyle(node, props) {
  if (!props.length) return () => {};
  const s = node.style;
  const had = node.hasAttribute('style');
  const saved = props.map(([p]) => [p, s.getPropertyValue(p), s.getPropertyPriority(p)]);
  for (const [p, v] of props) s.setProperty(p, v, 'important');
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    for (const [p, v, pr] of saved) {
      if (v) s.setProperty(p, v, pr);
      else s.removeProperty(p);
    }
    if (!had && !node.getAttribute('style')) node.removeAttribute('style');
  };
}

const docOrder = (x, y) => (x.el === y.el ? 0 : x.el.compareDocumentPosition(y.el) & 4 ? -1 : 1);

// ------------------------------------------------------------------ mod

export function createWebMode() {
  const root = $('#mweb');
  root.innerHTML = template();
  const el = {
    pick: $('#w-pick', root),
    path: $('#w-path', root),
    orient: $('#w-orient', root),
    count: $('#w-count', root),
    speed: $('#w-speed', root),
    play: $('#w-play', root),
    rec: $('#w-rec', root),
    area: $('#w-area', root),
    stage: $('#web-stage', root),
    frame: $('#w-frame', root),
    frameA: $('#w-frame', root),
    frameB: $('#w-frame2', root),
    live: $('#w-live', root),
    liveRec: $('#w-live-rec', root),
    liveStop: $('#w-live-stop', root),
    wait: $('#w-wait', root),
    waitS: $('#w-wait-s', root),
    note: $('#w-note', root),
    noteT: $('#w-note-t', root),
    log: $('#w-log', root),
    fx: $('#w-fx', root),
    shield: $('#w-shield', root),
    intro: $('#w-intro', root),
    introT: $('#w-intro-t', root),
    introS: $('#w-intro-s', root),
    empty: $('#w-empty', root),
    example: $('#w-example', root),
    devBtns: [...root.querySelectorAll('[data-dev]')],
    pvSize: $('#w-pv-size', root),
    selBtn: $('#w-sel', root),
    reload: $('#w-reload', root),
    open: $('#w-open', root),
    insp: $('#w-insp', root),
  };

  let orient = VIEWS[store.get('web_orient')] ? store.get('web_orient') : 'vertical';
  let count = [10, 20].includes(store.get('web_count')) ? store.get('web_count') : 20;
  let speed = ['1x', '2x', '5x', 'instant'].includes(store.get('web_speed')) ? store.get('web_speed') : '1x';
  el.orient.value = orient;
  el.count.value = String(count);
  el.speed.value = speed;

  let site = null; // {dir, entry, url, name}
  let active = false;
  let run = null; // çalışan yapılış
  let tourRun = null; // çalışan tur {stop}
  let hudOpen = false;
  let hudClose = null; // bu modun açtığı ajan katmanı oturumunun onClose'u (sahiplik belirteci)
  let recording = false;
  let unloaded = false;
  let triedLast = false;
  let examplePath = null;
  let L = null; // canlı oturum (yoksa null)
  let codeTok = 0; // kod paneli belirteci (showCode her çağrıda artırır)
  let device = DEVICES[store.get('web_device')] ? store.get('web_device') : 'fit';
  let insp = null; // önizleme denetçisi (web-inspect.js)

  // ---------------------------------------------------------------- sahne boyutu / koordinatlar

  /** Kayıt sürüyor mu? (kayıtta cihaz önizlemesi değil kayıt yönelimi geçerlidir) */
  const recLock = () => recording || !!L?.rec || document.body.classList.contains('hs-webrec');
  const view = () => (device !== 'fit' && DEVICES[device] && !recLock() ? DEVICES[device] : VIEWS[orient]);

  /** Ajan katmanı hâlâ Web modunun açtığı oturum mu? (agents.start onClose'u sıfırlar; başka mod açtıysa bizimki değildir) */
  const ownsHud = () => hudOpen && !!hudClose && agents.onClose === hudClose;

  /** Kayıt ya da yapılış sürerken yeni bir iş başlatılamaz (tarif çalıştırıcı bunu hata olarak raporlar). */
  function assertIdle() {
    if (recording || run || L)
      throw new Error(
        t('web.busy', 'Web mode is busy: {what} in progress', {
          what: L ? t('web.busy.live', 'live mode') : recording ? t('web.busy.rec', 'a recording') : t('web.busy.build', 'a build'),
        })
      );
  }

  function fit() {
    const a = el.area.getBoundingClientRect();
    if (a.width < 20 || a.height < 20) return;
    const pad = recording || document.body.classList.contains('hs-webrec') ? 0 : 18;
    const v = view();
    const ar = v.w / v.h;
    let w = a.width - pad * 2;
    let h = a.height - pad * 2;
    if (w / h > ar) w = h * ar;
    else h = w / ar;
    w = Math.floor(w);
    h = Math.floor(h);
    el.stage.style.width = w + 'px';
    el.stage.style.height = h + 'px';
    root.classList.toggle('w-tall', h > w * 1.2); // agents.js layout() ile aynı ölçüt (kod paneli sağ altta)
    for (const f of [el.frameA, el.frameB]) {
      f.style.width = v.w + 'px';
      f.style.height = v.h + 'px';
      f.style.transform = `scale(${w / v.w})`;
    }
    el.pvSize.textContent = `${v.w} × ${v.h} · ${Math.round((w / v.w) * 100)}%`;
    if (ownsHud()) agents.setBounds?.(el.stage);
    if (run) updateHandles(run);
    insp?.reposition();
  }
  new ResizeObserver(() => fit()).observe(el.area);

  function setDevice(d) {
    if (!DEVICES[d] && d !== 'fit') return;
    device = d;
    store.set('web_device', d);
    for (const b of el.devBtns) {
      b.classList.toggle('on', b.dataset.dev === d);
      b.setAttribute('aria-pressed', String(b.dataset.dev === d));
    }
    fit();
  }

  function setOrient(o) {
    if (!VIEWS[o] || o === orient) return;
    orient = o;
    el.orient.value = o;
    store.set('web_orient', o);
    fit();
  }

  /** iframe içindeki rect'i (iframe CSS px) ana belgenin client CSS pikseline çevirir. */
  function toMain(r) {
    const f = el.frame.getBoundingClientRect();
    const s = f.width / view().w || 1;
    return { x: f.left + r.left * s, y: f.top + r.top * s, w: r.width * s, h: r.height * s };
  }
  /** Sahne kutusuyla kesişim (seçim kutusu sahne dışına taşmasın). */
  function clipStage(rc) {
    const s = el.stage.getBoundingClientRect();
    const x1 = Math.max(rc.x, s.left);
    const y1 = Math.max(rc.y, s.top);
    const x2 = Math.min(rc.x + rc.w, s.right);
    const y2 = Math.min(rc.y + rc.h, s.bottom);
    if (x2 - x1 < 2 || y2 - y1 < 2)
      return { x: clamp(rc.x, s.left, s.right - 2), y: clamp(rc.y, s.top, s.bottom - 2), w: 2, h: 2 };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  const rectOf = (node) => clipStage(toMain(node.getBoundingClientRect()));
  const stageCenter = () => {
    const s = el.stage.getBoundingClientRect();
    return { x: s.left + s.width / 2, y: s.top + s.height / 2, r: Math.min(s.width, s.height) };
  };

  // ---------------------------------------------------------------- site yükleme

  function frameLoad(ms = 15000) {
    return new Promise((res) => {
      const done = () => {
        clearTimeout(t);
        el.frame.removeEventListener('load', done);
        res(true);
      };
      const t = setTimeout(() => {
        el.frame.removeEventListener('load', done);
        res(false);
      }, ms);
      el.frame.addEventListener('load', done);
    });
  }

  function frameDoc() {
    try {
      return el.frame.contentDocument;
    } catch {
      return null;
    }
  }

  /** Yükleme sonrası: fontlar ve görseller otursun, kaydırma çubuğu gizlensin (yalnızca çalışma anında). */
  async function settle(doc = frameDoc()) {
    if (!doc || !doc.documentElement) return null;
    if (!doc.getElementById('hs-view-style')) {
      const st = doc.createElement('style');
      st.id = 'hs-view-style';
      st.textContent = VIEW_CSS;
      (doc.head || doc.documentElement).appendChild(st);
    }
    await sleep(300);
    await Promise.race([doc.fonts?.ready, sleep(2000)]);
    const imgs = [...doc.images].filter((i) => !i.complete);
    if (imgs.length)
      await Promise.race([
        Promise.all(imgs.map((i) => new Promise((r) => (i.addEventListener('load', r, { once: true }), i.addEventListener('error', r, { once: true }))))),
        sleep(2500),
      ]);
    return doc;
  }

  async function showSite() {
    if (!site) return null;
    unloaded = false;
    el.empty.hidden = true;
    const p = frameLoad();
    el.frame.src = site.url + (site.url.includes('?') ? '&' : '?') + 'hs=' + Date.now();
    await p;
    const doc = await settle();
    if (!doc) toast(t('web.err.preview', 'Could not open the site preview (different origin or missing file).'), 4500);
    return doc;
  }

  /** iframe hâlâ seçili giriş sayfasında mı? (önizlemede bir bağlantıya tıklanmış olabilir) */
  function onEntryPage(doc) {
    if (!site) return false;
    const norm = (p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    };
    try {
      return norm(new URL(site.url, location.href).pathname) === norm(doc.location.pathname);
    } catch {
      return false;
    }
  }

  /** Her zaman seçili giriş sayfasını yükler: iframe zaten oradaysa yeniler, değilse giriş sayfasını açar. */
  async function reloadFrame() {
    const cur = frameDoc();
    if (unloaded || !cur || el.frame.src === 'about:blank' || !cur.body || !onEntryPage(cur)) return showSite();
    const p = frameLoad();
    try {
      el.frame.contentWindow.location.reload();
    } catch {
      return showSite();
    }
    await p;
    return settle();
  }

  async function loadSite(dir, entry = 'index.html') {
    assertIdle();
    if (!dir) throw new Error(t('web.err.dirNeeded', 'Site folder is required'));
    let d = String(dir);
    const native = platform.isNative() && !/^https?:/i.test(d);
    if (native) {
      d = d.replace(/\\/g, '/').replace(/\/+$/, '');
      if (/\.html?$/i.test(d)) {
        entry = baseName(d);
        d = platform.dirOf(d);
      }
      await platform.mount(MOUNT, d);
      const url = MOUNT + '/' + String(entry).split('/').map(encodeURIComponent).join('/');
      site = { dir: d, entry, url, name: baseName(d) };
      store.set('web_site', { dir: d, entry });
    } else {
      let url = d;
      if (!/\.html?($|[?#])/i.test(url)) url = url.replace(/\/+$/, '') + '/' + entry;
      const parts = url.split(/[?#]/)[0].split('/').filter(Boolean);
      site = { dir: d, entry: parts[parts.length - 1], url, name: parts.length > 1 ? parts[parts.length - 2] : 'site' };
    }
    el.path.textContent = native ? d : site.url;
    el.path.title = el.path.textContent;
    const doc = await showSite();
    return !!doc;
  }

  async function pickSite() {
    if (!platform.isNative()) {
      const u = prompt(t('web.prompt.url', 'Site address (path to index.html):'), site?.url || EXAMPLE_URL);
      if (u) await loadSite(u).catch((e) => toast(t('web.err.open', 'Could not open site: {msg}', { msg: e.message })));
      return;
    }
    const d = await platform.pickFolder(t('web.pickTitle', 'Choose site folder'));
    if (!d) return;
    let entry = 'index.html';
    if (!(await platform.exists(platform.join(d, entry)))) {
      const list = await platform.listDir(d).catch(() => []);
      const html = list.find((e) => e.type === 'FILE' && /\.html?$/i.test(e.entry));
      if (!html) {
        toast(t('web.err.noIndex', 'No index.html found in this folder.'), 4000);
        return;
      }
      entry = html.entry;
    }
    await loadSite(d, entry).catch((e) => toast(t('web.err.open', 'Could not open site: {msg}', { msg: e.message })));
  }

  async function findExample() {
    if (!platform.isNative()) return EXAMPLE_URL;
    if (!platform.paths.app) return null;
    for (const p of [platform.join(platform.paths.app, 'ornekler/site-ornek'), platform.join(platform.paths.root, 'ornekler/site-ornek')]) {
      if (await platform.exists(platform.join(p, 'index.html'))) return p;
    }
    return null;
  }

  // ---------------------------------------------------------------- arayüz

  /** Düğmelerin durumu her zaman o anki işlerden hesaplanır (yapılış / kayıt / canlı mod). */
  function syncUi() {
    const lv = !!L;
    const working = !!run || recording || lv;
    for (const b of [el.pick, el.play, el.rec, el.orient, el.count, el.example, el.live, el.liveRec]) b.disabled = working;
    el.live.hidden = lv;
    el.liveStop.hidden = !lv;
    el.liveStop.disabled = !!(L?.stopping || L?.starting);
    el.shield.hidden = !(run || recording || tourRun);
    root.classList.toggle('w-live-on', lv);
    const locked = !!run || recording;
    for (const b of el.devBtns) b.disabled = locked || !!L?.rec;
    el.selBtn.disabled = locked;
    el.reload.disabled = locked;
    insp?.sync();
  }
  const setRunning = () => syncUi();

  el.pick.onclick = () => pickSite();
  el.example.onclick = () => examplePath && loadSite(examplePath).catch((e) => toast(t('web.err.example', 'Could not open example: {msg}', { msg: e.message })));
  el.orient.onchange = () => setOrient(el.orient.value);
  el.count.onchange = () => {
    count = +el.count.value;
    store.set('web_count', count);
  };
  el.speed.onchange = () => {
    speed = el.speed.value;
    store.set('web_speed', speed);
    if (L) L.speed = speed;
    if (run || (L && ownsHud())) agents.setSpeed?.(speed);
  };
  el.live.onclick = async () => {
    try {
      let dir = site && platform.isNative() && !/^https?:/i.test(String(site.dir)) ? site.dir : null;
      let entry = site?.entry || 'index.html';
      if (!dir) {
        if (!platform.isNative()) return toast(t('web.err.liveDesktop', 'Live mode only works in the desktop app.'));
        dir = await platform.pickFolder(t('web.livePickTitle', 'Choose the site folder to watch live'));
        if (!dir) return;
        entry = 'index.html';
      }
      await liveStart({ site: dir, entry, record: el.liveRec.checked, orientation: orient, count, speed });
    } catch (e) {
      showErr(e);
    }
  };
  el.liveStop.onclick = () => L && stopLive({ tour: true }).catch(showErr);
  el.play.onclick = () => (site ? build().catch(showErr) : toast(t('web.pickFirst', 'Choose a site folder first.')));
  el.rec.onclick = () => (site ? record().catch(showErr) : toast(t('web.pickFirst', 'Choose a site folder first.')));
  const showErr = (e) => {
    console.error(e);
    toast(t('web.err.build', 'Web build error: {msg}', { msg: e?.message || e }), 5000);
  };

  // ---------------------------------------------------------------- önizleme araç çubuğu + denetçi

  for (const b of el.devBtns) b.onclick = () => setDevice(b.dataset.dev);
  el.selBtn.onclick = () => insp.toggle();
  el.reload.onclick = () => reloadPreview();
  el.open.onclick = () => openInBrowser().catch(showErr);

  /** Yazılabilir site klasörü (masaüstü + yerel klasör); yoksa null. */
  const siteDir = () => (platform.isNative() && site && !/^https?:/i.test(String(site.dir)) ? site.dir : null);

  /** iframe belgesinin site klasörüne göreli yolu ("index.html", "sayfa/a.html"); bilinmiyorsa null. */
  function siteRelOf(doc) {
    let p;
    try {
      p = decodeURIComponent(doc.location.pathname);
    } catch {
      return null;
    }
    // Sitenin betiği history.pushState ile "%2F..%2F" gibi bir yol koyabilir: klasör dışına çıkan ya da
    // HTML dosyası olmayan yollar yazılabilir sayılmaz (önizlemede kalır).
    const safe = (r) => {
      if (r === '' || r.endsWith('/')) r += 'index.html';
      if (/\\|\0|:/.test(r) || r.startsWith('/') || r.split('/').some((x) => x === '..' || x === '.' || x === '')) return null;
      return /\.html?$/i.test(r) ? r : null;
    };
    if (p.startsWith(MOUNT + '/')) return safe(p.slice(MOUNT.length + 1));
    if (!site || platform.isNative()) return null;
    try {
      const base = decodeURIComponent(new URL('.', new URL(site.url, location.href)).pathname);
      if (p.startsWith(base)) return safe(p.slice(base.length));
    } catch {}
    return null;
  }

  /** Canlı oturum bu klasörü izliyorsa onu döner (denetçinin yazdıkları yankı olarak işlenmesin diye). */
  const liveFor = (dir) => (L && dir && L.dir.toLowerCase() === String(dir).toLowerCase() ? L : null);

  /**
   * Denetçinin yazması. quiet: önizleme zaten güncel; canlı motor bu yazmayı yeniden oynatmaz
   * (metin dosyasında önbellek yeni içerikle eşitlenir, ikili dosya kısa süre yok sayılır).
   * Dosyada motorun henüz işlemediği yabancı bir değişiklik varsa (base ≠ önbellek) bastırılmaz: motor ikisini birlikte gösterir.
   */
  async function writeOwn(rel, data, base, quiet = true) {
    const dir = siteDir();
    if (!dir) throw new Error(t('web.err.noSiteDir', 'No site folder to write to'));
    const S = liveFor(dir);
    if (S && quiet) {
      if (typeof data === 'string' && data.length <= LIVE_MAX_TEXT) {
        if (!S.cache.has(rel) || S.cache.get(rel) === base) S.cache.set(rel, data);
      } else S.own.set(rel, performance.now() + OWN_MS); // ikili ya da önbelleğe alınmayan büyük metin
      S.known.add(rel);
    }
    const abs = platform.join(dir, rel);
    if (typeof data === 'string') await platform.writeText(abs, data);
    else await platform.writeBlob(abs, data);
  }

  async function removeOwn(rel, base) {
    const dir = siteDir();
    if (!dir) return;
    const S = liveFor(dir);
    if (S && (!S.cache.has(rel) || S.cache.get(rel) === base)) {
      S.cache.delete(rel);
      S.known.delete(rel);
    }
    await platform.removeFile(platform.join(dir, rel));
  }

  async function reloadPreview() {
    if (!site) return toast(t('web.pickFirst', 'Choose a site folder first.'));
    if (run || recording || !active) return; // pasif modda site yeniden yüklenmez (boşta döngü kalmasın)
    if (L?.chain) await L.chain; // canlı motor bir değişikliği işliyorsa önce bitsin
    if (run || recording || !active || L?.waiting) return;
    try {
      await reloadFrame();
    } catch (e) {
      showErr(e);
    }
  }

  async function openInBrowser() {
    if (!site) return toast(t('web.pickFirst', 'Choose a site folder first.'));
    const dir = siteDir();
    if (!dir) {
      window.open(new URL(site.url, location.href).href, '_blank', 'noopener');
      return;
    }
    const abs = platform.join(dir, siteRelOf(frameDoc() || {}) || site.entry);
    try {
      await window.Neutralino.os.open(encodeURI('file:///' + abs.replace(/^\/+/, '')));
    } catch {
      platform.reveal(abs);
    }
  }

  insp = createInspector({
    stage: el.stage,
    panel: el.insp,
    frame: () => el.frame,
    busy: () => !!run || recording || !!L?.busy || !!L?.starting,
    relOf: (doc) => siteRelOf(doc),
    canWrite: (rel) => !!rel && !!siteDir(),
    read: (rel) => platform.readText(platform.join(siteDir(), rel)),
    exists: (rel) => platform.exists(platform.join(siteDir(), rel)),
    write: writeOwn,
    remove: removeOwn,
    watching: () => liveFor(siteDir())?.watchId != null,
    reload: reloadPreview,
    onState: (on) => {
      el.selBtn.classList.toggle('on', on);
      el.selBtn.setAttribute('aria-pressed', String(on));
    },
  });
  setDevice(device);
  syncUi();

  // V: Seç aracı; Ctrl+Z: denetçi düzenlemesini geri al; Esc: seçimi bırak (yalnızca Web modu açıkken).
  addEventListener('keydown', (e) => {
    if (!active || e.defaultPrevented || isTyping(e) || e.target?.isContentEditable) return;
    if ($('#help') && !$('#help').hidden) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'v' && !ctrl && !e.altKey && !e.shiftKey) {
      if (el.selBtn.disabled) return;
      e.preventDefault();
      insp.toggle();
    } else if (insp.on && ctrl && !e.shiftKey && !e.altKey && k === 'z') {
      e.preventDefault();
      insp.undo();
    } else if (insp.on && k === 'escape') insp.select(null);
  });

  // ---------------------------------------------------------------- katmanlar

  const unitLayer = () => t('web.unit.layer', 'layers');

  function collect(doc, win) {
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const layers = [];
    const classify = (c, tag, cs, r) => {
      if (MEDIA.has(tag)) return tag === 'canvas' ? '3d' : 'media';
      if ((cs.transformStyle === 'preserve-3d' || cs.perspective !== 'none') && !SEMANTIC.has(tag) && r.width * r.height < vw * vh * 0.5)
        return '3d';
      if (CONTROLS.has(tag)) return 'control';
      if (TEXTY.has(tag) || hasDirectText(c)) {
        if (!c.querySelector(BLOCKISH)) return 'text';
        return boxLooking(cs) || hasDirectText(c) || SEMANTIC.has(tag) ? 'box' : null;
      }
      if (boxLooking(cs)) return 'box';
      if (SEMANTIC.has(tag) && tag !== 'main') return 'box'; // görünmez <main> sarmalayıcısı katman sayılmaz
      return null;
    };
    const roleOf = (kind, tag, cs) => {
      if (kind === 'box') return SEMANTIC.has(tag) ? 'Hiza' : 'Düzen';
      if (kind === 'media') return 'Görsel';
      if (kind === '3d') return '3D';
      if (kind === 'control') return 'Düzen';
      if (/^h[1-6]$/.test(tag)) return 'Yazı';
      if (tag === 'button' || (tag === 'a' && boxLooking(cs))) return 'Düzen';
      return 'Metin';
    };
    const textsOf = (c) => {
      const out = [];
      const w = doc.createTreeWalker(c, 4);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentNode?.localName;
        if (p === 'script' || p === 'style' || p === 'noscript' || p === 'textarea') continue;
        if (/\S/.test(n.nodeValue)) out.push({ node: n, text: n.nodeValue });
      }
      return out;
    };
    const visit = (node, parent, depth) => {
      for (const c of node.children) {
        const tag = c.localName;
        if (SKIP.has(tag) || (c.id && c.id.startsWith('hs-'))) continue;
        const cs = win.getComputedStyle(c);
        if (cs.display === 'none' || parseFloat(cs.opacity) <= 0.01) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 0 && (r.right <= 0 || r.left >= vw)) continue; // yatayda ekran dışı (kapalı menü vb.)
        const shown = cs.visibility !== 'hidden' && r.width >= 4 && r.height >= 4;
        const kind = classify(c, tag, cs, r);
        let idx = parent;
        if (kind && shown) {
          idx = layers.length;
          const texts = kind === 'text' ? textsOf(c) : [];
          const ph = kind === 'control' && c.getAttribute('placeholder') ? c.getAttribute('placeholder') : null;
          layers.push({
            el: c,
            tag,
            kind,
            role: roleOf(kind, tag, cs),
            parent,
            depth,
            inline: cs.display === 'inline',
            area: r.width * r.height,
            hasMotion: cs.transform !== 'none' || cs.animationName !== 'none',
            texts,
            ph,
            chars: texts.reduce((a, t) => a + t.text.trim().length, 0) + (ph ? ph.length : 0),
          });
        }
        if (kind && kind !== 'box') continue; // yaprak: alt öğeleri onunla birlikte görünür
        visit(c, idx, depth + 1);
      }
    };
    visit(doc.body, -1, 0);

    // Çok katman: küçük satır içi yaprakları ebeveyne kat.
    if (layers.length > MAX_LAYERS) {
      const cand = layers
        .map((L, i) => ({ L, i }))
        .filter(({ L }) => L.parent >= 0 && L.kind !== 'box')
        .sort((a, b) => (a.L.inline ? 0 : 1e12) + a.L.area - ((b.L.inline ? 0 : 1e12) + b.L.area));
      const drop = new Set(cand.slice(0, layers.length - MAX_LAYERS).map((c) => c.i));
      const map = new Map();
      const kept = [];
      layers.forEach((L, i) => {
        if (drop.has(i)) return;
        map.set(i, kept.length);
        kept.push(L);
      });
      for (const L of kept) {
        let p = L.parent;
        while (p >= 0 && drop.has(p)) p = layers[p].parent;
        L.parent = p >= 0 ? map.get(p) : -1;
      }
      layers.length = 0;
      layers.push(...kept);
    }

    // Bölümler (renk/font uygulama birimi)
    const sig = (e) =>
      [...e.children].filter((c) => {
        if (SKIP.has(c.localName) || (c.id && c.id.startsWith('hs-'))) return false;
        const r = c.getBoundingClientRect();
        return r.width >= 4 && r.height >= 4 && win.getComputedStyle(c).display !== 'none';
      });
    let roots = sig(doc.body);
    for (let g = 0; roots.length === 1 && sig(roots[0]).length >= 2 && g < 5; g++) roots = sig(roots[0]);
    const docH = doc.documentElement.scrollHeight || 1;
    roots = roots.flatMap((e) => ((e.localName === 'main' || e.getBoundingClientRect().height > docH * 0.6) && sig(e).length >= 2 ? sig(e) : [e]));
    const bodyBg = [doc.body, doc.documentElement].map((e) => win.getComputedStyle(e).backgroundColor).find((c) => alphaOf(c) > 0.04) || 'rgb(255, 255, 255)';
    const sections = roots.map((rootEl) => {
      let bg = null;
      for (let e = rootEl; e && e !== doc.documentElement && !bg; e = e.parentElement) {
        const c = win.getComputedStyle(e).backgroundColor;
        if (alphaOf(c) > 0.04) bg = c;
      }
      const heading = rootEl.querySelector('h1,h2,h3,h4') || null;
      const hs = win.getComputedStyle(heading || rootEl);
      const btn = [...rootEl.querySelectorAll('button,a,input[type=submit]')].find((b) => alphaOf(win.getComputedStyle(b).backgroundColor) > 0.3);
      const link = rootEl.querySelector('a');
      const accent = btn ? win.getComputedStyle(btn).backgroundColor : link ? win.getComputedStyle(link).color : hs.color;
      return { root: rootEl, heading, bg: bg || bodyBg, fg: hs.color, accent, font: firstFont(hs.fontFamily), total: 0, left: 0 };
    });
    for (const L of layers) {
      L.sec = sections.findIndex((s) => s.root === L.el || s.root.contains(L.el));
      if (L.sec >= 0) sections[L.sec].total++;
    }
    for (const s of sections) s.left = s.total;
    return { layers, sections, doc, win };
  }

  // ---------------------------------------------------------------- yapılış

  function newRun() {
    const r = {
      skipped: false,
      wakers: new Set(),
      handles: new Set(),
      chips: new Set(),
      busy: new Set(),
      secJobs: [],
      scrollQ: Promise.resolve(),
      k: 1,
      count,
    };
    r.done = new Promise((res) => (r.finish = res));
    return r;
  }

  /** X: animasyonu anında bitirir. */
  function skip(r = run) {
    if (!r || r.skipped) return;
    r.skipped = true;
    for (const w of r.wakers) w();
    r.wakers.clear();
    if (tourRun) tourRun.stop = true;
    agents.setSpeed?.('instant');
  }

  const isInstant = (r) => r.skipped || agents.instant || agents.speed === 'instant';
  /** Hıza göre ölçeklenmiş bekleme süresi (ms). */
  const D = (r, ms) => (isInstant(r) ? 0 : agents.dur ? agents.dur(ms) : ms);
  /** 1x süreyi katman sayısına göre otomatik ayar katsayısıyla ölçekler (ajan hareket süresi için). */
  const M = (r, ms) => Math.max(40, Math.round(ms * r.k));
  const wait = (r, ms) =>
    r.skipped || !(ms > 0)
      ? Promise.resolve()
      : new Promise((res) => {
          const w = () => {
            clearTimeout(t);
            r.wakers.delete(w);
            res();
          };
          const t = setTimeout(w, ms);
          r.wakers.add(w);
        });

  function pickAgent(r, role) {
    let a = agents.pick?.(role);
    for (let k = 0; a && r.busy.has(a.id) && k < r.count * 2; k++) a = agents.pick();
    if (a) r.busy.add(a.id);
    return a || null;
  }
  const release = (r, a) => a && r.busy.delete(a.id);
  const move = (r, a, target, ms) => (a && !r.skipped ? Promise.resolve(agents.moveTo(a, target, { dur: ms })).catch(() => {}) : Promise.resolve());
  function track(r, h, node) {
    const t = { h: h || NOH, node };
    r.handles.add(t);
    return t;
  }
  function untrack(r, t, how = 'done') {
    r.handles.delete(t);
    try {
      t.h[how]?.();
    } catch {}
  }
  function updateHandles(r) {
    for (const t of r.handles) {
      try {
        if (t.node) t.h.update?.(rectOf(t.node));
      } catch {}
    }
  }

  // Kaydırma
  function inView(win, node) {
    const r = node.getBoundingClientRect();
    const vh = win.innerHeight;
    if (r.top >= -2 && r.bottom <= vh + 2) return true;
    return r.height > vh * 0.6 && r.top < vh * 0.7 && r.bottom > vh * 0.3;
  }
  function animScroll(win, to, ms, token) {
    const from = win.scrollY;
    if (Math.abs(to - from) < 2 || !(ms > 16)) {
      win.scrollTo({ top: to, behavior: 'instant' });
      if (run) updateHandles(run);
      return Promise.resolve();
    }
    return new Promise((res) => {
      const t0 = performance.now();
      const step = (now) => {
        if (token?.stop || token?.skipped) {
          if (token?.skipped) win.scrollTo({ top: to, behavior: 'instant' });
          return res();
        }
        const p = Math.min(1, (now - t0) / ms);
        try {
          win.scrollTo({ top: from + (to - from) * ease(p), behavior: 'instant' });
        } catch {
          return res();
        }
        if (run) updateHandles(run);
        if (p < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
  }
  function scrollInto(r, win, node) {
    r.scrollQ = r.scrollQ.then(async () => {
      if (r.skipped || inView(win, node)) return;
      const rc = node.getBoundingClientRect();
      const vh = win.innerHeight;
      const margin = vh * 0.08;
      const off = rc.height > vh * 0.7 ? margin : Math.max(margin, (vh - rc.height) * 0.35);
      const max = Math.max(0, (win.document.scrollingElement || win.document.documentElement).scrollHeight - vh);
      const to = clamp(win.scrollY + rc.top - off, 0, max);
      await animScroll(win, to, D(r, M(r, 520)), r);
    });
    return r.scrollQ;
  }

  function lockSize(win, node) {
    const cs = win.getComputedStyle(node);
    if (cs.display === 'inline' || cs.display === 'contents' || node.offsetWidth == null) return null;
    const s = node.style;
    const saved = ['min-width', 'min-height'].map((p) => [p, s.getPropertyValue(p), s.getPropertyPriority(p)]);
    const px = (v) => parseFloat(v) || 0;
    const content = cs.boxSizing !== 'border-box';
    const w = node.offsetWidth - (content ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) : 0);
    const h = node.offsetHeight - (content ? px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) : 0);
    s.setProperty('min-width', Math.max(0, w) + 'px', 'important');
    s.setProperty('min-height', Math.max(0, h) + 'px', 'important');
    return saved;
  }
  function unlockSize(node, saved) {
    if (!saved) return;
    for (const [p, v, pr] of saved) {
      if (v) node.style.setProperty(p, v, pr);
      else node.style.removeProperty(p);
    }
    if (!node.getAttribute('style')) node.removeAttribute('style');
  }

  function reveal(r, L) {
    L.el.removeAttribute('data-hs-h');
    const ms = D(r, M(r, 280));
    if (ms > 0 && !L.edit && typeof L.el.animate === 'function') {
      const kf = L.hasMotion || L.inline ? [{ opacity: 0 }] : [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }];
      try {
        L.el.animate(kf, { duration: ms, easing: 'cubic-bezier(.2,.7,.2,1)' });
      } catch {}
    }
    L.revealed = true;
    L.resolveReveal();
  }

  async function typeLayer(r, L, t) {
    const ch = M(r, 32);
    let typed = 0;
    let steps = 0;
    for (const tx of L.texts) {
      const s = tx.text;
      let i = 0;
      while (i < s.length) {
        const ms = D(r, ch);
        if (r.skipped || ms <= 0) {
          tx.node.nodeValue = s;
          break;
        }
        const n = typed < SLOW_CHARS ? 1 : CHUNK;
        let c = 0;
        while (i < s.length && c < n) {
          if (/\s/.test(s[i])) while (i < s.length && /\s/.test(s[i])) i++;
          else {
            i++;
            c++;
          }
        }
        typed += c;
        tx.node.nodeValue = s.slice(0, i);
        if (++steps % 4 === 0) t.h.update?.(rectOf(L.el));
        await wait(r, ms);
      }
    }
    if (L.ph != null) {
      for (let i = 1; i <= L.ph.length; i++) {
        const ms = D(r, ch);
        if (r.skipped || ms <= 0) break;
        L.el.setAttribute('placeholder', L.ph.slice(0, i));
        await wait(r, ms);
      }
      L.el.setAttribute('placeholder', L.ph);
    }
    L.typed = true;
    t.h.update?.(rectOf(L.el));
  }

  function emptyTexts(L) {
    for (const tx of L.texts) tx.node.nodeValue = '';
    if (L.ph != null) L.el.setAttribute('placeholder', '');
    L.touched = true;
  }
  function restoreTexts(L) {
    if (!L.touched || L.typed) return;
    for (const tx of L.texts) if (tx.node.nodeValue !== tx.text) tx.node.nodeValue = tx.text;
    if (L.ph != null) L.el.setAttribute('placeholder', L.ph);
    L.typed = true;
  }

  async function buildLayer(r, plan, i) {
    const L = plan.layers[i];
    const { win } = plan;
    const agent = pickAgent(r, L.role);
    try {
      if (!inView(win, L.el)) {
        // önceki katmanlar bitmeden sahneyi kaydırma (belge sırası korunur)
        await Promise.all(plan.layers.slice(0, i).map((p) => p.doneP));
        // Biten bölümlerin renk/font uygulaması ekranda görünsün, sonra kaydır.
        await Promise.all(r.secJobs);
        if (!r.skipped && !inView(win, L.el)) await wait(r, D(r, M(r, 450)));
        await scrollInto(r, win, L.el);
      }
      if (r.skipped) return;
      await move(r, agent, rectOf(L.el), M(r, 420));
      const b = L.el.getBoundingClientRect();
      const t = track(r, agent && !r.skipped ? agents.select?.(agent, rectOf(L.el), { label: L.label || `${Math.round(b.width)} × ${Math.round(b.height)}` }) : null, L.el);
      if (plan.code) agents.codeLine?.(i, { type: true });
      await wait(r, D(r, M(r, 200)));
      if (L.parent >= 0) await plan.layers[L.parent].revealP;
      if (r.skipped) return untrack(r, t, 'remove');
      if (L.texts.length || L.ph != null) {
        L.lock = lockSize(win, L.el);
        emptyTexts(L);
        reveal(r, L);
        await typeLayer(r, L, t);
        unlockSize(L.el, L.lock);
        L.lock = null;
      } else {
        reveal(r, L);
        const ms = D(r, M(r, L.kind === 'media' || L.kind === '3d' ? 450 : 160));
        if (agent && ms && (L.kind === 'media' || L.kind === '3d')) agents.busy?.(agent, ms);
        await wait(r, ms);
      }
      untrack(r, t);
    } finally {
      release(r, agent);
      if (!L.revealed) L.resolveReveal();
      layerDone(r, plan, L);
    }
  }

  function layerDone(r, plan, L) {
    if (L.done) return;
    L.done = true;
    L.resolveDone?.();
    plan.doneCount++;
    const base = plan.base || 0;
    agents.progress?.(base + plan.doneCount, base + plan.layers.length, unitLayer());
    const s = plan.sections[L.sec];
    if (s && --s.left === 0) r.secJobs.push(applySection(r, plan, s));
  }

  function unraw(r, s, animate) {
    if (!s.root.hasAttribute('data-hs-raw')) return;
    s.root.removeAttribute('data-hs-raw');
    const ms = animate ? D(r, M(r, 700)) : 0;
    if (ms > 0 && typeof s.root.animate === 'function') {
      try {
        s.root.animate([{ filter: 'grayscale(1) contrast(.92)' }, { filter: 'grayscale(0) contrast(1)' }], { duration: ms, easing: 'ease-out' });
      } catch {}
    }
    updateHandles(r);
  }

  function makeChip(s, at) {
    const c = document.createElement('div');
    c.className = 'w-chip';
    for (const col of [s.bg, s.fg, s.accent]) {
      const i = document.createElement('i');
      i.style.background = col;
      c.appendChild(i);
    }
    const t = document.createElement('span');
    t.innerHTML = `<b>${esc(toHex(s.bg))}</b> · Aa ${esc(s.font)}`;
    c.appendChild(t);
    c.style.left = at.x + 'px';
    c.style.top = at.y + 'px';
    el.fx.appendChild(c);
    return c;
  }

  /** Bölüm tamamlanınca: bir ajan gerçek rengi, biri fontu "uygular". */
  async function applySection(r, plan, s) {
    if (r.skipped) return unraw(r, s, false);
    const sr = el.stage.getBoundingClientRect();
    const vis = toMain(s.root.getBoundingClientRect());
    const top = Math.max(vis.y, sr.top);
    const bottom = Math.min(vis.y + vis.h, sr.bottom);
    if (bottom - top < 24 || isInstant(r)) return unraw(r, s, !isInstant(r));
    const a = pickAgent(r, 'Renk');
    const f = s.heading && inView(plan.win, s.heading) ? pickAgent(r, 'Font') : null;
    try {
      const at = { x: clamp(vis.x - sr.left + 10, 6, Math.max(6, sr.width - 170)), y: clamp(top - sr.top + 10, 6, Math.max(6, sr.height - 34)) };
      const chip = makeChip(s, at);
      r.chips.add(chip);
      const chipTarget = { x: sr.left + at.x + 8, y: sr.top + at.y + 8, w: 16, h: 16 };
      let ft = null;
      await Promise.all([
        move(r, a, chipTarget, M(r, 360)),
        f
          ? move(r, f, rectOf(s.heading), M(r, 360)).then(() => {
              if (!r.skipped) ft = track(r, agents.select?.(f, rectOf(s.heading), { label: t('web.lbl.font', 'Font · {name}', { name: s.font }) }), s.heading);
            })
          : null,
      ]);
      chip.classList.add('on');
      if (a) agents.busy?.(a, D(r, M(r, 500)));
      await wait(r, D(r, M(r, 320)));
      unraw(r, s, true);
      await wait(r, D(r, M(r, 720)));
      if (ft) untrack(r, ft);
      chip.classList.remove('on');
      await wait(r, 260);
      chip.remove();
      r.chips.delete(chip);
    } finally {
      release(r, a);
      release(r, f);
      unraw(r, s, false);
    }
  }

  async function intro(r, plan, o) {
    const n = plan.layers.length;
    let list = Array.isArray(agents.list) ? agents.list : [];
    if (!list.length) {
      for (let k = 0; k < r.count * 3 && list.length < r.count; k++) {
        const a = agents.pick?.();
        if (!a) break;
        if (!list.some((x) => x.id === a.id)) list.push(a);
      }
    }
    const ring = (phase) => {
      const c = stageCenter();
      const rad = c.r * 0.2;
      return list.map((a, j) => {
        const ang = phase + (j / list.length) * Math.PI * 2;
        return { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad * 0.9 };
      });
    };
    let pts = ring(0);
    await Promise.all(list.map((a, j) => move(r, a, pts[j], 650)));
    for (let s = 1; s <= 6 && !r.skipped; s++) {
      if (s === 4) {
        el.introS.textContent = t('web.intro.found', '{n} layers found', { n });
        el.introS.classList.add('on');
      }
      pts = ring((s * Math.PI) / 4);
      await Promise.all(list.map((a, j) => move(r, a, pts[j], 200)));
    }
    await wait(r, D(r, 250));
  }

  function showIntro(text) {
    const txt = String(text || t('web.intro.scan', 'Scanning page')).replace(/[.…\s]+$/, '');
    el.introT.textContent = txt;
    el.introS.textContent = site?.name || '';
    el.introS.classList.remove('on');
    el.intro.classList.remove('out');
    el.intro.hidden = false;
    el.empty.hidden = true;
  }
  async function hideIntro(r) {
    el.intro.classList.add('out');
    await wait(r, 450);
    el.intro.hidden = true;
    el.intro.classList.remove('out');
  }

  function outline(layers) {
    return layers
      .map((L) => {
        const id = L.el.id ? '#' + L.el.id : '';
        const cl = typeof L.el.className === 'string' && L.el.className.trim() ? '.' + L.el.className.trim().split(/\s+/)[0] : '';
        const txt = L.texts.length ? ' ' + L.texts.map((t) => t.text.trim()).join(' ').slice(0, 28) : '';
        return '  '.repeat(Math.min(L.depth, 6)) + `<${L.tag}${id}${cl}>${txt}`;
      })
      .join('\n');
  }

  function finalize(r, plan, st) {
    for (const t of [...r.handles]) untrack(r, t, 'remove');
    for (const c of r.chips) c.remove();
    r.chips.clear();
    for (const L of plan.layers) {
      try {
        restoreTexts(L);
        if (L.lock) unlockSize(L.el, L.lock);
        L.el.removeAttribute('data-hs-h');
        if (!L.revealed) L.resolveReveal();
        L.resolveDone?.();
      } catch {}
    }
    for (const s of plan.sections) s.root.removeAttribute('data-hs-raw');
    st?.remove();
  }

  /** Dışarıdan (arayüz / tarif) çağrılan yapılış: başka bir iş sürüyorsa açık hata verir. */
  async function build(opts = {}) {
    assertIdle();
    return buildRun(opts);
  }

  /** Asıl yapılış; record() kendi kaydı sırasında bunu doğrudan çağırır. */
  async function buildRun(opts = {}) {
    if (!site) {
      toast(t('web.pickFirst', 'Choose a site folder first.'));
      return null;
    }
    if (run) {
      skip(run);
      await run.done;
    }
    if (tourRun) tourRun.stop = true;
    const given = Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined && v !== null));
    const o = { orientation: orient, count, speed, hold: 2, tour: true, intro: t('web.intro.scan', 'Scanning page'), code: false, ...given };
    if (!VIEWS[o.orientation]) o.orientation = orient;
    const lv = o.live || null; // canlı oturumun ilk kurulumu
    setOrient(o.orientation);
    const r = (run = newRun());
    r.count = Math.max(1, Math.min(40, Math.round(+o.count) || count));
    setRunning(true);
    let plan = null;
    let st = null;
    const t0 = performance.now();
    try {
      showIntro(o.intro);
      fit();
      const doc = await reloadFrame();
      if (!doc || !doc.body) throw new Error(t('web.err.noDoc', 'Could not access the site document'));
      if (r.skipped && !active) return null; // yüklenirken sekme değişti: yapılış iptal
      const win = el.frame.contentWindow;
      win.scrollTo({ top: 0, behavior: 'instant' });
      plan = collect(doc, win);
      plan.doneCount = 0;
      plan.code = !!o.code;
      plan.base = lv ? lv.built : 0;
      const n = plan.layers.length;
      if (lv) lv.total = plan.base + n;
      for (const L of plan.layers) {
        L.revealP = new Promise((res) => (L.resolveReveal = res));
        L.doneP = new Promise((res) => (L.resolveDone = res));
      }

      // geçici stil: katmanlar gizli, bölümler "ham" (gri + monospace)
      st = doc.createElement('style');
      st.id = 'hs-build-style';
      st.textContent = BUILD_CSS;
      (doc.head || doc.documentElement).appendChild(st);
      for (const L of plan.layers) L.el.setAttribute('data-hs-h', '');
      for (const s of plan.sections) s.root.setAttribute('data-hs-raw', '');

      if (o.onBeforeIntro) await o.onBeforeIntro();
      // Sekme değiştiyse (deactivate → skip) HUD'u başka modun üstünde açma.
      if (r.skipped && !active) return null;

      agents.start({
        count: r.count,
        mode: 'web',
        title: lv ? t('web.hud.live', 'Live · {name}', { name: site.name }) : t('web.hud.build', 'Web build · {name}', { name: site.name }),
        total: plan.base + n,
        speed: o.speed,
        bounds: el.stage,
        ...(o.code ? { code: outline(plan.layers) } : {}),
      });
      hudOpen = true;
      agents.onTour = () => {
        if (!run) runTour();
      };
      const onClose = lv
        ? liveOnClose
        : () => {
            if (run && !run.skipped) skip(run);
            else if (tourRun) tourRun.stop = true;
            else closeHud();
          };
      agents.onClose = hudClose = onClose; // sahiplik belirteci: başka oturum başlarsa agents.onClose değişir
      agents.progress?.(plan.base, plan.base + n, unitLayer());
      if (lv) {
        const fn = document.querySelector('.ag-code .ag-fn');
        if (fn) fn.textContent = baseName(site.entry);
      }

      // 1) tarama sahnesi
      await intro(r, plan, o);
      await hideIntro(r);

      // 2) zamanlama: 1x'te tipik sitede toplam ~25-50 sn
      const P = Math.min(r.count, n <= 25 ? 3 : n <= 80 ? 4 : 5);
      const typeCost = (c) => Math.min(c, SLOW_CHARS) * 32 + Math.ceil(Math.max(0, c - SLOW_CHARS) / CHUNK) * 32;
      const sum = plan.layers.reduce(
        (a, L) => a + 420 + 200 + 280 + (L.chars ? typeCost(L.chars) : L.kind === 'media' || L.kind === '3d' ? 450 : 160),
        0
      );
      const target = clamp(10000 + n * 220, 16000, 34000);
      r.k = clamp((target * P) / Math.max(1, sum), 0.2, 1.5);

      for (const s of plan.sections) if (!s.total) unraw(r, s, false);

      // 3) katmanlar: P ajan paralel, belge sırasıyla
      let next = 0;
      const worker = async () => {
        while (!r.skipped) {
          const i = next++;
          if (i >= n) break;
          await buildLayer(r, plan, i);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, P) }, worker));
      await Promise.all(r.secJobs);

      // 5) son: site tam hâli, ajanlar kenara
      finalize(r, plan, st);
      st = null;
      agents.progress?.(plan.base + n, plan.base + n, unitLayer());
      if (ownsHud() && !lv) agents.stop?.({ keep: true });
      if (!r.skipped) await wait(r, Math.max(0, +o.hold || 0) * 1000);
      if (o.tour && !r.skipped) await runTour(r);
      return { layers: n, sections: plan.sections.length, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (hudOpen) closeHud();
      throw e;
    } finally {
      if (plan) finalize(r, plan, st);
      if (!el.intro.hidden) el.intro.hidden = true;
      if (run === r) run = null;
      setRunning();
      r.finish();
      // Mod pasifken biten yapılışın HUD'u başka modun üstünde kalmasın.
      if (!active && !recording && !L?.rec && hudOpen) closeHud();
      if (!active && !recording && !L) unloadFrame();
    }
  }

  /** Yalnızca Web modunun kendi açtığı ajan katmanını kapatır; başka mod yeni oturum açtıysa ona dokunmaz. */
  function closeHud() {
    const mine = ownsHud();
    hudOpen = false;
    hudClose = null;
    if (mine) agents.stop?.({ keep: false });
  }

  function speedFactor() {
    const s = agents.speed ?? speed;
    if (typeof s === 'number') return 1 / Math.max(0.1, s);
    return { '1x': 1, '2x': 0.5, '5x': 0.2, instant: 0.2 }[s] ?? 1;
  }

  /** Sayfayı yumuşakça baştan sona kaydırıp başa döner. */
  async function runTour(r = null) {
    const win = el.frame.contentWindow;
    const doc = frameDoc();
    if (!win || !doc?.documentElement || tourRun) return;
    const token = (tourRun = { stop: false, get skipped() {
      return !!r?.skipped;
    } });
    el.shield.hidden = false;
    try {
      const max = Math.max(0, (doc.scrollingElement || doc.documentElement).scrollHeight - win.innerHeight);
      if (max < 8) return;
      const f = speedFactor();
      if (win.scrollY > 4) await animScroll(win, 0, 600 * f, token);
      if (token.stop) return;
      await animScroll(win, max, clamp((max / 650) * 1000, 2500, 9000) * f, token);
      if (token.stop) return;
      await sleep(500 * f);
      if (token.stop) return;
      await animScroll(win, 0, clamp((max / 2200) * 1000, 900, 2200) * f, token);
    } finally {
      if (tourRun === token) tourRun = null;
      el.shield.hidden = !run && !recording;
    }
  }

  // ---------------------------------------------------------------- kayıt

  async function addMusic(vid, music, out, secs, volume) {
    let mp = music;
    let tmp = null;
    if (typeof music !== 'string') {
      tmp = platform.join(platform.paths.out, `_muzik_${Date.now()}.${extOf(music.name || '') || 'mp3'}`);
      await platform.writeBlob(tmp, music);
      mp = tmp;
    } else mp = platform.resolvePath(music, platform.paths.root);
    const st = Math.max(0, secs - 1.9).toFixed(2);
    const vol = volume != null && isFinite(volume) ? `volume=${clamp(+volume, 0, 4)},` : '';
    const res = await platform.ffmpeg(
      `-i ${q(vid)} -i ${q(mp)} -filter_complex "[1:a]${vol}afade=t=in:st=0:d=0.5,afade=t=out:st=${st}:d=1.5,apad[a]" -map 0:v:0 -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart ${q(out)}`
    );
    if (tmp) await platform.removeFile?.(tmp)?.catch?.(() => {});
    if (res.exitCode === 0) {
      await Promise.resolve(platform.removeFile?.(vid)).catch(() => {});
      return out;
    }
    console.warn('ffmpeg music', res.stdErr);
    toast(t('web.err.music', 'Could not add music; saved a silent video.'), 4500);
    return vid;
  }

  /**
   * Kaydedilen dosyanın gerçek video süresi (sn). ffmpeg'in -progress çıktısı loglevel'den bağımsızdır;
   * akış kopyalanıp null'a yazılır (hızlı), son out_time değeri süreyi verir. Okunamazsa null.
   */
  async function videoSeconds(file) {
    try {
      const r = await platform.ffmpeg(`-nostats -progress pipe:1 -i ${q(file)} -map 0:v:0 -c copy -f null -`);
      const all = [...String(r?.stdOut || '').matchAll(/out_time_(?:us|ms)=(\d+)/g)];
      const s = all.length ? +all[all.length - 1][1] / 1e6 : NaN;
      return s > 0.5 ? s : null;
    } catch {
      return null;
    }
  }

  async function recordFfmpeg(o, v, outPath) {
    const vid = o.music ? outPath.replace(/\.mp4$/i, '') + '.sessiz.mp4' : outPath;
    let rec = null;
    let t0 = 0;
    const start = async () => {
      if (rec) return;
      await frames(2);
      // Fonksiyon olarak verilir: kayıt öncesi kontrol başarısız olursa pencere konumu yeniden ölçülür.
      const rect = async () => {
        const org = await platform.clientOrigin();
        const s = el.stage.getBoundingClientRect();
        return { x: org.x + s.left * org.dpr, y: org.y + s.top * org.dpr, w: s.width * org.dpr, h: s.height * org.dpr };
      };
      rec = await platform.startScreenRecord(rect, vid, { fps: 30, out: v.out });
      t0 = performance.now();
      await sleep(700); // ffmpeg yakalamaya başlasın
      // ffmpeg hemen çıktıysa (kodlayıcı/kap hatası vb.) yapılışı boşuna oynatma.
      if (!rec.alive) throw new Error(t('web.err.ffStart', 'ffmpeg screen recording did not start: {msg}', { msg: String(rec.error || '').trim() || t('web.err.unknown', 'unknown error') }));
    };
    try {
      await buildRun({ ...o, onBeforeIntro: start });
      if (!rec) return null;
      await sleep(800);
    } catch (e) {
      if (rec) await rec.stop().catch(() => {}); // asıl hatayı gölgeleme
      throw e;
    }
    // Bitiş zamanı durdurmadan ÖNCE alınır (kapanış/+faststart süresi videoya girmez).
    const t1 = performance.now();
    await rec.stop();
    if (o.music) {
      const secs = (await videoSeconds(vid)) || (t1 - t0) / 1000;
      return addMusic(vid, o.music, outPath, secs, o.musicVolume);
    }
    return outPath;
  }

  async function recordBrowser(o, v, outPath) {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t('web.err.noCapture', 'Screen capture is not supported and ffmpeg was not found'));
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    });
    const track = stream.getVideoTracks()[0];
    let recStream = null;
    let stopCanvas = null;
    let mr = null;
    let mime;
    let started = false; // MediaRecorder gerçekten başladı mı
    let stopped = null;
    const chunks = [];
    try {
      if (window.CropTarget && track?.cropTo) {
        try {
          await track.cropTo(await window.CropTarget.fromElement(el.stage));
          recStream = stream;
        } catch {}
      }
      if (!recStream) {
        // Bölge kırpma yoksa: sekme görüntüsünü tuvalde sahneye kırp (yalnızca kayıt boyunca çizilir).
        const vid = document.createElement('video');
        vid.muted = true;
        vid.srcObject = stream;
        let raf = 0;
        stopCanvas = () => {
          cancelAnimationFrame(raf);
          vid.srcObject = null;
        };
        await vid.play();
        const cv = document.createElement('canvas');
        cv.width = v.out.w;
        cv.height = v.out.h;
        const ctx = cv.getContext('2d');
        const draw = () => {
          const s = el.stage.getBoundingClientRect();
          const fx = vid.videoWidth / innerWidth;
          const fy = vid.videoHeight / innerHeight;
          if (vid.videoWidth) ctx.drawImage(vid, s.left * fx, s.top * fy, s.width * fx, s.height * fy, 0, 0, cv.width, cv.height);
          raf = requestAnimationFrame(draw);
        };
        draw();
        recStream = cv.captureStream(30);
      }
      mime = pickMime(['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
      if (mime === null) throw new Error(t('web.err.noMR', 'MediaRecorder is not supported'));
      const m = (mr = new MediaRecorder(recStream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 }));
      m.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      stopped = new Promise((res) => {
        m.onstop = res;
        m.onerror = res;
      });
      const start = async () => {
        if (m.state === 'inactive') {
          m.start(1000); // paylaşım durdurulmuşsa hata atar; started false kalır
          started = true;
          await sleep(200);
        }
      };
      await buildRun({ ...o, onBeforeIntro: start });
      await sleep(800);
    } finally {
      // Yalnızca başlamış kaydı bekle (hiç başlamadıysa onstop gelmez); takılmasın diye zaman aşımı.
      if (mr && started) {
        try {
          if (mr.state !== 'inactive') mr.stop();
        } catch {}
        await Promise.race([stopped, sleep(5000)]);
      }
      stream.getTracks().forEach((t) => t.stop());
      stopCanvas?.();
    }
    if (!chunks.length) return null;
    if (o.music) toast(t('web.err.musicNoFf', 'Music cannot be added without ffmpeg; saved a silent video.'), 4500);
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'video/webm' });
    return platform.saveVideoFile(blob, outPath);
  }

  async function record(opts = {}) {
    if (!site) {
      toast(t('web.pickFirst', 'Choose a site folder first.'));
      return null;
    }
    assertIdle(); // sessiz null yerine açık hata: tarif çalıştırıcı bunu hata olarak raporlar
    const o = { orientation: orient, ...Object.fromEntries(Object.entries(opts || {}).filter(([, x]) => x !== undefined && x !== null)) };
    if (!VIEWS[o.orientation]) o.orientation = orient;
    const v = VIEWS[o.orientation];
    const native = platform.isNative();
    const name = safeName(o.name || site.name);
    let outPath = o.file || `${name}-yapilis.mp4`;
    if (!/\.(mp4|webm)$/i.test(outPath)) outPath += '.mp4';
    if (native) outPath = platform.resolvePath(outPath, platform.paths.out);
    recording = true;
    setRunning(true);
    setOrient(o.orientation);
    document.body.classList.add('hs-webrec');
    fit();
    let onTop = false;
    try {
      if (native) {
        await Promise.resolve(platform.win.show()).catch(() => {});
        await Promise.resolve(platform.win.focus()).catch(() => {});
        if (platform.win.onTop) {
          await Promise.resolve(platform.win.onTop(true)).catch(() => {});
          onTop = true;
        }
      }
      await frames(2);
      fit();
      await sleep(250);
      const ff = native ? await platform.findFfmpeg() : null;
      // ffmpeg ekran kaydı libx264 ile yazar; .webm kabı H.264 almaz → çıktı her zaman .mp4.
      if (ff) outPath = outPath.replace(/\.webm$/i, '.mp4');
      const p = ff ? await recordFfmpeg(o, v, outPath) : await recordBrowser(o, v, outPath);
      if (p) toast(t('web.rec.saved', 'Build video saved: {name}', { name: baseName(p) }), 5000);
      return p;
    } finally {
      if (onTop) await Promise.resolve(platform.win.onTop(false)).catch(() => {});
      document.body.classList.remove('hs-webrec');
      recording = false;
      setRunning(!!run);
      fit();
      if (!active) unloadFrame();
    }
  }

  // ---------------------------------------------------------------- canlı mod
  // Claude site klasörüne yazarken klasör izlenir; her değişiklik grubu ajanlarla gösterilir.
  // Boşta: tek izleyici + tek zaman aşımı zamanlayıcısı; ajanlar kenara çekilir, döngü yok.

  const liveApi = {
    start: (o) => liveStart(o),
    note: (t) => liveNote(t),
    stop: (o = {}) => stopLive({ tour: o?.tour !== false }),
    get active() {
      return !!L;
    },
    onEnd: null,
  };

  const liveUrl = (rel) => MOUNT + '/' + String(rel).split('/').map(encodeURIComponent).join('/');
  const pathKey = (u, doc) => {
    try {
      return decodeURIComponent(new URL(u, doc?.baseURI || location.href).pathname).toLowerCase();
    } catch {
      return '';
    }
  };
  const patchBadge = (t) => {
    const b = document.querySelector('.ag-badge .ag-bt');
    if (b) b.textContent = t;
  };
  const isFast = (S) => !!S.fast || (!active && !S.rec);
  const reportLive = (e) => {
    console.error('live mode', e);
    toast(t('web.err.live', 'Live mode error: {msg}', { msg: e?.message || e }), 5000);
  };

  async function liveStart(o = {}) {
    if (L) throw new Error(t('web.err.liveOpen', 'Live mode is already open'));
    assertIdle();
    if (!platform.isNative()) throw new Error(t('web.err.liveDesktop', 'Live mode only works in the desktop app.'));
    if (!o || !o.site) throw new Error(t('web.err.liveDir', 'A site folder is required for live mode'));
    let d = String(o.site).replace(/\\/g, '/').replace(/\/+$/, '');
    let entry = String(o.entry || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
    if (/\.html?$/i.test(d)) {
      entry = baseName(d);
      d = platform.dirOf(d);
    }
    const ori = VIEWS[o.orientation] ? o.orientation : 'horizontal';
    // music: yol (string), Blob ya da live.js webMusic biçimi {file, volume, ...} olabilir.
    const m = o.music;
    const mObj = m && typeof m === 'object' && !(typeof Blob !== 'undefined' && m instanceof Blob);
    const music = typeof m === 'string' || (typeof Blob !== 'undefined' && m instanceof Blob) ? m : mObj && typeof m.file === 'string' ? m.file : null;
    const S = {
      dir: d,
      entry,
      name: safeName(o.name || 'canli'),
      orientation: ori,
      count: Math.max(1, Math.min(40, Math.round(+o.count) || 12)),
      speed: ['1x', '2x', '5x', 'instant'].includes(o.speed) ? o.speed : '1x',
      music: music || null,
      musicVolume: o.musicVolume ?? (mObj ? m.volume : undefined),
      pending: new Map(),
      incoming: new Map(),
      cache: new Map(),
      known: new Set(),
      files: new Set(),
      own: new Map(), // rel → son geçerlilik zamanı: denetçinin yazdığı ikili dosyalar (yankı sayılmaz)
      changes: 0,
      built: 0,
      total: 0,
      loaded: false,
      waiting: false,
      busy: false,
      stopping: false,
      fast: false,
      rec: null,
      watchId: null,
      chain: null,
      init: null,
      circle: null,
      debT: 0,
      debT0: 0,
      idleT: 0,
      restT: 0,
      noteT: 0,
    };
    if (!active || !root.classList.contains('on')) {
      console.warn('Live mode: Web tab is not visible');
      toast(t('web.live.started', 'Live mode started; switch to the Web tab to see it.'), 4500);
    }
    if (tourRun) tourRun.stop = true;
    if (hudOpen) closeHud();
    L = S;
    S.starting = true; // stopLive başlatmanın bitmesini bekler (izleyici/onTop sızmasın)
    S.startP = (async () => {
      try {
        if (!(await platform.exists(d))) await platform.mkdirp(d);
        await platform.mount(MOUNT, d);
        site = { dir: d, entry, url: liveUrl(entry), name: baseName(d) };
        store.set('web_site', { dir: d, entry });
        el.path.textContent = d;
        el.path.title = d;
        unloaded = false;
        el.empty.hidden = true;
        clearLiveUi();
        setOrient(ori);
        syncUi();
        if (o.record) {
          if (!(await platform.findFfmpeg())) toast(t('web.live.noFf', 'ffmpeg not found: the live session will not be recorded to video.'), 5000);
          else {
            S.rec = { parts: [], n: 0, cur: null, last: null, fails: 0, off: false, onTop: false };
            document.body.classList.add('hs-webrec');
            await Promise.resolve(platform.win.show()).catch(() => {});
            await Promise.resolve(platform.win.focus()).catch(() => {});
            if (platform.win.onTop) {
              await Promise.resolve(platform.win.onTop(true)).catch(() => {});
              S.rec.onTop = true;
            }
            await frames(2);
          }
        }
        fit();
        S.watchId = await platform.watchDir(d, (f, a, ed) => onFs(S, f, a, ed));
        resetIdle(S);
        S.init = async () => {
          await primeCache(S);
          if (await platform.exists(platform.join(d, entry))) await initialBuild(S);
          else showWaiting(S);
        };
        pump();
      } catch (e) {
        if (S.watchId != null) await platform.unwatchDir(S.watchId).catch(() => {});
        clearTimeout(S.idleT);
        endRecUi(S);
        if (L === S) L = null;
        syncUi();
        fit();
        throw e;
      } finally {
        S.starting = false;
        if (L === S) syncUi();
      }
    })();
    return S.startP;
  }

  /** Başlangıçtaki metin dosyaları: sonraki değişikliklerde satır farkı bunlara göre hesaplanır. */
  async function primeCache(S) {
    let n = 0;
    const walk = async (dir, rel, depth) => {
      let list;
      try {
        list = await platform.listDir(dir);
      } catch {
        return;
      }
      for (const e of list) {
        if (n >= 300 || L !== S) return;
        const name = e.entry;
        if (!name || name === '.' || name === '..' || name.startsWith('.') || name === 'node_modules') continue;
        const r = rel ? rel + '/' + name : name;
        if (e.type === 'DIRECTORY') {
          if (depth < 4) await walk(platform.join(dir, name), r, depth + 1);
          continue;
        }
        if (ignoredRel(r)) continue;
        S.known.add(r);
        if (!TEXT_EXT.has(extOf(name))) continue;
        try {
          const t = await platform.readText(platform.join(dir, name));
          if (t.length <= LIVE_MAX_TEXT) {
            S.cache.set(r, t);
            n++;
          }
        } catch {}
      }
    };
    await walk(S.dir, '', 0);
  }

  function resetIdle(S) {
    clearTimeout(S.idleT);
    S.idleT = setTimeout(() => {
      if (L !== S || S.stopping) return;
      toast(t('web.live.idle', 'Live mode: no changes for 20 minutes, ending the session.'), 5000);
      stopLive({ tour: true }).catch(reportLive);
    }, LIVE_IDLE_MS);
  }

  function onFs(S, filename, action, evDir) {
    if (L !== S || S.stopping) return;
    const rel = relOf(S.dir, filename, evDir);
    if (!rel || ignoredRel(rel)) return;
    S.incoming.set(rel, action);
    resetIdle(S);
    const now = performance.now();
    if (!S.debT0) S.debT0 = now;
    clearTimeout(S.debT);
    S.debT = setTimeout(() => flushFs(S), now - S.debT0 > LIVE_MAX_WAIT ? 0 : LIVE_DEBOUNCE);
  }

  function flushFs(S) {
    clearTimeout(S.debT);
    S.debT = 0;
    S.debT0 = 0;
    if (L !== S) return;
    for (const [k, v] of S.incoming) S.pending.set(k, v); // aynı dosyanın ara durumları birleşir (son içerik okunur)
    S.incoming.clear();
    pump();
  }

  /** Kuyruğu sırayla işler; animasyon sürerken gelenler birikip tek grup olarak işlenir. */
  function pump() {
    const S = L;
    if (!S) return Promise.resolve();
    if (S.chain) return S.chain;
    const visible = () => active || !!S.rec || S.stopping;
    if (!visible()) return Promise.resolve(); // sekme dışında: değişiklikler birikir, dönüşte oynatılır
    S.chain = (async () => {
      try {
        if (S.init) {
          const f = S.init;
          S.init = null;
          try {
            await f();
          } catch (e) {
            reportLive(e);
          }
        }
        while (L === S && S.pending.size && visible()) {
          const files = new Map(S.pending);
          S.pending.clear();
          try {
            await processGroup(S, files);
          } catch (e) {
            reportLive(e);
          }
        }
      } finally {
        S.chain = null;
      }
    })();
    return S.chain;
  }

  async function isDir(p) {
    try {
      return !!(await window.Neutralino?.filesystem?.getStats(p))?.isDirectory;
    } catch {
      return false;
    }
  }

  const deltaOf = (d) => `${d.add ? '+' + d.add : ''}${d.add && d.del ? ' ' : ''}${d.del ? '−' + d.del : ''}`;
  function describe(d) {
    if (!d.exists) return t('web.ev.deleted', '{rel} deleted', { rel: d.rel });
    if (d.add != null && (d.add || d.del)) return t('web.ev.lines', '{rel} · {delta} lines', { rel: d.rel, delta: deltaOf(d) });
    return t('web.ev.updated', '{rel} updated', { rel: d.rel });
  }

  async function processGroup(S, files) {
    S.busy = true;
    insp?.sync();
    try {
      const diffs = [];
      for (const [rel, action] of files) {
        const own = S.own.get(rel);
        if (own) {
          if (performance.now() < own) continue; // denetçinin kendi yazdığı görsel / büyük metin
          if (performance.now() >= own) S.own.delete(rel);
        }
        const abs = platform.join(S.dir, rel);
        const ex = await platform.exists(abs);
        if (ex && (await isDir(abs))) continue;
        if (!ex && !S.known.has(rel) && !S.cache.has(rel)) continue; // hiç görülmemiş ve artık yok (geçici dosya)
        const d = { rel, kind: kindOf(rel), exists: ex, action, add: null, del: 0, lines: [] };
        if (TEXT_EXT.has(extOf(rel))) {
          const txt = ex ? await platform.readText(abs).catch(() => null) : null;
          const old = S.cache.get(rel);
          if (txt != null && txt.length <= LIVE_MAX_TEXT) {
            if (old === txt) continue; // içerik aynı (yalnızca zaman damgası)
            Object.assign(d, lineDiff(old || '', txt));
            S.cache.set(rel, txt);
          } else if (!ex && old != null) {
            d.del = old.split('\n').length;
            S.cache.delete(rel);
          }
        }
        if (ex) S.known.add(rel);
        else S.known.delete(rel);
        diffs.push(d);
      }
      if (!diffs.length || L !== S) return;
      S.changes++;
      for (const d of diffs) {
        S.files.add(d.rel);
        logEvent(describe(d));
      }
      if (!(await platform.exists(platform.join(S.dir, S.entry)))) {
        if (!S.waiting) showWaiting(S);
        return;
      }
      if (!S.loaded || S.waiting) {
        await initialBuild(S);
        return;
      }
      await animateChanges(S, diffs);
    } finally {
      S.busy = false;
      insp?.sync();
    }
  }

  // ---- bekleme ekranı

  function showWaiting(S) {
    S.waiting = true;
    S.loaded = false;
    el.waitS.textContent = (baseName(S.dir) || S.dir) + ' / ' + S.entry;
    el.wait.hidden = false;
    el.empty.hidden = true;
    startCircle(S);
  }
  function hideWaiting(S) {
    S.waiting = false;
    el.wait.hidden = true;
    stopCircle(S);
  }
  function stopCircle(S) {
    if (S?.circle) {
      S.circle.stop = true;
      S.circle = null;
    }
  }
  /** Ajanlar sahnenin ortasında yavaşça daire çizer; süre sınırlı, sonra kenara çekilirler. */
  function startCircle(S) {
    stopCircle(S);
    if (isFast(S) || S.stopping) return;
    const tok = (S.circle = { stop: false });
    (async () => {
      ensureAgents(S);
      await sleep(900); // ajanlar HUD'dan çıkıp dağılsın
      const t0 = performance.now();
      let ph = 0;
      while (!tok.stop && L === S && performance.now() - t0 < LIVE_CIRCLE_MS) {
        const list = agents.list;
        if (!list.length || !agents.active || agents.instant || !ownsHud()) break;
        const c = stageCenter();
        const rad = c.r * 0.3;
        ph += Math.PI / 10;
        const s0 = performance.now();
        await Promise.all(
          list.map((a, j) => {
            const ang = ph + (j / list.length) * Math.PI * 2;
            return Promise.resolve(agents.moveTo(a, { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad * 0.85 }, { dur: 1000 })).catch(() => {});
          })
        );
        if (performance.now() - s0 < 120) break; // hareket yoksa sıkı döngüye girme
      }
      if (S.circle === tok) {
        S.circle = null;
        if (!tok.stop && L === S && !S.busy && !run) rest(S);
      }
    })().catch(() => {});
  }

  // ---- ajan katmanı

  function liveOnClose() {
    const S = L;
    if (!S) return closeHud();
    if (S.stopping) {
      if (tourRun) tourRun.stop = true;
      if (run) skip(run);
      return;
    }
    stopLive({ tour: true, fast: true }).catch(reportLive);
  }

  function ensureAgents(S) {
    clearTimeout(S.restT);
    if (ownsHud() && agents.active) {
      if (agents.speed === 'instant' && S.speed !== 'instant') agents.setSpeed?.(S.speed);
      return;
    }
    agents.start({ count: S.count, mode: 'web', title: t('web.hud.live', 'Live · {name}', { name: site?.name || '' }), total: S.total, speed: S.speed, bounds: el.stage });
    hudOpen = true;
    agents.onTour = () => {
      if (!run && !tourRun && L === S && !S.stopping && !S.busy) runTour();
    };
    agents.onClose = hudClose = liveOnClose;
    agents.progress?.(S.built, S.total, unitLayer());
  }

  /** Ajanlar kenara çekilir, döngü durur; HUD ve rozet ekranda kalır. */
  function rest(S) {
    clearTimeout(S.restT);
    if (run || S.busy || !ownsHud() || !agents.active) return;
    codeTok++; // askıda kalan yazım döngüsü panele dokunmasın
    agents.setCode?.('');
    agents.stop?.({ keep: true });
    patchBadge(t('web.badge.wait', 'Live · waiting for Claude'));
  }
  function restSoon(S, ms = LIVE_REST_MS) {
    clearTimeout(S.restT);
    S.restT = setTimeout(() => {
      if (L === S && !S.busy && !run && !S.circle) rest(S);
    }, ms);
  }

  // ---- not balonu ve etkinlik satırları

  function liveNote(text) {
    const S = L;
    if (!S) return;
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!t) return;
    resetIdle(S);
    el.noteT.textContent = t;
    el.note.hidden = false;
    el.note.classList.remove('on');
    void el.note.offsetWidth;
    el.note.classList.add('on');
    clearTimeout(S.noteT);
    S.noteT = setTimeout(() => {
      el.note.classList.remove('on');
      S.noteT = setTimeout(() => {
        if (!el.note.classList.contains('on')) el.note.hidden = true;
      }, 350);
    }, 6000);
    logEvent(t, 'note');
  }

  function logEvent(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'w-ev' + (cls ? ' ' + cls : '');
    if (cls === 'note') {
      const b = document.createElement('b');
      b.textContent = 'Claude';
      d.append(b, ' ' + text);
    } else d.textContent = text;
    el.log.appendChild(d);
    while (el.log.children.length > 3) el.log.firstElementChild.remove();
    el.log.hidden = false;
  }

  function clearLiveUi() {
    el.note.classList.remove('on');
    el.note.hidden = true;
    el.log.textContent = '';
    el.log.hidden = true;
    el.wait.hidden = true;
  }

  // ---- kod paneli

  function codeFor(diffs) {
    const d = diffs
      .filter((x) => x.add != null && (x.lines.length || x.del))
      .sort((x, y) => y.add + y.del - (x.add + x.del))[0];
    if (!d) return null;
    const body = [];
    let blank = false;
    for (const ln of d.lines) {
      const t = ln.replace(/\t/g, '  ').replace(/\s+$/, '');
      if (!t) {
        if (blank || !body.length) continue;
        blank = true;
      } else blank = false;
      body.push(t);
      if (body.length >= 39) break;
    }
    while (body.length && !body[body.length - 1]) body.pop();
    const ind = Math.min(...body.filter(Boolean).map((l) => l.match(/^ */)[0].length), 99);
    const lines = body.map((l) => {
      const s = l.slice(Math.min(ind, l.length));
      return s.length > 96 ? s.slice(0, 95) + '…' : s;
    });
    if (!lines.length) lines.push(t('web.code.onlyDeleted', '// (lines deleted only)'));
    const head = '// ' + t('web.ev.lines', '{rel} · {delta} lines', { rel: d.rel, delta: deltaOf(d) });
    lines.unshift(head);
    return { rel: d.rel, text: lines.join('\n'), n: lines.length };
  }

  /** Paneli yeni koda geçirir; dönen belirteç eski typeCode döngülerinin paneli karıştırmasını önler. */
  function showCode(code) {
    agents.setCode?.(code.text);
    const fn = document.querySelector('.ag-code .ag-fn');
    if (fn) fn.textContent = baseName(code.rel);
    return ++codeTok;
  }

  async function typeCode(r, n, tok) {
    const alive = () => !r.skipped && !r.codeStop && tok === codeTok && ownsHud();
    for (let i = 0; i < n && alive(); i++) {
      const typed = i < 9;
      const p = agents.codeLine?.(i, { type: typed });
      if (typed) await Promise.race([Promise.resolve(p), wait(r, 3000)]);
      else await wait(r, D(r, 60));
    }
    if (tok === codeTok && !r.skipped && ownsHud()) agents.codeDone?.(); // imleç kalkar, panel soluklaşır
  }

  /** Grup bitti: yazım döngüsü durur (sonraki grubun paneline dokunmaz), kalan satırlar gösterilir. */
  function endCode(r, tok) {
    r.codeStop = true;
    if (tok && tok === codeTok && ownsHud()) agents.codeDone?.();
  }

  // ---- kayıt (her değişiklik grubu ayrı parça; uzun beklemeler videoya girmez)

  async function liveRect() {
    const org = await platform.clientOrigin();
    const s = el.stage.getBoundingClientRect();
    return { x: org.x + s.left * org.dpr, y: org.y + s.top * org.dpr, w: s.width * org.dpr, h: s.height * org.dpr };
  }

  async function recStart(S) {
    const R = S.rec;
    if (!R || R.off || R.cur || isFast(S)) return;
    let rec = null;
    try {
      await frames(2);
      const m = await liveRect();
      const same = R.last && ['x', 'y', 'w', 'h'].every((k) => Math.abs(R.last[k] - m[k]) < 1);
      let first = true;
      // İlk ölçüm yeniden kullanılır; kontrol başarısız olursa platform konumu yeniden ölçer.
      const rectFn = async () => {
        if (first) {
          first = false;
          return m;
        }
        return liveRect();
      };
      const path = platform.join(platform.paths.out, `${S.name}-parca-${R.n + 1}.mp4`);
      rec = await platform.startScreenRecord(rectFn, path, { fps: 30, out: VIEWS[S.orientation].out, verify: !same });
      R.n++;
      R.cur = { rec, path };
      R.last = m;
      await sleep(700); // ffmpeg yakalamaya başlasın
      if (!rec.alive) throw new Error(t('web.err.ffStart', 'ffmpeg screen recording did not start: {msg}', { msg: String(rec.error || '').trim() || t('web.err.unknown', 'unknown error') }));
      R.fails = 0; // yalnızca art arda hatalar kaydı kapatır
    } catch (e) {
      if (R.cur) {
        await R.cur.rec.stop().catch(() => {});
        R.cur = null;
      }
      R.last = null; // sonraki parçada bölge yeniden doğrulansın
      if (++R.fails >= 2) R.off = true;
      console.error('live recording', e);
      const msg = e?.message || e;
      toast(R.off ? t('web.live.recStopped', 'Live recording stopped: {msg}', { msg }) : t('web.live.recSkipped', 'Live recording segment skipped: {msg}', { msg }), 6000);
    }
  }

  async function recStop(S, tail = 1200) {
    const R = S.rec;
    const cur = R?.cur;
    if (!cur) return;
    await sleep(tail);
    R.cur = null;
    try {
      R.parts.push(await cur.rec.stop());
    } catch (e) {
      console.warn('live recording segment', e);
    }
  }

  function endRecUi(S) {
    const R = S?.rec;
    if (!R) return;
    if (R.onTop) {
      R.onTop = false;
      Promise.resolve(platform.win.onTop(false)).catch(() => {});
    }
    document.body.classList.remove('hs-webrec');
  }

  async function finishVideo(S) {
    const R = S.rec;
    if (!R?.parts.length) return null;
    const out = platform.join(platform.paths.out, `${S.name}-canli.mp4`);
    const vid = S.music ? out.replace(/\.mp4$/i, '') + '.sessiz.mp4' : out;
    await Promise.resolve(platform.removeFile(vid)).catch(() => {});
    await platform.concatVideos(R.parts, vid);
    if (!S.music) return vid;
    const secs = (await videoSeconds(vid)) || 10;
    try {
      return await addMusic(vid, S.music, out, secs, S.musicVolume);
    } catch (e) {
      // Birleştirilmiş sessiz video kaybolmasın: sonuç olarak o döner.
      console.warn('live music', e);
      toast(t('web.err.music', 'Could not add music; saved a silent video.'), 4500);
      return vid;
    }
  }

  // ---- sayfa yenileme (çift tampon: yeni hâl arkadaki iframe'de hazırlanır, sonra yer değiştirir)

  async function loadBack() {
    const back = el.frame === el.frameA ? el.frameB : el.frameA;
    const p = new Promise((res) => {
      const done = (ok) => {
        clearTimeout(t);
        back.removeEventListener('load', on);
        res(ok);
      };
      const on = () => {
        let u = '';
        try {
          u = back.contentDocument?.URL || '';
        } catch {}
        if (u && !u.startsWith('about:')) done(true);
      };
      const t = setTimeout(() => done(false), 15000);
      back.addEventListener('load', on);
    });
    back.src = site.url + (site.url.includes('?') ? '&' : '?') + 'hs=' + Date.now();
    let doc = null;
    if (await p) {
      try {
        doc = back.contentDocument;
      } catch {}
    }
    if (!doc?.body) {
      back.src = 'about:blank';
      return null;
    }
    await settle(doc);
    return { frame: back, doc, win: back.contentWindow };
  }

  function swapTo(f) {
    const old = el.frame;
    if (old === f) return;
    f.classList.remove('w-back');
    old.classList.add('w-back');
    el.frame = f;
    try {
      old.src = 'about:blank';
    } catch {}
    insp?.frameChanged();
  }

  /** Değişen stil/görsel dosyaları (çalışma anında) sorgu parametresiyle yeniden çekilir: eski önbellek kalmasın. */
  async function bustAssets(doc, diffs) {
    const want = new Set(diffs.filter((d) => d.exists && (d.kind === 'css' || d.kind === 'img')).map((d) => (MOUNT + '/' + d.rel).toLowerCase()));
    if (!want.size) return;
    const ts = Date.now();
    const waits = [];
    const bump = (u) => {
      const x = new URL(u, doc.baseURI);
      x.searchParams.set('hs', ts);
      return x.href;
    };
    const loaded = (n) =>
      new Promise((res) => {
        n.addEventListener('load', res, { once: true });
        n.addEventListener('error', res, { once: true });
      });
    for (const l of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      if (!want.has(pathKey(l.href, doc))) continue;
      waits.push(loaded(l));
      l.href = bump(l.href);
    }
    for (const im of doc.images) {
      const u = im.getAttribute('src');
      if (!u || !want.has(pathKey(im.src, doc))) continue;
      waits.push(loaded(im));
      im.src = bump(im.src);
    }
    if (waits.length) await Promise.race([Promise.all(waits), sleep(2500)]);
  }

  async function refreshAndLoad(diffs) {
    await Promise.race([
      Promise.all(
        diffs
          .filter((d) => d.exists)
          .map((d) =>
            fetch(liveUrl(d.rel), { cache: 'reload' })
              .then((x) => x.arrayBuffer())
              .catch(() => {})
          )
      ),
      sleep(4000),
    ]);
    const nb = await loadBack();
    if (nb) await bustAssets(nb.doc, diffs);
    return nb;
  }

  // ---- gruplar

  async function initialBuild(S) {
    hideWaiting(S);
    if (isFast(S)) {
      if (await showSite()) S.loaded = true;
      return;
    }
    if (tourRun) tourRun.stop = true;
    const wasBusy = S.busy;
    S.busy = true;
    try {
      const res = await buildRun({
        orientation: S.orientation,
        count: S.count,
        speed: S.speed,
        hold: 0,
        tour: false,
        intro: t('web.intro.scan', 'Scanning page'),
        code: true,
        live: S,
        onBeforeIntro: () => recStart(S),
      });
      S.loaded = !!res || !!frameDoc()?.body;
      S.built = S.total;
    } finally {
      await recStop(S);
      S.busy = wasBusy;
    }
    restSoon(S);
  }

  /** Dosya rozeti (JS/CSS vb. görünmeyen değişiklikler): bir ajan sahnenin solunda kısa çalışır. */
  async function cornerJobs(r, list) {
    const LABEL = { js: 'JS', css: 'CSS', html: 'HTML', img: 'IMG', other: t('web.chip.file', 'FILE') };
    const ROLE = { js: 'Kod', css: 'Stil', html: 'Kod', img: 'Görsel', other: 'Kod' };
    await Promise.all(
      list.slice(0, 3).map(async (d, k) => {
        if (r.skipped) return;
        await wait(r, D(r, k * 200));
        if (r.skipped) return;
        const a = pickAgent(r, ROLE[d.kind] || 'Kod');
        const s = el.stage.getBoundingClientRect();
        const chip = document.createElement('div');
        chip.className = 'w-file';
        chip.innerHTML = `<i class="${d.kind}">${LABEL[d.kind] || LABEL.other}</i><span>${esc(baseName(d.rel))}</span>`;
        chip.style.left = '16px';
        chip.style.top = Math.round(s.height * 0.4 + k * 40) + 'px';
        el.fx.appendChild(chip);
        r.chips.add(chip);
        try {
          requestAnimationFrame(() => chip.classList.add('on'));
          await move(r, a, chip, M(r, 420));
          const tk = track(r, a && !r.skipped ? agents.select?.(a, chip, { label: d.kind === 'js' ? t('web.lbl.script', 'script') : t('web.lbl.file', 'file') }) : null, null);
          if (a) agents.busy?.(a, D(r, 1100));
          await wait(r, D(r, 1200));
          untrack(r, tk);
          chip.classList.remove('on');
          await wait(r, 240);
        } finally {
          release(r, a);
          chip.remove();
          r.chips.delete(chip);
        }
      })
    );
  }

  /** Kaldırılan öğeler: eski konumlarında kısa kırmızı "silindi" kutusu. */
  async function removedJob(r, removed) {
    if (r.skipped) return;
    const sr = el.stage.getBoundingClientRect();
    const shown = removed
      .filter((a) => a.shown)
      .map((a) => ({ a, rc: clipStage(toMain({ left: a.r.x, top: a.r.y, width: a.r.w, height: a.r.h })) }))
      .filter((x) => x.rc.w > 6 && x.rc.h > 6)
      .sort((x, y) => y.rc.w * y.rc.h - x.rc.w * x.rc.h)
      .slice(0, 6);
    if (!shown.length) return;
    const ag = pickAgent(r, 'Düzen');
    const boxes = shown.map(({ rc }) => {
      const g = document.createElement('div');
      g.className = 'w-del';
      g.style.cssText = `left:${rc.x - sr.left}px;top:${rc.y - sr.top}px;width:${rc.w}px;height:${rc.h}px`;
      g.innerHTML = `<span>${esc(t('web.deleted', 'deleted'))}</span>`;
      el.fx.appendChild(g);
      r.chips.add(g);
      requestAnimationFrame(() => g.classList.add('on'));
      return g;
    });
    try {
      await move(r, ag, shown[0].rc, M(r, 380));
      if (ag) agents.busy?.(ag, D(r, 700));
      await wait(r, D(r, 950));
      for (const g of boxes) g.classList.remove('on');
      await wait(r, 260);
    } finally {
      release(r, ag);
      for (const g of boxes) {
        g.remove();
        r.chips.delete(g);
      }
    }
  }

  /** Stil / görsel değişikliği: ajan gider, kutu + rozet, eski değerden yenisine geçiş. */
  async function runFx(r, plan, i) {
    const it = plan.layers[i];
    const { win } = plan;
    const agent = pickAgent(r, it.role);
    try {
      if (!inView(win, it.el)) {
        await Promise.all(plan.layers.slice(0, i).map((p) => p.doneP));
        if (!r.skipped && !inView(win, it.el)) await wait(r, D(r, M(r, 300)));
        await scrollInto(r, win, it.el);
      }
      if (r.skipped) return;
      await move(r, agent, rectOf(it.el), M(r, 420));
      const t = track(r, agent && !r.skipped ? agents.select?.(agent, rectOf(it.el), { label: it.label }) : null, it.el);
      await wait(r, D(r, M(r, 240)));
      const ms = D(r, M(r, 650));
      it.unpin?.();
      if (ms > 0 && typeof it.el.animate === 'function') {
        try {
          if (it.fx === 'style' && it.cats.includes('renk')) {
            const f = {};
            const to = {};
            if (it.a.st.color !== it.b.st.color) [f.color, to.color] = [it.a.st.color, it.b.st.color];
            if (it.a.st.bg !== it.b.st.bg) [f.backgroundColor, to.backgroundColor] = [it.a.st.bg, it.b.st.bg];
            it.el.animate([f, to], { duration: ms * 1.2, easing: 'ease-out' });
          } else it.el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
        } catch {}
      }
      if (agent && ms) agents.busy?.(agent, ms);
      await wait(r, ms);
      t.h.update?.(rectOf(it.el));
      await wait(r, D(r, M(r, 200)));
      untrack(r, t);
    } finally {
      release(r, agent);
      it.unpin?.();
      it.revealed = true;
      it.resolveReveal?.();
      layerDone(r, plan, it);
    }
  }

  const catName = (c) =>
    ({
      renk: t('web.cat.color', 'color'),
      font: t('web.cat.font', 'font'),
      düzen: t('web.cat.layout', 'layout'),
      boyut: t('web.cat.size', 'size'),
    })[c] || c;

  function pinOld(it) {
    const { a, b, cats } = it;
    const props = [];
    if (cats.includes('renk')) {
      if (a.st.color !== b.st.color) props.push(['color', a.st.color]);
      if (a.st.bg !== b.st.bg) props.push(['background-color', a.st.bg]);
    }
    if (cats.includes('font')) {
      if (a.st.ff !== b.st.ff) props.push(['font-family', a.st.ff]);
      if (a.st.fs !== b.st.fs) props.push(['font-size', a.st.fs]);
    }
    if (cats.includes('düzen')) {
      if (a.st.br !== b.st.br) props.push(['border-radius', a.st.br]);
      if (a.st.pad !== b.st.pad) props.push(['padding', a.st.pad]);
    }
    return pinStyle(it.el, props);
  }

  async function animateChanges(S, diffs) {
    const fast = isFast(S);
    const entryKey = S.entry.toLowerCase();
    const pageHit = diffs.some((d) => d.kind !== 'html' || d.rel.toLowerCase() === entryKey);
    const fdoc = frameDoc();
    if (pageHit && (!fdoc?.body || !onEntryPage(fdoc))) return initialBuild(S);
    if (tourRun) tourRun.stop = true;
    const code = fast ? null : codeFor(diffs);
    let tok = 0;
    if (!fast) {
      ensureAgents(S);
      if (code) tok = showCode(code);
    }
    const r = newRun();
    r.count = S.count;
    if (fast) r.skipped = true;
    let nb = null;
    let swapped = false;
    let plan = null;
    let st = null;
    let codeP = null;
    const sty = [];
    const edits = [];
    try {
      if (!pageHit) {
        // Sayfayı etkilemeyen dosya (ör. başka bir .html): yalnızca kod paneli + dosya rozeti.
        if (fast) return;
        await recStart(S);
        run = r;
        syncUi();
        codeP = code ? typeCode(r, code.n, tok) : null;
        await cornerJobs(r, diffs);
        return;
      }
      const fwin = el.frame.contentWindow;
      const scrollY = fwin?.scrollY || 0;
      const before = fast ? [] : snapshot(fdoc, fwin);
      [, nb] = await Promise.all([fast ? null : recStart(S), refreshAndLoad(diffs)]);
      if (!nb) {
        toast(t('web.live.loadFail', 'Live: could not load the page.'), 4000);
        return;
      }
      try {
        nb.win.scrollTo({ top: scrollY, behavior: 'instant' });
      } catch {}
      if (fast) return; // finally yer değiştirir
      await sleep(120); // kaydırmaya bağlı site betikleri (IntersectionObserver) otursun
      const { doc, win } = nb;
      const after = snapshot(doc, win);
      const df = diffTrees(before, after, diffs.some((d) => d.kind === 'css' || d.rel.toLowerCase() === entryKey));

      // eklenen öğeler → yapılış katmanları
      const addedTops = df.added.filter((b) => b.shown);
      const addedSet = new Set(addedTops.map((b) => b.el));
      const inAdded = (e) => {
        for (let x = e; x; x = x.parentElement) if (addedSet.has(x)) return true;
        return false;
      };
      const layers = [];
      if (addedSet.size) {
        const full = collect(doc, win).layers;
        const map = new Map();
        full.forEach((Ly, i) => {
          if (!inAdded(Ly.el)) return;
          map.set(i, layers.length);
          layers.push(Ly);
        });
        for (const Ly of layers) {
          let p = Ly.parent;
          while (p >= 0 && !map.has(p)) p = full[p].parent;
          Ly._pl = p >= 0 ? full[p] : null;
        }
        for (const b of addedTops)
          if (!layers.some((Ly) => b.el === Ly.el || b.el.contains(Ly.el)))
            layers.push({ el: b.el, tag: b.tag, kind: 'box', role: 'Düzen', depth: 0, inline: b.st.disp === 'inline', area: b.r.w * b.r.h, hasMotion: false, texts: [], ph: null, chars: 0, _pl: null });
      }
      const taken = new Set(layers.map((x) => x.el));
      // metni değişenler → yeniden yazılır
      for (const { a, b } of df.edits) {
        if (edits.length >= 40) break;
        if (taken.has(b.el) || inAdded(b.el)) continue;
        const texts = [...b.el.childNodes].filter((nd) => nd.nodeType === 3 && /\S/.test(nd.nodeValue)).map((nd) => ({ node: nd, text: nd.nodeValue }));
        if (!texts.length) continue;
        taken.add(b.el);
        edits.push({
          el: b.el,
          tag: b.tag,
          kind: 'text',
          role: /^h[1-6]$/.test(b.tag) ? 'Yazı' : 'Metin',
          depth: 0,
          inline: b.st.disp === 'inline',
          area: b.r.w * b.r.h,
          hasMotion: false,
          texts,
          ph: null,
          chars: texts.reduce((s, x) => s + x.text.trim().length, 0),
          edit: true,
          label: t('web.lbl.text', 'text'),
          old: texts.length === 1 && a.tn === 1 ? a.text : null,
        });
      }
      // stil değişiklikleri → en büyük ~12 öğe
      const ROLE = { renk: 'Renk', font: 'Font', 'düzen': 'Düzen', boyut: 'Düzen' };
      for (const s of df.styles
        .filter((s) => !taken.has(s.b.el) && !inAdded(s.b.el))
        .sort((x, y) => y.b.r.w * y.b.r.h - x.b.r.w * x.b.r.h)
        .slice(0, 12)) {
        taken.add(s.b.el);
        sty.push({ el: s.b.el, tag: s.b.tag, fx: 'style', cats: s.cats, a: s.a, b: s.b, role: ROLE[s.cats[0]] || 'Stil', label: s.cats.map(catName).join(' · '), texts: [], ph: null, chars: 0 });
      }
      // değişen görseller
      const imgs = [];
      const imgKeys = new Set(diffs.filter((d) => d.kind === 'img' && d.exists).map((d) => (MOUNT + '/' + d.rel).toLowerCase()));
      if (imgKeys.size)
        for (const im of doc.images) {
          if (imgs.length >= 4) break;
          if (taken.has(im) || inAdded(im) || !imgKeys.has(pathKey(im.currentSrc || im.src, doc))) continue;
          taken.add(im);
          imgs.push({ el: im, tag: 'img', fx: 'img', cats: [], role: 'Görsel', label: t('web.lbl.image', 'image'), texts: [], ph: null, chars: 0 });
        }

      const items = [...layers, ...edits, ...sty, ...imgs].sort(docOrder);
      const idx = new Map(items.map((x, i) => [x, i]));
      for (const it of items) {
        it.parent = it._pl && idx.has(it._pl) ? idx.get(it._pl) : -1;
        it.sec = -1;
        it.revealP = new Promise((res) => (it.resolveReveal = res));
        it.doneP = new Promise((res) => (it.resolveDone = res));
      }
      plan = { layers: items, sections: [], doc, win, doneCount: 0, code: false, base: S.built };

      // yer değiştirmeden önce: yeni öğeler gizli, değişen metin/stil eski hâlinde
      if (layers.length) {
        st = doc.createElement('style');
        st.id = 'hs-build-style';
        st.textContent = BUILD_CSS;
        (doc.head || doc.documentElement).appendChild(st);
        for (const x of layers) x.el.setAttribute('data-hs-h', '');
      }
      for (const x of edits) if (x.old != null) x.texts[0].node.nodeValue = x.old;
      for (const x of sty) x.unpin = pinOld(x);
      swapTo(nb.frame);
      swapped = true;
      run = r;
      if (isFast(S)) r.skipped = true; // yüklenirken sekme değişti ya da X'e basıldı
      syncUi();

      const n = items.length;
      S.total = S.built + n;
      agents.progress?.(S.built, S.total, unitLayer());
      const typeCost = (c) => Math.min(c, SLOW_CHARS) * 32 + Math.ceil(Math.max(0, c - SLOW_CHARS) / CHUNK) * 32;
      const sum = items.reduce((a, x) => a + (x.fx ? 1500 : 900 + (x.chars ? typeCost(x.chars) : x.kind === 'media' || x.kind === '3d' ? 450 : 160)), 0);
      const P = Math.max(1, Math.min(S.count, n <= 4 ? 2 : n <= 25 ? 3 : n <= 80 ? 4 : 5));
      r.k = clamp((clamp(2500 + n * 260, 2500, 30000) * P) / Math.max(1, sum), 0.25, 1.2);

      codeP = code ? typeCode(r, code.n, tok) : null;
      const quiet = diffs.filter(
        (d) =>
          d.kind === 'js' ||
          d.kind === 'other' ||
          (d.kind === 'css' && !sty.length) ||
          (d.kind === 'img' && !imgs.length) ||
          (d.kind === 'html' && (d.rel.toLowerCase() !== entryKey || (!n && !df.removed.length)))
      );
      const corner = cornerJobs(r, quiet);
      await removedJob(r, df.removed);
      let next = 0;
      const worker = async () => {
        while (!r.skipped) {
          const i = next++;
          if (i >= n) break;
          if (items[i].fx) await runFx(r, plan, i);
          else await buildLayer(r, plan, i);
        }
      };
      await Promise.all(Array.from({ length: P }, worker));
      await Promise.all([corner, r.scrollQ]);
    } finally {
      for (const x of sty) x.unpin?.();
      if (plan) finalize(r, plan, st);
      else st?.remove();
      for (const x of r.chips) x.remove();
      r.chips.clear();
      for (const x of edits) for (const tx of x.texts) if (tx.node.nodeValue !== tx.text) tx.node.nodeValue = tx.text;
      if (nb && !swapped) swapTo(nb.frame);
      if (plan) {
        S.built += plan.layers.length;
        S.total = Math.max(S.total, S.built);
        if (ownsHud()) agents.progress?.(S.built, S.total, unitLayer());
      }
      if (run === r) run = null;
      r.finish();
      syncUi();
      if (codeP) {
        await Promise.race([codeP, sleep(2500)]);
        endCode(r, tok); // zincir sıralı: sonraki grup başlamadan eski döngü durur
      }
      await recStop(S);
      if (!fast) restSoon(S);
    }
  }

  // ---- bitiş

  async function stopLive({ tour = true, fast = false } = {}) {
    const S = L;
    if (!S) return { video: null, changes: 0, files: [] };
    if (S.stopP) {
      if (fast && run) skip(run);
      return S.stopP;
    }
    S.stopping = true;
    S.stopP = (async () => {
      const res = { video: null, changes: 0, files: [] };
      // Başlatma sürüyorsa önce bitsin: izleyici, hs-webrec ve onTop ancak o zaman eksiksiz kapatılabilir.
      if (S.startP) await S.startP.catch(() => {});
      if (L !== S) return res; // başlatma başarısız oldu ve kendi temizliğini yaptı
      try {
        syncUi();
        clearTimeout(S.idleT);
        clearTimeout(S.restT);
        stopCircle(S);
        const id = S.watchId;
        S.watchId = null;
        await platform.unwatchDir(id);
        clearTimeout(S.debT);
        for (const [k, v] of S.incoming) S.pending.set(k, v);
        S.incoming.clear();
        if (fast) {
          S.fast = true;
          if (run) skip(run);
        }
        await pump(); // kuyruktaki son değişiklik de işlenir
        if (S.chain) await S.chain;
        if (S.waiting) hideWaiting(S);
        const visible = active || !!S.rec;
        if (tour && S.loaded && visible && frameDoc()?.body) {
          if (ownsHud() && agents.active) await agents.stop?.({ keep: true });
          S.fast = false; // son tur her durumda kayda girer
          await recStart(S);
          try {
            await runTour();
          } finally {
            await recStop(S, 600);
          }
        }
        if (ownsHud() && agents.active) await agents.stop?.({ keep: true });
        if (hudOpen) closeHud();
        endRecUi(S);
        if (S.rec?.parts.length) {
          busy.show?.(t('web.live.merging', 'Merging live video…'));
          try {
            res.video = await finishVideo(S);
          } catch (e) {
            console.error(e);
            toast(t('web.live.mergeFail', 'Could not merge live video: {msg}', { msg: e?.message || e }), 6000);
          } finally {
            busy.hide?.();
          }
        }
      } catch (e) {
        reportLive(e);
      } finally {
        if (S.rec?.cur) {
          await S.rec.cur.rec.stop().catch(() => {});
          S.rec.cur = null;
        }
        endRecUi(S);
        clearTimeout(S.noteT);
        clearLiveUi();
        if (L === S) L = null;
        res.changes = S.changes;
        res.files = [...S.files];
        syncUi();
        fit();
        if (!S.loaded) el.empty.hidden = false;
        if (!active) {
          if (hudOpen) closeHud();
          unloadFrame();
        }
        toast(res.video ? t('web.live.saved', 'Live video saved: {name}', { name: baseName(res.video) }) : t('web.live.ended', 'Live mode ended ({n} changes).', { n: res.changes }), 5000);
        const cb = liveApi.onEnd;
        if (typeof cb === 'function') {
          try {
            cb(res);
          } catch (e) {
            console.error(e);
          }
        }
      }
      return res;
    })();
    return S.stopP;
  }

  // ---------------------------------------------------------------- mod yaşam döngüsü

  function unloadFrame() {
    if (!site || unloaded) return;
    el.frame.src = 'about:blank'; // pasifken sitenin kendi döngüleri de dursun
    unloaded = true;
    insp?.frameChanged();
  }

  async function activate() {
    active = true;
    fit();
    if (examplePath === null) {
      examplePath = (await findExample().catch(() => null)) || false;
      el.example.hidden = !examplePath;
    }
    if (L) {
      // Canlı oturum sekme dışındayken biriken değişiklikler şimdi oynatılır.
      if (L.waiting && !L.stopping) startCircle(L);
      pump();
      return;
    }
    if (site && unloaded) {
      showSite();
      return;
    }
    if (!site && !triedLast && platform.isNative()) {
      triedLast = true;
      const last = store.get('web_site');
      if (last?.dir && (await platform.exists(platform.join(last.dir, last.entry || 'index.html')))) {
        if (active && !site) loadSite(last.dir, last.entry || 'index.html').catch(() => {});
      }
    }
  }

  function deactivate() {
    active = false;
    insp?.deactivate(); // bekleyen düzenleme yazılır, iframe dinleyicileri kalkar
    if (recording) return; // kayıt sürerken sahne kalır
    if (L) {
      // Canlı mod sürüyor: iframe ve izleyici kalır; yalnızca animasyon/HUD durur (değişiklikler birikir).
      if (L.rec) return;
      stopCircle(L);
      if (run) skip(run);
      if (tourRun) tourRun.stop = true;
      if (hudOpen) closeHud();
      return;
    }
    if (run) skip(run);
    if (tourRun) tourRun.stop = true;
    if (hudOpen) closeHud();
    if (run) run.done.then(() => !active && unloadFrame());
    else unloadFrame();
  }

  return {
    activate,
    deactivate,
    eco() {},
    api: {
      loadSite,
      build,
      record,
      live: liveApi,
      skip: () => skip(run),
      tour: () => runTour(),
      site: () => (site ? { ...site } : null),
      /** Önizleme boyutu: 'fit' | 'phone' | 'tablet' | 'desktop' (verilmezse geçerli değeri döner). */
      device: (d) => (d ? setDevice(d) : device),
      reloadPreview: () => reloadPreview(),
      inspector: { toggle: (on) => insp.toggle(on), undo: () => insp.undo(), get on() {
        return insp.on;
      } },
      el: { stage: () => el.stage, frame: () => el.frame },
    },
  };
}
