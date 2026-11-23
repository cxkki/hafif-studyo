// Ajan katmanı: renkli imleçler, seçim kutuları, sürükleme kartları, HUD, kod paneli.
// Tüm imleç/kutu çizimleri TEK bir tam pencere <canvas> üzerinde; HUD/rozet/kod paneli az güncellenen DOM.
// Döngü yalnızca bir şey hareket ederken döner; katman kapalıyken hiçbir zamanlayıcı/rAF yoktur.
import { clamp, esc } from './util.js';
import { t } from './i18n.js';

const NAMES = ['Düzen', 'Metin', '3D', 'Ses', 'Renk', 'Kamera', 'Işık', 'Zaman', 'Efekt', 'Yazı',
  'Kurgu', 'Stil', 'Font', 'Görsel', 'Kod', 'Hiza', 'Geçiş', 'Ölçek', 'Malzeme', 'Render'];
const COLORS = ['#3b82f6', '#f43f5e', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#facc15', '#ec4899', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6', '#ef4444', '#0ea5e9', '#d946ef', '#4ade80', '#fb923c', '#818cf8', '#2dd4bf', '#e879f9'];
const FACTOR = { '1x': 1, '2x': 2, '5x': 5, instant: Infinity };
const ORDER = ['1x', '2x', '5x', 'instant'];
const speedLabel = (v) => (v === 'instant' ? t('agents.speed.instant', 'Instant') : v);
const SEL = '#3b82f6';
const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
// Klasik ok imleci; uç (0,0).
const ARROW = 'M0 0 L0 18 L4.6 13.6 L7.7 20.6 L10.9 19.2 L7.9 12.4 L14 12.4 Z';
const SPR_PAD = 7;
const PILL_X = 12;
const PILL_Y = 18;
const PILL_H = 20;

const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const isEl = (t) => !!t && typeof t.getBoundingClientRect === 'function';

function normSpeed(s) {
  if (s == null) return null;
  const v = String(s).trim().toLowerCase();
  if (v === 'instant' || v === 'anında' || v === 'aninda' || v === '0' || v === 'max') return 'instant';
  const m = v.match(/^(\d+)\s*x?$/);
  if (m) return m[1] >= 5 ? '5x' : m[1] >= 2 ? '2x' : '1x';
  return FACTOR[v] ? v : null;
}

function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#111827' : '#fff';
}

function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

let _mctx = null;
function measure(text, font) {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d');
  _mctx.font = font;
  return _mctx.measureText(text).width;
}

/** Elemanın ana belgedeki client dikdörtgeni (aynı kökenli iframe içindeyse çerçeve ofseti/ölçeği eklenir). */
function elRect(el) {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  let w = r.width;
  let h = r.height;
  try {
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fe = win.frameElement;
      const fr = fe.getBoundingClientRect();
      const s = fe.offsetWidth ? fr.width / fe.offsetWidth : 1;
      x = fr.left + (fe.clientLeft + x) * s;
      y = fr.top + (fe.clientTop + y) * s;
      w *= s;
      h *= s;
      win = fe.ownerDocument.defaultView;
    }
  } catch {}
  return { x, y, w, h };
}

function targetRect(t) {
  if (!t) return null;
  if (isEl(t)) {
    if (t.isConnected === false) return null;
    const r = elRect(t);
    return r.w || r.h || r.x || r.y ? r : null;
  }
  if (typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y, w: t.w || 0, h: t.h || 0 };
  return null;
}

function fire(el, type) {
  const W = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  el.dispatchEvent(new W.Event(type, { bubbles: true }));
}

/** Eleman kaydırılabilir bir kabın dışında kalıyorsa sadece o kabı kaydırır (sayfayı/overflow:hidden'ı oynatmaz). */
function ensureVisible(el) {
  if (!isEl(el)) return;
  try {
    const W = el.ownerDocument.defaultView;
    const body = el.ownerDocument.body;
    let p = el.parentElement;
    while (p && p !== body) {
      const cs = W.getComputedStyle(p);
      const sy = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
      const sx = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
      if (sy || sx) {
        const r = el.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        if (sy) {
          if (r.top < pr.top) p.scrollTop -= pr.top - r.top + 10;
          else if (r.bottom > pr.bottom) p.scrollTop += Math.min(r.top - pr.top - 10, r.bottom - pr.bottom + 10);
        }
        if (sx) {
          if (r.left < pr.left) p.scrollLeft -= pr.left - r.left + 10;
          else if (r.right > pr.right) p.scrollLeft += Math.min(r.left - pr.left - 10, r.right - pr.right + 10);
        }
      }
      p = p.parentElement;
    }
  } catch {}
}

// ---------------------------------------------------------------- durum
const S = {
  active: false,
  shown: false,
  gen: 0,
  speed: '1x',
  mode: 'web',
  title: '',
  total: 0,
  done: 0,
  unit: '',
  list: [],
  rr: 0,
  bounds: null,
  B: { x: 0, y: 0, w: 1, h: 1 },
  dpr: 1,
  W: 0,
  H: 0,
  canvas: null,
  ctx: null,
  ui: [],
  hud: null,
  badge: null,
  code: null,
  codeBody: null,
  codeCount: null,
  lines: [],
  toks: [],
  lineEls: [],
  codeActive: -1,
  codeTyping: null,
  rings: [],
  sels: [],
  raf: 0,
  idleT: 0,
  lastDraw: 0,
  parking: false,
  ro: null,
  onTour: null,
  onClose: null,
  arrow: null,
};
const waits = new Set();

const factor = () => FACTOR[S.speed] || 1;
const isInstant = () => S.speed === 'instant';
/** Çizim yapılıyor mu (katman açık ve anında değil). */
const live = () => S.active && S.shown && !isInstant();
const dur = (ms) => (isInstant() ? 0 : Math.max(0, ms) / factor());

function wait(ms) {
  if (!(ms > 0) || !live()) return Promise.resolve();
  return new Promise((res) => {
    const w = { res, t: 0 };
    w.t = setTimeout(() => {
      waits.delete(w);
      res();
    }, ms);
    waits.add(w);
  });
}
function flushWaits() {
  for (const w of waits) {
    clearTimeout(w.t);
    w.res();
  }
  waits.clear();
}

function makeAgent(i) {
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (Math.floor(i / NAMES.length) + 1) : '');
  return {
    id: i + 1,
    name,
    color: COLORS[i % COLORS.length],
    x: 0,
    y: 0,
    _ops: 0,
    _move: null,
    _idleAt: 0,
    _alpha: 1,
    _press: 0,
    _pressA: null,
    _busy: null,
    _ghost: null,
    _spr: null,
  };
}

