// Draw clips: video clips whose frames are drawn by JavaScript (kind:"draw", field "code").
//
// The code is the BODY of   function (ctx, t, w, h, p, H) { ... }
//   ctx: 2D context of an OffscreenCanvas (project size w × h, transparent before every frame)
//   t:   seconds since the clip start, p = t / duration (0..1), H: helper library (makeHelpers below)
//
// Sandbox: the code runs only inside a dedicated Web Worker made from a Blob URL. Before any user code is compiled
// the worker removes network / storage / messaging / code-loading APIs (fetch, XMLHttpRequest, WebSocket,
// EventSource, importScripts, indexedDB, caches, BroadcastChannel, Worker, eval, Function, string timers…) and
// compiles with a captured Function in strict mode. It never receives NL_TOKEN or any Neutralino object: the only
// input is the frame request message. Each request has a timeout; on timeout the worker is terminated (recreated on
// the next request) and the clip shows an error. Errors are reported back as data, never thrown into the app.
//
// Performance: no loops. A worker renders only when a frame is requested (preview draw, playback, export).
// The main thread keeps the last ImageBitmap per clip; preview shows the cached frame while the next renders.
import { t as tr } from './i18n.js';

// --------------------------------------------------------------------------------------------- helper library
// makeHelpers is serialised into the worker with Function.prototype.toString: it must stay self-contained
// (no references to anything outside its own body). state.s = preview scale (canvas px per project px).
export function makeHelpers(state) {
  const st = state || { s: 1 };
  const PI = Math.PI;
  const DEG = PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const bounce = (k) => {
    const n = 7.5625;
    const d = 2.75;
    if (k < 1 / d) return n * k * k;
    if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
    if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
    return n * (k -= 2.625 / d) * k + 0.984375;
  };
  const EASES = {
    linear: (k) => k,
    'ease-in': (k) => k * k * k,
    'ease-out': (k) => 1 - (1 - k) ** 3,
    'ease-in-out': (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
    bounce,
    elastic: (k) => (k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * ((2 * PI) / 3)) + 1),
  };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const fontName = (f) => String(f || 'Segoe UI').replace(/["\\;{}]/g, '');

  /** Limb end points: a = angle (deg, 0 = down, + = towards +x; flip mirrors) or [upper, bend] (bend relative). */
  function limb(x0, y0, len, a, sx) {
    const two = Array.isArray(a);
    const a1 = num(two ? a[0] : a, 0) * DEG;
    if (!two) return { jx: x0 + sx * Math.sin(a1) * len * 0.5, jy: y0 + Math.cos(a1) * len * 0.5, ex: x0 + sx * Math.sin(a1) * len, ey: y0 + Math.cos(a1) * len };
    const a2 = a1 + num(a[1], 0) * DEG;
    const jx = x0 + sx * Math.sin(a1) * len * 0.5;
    const jy = y0 + Math.cos(a1) * len * 0.5;
    return { jx, jy, ex: jx + sx * Math.sin(a2) * len * 0.5, ey: jy + Math.cos(a2) * len * 0.5 };
  }

  const H = {
    lerp,
    clamp,
    ease(k, name) {
      return (EASES[name] || EASES['ease-in-out'])(clamp(num(k, 0), 0, 1));
    },
    /** sin wave: amp * sin(2π·freq·t + phase). */
    wave(t, freq, amp, phase) {
      return num(amp, 1) * Math.sin(2 * PI * num(freq, 1) * num(t, 0) + num(phase, 0));
    },
    /** Deterministic pseudo random 0..1 for index i (and seed). */
    rand(i, seed) {
      let x = (Math.floor(num(i, 0) * 1009) ^ Math.imul(Math.floor(num(seed, 0)) | 0, 0x9e3779b1)) | 0;
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      x ^= x >>> 16;
      return (x >>> 0) / 4294967296;
    },
    /** Progress 0..1 of t inside [start, end] (clamped). */
    seg(t, start, end) {
      t = num(t, 0);
      if (!(end > start)) return t >= start ? 1 : 0;
      return clamp((t - start) / (end - start), 0, 1);
    },
    /**
     * Stick figure standing with its lowest foot at (x, y), total height h.
     * pose angles in degrees: 0 = straight down, positive = towards +x (screen right); flip mirrors the pose.
     * A limb may be [upper, bend] (elbow / knee bend relative to the upper part). body = torso lean, neck = head tilt.
     * Returns the joints {head:{x,y,r}, neck, shoulder, hip, elbowL, elbowR, handL, handR, kneeL, kneeR, footL, footR}.
     */
    stick(ctx, o) {
      o = o || {};
      const h = num(o.h, 300);
      const lw = num(o.width, h / 25);
      const hs = num(o.head, 1);
      const sx = o.flip ? -1 : 1;
      const pose = o.pose || {};
      const r = h * 0.1 * hs;
      const legLen = h * 0.46;
      const torso = h * 0.3;
      const neckLen = h * 0.04;
      const armLen = h * 0.36;
      const x = num(o.x, 0);
      const y = num(o.y, 0);
      const legL0 = pose.legL != null ? pose.legL : -12;
      const legR0 = pose.legR != null ? pose.legR : 12;
      const lL = limb(0, 0, legLen, legL0, sx);
      const lR = limb(0, 0, legLen, legR0, sx);
      const low = Math.max(lL.jy, lL.ey, lR.jy, lR.ey, 0);
      const hipX = x;
      const hipY = y - low;
      const b = num(pose.body, 0) * DEG;
      const shX = hipX + sx * Math.sin(b) * torso;
      const shY = hipY - Math.cos(b) * torso;
      const hb = b + num(pose.neck, 0) * DEG;
      const headX = shX + sx * Math.sin(hb) * (neckLen + r);
      const headY = shY - Math.cos(hb) * (neckLen + r);
      const nkX = shX + sx * Math.sin(hb) * neckLen;
      const nkY = shY - Math.cos(hb) * neckLen;
      const aL = limb(shX, shY, armLen, pose.armL != null ? pose.armL : -25, sx);
      const aR = limb(shX, shY, armLen, pose.armR != null ? pose.armR : 25, sx);
      const legL = limb(hipX, hipY, legLen, legL0, sx);
      const legR = limb(hipX, hipY, legLen, legR0, sx);
      ctx.save();
      ctx.strokeStyle = o.color || '#fff';
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const [x0, y0, l] of [[hipX, hipY, legL], [hipX, hipY, legR], [shX, shY, aL], [shX, shY, aR]]) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(l.jx, l.jy);
        ctx.lineTo(l.ex, l.ey);
      }
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(shX, shY);
      ctx.lineTo(nkX, nkY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(headX, headY, r, 0, 2 * PI);
      if (o.fill) {
        ctx.fillStyle = o.fill;
        ctx.fill();
      }
      ctx.stroke();
      if (o.face) {
        ctx.translate(headX, headY);
        ctx.rotate(sx * hb);
        ctx.fillStyle = o.color || '#fff';
        ctx.lineWidth = Math.max(1, lw * 0.6);
        const eyeY = o.face === 'surprised' ? -r * 0.22 : -r * 0.15;
        const eyeR = o.face === 'surprised' ? r * 0.15 : r * 0.12;
        for (const ex of [-r * 0.35, r * 0.35]) {
          ctx.beginPath();
          ctx.arc(ex, eyeY, eyeR, 0, 2 * PI);
          ctx.fill();
        }
        ctx.beginPath();
        if (o.face === 'happy') ctx.arc(0, r * 0.05, r * 0.45, 0.2 * PI, 0.8 * PI);
        else if (o.face === 'sad') ctx.arc(0, r * 0.7, r * 0.4, 1.2 * PI, 1.8 * PI);
        else if (o.face === 'surprised') ctx.arc(0, r * 0.4, r * 0.18, 0, 2 * PI);
        else if (o.face === 'angry') {
          ctx.moveTo(-r * 0.6, -r * 0.5);
          ctx.lineTo(-r * 0.15, -r * 0.3);
          ctx.moveTo(r * 0.6, -r * 0.5);
          ctx.lineTo(r * 0.15, -r * 0.3);
          ctx.moveTo(-r * 0.3, r * 0.45);
          ctx.lineTo(r * 0.3, r * 0.45);
        }
        ctx.stroke();
      }
      ctx.restore();
      return {
        head: { x: headX, y: headY, r },
        neck: { x: nkX, y: nkY },
        shoulder: { x: shX, y: shY },
        hip: { x: hipX, y: hipY },
        elbowL: { x: aL.jx, y: aL.jy },
        elbowR: { x: aR.jx, y: aR.jy },
        handL: { x: aL.ex, y: aL.ey },
        handR: { x: aR.ex, y: aR.ey },
        kneeL: { x: legL.jx, y: legL.jy },
        kneeR: { x: legR.jx, y: legR.jy },
        footL: { x: legL.ex, y: legL.ey },
        footR: { x: legR.ex, y: legR.ey },
      };
    },
    /** Text centred vertically on y. Multi-line with "\n". */
    text(ctx, str, x, y, o) {
      o = o || {};
      const size = num(o.size, 80);
      const lines = String(str == null ? '' : str).split('\n');
      ctx.save();
      ctx.font = `${num(o.weight, 800)} ${size}px "${fontName(o.font)}", "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = o.align === 'left' || o.align === 'right' ? o.align : 'center';
      ctx.textBaseline = 'middle';
      const lh = size * 1.15;
      const top = num(y, 0) - ((lines.length - 1) * lh) / 2;
      if (o.stroke) {
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = num(o.strokeWidth, 0) || size * 0.08;
        ctx.lineJoin = 'round';
        lines.forEach((l, i) => ctx.strokeText(l, num(x, 0), top + i * lh));
      }
      ctx.fillStyle = o.color || '#fff';
      lines.forEach((l, i) => ctx.fillText(l, num(x, 0), top + i * lh));
      ctx.restore();
    },
    circle(ctx, x, y, r, fill, stroke, lw) {
      ctx.beginPath();
      ctx.arc(num(x, 0), num(y, 0), Math.max(0, num(r, 0)), 0, 2 * PI);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = num(lw, 4);
        ctx.stroke();
      }
    },
    line(ctx, x1, y1, x2, y2, color, lw) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(num(x1, 0), num(y1, 0));
      ctx.lineTo(num(x2, 0), num(y2, 0));
      ctx.strokeStyle = color || '#fff';
      ctx.lineWidth = num(lw, 4);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    },
    rect(ctx, x, y, w, h, fill, radius) {
      ctx.beginPath();
      const rr = Math.max(0, num(radius, 0));
      if (rr > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, rr);
      else ctx.rect(x, y, w, h);
      ctx.fillStyle = fill || '#fff';
      ctx.fill();
    },
    /** Polygon / polyline through [[x,y], ...]. */
    poly(ctx, pts, fill, stroke, lw, closed) {
      if (!Array.isArray(pts) || !pts.length) return;
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
      if (closed !== false && fill) ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = num(lw, 4);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    },
    /** Neon glow for what is drawn next (blur in project px). H.glow(ctx, null) turns it off. */
    glow(ctx, color, blur) {
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      if (!color) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        return;
      }
      ctx.shadowColor = color;
      // The worker's ctx scales shadow lengths itself (st.wrapped); otherwise scale here.
      ctx.shadowBlur = Math.max(0, num(blur, 20)) * (st.wrapped ? 1 : st.s > 0 ? st.s : 1);
    },
    /** Fills the background: a colour, or a linear gradient c1 → c2 (CSS-style angle: 90 = left → right, 180 = top → bottom). */
    bg(ctx, w, h, c1, c2, angle) {
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      if (c2) {
        const a = num(angle, 90) * DEG;
        const dx = Math.sin(a);
        const dy = -Math.cos(a);
        const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
        const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
        g.addColorStop(0, c1 || '#000');
        g.addColorStop(1, c2);
        ctx.fillStyle = g;
      } else ctx.fillStyle = c1 || '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
    /** 'hsl(...)' colour string. */
    hsl(hue, s, l, a) {
      return `hsla(${num(hue, 0)}, ${num(s, 100)}%, ${num(l, 50)}%, ${num(a, 1)})`;
    },
  };
  return Object.freeze(H);
}

// --------------------------------------------------------------------------------------------- worker
// workerMain is serialised into the worker (self-contained, like makeHelpers). scope = the worker global.
// Protocol: main → worker  {type:'frame', id, code, hash, t, dur, w, h, scale}
//           worker → main  {type:'frame', id, bitmap}  (transferred)  |  {type:'error', id, phase:'compile'|'run', message, line}
export function workerMain(scope, makeHelpers) {
  'use strict';
  const post = scope.postMessage.bind(scope);
  const listen = scope.addEventListener.bind(scope);
  const OC = scope.OffscreenCanvas;
  const F = Function;
  const real = scope === globalThis;
  const stub = function () {
    throw new Error('Not available in drawing code');
  };
  const BLOCK = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches',
    'BroadcastChannel', 'Worker', 'SharedWorker', 'Notification', 'navigator', 'postMessage', 'addEventListener', 'removeEventListener',
    'dispatchEvent', 'onmessage', 'onmessageerror', 'close', 'setTimeout', 'setInterval', 'eval', 'Function', 'FontFace', 'fonts',
    // Async schedulers: a drawing must not keep the worker busy between frames (idle CPU ~0).
    'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'scheduler', 'MessageChannel',
    // Origin storage that survives the worker (legacy sandboxed file system, cookies).
    'webkitRequestFileSystem', 'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL', 'cookieStore',
    'NL_TOKEN', 'Neutralino',
  ];
  const UNDEF = ['navigator', 'indexedDB', 'caches', 'onmessage', 'onmessageerror', 'fonts', 'scheduler', 'cookieStore', 'NL_TOKEN', 'Neutralino'];
  for (const name of BLOCK) {
    try {
      for (let o = Object.getPrototypeOf(scope); o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name);
        if (d && d.configurable) delete o[name];
      }
    } catch (e) {}
    try {
      delete scope[name];
    } catch (e) {}
    try {
      Object.defineProperty(scope, name, { value: UNDEF.includes(name) ? undefined : stub, writable: false, configurable: false, enumerable: false });
    } catch (e) {}
  }
  let seed = 1;
  let nowMs = 0;
  if (real) {
    // Function constructors reachable from any function value (incl. async / generator ones).
    const protos = [F.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})];
    for (const pr of protos) {
      try {
        Object.defineProperty(pr, 'constructor', { value: stub, writable: false, configurable: false });
      } catch (e) {}
    }
    // Deterministic Math.random (re-seeded for every frame from the code hash and t).
    try {
      Object.defineProperty(Math, 'random', {
        value: function () {
          seed = (seed + 0x6d2b79f5) | 0;
          let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
          return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        },
        writable: false,
        configurable: false,
      });
    } catch (e) {}
    // Deterministic clocks: Date.now() / performance.now() follow the frame time (same t -> same frame).
    try {
      Object.defineProperty(Date, 'now', { value: () => 1735689600000 + nowMs, writable: false, configurable: false });
    } catch (e) {}
    try {
      if (scope.performance) Object.defineProperty(scope.performance, 'now', { value: () => nowMs, writable: false, configurable: false });
    } catch (e) {}
  }

  const state = { s: 1 };
  const H = makeHelpers(state);
  const IMPORT_RE = /\bimport\b/;
  let canvas = null;
  let ctx = null;
  let curHash = null;
  let fn = null;
  let compileErr = null;

  const msgOf = (e) => {
    try {
      return String((e && e.message) || e).slice(0, 500);
    } catch (x) {
      return 'Error';
    }
  };
  // new Function source: "(function anonymous(ctx,t,w,h,p,H\n) {\n" + '"use strict";\n' + code → user line = line - 3.
  const lineOf = (e) => {
    try {
      const m = /<anonymous>:(\d+):(\d+)/.exec(String((e && e.stack) || ''));
      return m ? Math.max(1, +m[1] - 3) : 0;
    } catch (x) {
      return 0;
    }
  };

  function compile(code, hash) {
    if (hash === curHash) return;
    curHash = hash;
    fn = null;
    compileErr = null;
    if (IMPORT_RE.test(code)) {
      compileErr = { message: '"import" is not allowed in drawing code', line: 0 };
      return;
    }
    try {
      fn = F('ctx', 't', 'w', 'h', 'p', 'H', '"use strict";\n' + code);
    } catch (e) {
      compileErr = { message: msgOf(e), line: lineOf(e) };
    }
  }

  // The canvas is rendered at state.s × the project size (reduced preview, scaled export, PNG ×2), so the drawing
  // code sees project pixels: its transforms and shadow lengths are applied on top of that base scale. Without
  // this, code calling ctx.setTransform(1,0,0,1,0,0) / ctx.reset() or setting ctx.shadowBlur would render at
  // a different size in the preview and in scaled exports than at 100 %.
  let rawSet = null;
  let rawReset = null;
  function findDesc(o, name) {
    for (; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }
  function setupCtx(c) {
    const sd = findDesc(c, 'setTransform');
    rawSet = sd && typeof sd.value === 'function' ? sd.value : null;
    const rd = findDesc(c, 'reset');
    rawReset = rd && typeof rd.value === 'function' ? rd.value : null;
    if (!rawSet) return;
    const gd = findDesc(c, 'getTransform');
    const rawGet = gd && typeof gd.value === 'function' ? gd.value : null;
    const DM = scope.DOMMatrix;
    const S = () => (state.s > 0 ? state.s : 1);
    const def = (name, value) => {
      try {
        Object.defineProperty(c, name, { value, writable: false, configurable: false, enumerable: false });
      } catch (e) {}
    };
    const n = (v, d) => (v === undefined ? d : +v);
    def('setTransform', function (a, b, cc, d, e, f) {
      if (arguments.length <= 1) {
        const m = a == null ? {} : a;
        a = n(m.a !== undefined ? m.a : m.m11, 1);
        b = n(m.b !== undefined ? m.b : m.m12, 0);
        cc = n(m.c !== undefined ? m.c : m.m21, 0);
        d = n(m.d !== undefined ? m.d : m.m22, 1);
        e = n(m.e !== undefined ? m.e : m.m41, 0);
        f = n(m.f !== undefined ? m.f : m.m42, 0);
      }
      const s = S();
      rawSet.call(c, s * a, s * b, s * cc, s * d, s * e, s * f);
    });
    def('resetTransform', function () {
      const s = S();
      rawSet.call(c, s, 0, 0, s, 0, 0);
    });
    if (rawReset) {
      def('reset', function () {
        rawReset.call(c);
        const s = S();
        rawSet.call(c, s, 0, 0, s, 0, 0);
      });
    }
    if (rawGet && typeof DM === 'function') {
      def('getTransform', function () {
        const m = rawGet.call(c);
        const s = S();
        return new DM([m.a / s, m.b / s, m.c / s, m.d / s, m.e / s, m.f / s]);
      });
    }
    let shadows = true;
    for (const name of ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY']) {
      const d = findDesc(c, name);
      if (!d || !d.get || !d.set) {
        shadows = false;
        continue;
      }
      try {
        Object.defineProperty(c, name, {
          get() {
            return d.get.call(c) / S();
          },
          set(v) {
            d.set.call(c, +v * S());
          },
          configurable: false,
          enumerable: true,
        });
      } catch (e) {
        shadows = false;
      }
    }
    state.wrapped = shadows; // H.glow then passes project px (the setter scales)
  }

  function resetCtx(scale) {
    if (rawReset) rawReset.call(ctx);
    else {
      if (rawSet) rawSet.call(ctx, 1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (rawSet) rawSet.call(ctx, scale, 0, 0, scale, 0, 0);
  }

  listen('message', function (ev) {
    const d = ev.data;
    if (!d || d.type !== 'frame') return;
    const id = d.id;
    try {
      compile(String(d.code || ''), String(d.hash));
      if (compileErr) return post({ type: 'error', id, phase: 'compile', message: compileErr.message, line: compileErr.line });
      const w = Math.max(1, Math.min(8192, Math.round(+d.w) || 1));
      const h = Math.max(1, Math.min(8192, Math.round(+d.h) || 1));
      const scale = +d.scale > 0 ? Math.min(4, +d.scale) : 1;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      if (!canvas) {
        canvas = new OC(cw, ch);
        ctx = canvas.getContext('2d');
        setupCtx(ctx);
      } else if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      state.s = scale;
      resetCtx(scale);
      const t = +d.t || 0;
      const dur = +d.dur || 0;
      const p = dur > 0 ? Math.min(1, Math.max(0, t / dur)) : 0;
      seed = (parseInt(String(d.hash), 16) ^ Math.round(t * 1000)) | 0;
      nowMs = t * 1000;
      let ret;
      try {
        ret = fn(ctx, t, w, h, p, H);
      } catch (e) {
        return post({ type: 'error', id, phase: 'run', message: msgOf(e), line: lineOf(e) });
      }
      // A returned Promise (async code) would draw after the frame was taken: report it instead of a half frame.
      if (ret !== null && (typeof ret === 'object' || typeof ret === 'function')) {
        let then = null;
        try {
          then = ret.then;
        } catch (e) {}
        if (typeof then === 'function') {
          return post({ type: 'error', id, phase: 'run', message: 'Drawing code must be synchronous (no async/await, promises or timers)', line: 0 });
        }
      }
      const bitmap = canvas.transferToImageBitmap();
      post({ type: 'frame', id, bitmap }, [bitmap]);
    } catch (e) {
      post({ type: 'error', id, phase: 'run', message: msgOf(e), line: 0 });
    }
  });
}

/** The worker script (Blob source). */
export function workerSource() {
  return `"use strict";(${workerMain.toString()})(self, ${makeHelpers.toString()});`;
}

const hashMemo = new Map(); // code -> hash (draw() hashes every visible clip's code several times per frame)

/** FNV-1a 32-bit hash of a string, 8 hex chars. */
export function hashCode(str) {
  const s = String(str == null ? '' : str);
  const hit = hashMemo.get(s);
  if (hit) return hit;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const out = (h >>> 0).toString(16).padStart(8, '0');
  if (hashMemo.size >= 32) hashMemo.clear();
  hashMemo.set(s, out);
  return out;
}

/** Cache key of a frame request. */
export function frameKey(hash, t, w, h, scale, dur) {
  return `${hash}|${(+t || 0).toFixed(4)}|${Math.round(+w) || 0}x${Math.round(+h) || 0}|${(+scale || 1).toFixed(4)}|${(+dur || 0).toFixed(4)}`;
}

// --------------------------------------------------------------------------------------------- main-thread renderer

const FIRST_GRACE_MS = 2000; // a fresh worker parses its script first
const PREVIEW_PIXELS = 1080 * 1920 * 0.25; // a half-size vertical preview frame gets the base timeout
// An idle worker is terminated after this long: drawing code may have left async work running (an async
// function loop, promise chains…) that would otherwise burn CPU forever; it also frees the canvas memory.
// The next frame request recreates the worker.
const IDLE_MS = 3000;

/**
 * createDrawRenderer({ timeout = 250, onFrame(clipId), onError(clipId, message|null), createWorker? })
 *   frame(clipId, code, t, w, h, scale = 1, dur = 0) -> Promise<ImageBitmap>   (p = t / dur; rejects on error)
 *   has(clipId, code, t, w, h, scale = 1, dur = 0)   -> bool: the cached frame is exactly this one
 *   cached(clipId) -> ImageBitmap|null   (last frame; valid until the next frame of that clip arrives)
 *   meta(clipId)   -> {hash, t, w, h, scale, dur}|null of the cached frame
 *   error(clipId)  -> string|null ; retry(clipId) clears a sticky error (same code is tried again)
 *   dispose(clipId); disposeAll(); ids() -> clip ids with a slot
 * onFrame / onError are called asynchronously; onError only when the error text changes.
 */
export function createDrawRenderer(opts = {}) {
  const timeout = +opts.timeout > 0 ? +opts.timeout : 250;
  const slots = new Map();
  let seq = 0;
  let url = null;

  const makeWorker =
    opts.createWorker ||
    (() => {
      if (!url) url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      return new Worker(url, { name: 'hs-draw' });
    });

  function slot(clipId) {
    let s = slots.get(clipId);
    if (!s) {
      s = { id: clipId, worker: null, fresh: false, idle: 0, inflight: null, queued: null, bmp: null, meta: null, err: null, errKey: null, fatalHash: null };
      slots.set(clipId, s);
    }
    return s;
  }

  const fmtErr = (d) => {
    const msg = String(d.message || 'Error').slice(0, 500);
    if (d.timeout) return tr('draw.err.timeout', 'The drawing took longer than {ms} ms (endless loop?). Fix the code and apply it again.', { ms: d.ms || timeout });
    const prefix = d.phase === 'compile' ? tr('draw.err.syntax', 'Code error') : tr('draw.err.runtime', 'Drawing error');
    return d.line > 0 ? tr('draw.err.withLine', '{prefix} (line {line}): {message}', { prefix, line: d.line, message: msg }) : `${prefix}: ${msg}`;
  };

  function setError(s, text) {
    if (s.err === text) return;
    s.err = text;
    try {
      opts.onError?.(s.id, text);
    } catch (e) {
      console.warn(e);
    }
  }

  function killWorker(s) {
    clearTimeout(s.idle);
    s.idle = 0;
    if (s.worker) {
      try {
        s.worker.terminate();
      } catch (e) {}
    }
    s.worker = null;
  }

  function ensureWorker(s) {
    if (s.worker) return s.worker;
    const w = makeWorker();
    s.worker = w;
    s.fresh = true;
    w.onmessage = (ev) => onMessage(s, w, ev.data);
    w.onerror = (ev) => {
      ev?.preventDefault?.();
      if (s.worker !== w) return;
      killWorker(s);
      const req = s.inflight;
      if (req) finish(s, req, null, { phase: 'run', message: ev?.message || 'Worker error' });
    };
    w.onmessageerror = () => {};
    return w;
  }

  function send(s, req) {
    clearTimeout(s.idle);
    s.idle = 0;
    const w = ensureWorker(s);
    req.id = ++seq;
    s.inflight = req;
    // The budget grows with the pixel count (full-size export frames may take longer than reduced previews).
    const limit = Math.round(timeout * Math.min(8, Math.max(1, (req.w * req.h * req.scale * req.scale) / PREVIEW_PIXELS)));
    const ms = s.fresh ? limit + FIRST_GRACE_MS : limit;
    req.timer = setTimeout(() => {
      if (s.inflight !== req) return;
      killWorker(s);
      finish(s, req, null, { timeout: true, ms: limit, phase: 'run', message: 'timeout' }, true);
    }, ms);
    try {
      w.postMessage({ type: 'frame', id: req.id, code: req.code, hash: req.hash, t: req.t, dur: req.dur, w: req.w, h: req.h, scale: req.scale });
    } catch (e) {
      finish(s, req, null, { phase: 'run', message: e.message });
    }
  }

  function onMessage(s, w, d) {
    const req = s.inflight;
    if (s.worker !== w || !req || !d || d.id !== req.id) {
      // A late / stale frame: release its pixels now instead of waiting for GC.
      try {
        d?.bitmap?.close?.();
      } catch (e) {}
      return;
    }
    s.fresh = false;
    if (d.type === 'frame') {
      const bmp = d.bitmap;
      const okBmp = bmp && (typeof ImageBitmap === 'undefined' ? typeof bmp.close === 'function' : bmp instanceof ImageBitmap);
      if (!okBmp) return finish(s, req, null, { phase: 'run', message: 'Invalid frame' });
      // The drawing code may resize ctx.canvas: never keep a frame of another size (memory, layout).
      const ew = Math.max(1, Math.round(Math.max(1, Math.min(8192, req.w)) * Math.min(4, req.scale)));
      const eh = Math.max(1, Math.round(Math.max(1, Math.min(8192, req.h)) * Math.min(4, req.scale)));
      if (typeof bmp.width === 'number' && (bmp.width !== ew || bmp.height !== eh)) {
        bmp.close();
        return finish(s, req, null, { phase: 'run', message: 'The drawing changed the canvas size (do not set ctx.canvas.width / height)' });
      }
      return finish(s, req, bmp, null);
    }
    if (d.type === 'error') return finish(s, req, null, { phase: d.phase === 'compile' ? 'compile' : 'run', message: String(d.message || ''), line: +d.line || 0 }, d.phase === 'compile');
  }

  /** Settles the in-flight request, then sends the queued one. fatal: the error sticks to this code hash. */
  function finish(s, req, bmp, err, fatal) {
    clearTimeout(req.timer);
    if (s.inflight === req) s.inflight = null;
    if (bmp) {
      const old = s.bmp;
      s.bmp = bmp;
      s.meta = { key: req.key, hash: req.hash, t: req.t, w: req.w, h: req.h, scale: req.scale, dur: req.dur };
      if (old && old !== bmp) old.close?.();
      s.errKey = null;
      s.fatalHash = null;
      for (const wt of req.waiters) wt.res(bmp);
      setError(s, null);
      try {
        opts.onFrame?.(s.id);
      } catch (e) {
        console.warn(e);
      }
    } else {
      const text = fmtErr(err || {});
      s.errKey = req.key;
      if (fatal) s.fatalHash = req.hash;
      for (const wt of req.waiters) wt.rej(new Error(text));
      setError(s, text);
    }
    const q = s.queued;
    s.queued = null;
    if (q) {
      if (q.hash === s.fatalHash || q.key === s.errKey) {
        for (const wt of q.waiters) wt.rej(new Error(s.err || 'Error'));
      } else send(s, q);
    }
    if (!s.inflight && s.worker && slots.get(s.id) === s) {
      clearTimeout(s.idle);
      s.idle = setTimeout(() => {
        s.idle = 0;
        if (!s.inflight && !s.queued) killWorker(s);
      }, IDLE_MS);
    }
  }

  function frame(clipId, code, t, w, h, scale = 1, dur = 0) {
    code = String(code == null ? '' : code);
    const hash = hashCode(code);
    t = +t || 0;
    scale = +scale > 0 ? +scale : 1;
    dur = +dur > 0 ? +dur : 0;
    const key = frameKey(hash, t, w, h, scale, dur);
    const s = slot(clipId);
    if (s.bmp && s.meta?.key === key) return Promise.resolve(s.bmp);
    if (s.fatalHash === hash || s.errKey === key) return Promise.reject(new Error(s.err || 'Error'));
    return new Promise((res, rej) => {
      const waiter = { res, rej };
      if (s.inflight?.key === key) return s.inflight.waiters.push(waiter);
      const req = { key, hash, code, t, w: Math.round(+w) || 1, h: Math.round(+h) || 1, scale, dur, waiters: [waiter], timer: 0, id: 0 };
      if (s.inflight) {
        // Only the newest pending request is kept; earlier waiters get the newer frame.
        if (s.queued) req.waiters.unshift(...s.queued.waiters);
        s.queued = req;
      } else send(s, req);
    });
  }

  function has(clipId, code, t, w, h, scale = 1, dur = 0) {
    const s = slots.get(clipId);
    if (!s || !s.bmp || !s.meta) return false;
    return s.meta.key === frameKey(hashCode(String(code == null ? '' : code)), +t || 0, w, h, +scale > 0 ? +scale : 1, +dur > 0 ? +dur : 0);
  }

  function dispose(clipId) {
    const s = slots.get(clipId);
    if (!s) return;
    slots.delete(clipId);
    killWorker(s);
    for (const req of [s.inflight, s.queued]) {
      if (!req) continue;
      clearTimeout(req.timer);
      for (const wt of req.waiters) wt.rej(new Error('disposed'));
    }
    s.inflight = s.queued = null;
    s.bmp?.close?.();
    s.bmp = null;
    s.meta = null;
  }

  return {
    frame,
    has,
    cached: (clipId) => slots.get(clipId)?.bmp || null,
    meta: (clipId) => {
      const m = slots.get(clipId)?.meta;
      return m ? { hash: m.hash, t: m.t, w: m.w, h: m.h, scale: m.scale, dur: m.dur } : null;
    },
    error: (clipId) => slots.get(clipId)?.err || null,
    pending: (clipId) => !!slots.get(clipId)?.inflight,
    retry(clipId) {
      const s = slots.get(clipId);
      if (!s) return;
      s.fatalHash = null;
      s.errKey = null;
    },
    dispose,
    disposeAll() {
      for (const id of [...slots.keys()]) dispose(id);
    },
    ids: () => [...slots.keys()],
  };
}

// --------------------------------------------------------------------------------------------- docs for the AI

/** Short English reference of draw clips and the H helpers (used by the AI schema). */
export const DRAW_HELP = `Draw clip: {"kind":"draw","track":"v2","start":0,"duration":10,"code":"<JS>"} — a video layer drawn by JavaScript.
"code" is the BODY of function (ctx, t, w, h, p, H) { ... }, called for every frame:
  ctx = CanvasRenderingContext2D (OffscreenCanvas, project size w×h, transparent before each frame);
  t = seconds since the clip start (0..duration); p = t/duration (0..1); w, h = frame size in px (e.g. 1080×1920).
Rules: deterministic (same t -> same frame; Math.random is seeded per frame, prefer H.rand; Date.now() follows t), synchronous (no async/promises), fast (< 250 ms per frame),
no network/DOM/import/eval/timers. Composited like a full-frame image clip: x/y/scale/opacity/rotation/effects/motion/transition apply.
H helpers:
  H.lerp(a,b,k)  H.clamp(v,a,b)  H.ease(k, 'linear'|'ease-in'|'ease-out'|'ease-in-out'|'bounce'|'elastic')
  H.wave(t, freq=1, amp=1, phase=0) -> amp*sin(2π·freq·t+phase)   H.rand(i, seed=0) -> 0..1 deterministic
  H.seg(t, start, end) -> 0..1 progress of t inside [start,end] (clamped)   H.hsl(h,s,l,a=1) -> colour string
  H.stick(ctx, {x, y, h=300, color='#fff', width=h/25, head=1, fill=null, flip=false, face:'happy'|'sad'|'surprised'|'angry'|null,
           pose:{armL, armR, legL, legR, body, neck}}) -> joints {head{x,y,r}, shoulder, hip, handL, handR, elbowL, elbowR, kneeL, kneeR, footL, footR}
     stick figure whose lowest foot is at (x,y); angles in degrees, 0 = straight down, + = towards screen right (flip mirrors);
     a limb may be [upper, bend] for elbows/knees; arms up = armL:-160, armR:160; defaults armL:-25 armR:25 legL:-12 legR:12.
  H.text(ctx, str, x, y, {size=80, color='#fff', font='Segoe UI', weight=800, align='center', stroke=null, strokeWidth=0})  (y = middle, "\\n" = new line)
  H.circle(ctx, x, y, r, fill, stroke, lw)   H.line(ctx, x1, y1, x2, y2, color, lw)   H.rect(ctx, x, y, w, h, fill, radius=0)
  H.poly(ctx, [[x,y],...], fill, stroke, lw)   H.glow(ctx, color, blur) neon glow for what follows (H.glow(ctx,null) = off)
  H.bg(ctx, w, h, c1, c2=null, angle=90) background colour / gradient (CSS angle: 90 = left→right, 180 = top→bottom)
Tips: use sizes relative to w/h; animate with t, H.seg + H.ease for timed beats; use ctx.save()/restore() for transforms.`;

/** Example drawing: two neon stick figures, one waves, the other jumps. */
export const STICK_EXAMPLE = `// Two neon stick figures: one waves, the other jumps.
H.bg(ctx, w, h, '#0b0620', '#1d0b45', 180);
for (let i = 0; i < 40; i++) {
  const tw = 0.5 + 0.5 * H.wave(t, 0.3 + H.rand(i, 3), 1, i);
  H.circle(ctx, H.rand(i, 1) * w, H.rand(i, 2) * h * 0.6, 2 + 3 * tw, 'rgba(255,255,255,' + (0.25 + 0.6 * tw) + ')');
}
const gy = h * 0.72;
const s = Math.min(w, h) * 0.42;
H.glow(ctx, '#00e5ff', 24);
H.line(ctx, w * 0.06, gy, w * 0.94, gy, '#00e5ff', 6);

// Left: waves at the other one
H.glow(ctx, '#ff3df2', 28);
const a = H.stick(ctx, { x: w * 0.3, y: gy, h: s, color: '#ff3df2', face: 'happy',
  pose: { armL: -20, armR: [110, 50 + H.wave(t, 2, 30)], body: H.wave(t, 0.5, 4) } });

// Right: jumps
const k = (t * 0.9) % 1;
const air = Math.sin(k * Math.PI);
H.glow(ctx, '#39ff88', 28);
H.stick(ctx, { x: w * 0.7, y: gy - air * s * 0.45, h: s, color: '#39ff88', flip: true,
  face: air > 0.6 ? 'surprised' : 'happy',
  pose: { armL: -30 - 130 * air, armR: 30 + 130 * air, legL: [-10 - 20 * air, 40 * air], legR: [10 + 20 * air, -40 * air] } });

// Speech bubble
const pop = H.ease(H.seg(t, 0.4, 0.8), 'elastic');
if (pop > 0) {
  ctx.save();
  ctx.translate(a.head.x + s * 0.2, a.head.y - s * 0.3);
  ctx.scale(pop, pop);
  H.glow(ctx, '#ffffff', 16);
  H.rect(ctx, -s * 0.28, -s * 0.1, s * 0.56, s * 0.2, '#ffffff', s * 0.06);
  H.glow(ctx, null);
  H.text(ctx, 'Hi!', 0, 0, { size: s * 0.12, color: '#1d0b45' });
  ctx.restore();
}
H.glow(ctx, '#ffd400', 30);
H.text(ctx, 'LET\\'S GO!', w / 2, h * 0.2, { size: w * 0.11, color: '#fff', stroke: '#ff3df2', strokeWidth: 6 });
H.glow(ctx, null);`;
