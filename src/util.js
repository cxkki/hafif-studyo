// Ortak küçük yardımcılar. Hiçbiri durum tutmaz (store hariç).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Modlar arası olay yolu (ör. "to-video"). */
export const bus = new EventTarget();

/** localStorage üzerinde küçük ayar deposu ("hs_" önekli). */
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('hs_' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('hs_' + key, JSON.stringify(value));
    } catch {}
  },
};

/** Uygulama geneli ayarlar. */
export const settings = { eco: store.get('eco', true) };

export function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove('show'), ms);
}

/** Tarayıcı dosya seçici (masaüstünde platform.openFiles tercih edilir). */
export function pickFilesBrowser(accept, multiple = true) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

export const fmtTime = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const uid = () => Math.random().toString(36).slice(2, 9);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Bir olayı zaman aşımıyla bekler; olay gelirse true döner. */
export const waitEvent = (target, ev, ms = 8000) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      target.removeEventListener(ev, done);
      resolve(true);
    };
    const t = setTimeout(() => {
      target.removeEventListener(ev, done);
      resolve(false);
    }, ms);
    target.addEventListener(ev, done);
  });

/** İlk desteklenen MediaRecorder türü; hiç MediaRecorder yoksa null, hiçbiri desteklenmiyorsa "". */
export function pickMime(list) {
  if (typeof MediaRecorder === 'undefined') return null;
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/** Klavye kısayollarını yazı alanlarında yutmamak için. */
export const isTyping = (e) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';

/** "Çalışıyor" penceresi (ilerleme çubuğu + iptal). */
export const busy = {
  show(title, onCancel) {
    const el = $('#busy');
    $('#busyTitle', el).textContent = title;
    $('#busyBar', el).style.width = '0%';
    $('#busyText', el).textContent = '';
    const c = $('#busyCancel', el);
    c.hidden = !onCancel;
    c.onclick = onCancel || null;
    el.hidden = !!busy.quiet;
  },
  progress(p, text) {
    $('#busyBar').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    if (text != null) $('#busyText').textContent = text;
    busy.onProgress?.(p, text);
  },
  hide() {
    $('#busy').hidden = true;
  },
  /** Ajan modu çalışırken modal pencere gösterilmez, ilerleme HUD'a gider. */
  quiet: false,
  onProgress: null,
};

/** Dosya uzantısı (küçük harf, noktasız). Uzantı yoksa "". */
export const extOf = (name) => {
  const base = String(name).split(/[?#]/)[0].split(/[\\/]/).pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};
export const baseName = (p) => String(p).split(/[\\/]/).pop();
export const stripExt = (n) => String(n).replace(/\.[^.]+$/, '');