// ---------------------------------------------------------------- sprite (imleç + isim hapı, bir kez çizilir)
function sprite(a) {
  if (a._spr && a._spr.dpr === S.dpr) return a._spr;
  const dpr = S.dpr;
  const font = `600 11.5px ${FONT}`;
  const pw = Math.ceil(measure(a.name, font) + 17);
  const w = SPR_PAD * 2 + Math.max(15, PILL_X + pw);
  const h = SPR_PAD * 2 + PILL_Y + PILL_H + 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.translate(SPR_PAD, SPR_PAD);
  // isim hapı
  g.save();
  g.shadowColor = 'rgba(0,0,0,.38)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  rr(g, PILL_X, PILL_Y, pw, PILL_H, PILL_H / 2);
  g.fillStyle = a.color;
  g.fill();
  g.restore();
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255,255,255,.55)';
  rr(g, PILL_X + 0.5, PILL_Y + 0.5, pw - 1, PILL_H - 1, (PILL_H - 1) / 2);
  g.stroke();
  g.fillStyle = inkOn(a.color);
  g.font = font;
  g.textBaseline = 'middle';
  g.fillText(a.name, PILL_X + 8.5, PILL_Y + PILL_H / 2 + 0.5);
  // ok
  const p = S.arrow || (S.arrow = new Path2D(ARROW));
  g.save();
  g.shadowColor = 'rgba(0,0,0,.42)';
  g.shadowBlur = 5;
  g.shadowOffsetY = 1.5;
  g.fillStyle = a.color;
  g.fill(p);
  g.restore();
  g.lineJoin = 'round';
  g.lineWidth = 1.5;
  g.strokeStyle = '#fff';
  g.stroke(p);
  a._spr = { c, dpr, dw: c.width / dpr, dh: c.height / dpr, pw };
  return a._spr;
}

// ---------------------------------------------------------------- sınırlar
function resolveBounds() {
  const b = S.bounds;
  let r = null;
  if (isEl(b)) r = b.isConnected === false ? null : elRect(b);
  else if (b && b.w > 0 && b.h > 0) r = { x: +b.x || 0, y: +b.y || 0, w: +b.w, h: +b.h };
  if (!r || r.w < 40 || r.h < 40) r = { x: 0, y: 0, w: innerWidth, h: innerHeight };
  S.B = r;
}
function clampPt(x, y, m = 3) {
  const B = S.B;
  return {
    x: clamp(x, B.x + m, Math.max(B.x + m, B.x + B.w - m)),
    y: clamp(y, B.y + m, Math.max(B.y + m, B.y + B.h - m)),
  };
}
/** Boşta dolaşma bölgesi (kenarlar ve HUD şeridi hariç). */
function roam() {
  const B = S.B;
  const x0 = B.x + Math.min(40, B.w * 0.08);
  const y0 = B.y + Math.min(64, B.h * 0.12);
  const x1 = Math.max(x0 + 1, B.x + B.w - Math.min(120, B.w * 0.25));
  const y1 = Math.max(y0 + 1, B.y + B.h - Math.min(96, B.h * 0.18));
  return { x0, y0, x1, y1 };
}
function origin() {
  const B = S.B;
  return { x: B.x + B.w / 2, y: B.y + B.h - 36 };
}

// ---------------------------------------------------------------- hareket
function startMove(a, x, y, ms, o = {}) {
  const old = a._move;
  if (old) {
    clearTimeout(old.timer);
    a._move = null;
    // Yarıda kesilen belirme/sönme hareketi görünürlüğü ara değerde bırakmasın.
    if (old.fade === 'in' && o.fade !== 'out') a._alpha = 1;
    if (old.fade === 'out' && o.fade !== 'in') a._alpha = 0;
    old.res();
  }
  if (!o.soft && a._busy) a._busy = null;
  const p = o.free ? { x, y } : clampPt(x, y);
  if (!(ms > 0) || !S.canvas) {
    a.x = p.x;
    a.y = p.y;
    if (o.fade === 'in') a._alpha = 1;
    if (o.fade === 'out') a._alpha = 0;
    kick();
    return Promise.resolve();
  }
  const dx = p.x - a.x;
  const dy = p.y - a.y;
  const d = Math.hypot(dx, dy);
  let cx = (a.x + p.x) / 2;
  let cy = (a.y + p.y) / 2;
  if (!o.straight && d > 30) {
    const k = Math.min(d * 0.14, 70) * (Math.random() < 0.5 ? -1 : 1);
    cx += (-dy / d) * k;
    cy += (dx / d) * k;
  }
  const delay = o.delay || 0;
  return new Promise((res) => {
    const m = { x0: a.x, y0: a.y, cx, cy, x1: p.x, y1: p.y, t0: now() + delay, ms, res, soft: !!o.soft, fade: o.fade || null };
    // rAF durursa (pencere gizli) söz asılı kalmasın.
    m.timer = setTimeout(() => a._move === m && finishMove(a), ms + delay + 400);
    a._move = m;
    kick();
  });
}
function finishMove(a) {
  const m = a._move;
  if (!m) return;
  clearTimeout(m.timer);
  a._move = null;
  a.x = m.x1;
  a.y = m.y1;
  if (m.fade === 'in') a._alpha = 1;
  if (m.fade === 'out') a._alpha = 0;
  m.res();
}
function finishAll() {
  for (const a of S.list) {
    finishMove(a);
    a._busy = null;
    a._pressA = null;
    a._press = 0;
  }
  flushWaits();
}

function goTo(a, target, o = {}) {
  const r = targetRect(target);
  if (!r) return Promise.resolve();
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  if (!live()) {
    const p = clampPt(x, y);
    a.x = p.x;
    a.y = p.y;
    return Promise.resolve();
  }
  const d = Math.hypot(x - a.x, y - a.y);
  const ms = o.dur != null ? dur(o.dur) : dur(clamp(240 + d * 0.7, 280, 1050) * (o.mult || 1));
  return startMove(a, x, y, ms, o);
}

function press(a, v) {
  if (!live()) {
    a._press = 0;
    a._pressA = null;
    return;
  }
  a._pressA = { from: a._press, to: v, t0: now(), ms: 90 };
  kick();
}
function ring(a) {
  if (!live()) return;
  S.rings.push({ x: a.x, y: a.y, c: a.color, t0: now() });
  if (S.rings.length > 40) S.rings.shift();
  kick();
}
function beginOp(a) {
  a._ops++;
}
function endOp(a) {
  a._ops = Math.max(0, a._ops - 1);
  if (!a._ops) a._idleAt = now() + rand(1500, 4000);
  kick();
}

function startDrift(a) {
  const R = roam();
  const tx = clamp(a.x + rand(-120, 120), R.x0, R.x1);
  const ty = clamp(a.y + rand(-90, 90), R.y0, R.y1);
  const d = Math.hypot(tx - a.x, ty - a.y);
  startMove(a, tx, ty, clamp(700 + d * 6, 1000, 2000) / Math.sqrt(factor()), { soft: true });
  a._idleAt = now() + rand(1500, 4000) + 1200;
}

