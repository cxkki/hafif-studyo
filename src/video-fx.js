// Video editor helpers: effects, looks, transitions, motion, crop, text styles, shapes, export presets.
// Pure module (no DOM access at import time, no imports): used by video-mode.js (drawing, panel)
// and live-video.js (defaults / normalisation for proje.json). Everything here is cheap per frame:
// effects go through ctx.filter, overlays are single gradient fills, no per-pixel JS loops.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const finite = (v) => Number.isFinite(num(v));
const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ effects

/** clip.effects: every key optional; missing key = default (no change). */
export const EFFECT_DEFAULTS = { brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, grayscale: 0, sepia: 0, vignette: 0 };
export const EFFECT_RANGES = {
  brightness: [0, 2],
  contrast: [0, 2],
  saturation: [0, 3],
  hue: [-180, 180], // degrees
  blur: [0, 40], // pixels at a 1080 px short side (scaled with the frame)
  grayscale: [0, 1],
  sepia: [0, 1],
  vignette: [0, 1],
};
export const EFFECT_KEYS = Object.keys(EFFECT_DEFAULTS);

/** One-click looks: each is a complete effects object (replaces the clip's effects). */
export const LOOKS = {
  cinematic: { brightness: 0.95, contrast: 1.18, saturation: 0.85, sepia: 0.08, vignette: 0.4 },
  warm: { brightness: 1.03, saturation: 1.15, sepia: 0.22, hue: -6 },
  cool: { brightness: 1.02, contrast: 1.05, saturation: 0.95, hue: 12 },
  bw: { grayscale: 1, contrast: 1.2 },
  vintage: { brightness: 1.05, contrast: 0.9, saturation: 0.75, sepia: 0.45, vignette: 0.45 },
  vivid: { contrast: 1.12, saturation: 1.5 },
};
export const LOOK_KEYS = Object.keys(LOOKS);

/**
 * Sanitises effects. patch: look name (string) | object (replaces) | null (clears).
 * Returns a minimal object (only non-default keys) or null when everything is default.
 */