// ---------------------------------------------------------------- döngü
// Tek rAF zinciri: S.raf doluysa (bekleyen kare var) kick() yenisini açmaz. frame() başta
// S.raf=0 yapar; kare içinde kick() (ör. startDrift→startMove) sonraki kareyi planlarsa kare
// sonu onu yeniden kullanır, ikinci istek açmaz. Boşta yalnızca tek zamanlayıcı (S.idleT) bekler.
function kick() {
  if (!S.canvas) return;
  if (S.idleT) {
    clearTimeout(S.idleT);
    S.idleT = 0;
  }
  if (!S.raf) S.raf = requestAnimationFrame(frame);
}

function frame() {
  S.raf = 0;
  if (!S.canvas) return;
  const t = now();
  let hot = false;
  let warm = false;
  let nextIdle = Infinity;
  const ambient = S.active && !isInstant() && !S.parking;
  for (const a of S.list) {
    const m = a._move;
    if (m) {
      let p = (t - m.t0) / m.ms;
      if (p >= 1) finishMove(a);
      else {
        if (p < 0) p = 0;
        const e = ease(p);
        const u = 1 - e;
        a.x = u * u * m.x0 + 2 * u * e * m.cx + e * e * m.x1;
        a.y = u * u * m.y0 + 2 * u * e * m.cy + e * e * m.y1;
        if (m.fade === 'in') a._alpha = clamp(p * 2.5, 0, 1);
        else if (m.fade === 'out') a._alpha = 1 - clamp((p - 0.35) / 0.65, 0, 1);
        if (m.soft) warm = true;
        else hot = true;
      }
    }
    if (a._pressA) {
      const q = a._pressA;
      const p = clamp((t - q.t0) / q.ms, 0, 1);
      a._press = q.from + (q.to - q.from) * easeOut(p);
      if (p >= 1) a._pressA = null;
      hot = true;
    }
    if (a._busy) hot = true;
    if (ambient && !a._ops && !a._move) {
      if (t >= a._idleAt) {
        startDrift(a);
        warm = true;
      } else nextIdle = Math.min(nextIdle, a._idleAt);
    }
  }
  if (S.rings.length) {
    S.rings = S.rings.filter((r) => t - r.t0 < 480);
    if (S.rings.length) hot = true;
  }
  if (S.sels.length) {
    S.sels = S.sels.filter((s) => !(s.fadeT0 && t - s.fadeT0 > 260));
    for (const s of S.sels) if (s.fadeT0 || t - s.t0 < 200) hot = true;
  }
  if (hot || warm) {
    // Sadece boşta süzülme varsa ~30 fps yeter.
    if (hot || t - S.lastDraw > 30) {
      draw(t);
      S.lastDraw = t;
    }
    if (!S.raf) S.raf = requestAnimationFrame(frame);
  } else {
    draw(t);
    S.lastDraw = t;
    if (S.idleT) {
      clearTimeout(S.idleT);
      S.idleT = 0;
    }
    // Kare içinde kick() zaten bir kare planladıysa zamanlayıcıya gerek yok.
    if (!S.raf && nextIdle < Infinity) S.idleT = setTimeout(kick, Math.max(16, nextIdle - t));
  }
}

function draw(t) {
  const g = S.ctx;
  g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  g.clearRect(0, 0, S.W, S.H);
  for (const s of S.sels) drawSel(g, s, t);
  for (const r of S.rings) drawRing(g, r, t);
  for (const a of S.list) if (a._alpha > 0.01) drawAgent(g, a, t);
  g.globalAlpha = 1;
}

function drawAgent(g, a, t) {
  const s = sprite(a);
  let x = a.x;
  let y = a.y;
  const b = a._busy;
  if (b && b.jit) {
    const k = (t - b.t0) / 1000;
    x += Math.sin(k * 5.3) * 6 + Math.sin(k * 11.7) * 1.5;
    y += Math.sin(k * 7.1) * 4;
  }
  const dpr = S.dpr;
  x = Math.round(x * dpr) / dpr;
  y = Math.round(y * dpr) / dpr;
  g.globalAlpha = a._alpha;
  if (a._ghost) drawGhost(g, a, x, y);
  const k = 1 - 0.17 * a._press;
  if (k !== 1) {
    g.save();
    g.translate(x, y);
    g.scale(k, k);
    g.drawImage(s.c, -SPR_PAD, -SPR_PAD, s.dw, s.dh);
    g.restore();
  } else g.drawImage(s.c, x - SPR_PAD, y - SPR_PAD, s.dw, s.dh);
  if (b) {
    // küçük "çalışıyor" yayı, hapın sağında
    const cx = x + PILL_X + s.pw + 10;
    const cy = y + PILL_Y + PILL_H / 2;
    const ang = t / 140;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.beginPath();
    g.arc(cx, cy + 0.6, 5, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = a.color;
    g.beginPath();
    g.arc(cx, cy, 5, ang, ang + Math.PI * 1.3);
    g.stroke();
    g.lineCap = 'butt';
  }
}

function drawGhost(g, a, x, y) {
  const gh = a._ghost;
  g.save();
  g.translate(x - 16, y - 14);
  g.rotate(-0.04);
  const al = g.globalAlpha;
  g.globalAlpha = al * 0.94;
  g.shadowColor = 'rgba(0,0,0,.45)';
  g.shadowBlur = 16;
  g.shadowOffsetY = 6;
  rr(g, 0, 0, gh.w, 32, 8);
  g.fillStyle = 'rgba(24,27,33,.86)';
  g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = 1.5;
  g.strokeStyle = a.color;
  g.stroke();
  g.fillStyle = a.color;
  g.beginPath();
  g.arc(13, 16, 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `600 12px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(gh.label, 24, 16.5);
  g.restore();
  g.globalAlpha = al;
}

function drawRing(g, r, t) {
  const p = clamp((t - r.t0) / 480, 0, 1);
  const e = easeOut(p);
  g.globalAlpha = 1 - p;
  g.lineWidth = 2.5 * (1 - p) + 0.6;
  g.strokeStyle = r.c;
  g.beginPath();
  g.arc(r.x, r.y, 4 + 24 * e, 0, Math.PI * 2);
  g.stroke();
  if (p < 0.4) {
    g.globalAlpha = 0.35 * (1 - p / 0.4);
    g.fillStyle = r.c;
    g.beginPath();
    g.arc(r.x, r.y, 4 + 10 * e, 0, Math.PI * 2);
    g.fill();
  }
}

function selLabel(s) {
  s.text = s.label != null && s.label !== '' ? String(s.label) : `${Math.round(s.r.w)} × ${Math.round(s.r.h)}`;
  if (s.text.length > 40) s.text = s.text.slice(0, 39) + '…';
  s.tw = measure(s.text, `600 11px ${FONT}`);
}

function drawSel(g, s, t) {
  const e = easeOut(clamp((t - s.t0) / 180, 0, 1));
  let alpha = e;
  if (s.fadeT0) alpha *= 1 - clamp((t - s.fadeT0) / 260, 0, 1);
  if (alpha <= 0.01) return;
  const sc = 0.95 + 0.05 * e;
  const w = s.r.w * sc;
  const h = s.r.h * sc;
  const x = s.r.x + (s.r.w - w) / 2;
  const y = s.r.y + (s.r.h - h) / 2;
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(59,130,246,.07)';
  g.fillRect(x, y, w, h);
  g.lineWidth = 1.5;
  g.strokeStyle = SEL;
  g.strokeRect(x, y, w, h);
  g.fillStyle = '#fff';
  g.lineWidth = 1.2;
  for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    g.fillRect(hx - 3.5, hy - 3.5, 7, 7);
    g.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
  }
  // boyut rozeti
  const B = S.B;
  const bw = s.tw + 16;
  const bh = 19;
  let by = y + h + 8;
  if (by + bh > B.y + B.h - 2) by = y - bh - 8;
  if (by < B.y + 2) by = y + h - bh - 6;
  const bx = clamp(x + w / 2 - bw / 2, B.x + 2, Math.max(B.x + 2, B.x + B.w - bw - 2));
  rr(g, bx, by, bw, bh, bh / 2);
  g.fillStyle = SEL;
  g.fill();
  g.fillStyle = '#fff';
  g.font = `600 11px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(s.text, bx + 8, by + bh / 2 + 0.5);
}

// ---------------------------------------------------------------- DOM (canvas, HUD, rozet, kod paneli)
function sizeCanvas() {
  const c = S.canvas;
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (dpr !== S.dpr) for (const a of S.list) a._spr = null;
  S.dpr = dpr;
  S.W = innerWidth;
  S.H = innerHeight;
  c.width = Math.round(S.W * dpr);
  c.height = Math.round(S.H * dpr);
  c.style.width = S.W + 'px';
  c.style.height = S.H + 'px';
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function buildDom() {
  const c = el('canvas', 'ag-canvas');
  c.setAttribute('aria-hidden', 'true');
  S.canvas = c;
  S.ctx = c.getContext('2d');

  const n = S.list.length;
  const hud = el('div', 'ag-ui ag-hud ag-in');
  hud.innerHTML =
    `<div class="ag-dots">${S.list.slice(0, 8).map((a) => `<i style="background:${a.color}"></i>`).join('')}</div>` +
    `<div class="ag-txt"><b class="ag-cnt">${esc(t('agents.count', '{n} agents', { n }))}</b><span class="ag-sep">·</span><span class="ag-prog"></span></div>` +
    `<button type="button" class="ag-b ag-tour" title="${esc(t('agents.tourTitle', 'Tour the result'))}">${esc(t('agents.tour', 'Tour'))}</button>` +
    `<button type="button" class="ag-b ag-spd" title="${esc(t('agents.speed', 'Speed'))}">${esc(speedLabel(S.speed))}</button>` +
    `<button type="button" class="ag-x" title="${esc(t('agents.close', 'Close'))}" aria-label="${esc(t('agents.close', 'Close'))}">` +
    `<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>` +
    `<div class="ag-bar"><i></i></div>`;
  hud.querySelector('.ag-tour').onclick = () => S.onTour && S.onTour();
  hud.querySelector('.ag-spd').onclick = () => {
    const i = ORDER.indexOf(S.speed);
    agents.setSpeed(ORDER[(i + 1) % ORDER.length]);
  };
  hud.querySelector('.ag-x').onclick = () => {
    if (S.onClose) S.onClose();
    else agents.stop({ keep: false });
  };
  S.hud = hud;

  const av = S.list.slice(0, 6);
  const more = n - av.length;
  const badge = el('div', 'ag-ui ag-badge ag-in');
  badge.innerHTML =
    `<span class="ag-live"></span>` +
    `<b class="ag-bt">${esc(t('agents.active', '{n} agents active', { n }))}</b>` +
    `<span class="ag-av">${av
      .map((a) => `<i style="background:${a.color};color:${inkOn(a.color)}">${esc(a.name.charAt(0))}</i>`)
      .join('')}${more > 0 ? `<i class="ag-more">+${more}</i>` : ''}</span>` +
    `<span class="ag-title"></span>`;
  S.badge = badge;

  const code = el('div', 'ag-ui ag-code ag-in');
  code.innerHTML =
    `<div class="ag-code-h"><span class="ag-tl"><i></i><i></i><i></i></span><span class="ag-fn">tarif.json</span><span class="ag-cc"></span></div>` +
    `<div class="ag-code-b"></div>`;
  code.hidden = true;
  S.code = code;
  S.codeBody = code.querySelector('.ag-code-b');
  S.codeCount = code.querySelector('.ag-cc');

  S.ui = [hud, badge, code];
  document.body.append(hud, badge, code, c);
  updateTour();
  setTitle(S.title);
}

function setTitle(t) {
  if (!S.badge) return;
  const e = S.badge.querySelector('.ag-title');
  e.textContent = t || '';
  e.hidden = !t;
}

function updateTour() {
  const b = S.hud && S.hud.querySelector('.ag-tour');
  if (b) b.hidden = !S.onTour;
}

function layout() {
  const B = S.B;
  const cx = Math.round(B.x + B.w / 2);
  if (S.hud) {
    const s = S.hud.style;
    s.left = cx + 'px';
    s.top = Math.round(B.y + B.h - 14) + 'px';
    s.maxWidth = Math.max(160, B.w - 16) + 'px';
    S.hud.classList.toggle('narrow', B.w < 470);
  }
  if (S.badge) {
    const s = S.badge.style;
    s.left = cx + 'px';
    s.top = Math.round(B.y + 12) + 'px';
    s.maxWidth = Math.max(160, B.w - 16) + 'px';
    S.badge.classList.toggle('narrow', B.w < 470);
  }
  if (S.code) {
    // Dikey sahne: dar ve kısa panel, sağ altta HUD'un hemen üstüne oturur (sitenin üstünü kapatmaz).
    const tall = B.h > B.w * 1.2;
    S.code.classList.toggle('tall', tall);
    const s = S.code.style;
    if (tall) {
      const w = Math.round(Math.max(120, Math.min(220, B.w * 0.4, B.w - 24)));
      const maxH = Math.max(100, Math.min(B.h * 0.26, B.h - 60 - 78));
      const vh = document.documentElement.clientHeight || innerHeight;
      s.width = w + 'px';
      s.left = Math.round(B.x + B.w - 14 - w) + 'px';
      s.top = 'auto';
      s.bottom = Math.round(vh - (B.y + B.h - 78)) + 'px'; // alta sabit: satır eklenince yeniden konumlamaya gerek yok
      s.maxHeight = Math.round(maxH) + 'px';
    } else {
      const w = Math.round(Math.min(340, Math.max(200, B.w * 0.46), B.w - 24));
      const top = B.y + 60;
      const maxH = Math.max(120, Math.min(B.h * 0.7, B.h - 60 - 78));
      s.width = w + 'px';
      s.left = Math.round(B.x + B.w - 14 - w) + 'px';
      s.top = Math.round(top) + 'px';
      s.bottom = '';
      s.maxHeight = Math.round(maxH) + 'px';
    }
  }
}

function onResize() {
  if (!S.shown) return;
  sizeCanvas();
  resolveBounds();
  layout();
  for (const s of S.sels) {
    if (isEl(s.target)) {
      const r = targetRect(s.target);
      if (r) s.r = r;
    }
  }
  for (const a of S.list) {
    if (!a._move) {
      const p = clampPt(a.x, a.y);
      a.x = p.x;
      a.y = p.y;
    }
  }
  kick();
}

function observeBounds() {
  if (S.ro) {
    S.ro.disconnect();
    S.ro = null;
  }
  if (isEl(S.bounds) && typeof ResizeObserver !== 'undefined') {
    S.ro = new ResizeObserver(onResize);
    S.ro.observe(S.bounds);
  }
}

function renderProgress() {
  if (!S.hud) return;
  const n = S.list.length;
  const d = Math.round(S.done || 0);
  const txt = S.total > 0 ? `${d} / ${Math.round(S.total)} ${S.unit}` : `${d} ${S.unit}`;
  const p = S.hud.querySelector('.ag-prog');
  if (p.textContent !== txt) p.textContent = txt;
  const c = S.hud.querySelector('.ag-cnt');
  const ct = t('agents.count', '{n} agents', { n });
  if (c.textContent !== ct) c.textContent = ct;
  const w = S.total > 0 ? clamp(S.done / S.total, 0, 1) * 100 : 0;
  S.hud.querySelector('.ag-bar i').style.width = w.toFixed(1) + '%';
}

function teardown() {
  S.gen++;
  S.active = false;
  S.shown = false;
  S.parking = false;
  finishAll();
  stopTyping();
  if (S.raf) cancelAnimationFrame(S.raf);
  if (S.idleT) clearTimeout(S.idleT);
  S.raf = 0;
  S.idleT = 0;
  if (S.ro) S.ro.disconnect();
  S.ro = null;
  removeEventListener('resize', onResize);
  for (const e of S.ui) e.remove();
  if (S.canvas) S.canvas.remove();
  S.ui = [];
  S.canvas = S.ctx = S.hud = S.badge = S.code = S.codeBody = S.codeCount = null;
  S.sels = [];
  S.rings = [];
  S.lines = [];
  S.toks = [];
  S.lineEls = [];
  S.codeActive = -1;
  // HUD gitti: önceki oturumun düğme geri çağrıları sonrakine sızmasın.
  S.onTour = null;
  S.onClose = null;
  for (const a of S.list) a._ghost = null;
}

// ---------------------------------------------------------------- kod paneli
const TOK = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],])/g;
function tokenize(line) {
  const out = [];
  let last = 0;
  let m;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(line))) {
    if (m.index > last) out.push(['', line.slice(last, m.index)]);
    if (m[1]) {
      out.push([m[2] ? 'k' : 's', m[1]]);
      if (m[2]) out.push(['p', m[2]]);
    } else if (m[3]) out.push(['n', m[3]]);
    else if (m[4]) out.push(['b', m[4]]);
    else out.push(['p', m[5]]);
    last = TOK.lastIndex;
  }
  if (last < line.length) out.push(['', line.slice(last)]);
  return out;
}
function tokHtml(toks, n = Infinity) {
  let html = '';
  let left = n;
  for (const [c, txt] of toks) {
    if (left <= 0) break;
    const part = txt.length <= left ? txt : txt.slice(0, left);
    left -= part.length;
    html += c ? `<span class="ag-j${c}">${esc(part)}</span>` : esc(part);
  }
  return html;
}
function renderLine(i, n = Infinity) {
  const e = S.lineEls[i];
  if (!e) return;
  const caret = i === S.codeActive && S.active ? '<i class="ag-caret"></i>' : '';
  e.lastChild.innerHTML = tokHtml(S.toks[i], n) + caret;
}
function addLine(i) {
  const d = el('div', 'ag-ln');
  d.innerHTML = `<span class="ag-n">${i + 1}</span><span class="ag-t"></span>`;
  S.codeBody.appendChild(d);
  S.lineEls[i] = d;
  return d;
}
function scrollToLine(d) {
  const b = S.codeBody;
  const top = d.offsetTop;
  const h = d.offsetHeight;
  if (top + h > b.scrollTop + b.clientHeight - 10) b.scrollTop = top + h - b.clientHeight + 10 + h * 2;
  else if (top < b.scrollTop + 4) b.scrollTop = Math.max(0, top - 8);
}
function stopTyping() {
  const ty = S.codeTyping;
  if (!ty) return;
  S.codeTyping = null;
  ty.cancel = true;
  renderLine(ty.i);
  ty.res();
}