export function sanitizeEffects(patch) {
  if (patch == null || patch === false) return null;
  if (typeof patch === 'string') patch = LOOKS[patch.toLowerCase().replace(/[^a-z]/g, '')] || null;
  if (!isObj(patch)) return null;
  const out = {};
  for (const k of EFFECT_KEYS) {
    if (!finite(patch[k])) continue;
    const [lo, hi] = EFFECT_RANGES[k];
    const v = r3(clamp(num(patch[k]), lo, hi));
    if (v !== EFFECT_DEFAULTS[k]) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Full effects object with defaults filled in. */
export const effectsFull = (fx) => ({ ...EFFECT_DEFAULTS, ...(fx || {}) });

/**
 * ctx.filter string for the effects. blurScale: canvas pixels per effect-blur unit;
 * extraBlur: additional blur in canvas pixels (blur transition). 'none' when nothing to do.
 */
export function filterOf(fx, blurScale = 1, extraBlur = 0) {
  const parts = [];
  if (fx) {
    if (fx.brightness != null && fx.brightness !== 1) parts.push(`brightness(${fx.brightness})`);
    if (fx.contrast != null && fx.contrast !== 1) parts.push(`contrast(${fx.contrast})`);
    if (fx.saturation != null && fx.saturation !== 1) parts.push(`saturate(${fx.saturation})`);
    if (fx.hue) parts.push(`hue-rotate(${fx.hue}deg)`);
    if (fx.grayscale) parts.push(`grayscale(${fx.grayscale})`);
    if (fx.sepia) parts.push(`sepia(${fx.sepia})`);
  }
  const blur = (fx?.blur || 0) * blurScale + extraBlur;
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

/** Darkened edges over the rectangle (x, y, w, h) in the current transform. One gradient fill. */
export function drawVignette(ctx, amount, x, y, w, h) {
  if (!(amount > 0)) return;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${clamp(amount, 0, 1) * 0.9})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

// ------------------------------------------------------------------ easing

export const EASES = {
  linear: (k) => k,
  'ease-in': (k) => k * k * k,
  'ease-out': (k) => 1 - (1 - k) ** 3,
  'ease-in-out': (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
};
export const EASE_KEYS = Object.keys(EASES);
export const ease = (name, k) => (EASES[name] || EASES['ease-in-out'])(clamp(k, 0, 1));

/** Bounce-out easing (text "bounce" animation). */
export function easeOutBounce(k) {
  const n = 7.5625;
  const d = 2.75;
  if (k < 1 / d) return n * k * k;
  if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
  if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
  return n * (k -= 2.625 / d) * k + 0.984375;
}

// ------------------------------------------------------------------ transitions

/** clip.transition = { type, duration } (at the clip's start). */
export const TRANSITION_TYPES = ['none', 'fade', 'crossfade', 'slide-left', 'slide-up', 'zoom', 'wipe', 'blur'];
export const TRANSITION_DEFAULT = { type: 'none', duration: 0.5 };

/** Returns { type, duration } or null ("none"). Accepts a bare type string. */
export function sanitizeTransition(v) {
  if (v == null || v === false) return null;
  if (typeof v === 'string') v = { type: v };
  if (!isObj(v)) return null;
  const type = String(v.type || 'crossfade').toLowerCase();
  if (!TRANSITION_TYPES.includes(type) || type === 'none') return null;
  const duration = finite(v.duration) ? r3(clamp(num(v.duration), 0.05, 5)) : TRANSITION_DEFAULT.duration;
  return { type, duration };
}

/**
 * Does this transition draw the previous clip of the same track underneath (extended past its end)?
 * "fade" fades in from the background instead.
 */
export const usesUnderlay = (tr) => !!tr && tr.type !== 'fade';

// ------------------------------------------------------------------ motion (Ken Burns)

/** clip.motion = { from:{x,y,scale,rotation}, to:{...}, ease } — offsets on top of the clip's own x/y/scale/rotation. */
export const MOTION_POINT = { x: 0, y: 0, scale: 1, rotation: 0 };
const MOTION_RANGES = { x: [-2, 2], y: [-2, 2], scale: [0.05, 10], rotation: [-720, 720] };

export const MOTION_PRESETS = {
  'zoom-in': { from: { scale: 1 }, to: { scale: 1.25 }, ease: 'ease-in-out' },
  'zoom-out': { from: { scale: 1.25 }, to: { scale: 1 }, ease: 'ease-in-out' },
  'pan-left': { from: { x: 0.06, scale: 1.15 }, to: { x: -0.06, scale: 1.15 }, ease: 'linear' },
  'pan-right': { from: { x: -0.06, scale: 1.15 }, to: { x: 0.06, scale: 1.15 }, ease: 'linear' },
};

function motionPoint(p) {
  const out = { ...MOTION_POINT };
  if (!isObj(p)) return out;
  for (const k of Object.keys(MOTION_POINT)) {
    if (!finite(p[k])) continue;
    const [lo, hi] = MOTION_RANGES[k];
    out[k] = r3(clamp(num(p[k]), lo, hi));
  }
  return out;
}

/** Returns a complete motion object or null. Accepts a preset name. */
export function sanitizeMotion(v) {
  if (v == null || v === false) return null;
  if (typeof v === 'string') v = MOTION_PRESETS[v.toLowerCase()] || null;
  if (!isObj(v)) return null;
  const from = motionPoint(v.from);
  const to = motionPoint(v.to);
  const ez = EASE_KEYS.includes(v.ease) ? v.ease : 'ease-in-out';
  if (JSON.stringify(from) === JSON.stringify(MOTION_POINT) && JSON.stringify(to) === JSON.stringify(MOTION_POINT)) return null;
  return { from, to, ease: ez };
}

/** Interpolated motion offsets at clip progress u (0..1). */
export function motionAt(m, u) {
  if (!m) return MOTION_POINT;
  const k = ease(m.ease, u);
  const lerp = (a, b) => a + (b - a) * k;
  return {
    x: lerp(m.from.x, m.to.x),
    y: lerp(m.from.y, m.to.y),
    scale: lerp(m.from.scale, m.to.scale),
    rotation: lerp(m.from.rotation, m.to.rotation),
  };
}

// ------------------------------------------------------------------ crop

/** clip.crop = { l, t, r, b } — fractions of the source (0..0.45 each). null when no crop. */
export const CROP_KEYS = ['l', 't', 'r', 'b'];
export function sanitizeCrop(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of CROP_KEYS) out[k] = finite(v[k]) ? r3(clamp(num(v[k]), 0, 0.45)) : 0;
  return CROP_KEYS.some((k) => out[k] > 0) ? out : null;
}

// ------------------------------------------------------------------ text styles

/** Safe fonts that ship with Windows (WebView2 target). Any installed family name is also accepted. */
export const FONTS = [
  'Segoe UI',
  'Arial',
  'Arial Black',
  'Impact',
  'Bahnschrift',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Palatino Linotype',
  'Courier New',
  'Consolas',
  'Comic Sans MS',
  'Segoe Script',
  'Segoe Print',
];
export const fontCss = (f) => `"${String(f || 'Segoe UI').replace(/["\\;]/g, '')}", "Segoe UI", Arial, sans-serif`;
export const sanitizeFont = (f) => {
  const s = String(f ?? '').replace(/["\\;{}<>]/g, '').trim().slice(0, 48);
  return s || 'Segoe UI';
};

/** New text style fields (all optional on a text clip). */
export const TEXT_DEFAULTS = {
  font: 'Segoe UI',
  weight: 800,
  italic: false,
  strokeColor: '#000000',
  strokeWidth: 0.14, // × font size
  shadow: false,
  shadowColor: '#000000',
  shadowBlur: 0.3, // × font size
  shadowDist: 0.08, // × font size, down-right
  align: 'center',
  letterSpacing: 0, // em
  lineHeight: 1.15, // × font size
  boxPad: 0.35, // em
  boxRadius: 0.25, // em
  boxOpacity: 0.8,
  rotation: 0,
};
export const TEXT_RANGES = {
  weight: [100, 900],
  strokeWidth: [0, 0.5],
  shadowBlur: [0, 2],
  shadowDist: [0, 1],
  letterSpacing: [-0.2, 1],
  lineHeight: [0.6, 3],
  boxPad: [0, 2],
  boxRadius: [0, 1.5],
  boxOpacity: [0, 1],
};
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_ANIMS = ['none', 'pop', 'slide', 'type', 'bounce', 'fade-up', 'zoom-in', 'wave'];

// ------------------------------------------------------------------ shapes

/** Shape clips: { kind:'shape', shape, color, w, h, radius } on the overlay (v2) or main (v1) track. */
export const SHAPES = ['rect', 'rounded', 'circle', 'bar'];
export const SHAPE_DEFAULTS = { shape: 'rect', color: '#4f8cff', w: 0.6, h: 0.1, radius: 0.3 };
export const SHAPE_RANGES = { w: [0.005, 2], h: [0.005, 2], radius: [0, 1] };

/**
 * Draws a shape centred at (0, 0) in the current transform. bw/bh: box size in frame pixels.
 * progress (0..1): fill fraction for "bar" (progress bar), the bar track is drawn at 25 % opacity.
 */
export function drawShape(ctx, shape, color, bw, bh, radius, progress = 1) {
  ctx.fillStyle = color;
  const x = -bw / 2;
  const y = -bh / 2;
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const r = shape === 'rect' ? 0 : clamp(radius, 0, 1) * (Math.min(bw, bh) / 2);
  const box = (w) => {
    ctx.beginPath();
    if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, bh, Math.min(r, w / 2));
    else ctx.rect(x, y, w, bh);
    ctx.fill();
  };
  if (shape === 'bar') {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * 0.25;
    box(bw);
    ctx.globalAlpha = a;
    const w = bw * clamp(progress, 0, 1);
    if (w > 0.5) box(w);
    return;
  }
  box(bw);
}

// ------------------------------------------------------------------ export presets

export const EXPORT_PRESETS = [
  { id: 'project', res: null },
  { id: 'vertical', res: '1080x1920' },
  { id: 'youtube', res: '1920x1080' },
  { id: 'light', res: '1280x720' },
  { id: 'square', res: '1080x1080' },
];
export const EXPORT_QUALITY = { low: 0.06, medium: 0.1, high: 0.17 }; // bits per pixel per frame

/** Video bitrate (bits/s) for the output size, fps and quality level. */
export function bitrateFor(w, h, fps, q = 'medium') {
  const bpp = EXPORT_QUALITY[q] ?? EXPORT_QUALITY.medium;
  return Math.round(clamp(w * h * clamp(fps, 1, 120) * bpp, 1.5e6, 3e7));
}

// ------------------------------------------------------------------ defaults for proje.json fields

/** Defaults of the new visual clip fields (what an absent field means). */
export const CLIP_FX_DEFAULTS = { speed: 1, rotation: 0, crop: null, effects: null, transition: null, motion: null };