async function typeLine(i) {
  const total = S.lines[i].length;
  const lead = S.lines[i].match(/^\s*/)[0].length;
  let ty;
  const p = new Promise((res) => (ty = { i, cancel: false, res }));
  S.codeTyping = ty;
  let n = lead;
  renderLine(i, n);
  while (n < total) {
    const f = factor();
    if (!live() || ty.cancel) break;
    await wait(30);
    if (ty.cancel) return p;
    n = Math.min(total, n + Math.max(1, Math.round((30 * f) / 15)));
    renderLine(i, n);
  }
  if (S.codeTyping === ty) {
    S.codeTyping = null;
    renderLine(i);
    ty.res();
  }
  return p;
}

// ---------------------------------------------------------------- dışa açık nesne
export const agents = {
  /** Katmanı açar. */
  start(opts = {}) {
    const { count = 12, mode = 'web', title = '', total = 0, speed, code, bounds } = opts;
    if (S.shown) teardown();
    // Geri çağrılar oturuma özel; çağıran kendi onTour/onClose'unu start()'tan sonra atar.
    S.onTour = null;
    S.onClose = null;
    S.gen++;
    S.mode = mode || 'web';
    S.title = title || '';
    S.total = +total || 0;
    S.done = 0;
    S.unit = S.mode === 'web' ? t('agents.unit.layer', 'layers') : t('agents.unit.step', 'steps');
    const sp = normSpeed(speed);
    if (sp) S.speed = sp;
    S.bounds = bounds || null;
    S.list = Array.from({ length: clamp(count | 0 || 12, 1, 40) }, (_, i) => makeAgent(i));
    S.rr = 0;
    S.rings = [];
    S.sels = [];
    buildDom();
    sizeCanvas();
    resolveBounds();
    layout();
    S.active = true;
    S.shown = true;
    agents.setCode(code || '');
    renderProgress();
    addEventListener('resize', onResize);
    observeBounds();
    // ajanlar HUD'dan çıkıp sahneye dağılır
    const o = origin();
    const R = roam();
    const tNow = now();
    S.list.forEach((a, i) => {
      const tx = rand(R.x0, R.x1);
      const ty = rand(R.y0, R.y1);
      a._idleAt = tNow + rand(1200, 3500) + i * 45;
      if (isInstant()) {
        a.x = tx;
        a.y = ty;
        a._alpha = 1;
      } else {
        a.x = o.x;
        a.y = o.y;
        a._alpha = 0;
        startMove(a, tx, ty, rand(750, 1150), { soft: true, delay: i * 45, fade: 'in' });
      }
    });
    kick();
  },

  /** Ajanlar HUD'a çekilip söner; döngü durur. keep=true ise HUD/rozet/kod paneli ekranda kalır. */
  stop({ keep = false } = {}) {
    if (!S.shown) return Promise.resolve();
    const gen = S.gen;
    const wasLive = live();
    S.active = false;
    finishAll();
    stopTyping();
    for (const s of S.sels) if (!s.fadeT0) s.fadeT0 = now();
    for (const a of S.list) a._ghost = null;
    if (S.badge) {
      S.badge.classList.add('done');
      S.badge.querySelector('.ag-bt').textContent = t('agents.done', '{n} agents · done', { n: S.list.length });
    }
    if (S.codeActive >= 0) renderLine(S.codeActive); // imleci kaldır
    const finalize = () => {
      if (gen !== S.gen) return;
      S.parking = false;
      if (keep) {
        if (S.raf) cancelAnimationFrame(S.raf);
        if (S.idleT) clearTimeout(S.idleT);
        S.raf = S.idleT = 0;
        S.sels = [];
        S.rings = [];
        if (S.ctx) S.ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);
        if (S.canvas) S.canvas.remove();
        S.canvas = S.ctx = null;
      } else teardown();
    };
    if (!wasLive || document.hidden) {
      finalize();
      return Promise.resolve();
    }
    S.parking = true;
    const o = origin();
    const k = 1 / Math.sqrt(factor());
    const ps = S.list.map((a, i) =>
      startMove(a, o.x + rand(-24, 24), o.y + rand(-4, 4), rand(420, 650) * k, { delay: i * 22 * k, fade: 'out' }),
    );
    kick();
    return Promise.all(ps).then(finalize);
  },

  /** HUD ilerlemesi: "20 ajan · 168 / 351 katman". */
  progress(done, total, label) {
    S.done = +done || 0;
    if (total != null) S.total = +total || 0;
    if (label) S.unit = String(label);
    renderProgress();
  },

  /** Sıradaki ajan; role bir isimle eşleşirse o (büyük/küçük harf duyarsız, içerir). */
  pick(role) {
    if (!S.list.length) S.list = Array.from({ length: 12 }, (_, i) => makeAgent(i));
    if (role) {
      const q = String(role).toLocaleLowerCase('tr');
      const f =
        S.list.find((a) => a.name.toLocaleLowerCase('tr') === q) ||
        S.list.find((a) => {
          const n = a.name.toLocaleLowerCase('tr');
          return n.includes(q) || q.includes(n);
        });
      if (f) return f;
    }
    const L = S.list;
    for (let k = 0; k < L.length; k++) {
      const a = L[(S.rr + k) % L.length];
      if (!a._ops) {
        S.rr = (S.rr + k + 1) % L.length;
        return a;
      }
    }
    const a = L[S.rr % L.length];
    S.rr = (S.rr + 1) % L.length;
    return a;
  },

  /** Hedefin merkezine yumuşak hareket. */
  async moveTo(agent, target, o = {}) {
    const a = agent || agents.pick();
    beginOp(a);
    try {
      await goTo(a, target, o);
    } finally {
      endOp(a);
    }
  },

  /** Gider, imleç küçülür + halka; real ise el.click(). */
  async click(agent, target, { real = true } = {}) {
    const a = agent || agents.pick();
    const elx = isEl(target) ? target : null;
    beginOp(a);
    try {
      if (elx) ensureVisible(elx);
      if (live()) {
        await goTo(a, target);
        press(a, 1);
        ring(a);
        await wait(dur(85));
        if (real && elx) elx.click();
        press(a, 0);
        await wait(dur(140));
      } else {
        if (targetRect(target)) await goTo(a, target);
        if (real && elx) elx.click();
      }
    } finally {
      endOp(a);
    }
  },

  /** Mavi seçim kutusu + köşe tutamaçları + boyut rozeti. */
  select(agent, target, { label, hold } = {}) {
    const noop = { update() {}, done() {}, remove() {} };
    if (!live()) return noop;
    const r = targetRect(target);
    if (!r) return noop;
    const s = { r, target, label, t0: now(), fadeT0: 0, text: '', tw: 0 };
    selLabel(s);
    S.sels.push(s);
    // aşırı birikmeyi önle
    let live_ = 0;
    for (let k = S.sels.length - 1; k >= 0; k--) if (!S.sels[k].fadeT0 && ++live_ > 30) S.sels[k].fadeT0 = now();
    kick();
    let timer = 0;
    const h = {
      update(t) {
        const nr = targetRect(t != null ? t : s.target);
        if (!nr) return;
        if (t != null) s.target = t;
        s.r = nr;
        selLabel(s);
        kick();
      },
      done() {
        clearTimeout(timer);
        if (!s.fadeT0) s.fadeT0 = now();
        kick();
      },
      remove() {
        clearTimeout(timer);
        const i = S.sels.indexOf(s);
        if (i >= 0) S.sels.splice(i, 1);
        kick();
      },
    };
    if (hold > 0) timer = setTimeout(h.done, Math.max(150, dur(hold)));
    return h;
  },

  /** Form alanına harf harf yazar; her harfte input, sonda change. */
  async typeInto(agent, field, text) {
    if (!field) return;
    const a = agent || agents.pick();
    text = String(text == null ? '' : text);
    beginOp(a);
    try {
      ensureVisible(field);
      if (live()) {
        await goTo(a, field);
        press(a, 1);
        ring(a);
        await wait(dur(70));
        press(a, 0);
      }
      try {
        field.focus({ preventScroll: true });
      } catch {}
      const tag = field.tagName;
      const type = String(field.type || '').toLowerCase();
      const direct =
        tag === 'SELECT' ||
        !('value' in field) ||
        /^(color|range|date|time|datetime-local|month|week|file|checkbox|radio|hidden)$/.test(type);
      if (direct) {
        if (type === 'file') return;
        if (type === 'checkbox' || type === 'radio') field.checked = !!text && text !== 'false' && text !== '0';
        else field.value = text;
        fire(field, 'input');
        fire(field, 'change');
        return;
      }
      const isNum = type === 'number';
      const isArea = tag === 'TEXTAREA';
      const put = (n) => {
        field.value = text.slice(0, n);
        if (!isNum || field.value !== '') fire(field, 'input');
        if (isArea) field.scrollTop = field.scrollHeight;
        else
          try {
            field.setSelectionRange(field.value.length, field.value.length);
          } catch {}
      };
      field.value = '';
      const len = text.length;
      if (!live() || !len) {
        put(len);
        fire(field, 'change');
        return;
      }
      a._busy = { t0: now(), jit: false };
      const head = len > 60 ? 40 : len;
      let i = 0;
      while (i < len) {
        if (!live()) {
          i = len;
          put(i);
          break;
        }
        const f = factor();
        let step;
        let delay;
        if (i < head) {
          const per = rand(25, 40) / f;
          step = Math.max(1, Math.ceil(16 / per));
          delay = per * step;
          step = Math.min(step, head - i);
        } else {
          step = Math.max(6, Math.ceil((len - head) / 25));
          delay = Math.max(16, 45 / f);
        }
        i = Math.min(len, i + step);
        put(i);
        if (i < len) await wait(delay);
      }
      fire(field, 'change');
    } finally {
      a._busy = null;
      endOp(a);
    }
  },

  /** Kaydırıcıyı başparmağından tutup değere çeker; ~12 ara değer, input olayları, sonda change. */
  async slide(agent, range, value) {
    if (!range) return;
    const a = agent || agents.pick();
    beginOp(a);
    try {
      ensureVisible(range);
      const min = range.min === '' || range.min == null ? 0 : +range.min;
      const max = range.max === '' || range.max == null ? 100 : +range.max;
      const v0 = +range.value || 0;
      const v1 = clamp(+value, Math.min(min, max), Math.max(min, max));
      const set = (v) => {
        range.value = String(v);
        fire(range, 'input');
      };
      const r = targetRect(range);
      if (!live() || !r || String(range.type).toLowerCase() !== 'range') {
        if (live() && r) await goTo(a, range);
        set(v1);
        fire(range, 'change');
        return;
      }
      const span = max - min || 1;
      const thumbX = (v) => r.x + 8 + (r.w - 16) * clamp((v - min) / span, 0, 1);
      const cy = r.y + r.h / 2;
      await goTo(a, { x: thumbX(v0), y: cy });
      press(a, 1);
      await wait(dur(90));
      const N = 12;
      const total = dur(clamp(320 + Math.abs(thumbX(v1) - thumbX(v0)) * 2.2, 380, 950));
      const step = total / N;
      for (let k = 1; k <= N; k++) {
        if (!live()) break;
        set(v0 + (v1 - v0) * ease(k / N));
        startMove(a, thumbX(+range.value), cy, step, { straight: true });
        await wait(step);
      }
      set(v1);
      fire(range, 'change');
      if (live()) {
        startMove(a, thumbX(+range.value), cy, dur(80), { straight: true });
        press(a, 0);
        await wait(dur(110));
      }
    } finally {
      endOp(a);
    }
  },

  /** from'a gider, tutar, yarı saydam kartı to'ya taşır, bırakınca onDrop() ve kısa seçim flaşı. */
  async drag(agent, from, to, { label = '', onDrop } = {}) {
    const a = agent || agents.pick();
    beginOp(a);
    try {
      if (!live()) {
        const pt = targetRect(to);
        if (pt) await goTo(a, to);
        return onDrop ? await onDrop() : undefined;
      }
      if (isEl(from)) ensureVisible(from);
      await goTo(a, from);
      press(a, 1);
      ring(a);
      await wait(dur(120));
      let txt = String(label || t('agents.item', 'Item'));
      if (txt.length > 32) txt = txt.slice(0, 31) + '…';
      a._ghost = { label: txt, w: Math.ceil(measure(txt, `600 12px ${FONT}`) + 36) };
      kick();
      await goTo(a, to, { mult: 1.25 });
      const gw = a._ghost ? a._ghost.w : 120;
      const gr = { x: a.x - 16, y: a.y - 14, w: gw, h: 32 };
      press(a, 0);
      a._ghost = null;
      kick();
      const res = onDrop ? await onDrop() : undefined;
      if (live()) {
        agents.select(a, gr, { label, hold: 520 });
        await wait(dur(140));
      }
      return res;
    } finally {
      a._ghost = null;
      endOp(a);
    }
  },

  /** Kod panelinde i. satırı görünür kılar (type ise harf harf yazar), vurgular, paneli kaydırır. */
  codeLine(i, { type = true } = {}) {
    if (!S.lines.length || !S.codeBody) return Promise.resolve();
    i = clamp(i | 0, 0, S.lines.length - 1);
    stopTyping();
    if (S.code) S.code.classList.remove('ag-dim');
    for (let k = S.lineEls.length; k < i; k++) {
      addLine(k);
      renderLine(k);
    }
    const prev = S.codeActive;
    S.codeActive = i;
    if (prev >= 0 && prev !== i && S.lineEls[prev]) {
      S.lineEls[prev].classList.remove('on');
      renderLine(prev);
    }
    let d = S.lineEls[i];
    const fresh = !d;
    if (fresh) d = addLine(i);
    d.classList.add('on');
    if (S.codeCount) S.codeCount.textContent = `${i + 1} / ${S.lines.length}`;
    let p;
    if (fresh && type && live()) p = typeLine(i);
    else {
      renderLine(i);
      p = Promise.resolve();
    }
    scrollToLine(d);
    return p;
  },

  /**
   * Kod yazımı bitti: kalan satırlar yazmadan eklenir, imleç (ve yanıp sönmesi) kalkar,
   * panel birkaç saniye sonra soluklaşıp küçülür (ag-dim). setCode/codeLine bunu geri alır.
   */
  codeDone() {
    stopTyping();
    if (!S.code || !S.codeBody || !S.lines.length) return;
    for (let k = S.lineEls.length; k < S.lines.length; k++) {
      addLine(k);
      renderLine(k);
    }
    const i = S.codeActive;
    S.codeActive = -1;
    if (i >= 0) renderLine(i);
    if (S.codeCount) S.codeCount.textContent = `${S.lines.length} / ${S.lines.length}`;
    S.code.classList.add('ag-dim');
  },

  /** Ajanı yerinde küçük "çalışıyor" hareketiyle oyalar. */
  async busy(agent, ms = 800) {
    const a = agent || agents.pick();
    if (!live()) return;
    beginOp(a);
    const b = { t0: now(), jit: true };
    a._busy = b;
    kick();
    try {
      await wait(dur(ms));
    } finally {
      if (a._busy === b) a._busy = null;
      endOp(a);
    }
  },

  setSpeed(s) {
    const v = normSpeed(s);
    if (!v) return;
    S.speed = v;
    if (v === 'instant') {
      finishAll();
      stopTyping();
      for (const s2 of S.sels) if (!s2.fadeT0) s2.fadeT0 = now();
    }
    const b = S.hud && S.hud.querySelector('.ag-spd');
    if (b) b.textContent = speedLabel(v);
    kick();
  },
  get speed() {
    return S.speed;
  },
  set speed(v) {
    agents.setSpeed(v);
  },
  get instant() {
    return isInstant();
  },
  dur,

  /** Kayıt bölgesi: Element ya da {x,y,w,h}; null = tüm pencere. */
  setBounds(b) {
    S.bounds = b || null;
    if (!S.shown) return;
    observeBounds();
    onResize();
  },
  /** Kod paneline metin (tarif JSON'u); boşsa panel gizlenir. */
  setCode(text) {
    stopTyping();
    const t = String(text || '');
    S.lines = t ? t.replace(/\r\n?/g, '\n').split('\n') : [];
    S.toks = S.lines.map(tokenize);
    S.lineEls = [];
    S.codeActive = -1;
    if (!S.code) return;
    S.code.classList.remove('ag-dim');
    S.codeBody.textContent = '';
    S.codeBody.scrollTop = 0;
    S.codeCount.textContent = S.lines.length ? `0 / ${S.lines.length}` : '';
    S.code.hidden = !S.lines.length;
  },

  get onTour() {
    return S.onTour;
  },
  set onTour(fn) {
    S.onTour = typeof fn === 'function' ? fn : null;
    updateTour();
  },
  get onClose() {
    return S.onClose;
  },
  set onClose(fn) {
    S.onClose = typeof fn === 'function' ? fn : null;
  },
  get active() {
    return S.active;
  },
  /** Ajan listesi (salt okunur kullanım). */
  get list() {
    return S.list.slice();
  },
};

// ---------------------------------------------------------------- demo (test için)
/** Sayfadaki düğmeler üzerinde 12 ajanla ~10 saniyelik gösteri. */
export async function demo({ seconds = 10, bounds } = {}) {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const panel = el(
    'div',
    'ag-ui ag-demo',
    `<div class="ag-demo-h">${esc(t('agents.demo.title', 'Agent demo'))}</div>` +
      `<label>${esc(t('agents.demo.heading', 'Heading'))}<input type="text" data-d="t"></label>` +
      `<label>${esc(t('agents.demo.size', 'Size'))}<input type="number" data-d="n" value="12"></label>` +
      `<label>${esc(t('agents.demo.opacity', 'Opacity'))}<input type="range" data-d="r" min="0" max="100" value="20"></label>` +
      `<label>${esc(t('agents.demo.desc', 'Description'))}<textarea data-d="a" rows="3"></textarea></label>`,
  );
  document.body.appendChild(panel);
  const q = (k) => panel.querySelector(`[data-d="${k}"]`);
  const pool = [...document.querySelectorAll('button, summary, select, .clip, .mcard, canvas')].filter(
    (e) => !e.closest('.ag-ui') && !e.classList.contains('ag-canvas') && vis(e),
  );
  if (!pool.length) pool.push(...panel.querySelectorAll('input, textarea'));
  const any = () => pool[Math.floor(Math.random() * pool.length)];
  const sample = {
    ad: 'demo',
    tur: 'web',
    ajanlar: { sayi: 12, hiz: '1x' },
    sahne: [
      { tip: 'baslik', metin: 'Hafif Stüdyo', boyut: 64 },
      { tip: 'kutu', x: 120, y: 80, w: 640, h: 360, renk: '#3b82f6' },
      { tip: 'yazi', metin: 'ajan modu', anim: 'type' },
    ],
    cikti: { dosya: 'demo.mp4', fps: 30, cozunurluk: '1080x1920' },
  };
  const code = JSON.stringify(sample, null, 2);
  const total = 48;
  agents.start({ count: 12, mode: 'web', title: t('agents.demo.badge', 'Demo'), total, code, bounds });
  agents.onTour = () => agents.setSpeed(agents.speed === '1x' ? '2x' : '1x');
  const t0 = performance.now();
  const alive = () => agents.active && performance.now() - t0 < seconds * 1000;
  let n = 0;
  const tick = () => agents.progress(Math.min(total, ++n), total);
  const L = agents.list;
  const loops = L.map(async (a, k) => {
    await new Promise((r) => setTimeout(r, 300 + k * 140));
    while (alive()) {
      if (k === 0) {
        await agents.typeInto(a, q('t'), t('agents.demo.typedTitle', 'Hafif Studio — agent mode'));
        await agents.typeInto(a, q('a'), t('agents.demo.typedDesc', 'This description is for demo purposes; in long texts the first part is typed letter by letter and the rest in chunks. ').repeat(2));
      } else if (k === 1) {
        await agents.slide(a, q('r'), Math.round(Math.random() * 100));
        agents.busy(a, 600);
        await new Promise((r) => setTimeout(r, 700));
      } else if (k === 2) {
        await agents.typeInto(a, q('n'), String(Math.round(rand(8, 96))));
        await agents.busy(a, 700);
      } else if (k === 3) {
        await agents.drag(a, any(), any(), { label: t('agents.demo.clip', 'Clip {n}', { n: n + 1 }), onDrop: () => {} });
      } else {
        const t = any();
        await agents.moveTo(a, t);
        const h = agents.select(a, t, { hold: 1100 });
        await agents.busy(a, rand(300, 900));
        await agents.click(a, t, { real: false });
        h.done();
        await new Promise((r) => setTimeout(r, rand(200, 900)));
      }
      tick();
    }
  });
  const coder = (async () => {
    const lines = code.split('\n').length;
    for (let i = 0; i < lines && alive(); i++) {
      await agents.codeLine(i);
      await new Promise((r) => setTimeout(r, agents.dur(260)));
    }
  })();
  await Promise.all([...loops, coder]);
  agents.progress(total, total);
  agents.onTour = null;
  await agents.stop({ keep: false });
  panel.remove();
}
