// Canlı video projesi uygulayıcısı (docs/CANLI.md → "Uygulayıcı arayüzü").
// Yönetici (src/live.js) proje.json'un önceki ve yeni hâlini verir; burada fark çıkarılır ve ajanlar
// GERÇEK arayüz işlemleriyle (kütüphaneden sürükleme, "Yazı ekle", panel alanları, "Sil") uygular.
// Sonunda kesin değerler API ile yazılır. Proje kimlikleri (c1/t1) ile video-mode'un iç klip kimlikleri
// farklıdır: eşleme modül içinde tutulur, snapshot() geri çevirir.
//
// Dosyanın "saf" bölümü (aşağıda <saf> … </saf>) DOM ya da içe aktarma kullanmaz; Node'da ayrıca test edilir.
import { $, sleep, busy } from './util.js';
import * as platform from './platform.js';
import { agents as agentsModule } from './agents.js';
import { t } from './i18n.js';
import { SHAPE_DEFAULTS, SHAPES } from './video-fx.js';
import { generateMusic, musicFileName, musicWavBytes } from './music-gen.js';

// <saf> ---------------------------------------------------------------- saf yardımcılar (DOM yok)

const RES_ALIAS = { vertical: '1080x1920', dikey: '1080x1920', horizontal: '1920x1080', yatay: '1920x1080', square: '1080x1080', kare: '1080x1080' };
const DEF = { resolution: '1080x1920', fps: 30, background: '#000000' };

/** Panelde/ API'de karşılığı olan alanlar (proje.json adlarıyla), panelde görünme sırasına göre. */
const CLIP_FIELDS = ['start', 'duration', 'in', 'speed', 'x', 'y', 'scale', 'rotation', 'opacity', 'fit', 'volume', 'fadeIn', 'fadeOut', 'transition', 'effects', 'motion', 'crop'];
const TEXT_FIELDS = [
  'text', 'start', 'duration', 'size', 'color', 'stroke', 'box', 'boxColor', 'anim', 'x', 'y', 'scale', 'opacity', 'fadeIn', 'fadeOut',
  'font', 'weight', 'italic', 'align', 'letterSpacing', 'lineHeight', 'rotation', 'strokeColor', 'strokeWidth',
  'shadow', 'shadowColor', 'shadowBlur', 'shadowDist', 'boxPad', 'boxRadius', 'boxOpacity',
];
/** Shape clips (clips[] entries with "kind": "shape", no media). */
const SHAPE_FIELDS = ['start', 'duration', 'shape', 'color', 'w', 'h', 'radius', 'x', 'y', 'scale', 'rotation', 'opacity', 'fadeIn', 'fadeOut', 'transition', 'effects', 'motion'];
/** Draw clips (clips[] entries with "kind": "draw", no media): "code" is the body of function (ctx, t, w, h, p, H). */
const DRAW_FIELDS = ['start', 'duration', 'code', 'x', 'y', 'scale', 'rotation', 'opacity', 'fadeIn', 'fadeOut', 'transition', 'effects', 'motion'];
const MUSIC_FIELDS = ['start', 'duration', 'in', 'speed', 'volume', 'fadeIn', 'fadeOut'];
/** Yeni (kullanıcının arayüzde eklediği) klipler snapshot'ta bu alanlarla yazılır. */
const FRESH_FIELDS = {
  video: CLIP_FIELDS,
  image: ['start', 'duration', 'x', 'y', 'scale', 'rotation', 'opacity', 'fit', 'fadeIn', 'fadeOut', 'transition', 'effects', 'motion', 'crop'],
  audio: ['start', 'duration', 'in', 'speed', 'volume', 'fadeIn', 'fadeOut'],
  text: TEXT_FIELDS,
  shape: SHAPE_FIELDS,
  draw: DRAW_FIELDS,
};
/** Optional (newer) fields: left out of freshly written items while they hold these defaults. */
const OPTIONAL_DEFAULTS = {
  speed: 1, rotation: 0, transition: null, effects: null, motion: null, crop: null,
  font: 'Segoe UI', weight: 800, italic: false, align: 'center', letterSpacing: 0, lineHeight: 1.15,
  strokeColor: '#000000', strokeWidth: 0.14, shadow: false, shadowColor: '#000000', shadowBlur: 0.3, shadowDist: 0.08,
  boxPad: 0.35, boxRadius: 0.25, boxOpacity: 0.8,
};
/** Object-valued fields (animated sub-field by sub-field in the panel). */
const OBJ_KEYS = new Set(['transition', 'effects', 'motion', 'crop']);
const TRACK_FLAG_NAMES = { t: ['hide', 'lock'], v2: ['mute', 'hide', 'lock'], v1: ['mute', 'hide', 'lock'], a: ['mute', 'lock'] };
const MUSIC_KEY = 'm:music';
const MUSIC_DEFAULTS = { start: 0, in: 0, volume: 0.8, fadeIn: 0.3, fadeOut: 1.5 };

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileOf = (p) => String(p).split(/[\\/]/).pop();
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const eqv = (a, b) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && same(a, b));
/** Field list of a project item: text / music / shape clip / media clip. */
const fieldsFor = (kind, item) =>
  kind === 'text' ? TEXT_FIELDS : kind === 'music' ? MUSIC_FIELDS : item?.kind === 'shape' ? SHAPE_FIELDS : item?.kind === 'draw' ? DRAW_FIELDS : CLIP_FIELDS;
/** Clip kinds without media (built from their own fields). */
const isSynthKind = (k) => k === 'shape' || k === 'draw';
/** Draw clip code as video-mode takes it: a string (an array of lines is joined). */
const codeStr = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).join('\n') : v == null ? '' : String(v));
/** Music generated from parameters ("music": {"generate": {...}}), not from a file. */
const isGenMusic = (m) => isObj(m) && m.generate != null && m.generate !== false && (m.media == null || m.media === '') && (m.file == null || m.file === '');
/** "generate": {...} | "lofi" | true → generator parameters (style, bpm, seed, key). */
function genParams(m) {
  const g = isObj(m) ? m.generate : null;
  if (isObj(g)) return { style: g.style, bpm: g.bpm, seed: g.seed, key: g.key };
  return typeof g === 'string' ? { style: g } : {};
}

/** "markers": [1.5, {"time": 4}] → sorted unique seconds. */
function normMarkers(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const v of list) {
    const n = isObj(v) ? +(v.time ?? v.t) : +v;
    if (Number.isFinite(n) && n >= 0) out.add(Math.round(n * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

/** "tracks": {"v1": {"mute": true}} → only known tracks/flags that are true (muted/hidden/locked also accepted). */
function normTracks(obj) {
  const out = {};
  if (!isObj(obj)) return out;
  const alias = { muted: 'mute', hidden: 'hide', locked: 'lock' };
  for (const [track, flags] of Object.entries(TRACK_FLAG_NAMES)) {
    const src = obj[track];
    if (!isObj(src)) continue;
    const f = {};
    for (const [k, v] of Object.entries(src)) {
      const name = alias[k] || k;
      if (flags.includes(name) && v === true) f[name] = true;
    }
    if (Object.keys(f).length) out[track] = Object.fromEntries(flags.filter((x) => f[x]).map((x) => [x, true]));
  }
  return out;
}
const isAuto = (d) => d == null || d === 'auto';

/** "vertical" / [1080,1920] / "1080×1920" → "1080x1920"; boşsa null. */
function normRes(r) {
  if (r == null || r === '') return null;
  if (Array.isArray(r)) r = r.join('x');
  const s = String(r).trim().toLowerCase();
  if (RES_ALIAS[s]) return RES_ALIAS[s];
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(s);
  return m ? `${m[1]}x${m[2]}` : String(r);
}

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
/** Dosya adından medya kimliği: "Oyun Kaydı.mp4" → "oyun-kaydi". */
function keyFromFile(p) {
  const base = fileOf(p).replace(/\.[^.]+$/, '');
  const s = base
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => TR_MAP[c])
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'medya';
}
const uniqueKey = (base, taken) => {
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}-${n}`;
  return k;
};
const nextId = (prefix, taken) => {
  let n = 1;
  while (taken.has(prefix + n)) n++;
  taken.add(prefix + n);
  return prefix + n;
};

/**
 * Kimlikleri eksik öğelere atanmış kopya. media her zaman nesne biçiminde ({kimlik: yol});
 * kliplerde/müzikte doğrudan dosya yolu verilmişse medyaya eklenir ve kimlikle değiştirilir.
 * Girdiyi değiştirmez.
 */
function normalize(proj) {
  const p = isObj(proj) ? clone(proj) : {};
  const media = {};
  const taken = new Set();
  const put = (key, path) => {
    media[key] = path;
    taken.add(key);
  };
  if (Array.isArray(p.media)) {
    p.media.forEach((m, i) => {
      const path = typeof m === 'string' ? m : isObj(m) ? (m.path ?? m.file ?? m.src) : null;
      if (path == null || path === '') return;
      const want = isObj(m) && (m.id ?? m.key) != null ? String(m.id ?? m.key) : keyFromFile(path) || `m${i + 1}`;
      put(uniqueKey(want, taken), String(path));
    });
  } else if (isObj(p.media)) {
    for (const [k, v] of Object.entries(p.media)) {
      const path = isObj(v) ? (v.path ?? v.file ?? v.src) : v;
      if (path != null && path !== '') put(k, String(path));
    }
  }
  p.media = media;
  const refKey = (ref) => {
    ref = String(ref);
    if (has(media, ref)) return ref;
    const np = normPath(ref);
    const hit = Object.keys(media).find((k) => normPath(media[k]) === np);
    if (hit) return hit;
    const k = uniqueKey(keyFromFile(ref), taken);
    put(k, ref);
    return k;
  };

  const fixList = (list, prefix, withMedia) => {
    const ids = new Set();
    const items = list.filter(isObj).map((c) => {
      const o = { ...c };
      const id = o.id != null && o.id !== '' ? String(o.id) : null;
      if (id != null && !ids.has(id)) {
        ids.add(id);
        o.id = id;
      } else delete o.id;
      // A clip without media but with a "shape" is a shape clip even when "kind" is left out;
      // one with "code" (and no media or shape) is a draw clip.
      if (withMedia && o.kind == null && o.media == null && o.file == null) {
        if (typeof o.shape === 'string') o.kind = 'shape';
        else if (typeof o.code === 'string' || Array.isArray(o.code)) o.kind = 'draw';
      }
      if (withMedia && !isSynthKind(o.kind)) {
        const ref = o.media ?? o.file;
        if (ref != null && ref !== '') o.media = refKey(ref);
        delete o.file;
      }
      return o;
    });
    return items.map((o) => (o.id != null ? o : { id: nextId(prefix, ids), ...o }));
  };
  if (Array.isArray(p.clips)) p.clips = fixList(p.clips, 'c', true);
  if (Array.isArray(p.texts)) p.texts = fixList(p.texts, 't', false);

  if (typeof p.music === 'string' && p.music) p.music = { media: refKey(p.music) };
  else if (isObj(p.music)) {
    const ref = p.music.media ?? p.music.file;
    if (ref != null && ref !== '') {
      p.music = { ...p.music, media: refKey(ref) };
      delete p.music.file;
    }
  }
  return p;
}

/** Proje ayarlarının etkin (varsayılanlı) değerleri. */
function effSettings(p) {
  return {
    resolution: normRes(p.resolution) || DEF.resolution,
    fps: +p.fps > 0 ? +p.fps : DEF.fps,
    background: String(p.background || DEF.background).toLowerCase(),
  };
}

/**
 * Fark planı. prev null ise sıfırdan kurulum (her şey eklenir).
 * st: { alive(key) → bool (eşlenmiş ve arayüzde duran öğe), specOf(key) → son uygulanan/okunan proje öğesi,
 *       loaded: Map<medyaKimliği, yol> (kütüphanede olan), changed: Set<medyaKimliği> (dosyası değişen) }
 * İşlemler: settings · media · remove · add · replace (sil+ekle) · update (yalnız değişen alanlar).
 * Anahtarlar: "c:<id>" klip, "t:<id>" yazı, "m:music" müzik.
 */
function diffPlan(prev, next, st) {
  const P = prev ? normalize(prev) : null;
  const N = normalize(next);
  const ops = [];

  const en = effSettings(N);
  const ep = P ? effSettings(P) : null;
  const set = {};
  for (const k of Object.keys(en)) if (!ep || ep[k] !== en[k]) set[k] = en[k];
  if (Object.keys(set).length) ops.push({ op: 'settings', set });

  // Timeline markers and track flags (mute / hide / lock).
  const nMk = normMarkers(N.markers);
  if (!same(nMk, P ? normMarkers(P.markers) : [])) ops.push({ op: 'markers', markers: nMk });
  const nTr = normTracks(N.tracks);
  if (!same(nTr, P ? normTracks(P.tracks) : {})) ops.push({ op: 'tracks', tracks: nTr });

  const reload = new Set();
  for (const [key, path] of Object.entries(N.media)) {
    const had = st.loaded.get(key);
    if (had == null || normPath(had) !== normPath(path) || st.changed.has(key)) {
      ops.push({ op: 'media', key, path, replace: had != null });
      if (had != null) reload.add(key);
    }
  }

  const list = (p, f) => (p && Array.isArray(p[f]) ? p[f] : []);
  const diffItems = (kind, prefix, pl, nl) => {
    const nids = new Set(nl.map((c) => c.id));
    for (const c of pl) if (!nids.has(c.id) && st.alive(prefix + c.id)) ops.push({ op: 'remove', kind, key: prefix + c.id });
    const pm = new Map(pl.map((c) => [c.id, c]));
    for (const item of nl) diffOne(kind, prefix + item.id, pm.get(item.id), item);
  };
  const diffOne = (kind, key, prevItem, item) => {
    const base = st.alive(key) ? (st.specOf(key) ?? prevItem) : null;
    if (!base) return ops.push({ op: 'add', kind, key, spec: item });
    if (
      kind !== 'text' &&
      (String(base.media) !== String(item.media) ||
        (base.track || '') !== (item.track || '') ||
        (base.kind || '') !== (item.kind || '') ||
        reload.has(item.media) ||
        // Generated music: new generator parameters (or file ↔ generated) make a new piece.
        (kind === 'music' && (isGenMusic(base) !== isGenMusic(item) || (isGenMusic(item) && !same(base.generate, item.generate)))))
    )
      return ops.push({ op: 'replace', kind, key, spec: item });
    const changed = fieldsFor(kind, item).filter((f) => !same(base[f], item[f]));
    if (changed.length) ops.push({ op: 'update', kind, key, spec: item, changed });
  };
  diffItems('clip', 'c:', list(P, 'clips'), list(N, 'clips'));
  diffItems('text', 't:', list(P, 'texts'), list(N, 'texts'));
  const nm = isObj(N.music) ? N.music : null;
  if (!nm) {
    if (st.alive(MUSIC_KEY)) ops.push({ op: 'remove', kind: 'music', key: MUSIC_KEY });
  } else diffOne('music', MUSIC_KEY, P && isObj(P.music) ? P.music : null, nm);

  const rank = { settings: 0, markers: 0, tracks: 0, media: 1, remove: 2 };
  const sorted = ops.map((o, i) => [rank[o.op] ?? 3, i, o]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  return { ops: sorted, next: N };
}

/** video-mode publicClip alanı → proje.json alanı. */
function pubVal(pub, f) {
  if (!pub) return undefined;
  if (f === 'duration') return pub.dur;
  if (f === 'in') return pub.inP;
  if (f === 'volume') return pub.vol;
  if (f === 'box') return pub.bg;
  if (f === 'boxColor') return pub.bgColor;
  return pub[f];
}

/** Uygulanan öğe (spec) + uygulandığı andaki klip (base) + şimdiki klip (pub) → proje öğesi. Yalnız kullanıcının değiştirdiği alanlar yeniden yazılır. */
function mergeSnap(spec, base, pub, fields) {
  const out = { ...spec };
  for (const f of fields) {
    const cur = pubVal(pub, f);
    if (cur === undefined) continue;
    if (!base || !eqv(cur, pubVal(base, f))) out[f] = r3(cur);
  }
  return out;
}

/** Kullanıcının arayüzde eklediği klip → proje öğesi (tüm alanlar). */
function freshSnap(pub, id, mediaKey) {
  const out = { id };
  if (isSynthKind(pub.kind)) {
    out.kind = pub.kind;
    out.track = pub.track;
  } else if (pub.kind !== 'text') {
    if (mediaKey != null) out.media = mediaKey;
    out.track = pub.track;
  }
  for (const f of FRESH_FIELDS[pub.kind] || CLIP_FIELDS) {
    const v = pubVal(pub, f);
    if (v === undefined) continue;
    if (has(OPTIONAL_DEFAULTS, f) && eqv(v, OPTIONAL_DEFAULTS[f])) continue;
    if (v === null) continue;
    out[f] = r3(v);
  }
  return out;
}

/** env.mediaChanged (kimlik ya da göreli/mutlak yol listesi) → değişen medya kimlikleri. */
function mediaChangedKeys(mc, media) {
  const keys = new Set();
  if (!mc) return keys;
  const arr = typeof mc === 'string' ? [mc] : [...mc];
  for (const v of arr) {
    if (has(media, v)) {
      keys.add(v);
      continue;
    }
    const nv = normPath(v);
    for (const [k, p] of Object.entries(media)) {
      const np = normPath(p);
      if (np === nv || nv.endsWith('/' + np)) keys.add(k);
    }
  }
  return keys;
}

/** Mutlak yol proje klasörünün içindeyse göreli yap. */
function relPath(p, dir) {
  if (!p) return null;
  const np = String(p).replace(/\\/g, '/');
  const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (d && np.toLowerCase().startsWith(d.toLowerCase() + '/')) return np.slice(d.length + 1);
  return np;
}

export const _pure = { normalize, normRes, keyFromFile, diffPlan, mergeSnap, freshSnap, pubVal, mediaChangedKeys, relPath, effSettings, normMarkers, normTracks, isGenMusic, genParams, codeStr };
// </saf> ---------------------------------------------------------------

export { normalize };

// ---------------------------------------------------------------- modül durumu

/** Proje anahtarı ("c:c1", "t:t1", "m:music") ↔ video-mode klip kimliği; medya kimliği → kütüphane öğesi. */
const S = {
  entries: new Map(), // key -> { iid, spec, base }  (spec: proje öğesi, base: uygulandığı andaki publicClip)
  byIid: new Map(), // iid -> key
  media: new Map(), // medya kimliği -> { m, path }
  retired: new Map(), // kütüphaneden kaldırılan medya (m.id) -> { key, path }: geri alınırsa aynı adla yazılır
  proj: null, // son uygulanan / okunan proje (normalize edilmiş)
  applying: 0, // süren apply sayısı (dışa aktarma bekler)
  // Generated music ("music": {"generate": {...}}): never part of "media" in proje.json.
  gen: new Map(), // file name (musicFileName) -> { m (library item), full (absolute path on disk | null), wrote (this session wrote the file) }
  genMids: new Map(), // library id -> file name of every generated piece (kept out of the snapshot's "media", also after undo)
  genLock: null, // Promise while a generated piece is being (re)built outside apply
  genT: 0, // timer of a refresh queued by snapshot()
};

function reset() {
  S.entries.clear();
  S.byIid.clear();
  S.media.clear();
  S.retired.clear();
  S.gen.clear();
  S.genMids.clear();
  clearTimeout(S.genT);
  S.genT = 0;
  S.proj = null;
}

function register(key, iid, spec) {
  const old = S.entries.get(key);
  if (old && old.iid !== iid && S.byIid.get(old.iid) === key) S.byIid.delete(old.iid);
  S.entries.set(key, { iid, spec: clone(spec), base: null });
  S.byIid.set(iid, key);
}

function unregister(key) {
  const e = S.entries.get(key);
  if (!e) return;
  if (S.byIid.get(e.iid) === key) S.byIid.delete(e.iid);
  S.entries.delete(key);
}

const agentsOf = (env) => {
  const a = env?.agents;
  if (a && typeof a.pick === 'function') return a;
  if (a?.agents && typeof a.agents.pick === 'function') return a.agents;
  return agentsModule;
};

const fmtNum = (v) => String(+(+v).toFixed(2));
const setVal = (el, v, ev = 'input') => {
  el.value = v;
  el.dispatchEvent(new Event(ev, { bubbles: true }));
};
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));

/** Ajan adımları (recipe.js makeDirector'ın sadeleştirilmiş kopyası). Yalnız show=true iken kullanılır. */
function makeDirector(A) {
  return {
    pick: (role) => A.pick(role),
    async click(ag, el, real = true) {
      if (el) await A.click(ag, el, { real });
    },
    async type(ag, el, text) {
      if (el) await A.typeInto(ag, el, String(text));
    },
    async slide(ag, el, v) {
      if (el && v != null && Number.isFinite(+v)) await A.slide(ag, el, +v);
    },
    async color(ag, el, v) {
      if (!el || !isHex(v)) return;
      await A.click(ag, el, { real: false });
      setVal(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    async choose(ag, el, v) {
      if (!el || v == null) return;
      await A.click(ag, el, { real: false });
      if (![...el.options].some((o) => o.value === String(v))) return;
      setVal(el, String(v));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    flash(ag, target, label, hold = 900, extra = {}) {
      if (target) A.select(ag, target, { label, hold, ...extra });
    },
    wait: (ms) => sleep(typeof A.dur === 'function' ? A.dur(ms) : ms),
  };
}

/** Proje alanı → panel girdisi (data-k). */
const PANEL_KEY = { duration: 'dur', in: 'inP', volume: 'vol', box: 'bg', boxColor: 'bgColor' };
const panelEl = (field) => $(`#v-props [data-k="${PANEL_KEY[field] || field}"]`);

/**
 * Paneldeki bir alanı ajanla değiştirir (sayı: yazar, kaydırıcı: kaydırır, renk/seçim: tıklar).
 * ok(): panel hâlâ hedef klibe mi ait (kullanıcı bu sırada başka klip seçtiyse adım atlanır).
 */
async function uiField(D, ag, field, value, ok = () => true) {
  if (!ok()) return;
  const el = panelEl(field);
  if (!el || value === undefined || value === null) return;
  // Fields in a collapsed panel section: open it first so the agent can be seen working there.
  const det = el.closest('details');
  if (det && !det.open) {
    det.open = true;
    await D.wait(140);
    if (!ok()) return;
  }
  const tag = el.tagName;
  const type = String(el.type || '').toLowerCase();
  if (tag === 'TEXTAREA') {
    // Metin baştan yazılır: önce temizle (görünür), sonra harf harf.
    setVal(el, '');
    await D.wait(160);
    if (!ok()) return;
    await D.type(ag, panelEl(field) || el, String(value));
  } else if (tag === 'SELECT') await D.choose(ag, el, value);
  else if (type === 'number') {
    if (Number.isFinite(+value)) await D.type(ag, el, fmtNum(value));
  } else if (type === 'range') await D.slide(ag, el, value);
  else if (type === 'color') await D.color(ag, el, value);
  else if (type === 'checkbox') {
    if (el.checked !== !!value) await D.click(ag, el, true);
  }
}

/** Panel button inside the properties panel (opens its collapsed section first). */
async function uiButton(D, ag, sel) {
  const b = $(`#v-props ${sel}`);
  if (!b) return;
  const det = b.closest('details');
  if (det && !det.open) {
    det.open = true;
    await D.wait(140);
  }
  await D.click(ag, $(`#v-props ${sel}`) || b, true);
}

/**
 * Object fields (effects / transition / motion / crop): the agent edits the visible sub-fields one by one
 * (look buttons, type select, sliders, from/to numbers). The exact value is applied afterwards via the API.
 */
async function uiObjField(D, ag, field, value, ok = () => true) {
  if (!ok()) return;
  if (field === 'effects') {
    if (typeof value === 'string') return uiButton(D, ag, `[data-look="${CSS.escape(value.toLowerCase().replace(/[^a-z]/g, ''))}"]`);
    if (!isObj(value)) return uiButton(D, ag, '[data-act="fx-reset"]');
    for (const k of Object.keys(value).slice(0, 5)) if (ok()) await uiField(D, ag, 'effects.' + k, value[k], ok);
  } else if (field === 'transition') {
    const tv = typeof value === 'string' ? { type: value } : isObj(value) ? value : { type: 'none' };
    await uiField(D, ag, 'transition.type', tv.type || 'crossfade', ok);
    if (tv.duration != null && ok()) await uiField(D, ag, 'transition.duration', tv.duration, ok);
  } else if (field === 'motion') {
    if (!isObj(value)) return uiButton(D, ag, `[data-motion="${CSS.escape(typeof value === 'string' ? value : 'off')}"]`);
    // No motion yet: a preset creates the From/To fields, then the values are typed in.
    if (!panelEl('motion.to.scale')) await uiButton(D, ag, '[data-motion="zoom-in"]');
    for (const end of ['from', 'to'])
      for (const k of ['scale', 'x', 'y', 'rotation']) if (isObj(value[end]) && value[end][k] != null && ok()) await uiField(D, ag, `motion.${end}.${k}`, value[end][k], ok);
  } else if (field === 'crop' && isObj(value)) {
    for (const k of ['l', 't', 'r', 'b']) if (value[k] != null && ok()) await uiField(D, ag, 'crop.' + k, value[k], ok);
  }
}

const codeBox = () => $('#v-props [data-draw-code]');

/**
 * Draw clip code: the agent clears the panel's code box, types the first lines, the rest appears at once
 * ("pasted"), then it points at Apply. The exact code is set through the API by the caller.
 */
async function uiCode(D, ag, code, ok = () => true) {
  if (!ok()) return;
  const el = codeBox();
  if (!el) return;
  const full = codeStr(code);
  const lines = full.split('\n');
  let head = lines.slice(0, 4).join('\n');
  if (head.length > 240) head = head.slice(0, 240);
  setVal(el, '');
  await D.wait(140);
  if (!ok()) return;
  await D.type(ag, codeBox() || el, head);
  if (!ok()) return;
  const box = codeBox();
  if (box && head.length < full.length) {
    setVal(box, full);
    await D.wait(220);
  }
  if (ok()) await D.click(ag, $('#v-props [data-act="draw-apply"]'), false);
}

/** After the exact code was set: the panel's code box shows it too, so no stale "not applied" draft stays behind. */
function syncCodeBox(api, iid, code) {
  if (api.selected && api.selected() !== iid) return;
  const el = codeBox();
  if (el && el.value !== code) setVal(el, code);
}

/** Any field: object fields go sub-field by sub-field; draw code is typed into the code box. */
const uiAny = (D, ag, field, value, ok) =>
  field === 'code' ? uiCode(D, ag, value, ok) : OBJ_KEYS.has(field) ? uiObjField(D, ag, field, value, ok) : uiField(D, ag, field, value, ok);

/** Clip speed as video-mode applies it (0.25–4, rounded to 0.001); anything else is 1. */
const speedVal = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(4, Math.max(0.25, n)) * 1000) / 1000 : 1;
};

/** Müzik "auto" süresi: diğer kliplerin sonuna kadar (medyanın kalan süresini — hızına göre — aşmadan). */
function autoMusicDur(api, m, start, inP, exceptIid, speed = 1) {
  const end = api.clips().reduce((mx, c) => (c.id === exceptIid ? mx : Math.max(mx, c.start + c.dur)), 0);
  const avail = Math.max(0.1, ((m?.dur || 0) - inP) / speedVal(speed));
  return end - start > 0.1 ? Math.min(end - start, avail) : avail;
}

/**
 * Müzik süresi "auto" ise ve kullanıcı müziğin süresine elle dokunmadıysa müziği videonun sonuna uydurur
 * (ör. kullanıcı arayüzde videoyu kısalttı). Değiştiyse true; commit çağırana kalır.
 */
function syncAutoMusic(api) {
  const e = S.entries.get(MUSIC_KEY);
  if (!e || !e.base || !isObj(e.spec) || !isAuto(e.spec.duration)) return false;
  const pub = api.clips().find((c) => c.id === e.iid);
  if (!pub || !eqv(pub.dur, e.base.dur)) return false;
  const m = api.media().find((x) => x.id === pub.mid) || S.media.get(e.spec.media)?.m;
  if (!m) return false;
  const want = autoMusicDur(api, m, pub.start, pub.inP, e.iid, pub.speed);
  if (Math.abs(pub.dur - want) <= 0.01) return false;
  const np = api.updateClip(e.iid, { duration: want });
  const nd = np?.dur ?? want;
  e.base = { ...e.base, dur: nd };
  // Clamped to the same length (nothing changed): no commit, so no empty history entry.
  return Math.abs(nd - pub.dur) > 0.01;
}

// ---------------------------------------------------------------- generated music ("music": {"generate": {...}})

/**
 * Seconds a generated piece must cover: its "in" + duration × speed; "auto" = up to the end of the other clips
 * (30 s while there is nothing else). Rounded up to 0.5 s so tiny timeline edits reuse the same file; 3..180 s.
 */
function genSeconds(api, spec, exceptIid) {
  const sp = speedVal(spec.speed);
  const inP = Math.max(0, +spec.in || 0);
  const st = Math.max(0, +spec.start || 0);
  let d;
  if (isAuto(spec.duration)) {
    const end = api.clips().reduce((mx, c) => (c.id === exceptIid ? mx : Math.max(mx, c.start + c.dur)), 0);
    d = end - st > 0.1 ? end - st : 30;
  } else d = +spec.duration > 0 ? +spec.duration : 30;
  return Math.min(180, Math.max(3, Math.ceil((inP + d * sp) * 2 - 1e-6) / 2));
}

/**
 * The library item of a generated piece. Desktop: <project>/medya/<musicFileName> is reused when it exists,
 * otherwise the piece is rendered and saved there. Browser (or no project folder): the WAV stays in memory.
 * @returns {Promise<{m, name}>}
 */
async function genMedia(api, env, spec, seconds) {
  const params = genParams(spec);
  const name = musicFileName(params, seconds);
  const hit = S.gen.get(name);
  if (hit && api.media().some((x) => x.id === hit.m.id)) return { m: hit.m, name };
  let file = null;
  let full = null;
  let wrote = false;
  if (platform.isNative() && env?.dir) {
    const rel = 'medya/' + name;
    full = String(typeof env.resolve === 'function' ? env.resolve(rel) : platform.resolvePath(rel, env.dir)).replace(/\\/g, '/');
    try {
      if (await platform.exists(full)) file = await platform.readBlob(full);
    } catch {
      file = null;
    }
    // A cached file cut short (e.g. the app closed while it was being written) is rendered again, not reused.
    if (file && file.size !== musicWavBytes(seconds)) file = null;
  }
  if (!file) {
    const blob = await generateMusic({ ...params, duration: seconds });
    if (full) {
      try {
        await platform.writeBlob(full, blob);
        wrote = true;
      } catch (e) {
        console.warn('[canlı video] music cache', e);
        full = null;
      }
    }
    file = new File([blob], name, { type: 'audio/wav' });
    if (full) file.path = full;
  }
  const m = await api.addMedia(file, name, 'audio');
  if (!m) throw new Error(t('live.video.genMusicFailed', 'Could not generate the music'));
  S.gen.set(name, { m, full: wrote || file.path ? full : null, wrote });
  S.genMids.set(m.id, name);
  return { m, name };
}

/**
 * Generated pieces that no clip uses any more leave the library; a file this session wrote for one is deleted
 * (it can always be rendered again from proje.json). keep: the file name in use.
 */
function dropGen(api, keep) {
  for (const [name, g] of [...S.gen]) {
    if (name === keep || api.clips().some((c) => c.mid === g.m.id)) continue;
    if (!api.removeMedia?.(g.m.id)) continue;
    S.gen.delete(name);
    if (g.wrote && g.full && platform.isNative()) platform.removeFile(g.full).catch(() => {});
  }
}

/**
 * Generated music whose needed length (or parameters) no longer matches its file: render the right piece and
 * swap it in, keeping the clip's start / in / speed / volume / fades. Returns true when the clip was replaced
 * (no history entry: the caller commits when it wants one).
 */
async function refreshGenMusic(api, env) {
  const e = S.entries.get(MUSIC_KEY);
  if (!e || !isGenMusic(e.spec)) return false;
  const pub = api.clips().find((c) => c.id === e.iid);
  if (!pub) return false;
  const spec = e.spec;
  const sec = genSeconds(api, spec, e.iid);
  if (e.gen === musicFileName(genParams(spec), sec) && api.media().some((x) => x.id === pub.mid)) return false;
  const { m, name } = await genMedia(api, env, spec, sec);
  // The timeline may have moved on while the piece was rendered.
  const cur = S.entries.get(MUSIC_KEY) === e ? api.clips().find((c) => c.id === e.iid) : null;
  if (!cur) return false;
  const speed = cur.speed ?? 1;
  const opts = { track: 'a', start: cur.start, in: cur.inP, volume: cur.volume ?? cur.vol, fadeIn: cur.fadeIn, fadeOut: cur.fadeOut };
  if (speed !== 1) opts.speed = speed;
  opts.duration = isAuto(spec.duration) ? autoMusicDur(api, m, cur.start, cur.inP, e.iid, speed) : +spec.duration > 0 ? +spec.duration : cur.dur;
  const clip = api.addClip(m, opts);
  api.removeClip(e.iid);
  if (S.byIid.get(e.iid) === MUSIC_KEY) S.byIid.delete(e.iid);
  e.iid = clip.id;
  e.gen = name;
  S.byIid.set(clip.id, MUSIC_KEY);
  const np = api.clips().find((c) => c.id === clip.id) || clip;
  // Only the swap itself is "applied": a not yet written user change on the music stays a user change.
  e.base = e.base ? { ...e.base, id: np.id, mid: np.mid, dur: np.dur } : np;
  dropGen(api, name);
  return true;
}

/**
 * snapshot(): the user changed the video length under "auto" generated music, so its file is now too short or
 * too long. The new piece is rendered in the background (no idle work: a single timer), never during an apply.
 */
function queueGenRefresh(api, env) {
  const e = S.entries.get(MUSIC_KEY);
  if (!e || !isGenMusic(e.spec) || S.genT) return;
  const pub = api.clips().find((c) => c.id === e.iid);
  // Same check as refreshGenMusic: also when the piece's library item is gone (e.g. dropped, then the clip came back by undo).
  if (!pub || (e.gen === musicFileName(genParams(e.spec), genSeconds(api, e.spec, e.iid)) && api.media().some((x) => x.id === pub.mid))) return;
  S.genT = setTimeout(() => {
    S.genT = 0;
    // An apply or a (real-time) export is running: try again afterwards.
    if (S.applying > 0 || api.exporting?.()) return void queueGenRefresh(api, env);
    S.applying++;
    S.genLock = refreshGenMusic(api, env)
      .catch((err) => {
        console.warn('[canlı video] music', err);
        env?.note?.(t('live.video.note', 'Video: {msg}', { msg: err?.message || String(err) }));
      })
      .finally(() => {
        S.applying--;
        S.genLock = null;
      });
  }, 500);
}

// ---------------------------------------------------------------- uygulama

/**
 * prev → next farkını ajanlarla uygular. prev null ise sıfırdan kurulum.
 * @returns {{changes:number, errors:string[]}}
 */
export async function apply(prev, next, env) {
  S.applying++;
  try {
    return await applyImpl(prev, next, env);
  } finally {
    S.applying--;
  }
}

async function applyImpl(prev, next, env) {
  const api = env.modes.mvid.api;
  const A = agentsOf(env);
  // Dışa aktarma gerçek zamanlı kayıttır: zaman çizelgesi kaydın ortasında değişmesin, bitmesi beklenir.
  while (api.exporting?.()) await sleep(250);
  // A generated piece being swapped in the background finishes first (it changes the music clip).
  if (S.genLock) await S.genLock;
  if (!prev) {
    reset();
    api.clear();
  }
  env.switchTab?.('mvid');
  await sleep(30);

  const libIds = new Set(api.media().map((m) => m.id));
  for (const [k, v] of S.media) if (!libIds.has(v.m.id)) S.media.delete(k);
  for (const [k, v] of S.gen) if (!libIds.has(v.m.id)) S.gen.delete(k);
  const aliveNow = () => new Set(api.clips().map((c) => c.id));
  let aliveIids = aliveNow();
  const alive = (key) => {
    const e = S.entries.get(key);
    return !!e && aliveIids.has(e.iid);
  };
  const N0 = normalize(next);
  const { ops, next: N } = diffPlan(prev, next, {
    alive,
    specOf: (k) => S.entries.get(k)?.spec,
    loaded: new Map([...S.media].map(([k, v]) => [k, v.path])),
    changed: mediaChangedKeys(env.mediaChanged, N0.media),
  });

  const show = env.show !== false && env.speed !== 'instant';
  const D = show ? makeDirector(A) : null;
  let startedHud = false;
  if (show && ops.length && !A.active) {
    A.start({ count: 12, mode: 'video', title: N.name || 'video', total: ops.length, speed: env.speed });
    startedHud = true;
  }
  const errors = [];
  // Dokunulan öğe → uygulanan alanlar (proje adlarıyla); null: tümü (ekleme/değiştirme).
  const touched = new Map();
  const touch = (key, fields) => {
    if (!fields) return void touched.set(key, null);
    if (touched.has(key) && touched.get(key) === null) return;
    const s = touched.get(key) || new Set();
    for (const f of fields) s.add(f);
    touched.set(key, s);
  };
  const staleMedia = new Map(); // eski m.id -> { key, path }
  const dirty = ops.length > 0;
  const total = ops.length;
  if (show && total) A.progress(0, total, t('live.video.changes', 'changes'));

  const pubOf = (iid) => api.clips().find((c) => c.id === iid) || null;
  const mediaFor = (key) => S.media.get(key)?.m || null;
  /**
   * Where a main-track (v1) clip without "start" lands on reopen: after every v1 clip that comes before it
   * in "clips" (reopen adds them in order and video-mode appends each at the track's end).
   */
  const seqStartV1 = (key) => {
    let end = 0;
    for (const c of N.clips || []) {
      const k = 'c:' + c.id;
      if (k === key) break;
      const e = S.entries.get(k);
      const p = e && pubOf(e.iid);
      if (p && p.track === 'v1') end = Math.max(end, p.start + p.dur);
    }
    return end;
  };

  // ---- yardımcılar (closure: api, D, show)
  const scrollToTime = async (tm) => {
    const sc = api.el.scroll?.() || $('#v-tls');
    if (!sc || !Number.isFinite(+tm)) return;
    const px = api.el.timeToX(+tm) - api.el.timeToX(0);
    if (px >= sc.scrollLeft + 20 && px <= sc.scrollLeft + sc.clientWidth - 80) return;
    const left = Math.max(0, px - sc.clientWidth * 0.3);
    if (show) {
      sc.scrollTo({ left, behavior: 'smooth' });
      await D.wait(260);
    } else sc.scrollLeft = left;
  };
  const peek = (start, dur) => {
    if (show) api.seek(+start + Math.min(0.4, (+dur || 1) / 2));
  };

  /**
   * Arayüz adımından hemen önce: hedef klip seçili değilse (kullanıcı bu sırada başkasını seçtiyse) yeniden seçer.
   * Yine de seçili değilse false (arayüz adımı atlanır; kesin değerler API ile yazılır).
   */
  const ensureSel = (iid) => {
    if (api.selected?.() !== iid) api.select(iid);
    return (api.selected ? api.selected() : iid) === iid && !!pubOf(iid);
  };
  const selOk = (iid) => () => (api.selected ? api.selected() === iid : true);

  /** Proje öğesi → api seçenekleri (yalnız verilen alanlar). */
  const optsOf = (kind, spec, fields, m, exceptIid, fresh = false) => {
    const o = {};
    for (const f of fields) if (spec[f] !== undefined) o[f] = spec[f];
    if (kind === 'text') {
      if (has(o, 'text')) o.text = String(o.text ?? '');
    } else if (has(o, 'code')) {
      o.code = codeStr(o.code);
    } else if (kind === 'music') {
      for (const [k, v] of Object.entries(MUSIC_DEFAULTS)) if (fields.includes(k) && o[k] === undefined) o[k] = v;
      if (fields.includes('duration') && isAuto(spec.duration)) {
        // Speed being applied now, else the clip's live speed, else the file's.
        const live = exceptIid && !fresh ? pubOf(exceptIid) : null; // fresh: exceptIid is only a clip left out of the end calc
        const sp = o.speed !== undefined ? o.speed : (live?.speed ?? spec.speed);
        const st = o.start !== undefined ? +o.start || 0 : (live?.start ?? 0);
        const inP = o.in !== undefined ? +o.in || 0 : (live?.inP ?? 0);
        o.duration = autoMusicDur(api, m, st, inP, exceptIid, sp);
      }
    }
    return o;
  };

  /** Klibi siler: seç → kırmızımsı kutu → "Sil" düğmesi (gerçek tıklama). */
  const removeIid = async (iid, label) => {
    const pub = pubOf(iid);
    if (!pub) return;
    if (show) {
      await scrollToTime(pub.start);
      const ag = D.pick('Kurgu');
      await D.click(ag, api.el.clip(iid), false);
      api.select(iid);
      const el = api.el.clip(iid);
      if (el) {
        el.style.outline = '2px solid #ef4444';
        el.style.boxShadow = '0 0 0 3px rgba(239,68,68,.35) inset';
        el.style.filter = 'saturate(.6) brightness(.85)';
      }
      D.flash(ag, el, t('live.video.deleting', 'delete') + (label ? ' · ' + label : ''), 700, { color: '#ef4444' });
      await D.wait(380);
      // Gerçek "Sil" tıklaması yalnız hedef klip hâlâ seçiliyse (yoksa kullanıcının seçtiği klip silinirdi).
      const del = $('#v-del');
      await D.click(ag, del, false);
      if (del && ensureSel(iid)) del.click();
    }
    if (pubOf(iid)) api.removeClip(iid);
  };

  /** Kütüphaneden kanala sürükleyerek klip ekler (recipe.js placeClip gibi). */
  const placeClip = async (m, opts, role) => {
    const track = opts.track;
    if (!show) return api.addClip(m, opts);
    const ag = D.pick(role);
    await scrollToTime(opts.start ?? 0);
    const tr = api.el.track(track);
    const tb = tr?.getBoundingClientRect();
    const x = api.el.timeToX(opts.start ?? (track === 'v1' ? api.clips().filter((c) => c.track === 'v1').reduce((mx, c) => Math.max(mx, c.start + c.dur), 0) : 0));
    const to = tb ? { x: Math.min(tb.right - 20, Math.max(tb.left + 10, x + 12)), y: tb.top + tb.height / 2 } : tr;
    let clip = null;
    await A.drag(ag, api.el.mediaCard(m.id), to, {
      label: m.name,
      onDrop: () => {
        clip = api.addClip(m, opts);
      },
    });
    if (!clip) clip = api.addClip(m, opts);
    api.select(clip.id);
    await sleep(30);
    const ok = selOk(clip.id);
    if (opts.fadeIn && ensureSel(clip.id)) await uiField(D, ag, 'fadeIn', opts.fadeIn, ok);
    if (opts.fadeOut && ensureSel(clip.id)) await uiField(D, ag, 'fadeOut', opts.fadeOut, ok);
    if (opts.volume != null && m.type !== 'image' && ensureSel(clip.id)) await uiField(D, ag, 'volume', opts.volume, ok);
    for (const f of ['speed', 'transition', 'effects']) {
      if (opts[f] == null || (f === 'speed' && m.type === 'image') || !ensureSel(clip.id)) continue;
      await uiAny(D, ag, f, opts[f], ok);
    }
    const { track: _t, start: _s, ...rest } = opts;
    api.updateClip(clip.id, opts.start != null ? { ...rest, start: opts.start } : rest);
    D.flash(D.pick('Zaman'), api.el.clip(clip.id), t('live.video.atSec', '{n} s', { n: (+pubOf(clip.id)?.start || 0).toFixed(1) }), 700);
    return pubOf(clip.id) || clip;
  };

  const addItem = async (op) => {
    const { kind, key, spec } = op;
    if (kind === 'text') {
      const opts = optsOf('text', spec, TEXT_FIELDS);
      // No "start" = 0 s (as on reopen), not wherever the playhead happens to be.
      if (opts.start == null) opts.start = 0;
      const txt = String(spec.text ?? '');
      let clip = null;
      if (show) {
        const ag = D.pick('Metin');
        await scrollToTime(+spec.start || 0);
        api.seek(+spec.start || 0);
        const before = new Set(api.clips().map((c) => c.id));
        await D.click(ag, $('#v-text'), true);
        // The text the button created (it is selected and pushed last); a clip the user added meanwhile is not it.
        const fresh = api.clips().filter((c) => !before.has(c.id) && c.kind === 'text');
        const selId = api.selected?.();
        clip = fresh.find((c) => c.id === selId) || fresh[fresh.length - 1] || null;
        if (clip) {
          api.select(clip.id);
          await sleep(30);
          const ok = selOk(clip.id);
          if (ensureSel(clip.id)) await D.type(ag, panelEl('text'), txt);
          if (spec.size != null && ensureSel(clip.id)) await uiField(D, ag, 'size', spec.size, ok);
          if (spec.color && ensureSel(clip.id)) await uiField(D, ag, 'color', spec.color, ok);
          if (spec.anim && ensureSel(clip.id)) await uiField(D, ag, 'anim', spec.anim, ok);
          if (spec.font && ensureSel(clip.id)) await uiField(D, ag, 'font', spec.font, ok);
          api.updateClip(clip.id, opts);
          D.flash(D.pick('Font'), $('#v-canvas'), txt.split('\n')[0].slice(0, 24) || t('live.video.text', 'text'), 700);
        }
      }
      if (!clip) clip = api.addText(opts);
      register(key, clip.id, spec);
      touch(key, null);
      peek(pubOf(clip.id)?.start ?? 0, pubOf(clip.id)?.dur);
      return;
    }
    if (kind === 'clip' && spec.kind === 'shape') {
      const opts = optsOf('clip', spec, SHAPE_FIELDS);
      opts.track = spec.track === 'v1' ? 'v1' : 'v2';
      if (opts.start == null) opts.start = 0;
      let clip = null;
      if (show) {
        const ag = D.pick('Kurgu');
        await scrollToTime(opts.start);
        api.seek(+opts.start || 0);
        await D.click(ag, api.el.shapeButton?.() || $('#v-shape'), false);
        clip = api.addShape(opts);
        api.select(clip.id);
        await sleep(30);
        const ok = selOk(clip.id);
        if (spec.color && ensureSel(clip.id)) await uiField(D, ag, 'color', spec.color, ok);
        if (spec.transition && ensureSel(clip.id)) await uiAny(D, ag, 'transition', spec.transition, ok);
        api.updateClip(clip.id, opts);
        D.flash(D.pick('Zaman'), api.el.clip(clip.id), label(kind, spec, null), 700);
      } else clip = api.addShape(opts);
      register(key, clip.id, spec);
      touch(key, null);
      peek(pubOf(clip.id)?.start ?? 0, pubOf(clip.id)?.dur);
      return;
    }
    if (kind === 'clip' && spec.kind === 'draw') {
      // Draw clip: the "Code" agent clicks "Drawing", types the first lines of the code into the panel's
      // code box and points at Apply; the exact code and fields are then set through the API.
      const opts = optsOf('clip', spec, DRAW_FIELDS);
      opts.code = codeStr(spec.code);
      opts.track = spec.track === 'v1' ? 'v1' : 'v2';
      if (opts.start == null) opts.start = 0;
      let clip = null;
      if (show) {
        const ag = D.pick('Kod');
        await scrollToTime(opts.start);
        api.seek(+opts.start || 0);
        await D.click(ag, api.el.drawButton?.() || $('#v-draw'), false);
        // Empty code first: the drawing appears when the agent "applies" it.
        clip = api.addDraw({ ...opts, code: '' });
        api.select(clip.id);
        await sleep(30);
        const ok = selOk(clip.id);
        if (ensureSel(clip.id)) await uiCode(D, ag, opts.code, ok);
        if (spec.transition && ensureSel(clip.id)) await uiAny(D, ag, 'transition', spec.transition, ok);
        api.updateClip(clip.id, opts);
        syncCodeBox(api, clip.id, opts.code);
        D.flash(D.pick('Zaman'), api.el.clip(clip.id), label(kind, spec, null), 700);
      } else clip = api.addDraw(opts);
      register(key, clip.id, spec);
      touch(key, null);
      peek(pubOf(clip.id)?.start ?? 0, pubOf(clip.id)?.dur);
      return;
    }
    let m;
    let genName = null;
    if (kind === 'music' && isGenMusic(spec)) {
      // Generated music: rendered (or the cached WAV in medya/ reused) for the length it must cover.
      const exceptIid = op.op === 'replace' ? S.entries.get(key)?.iid : null;
      if (show) {
        const ag = D.pick('Ses');
        await D.click(ag, $('#v-import'), false);
        D.flash(ag, $('#v-import'), t('live.video.genMusic', 'generating music · {style}', { style: String(genParams(spec).style || 'upbeat') }), 900);
      }
      const g = await genMedia(api, env, spec, genSeconds(api, spec, exceptIid));
      m = g.m;
      genName = g.name;
    } else m = mediaFor(spec.media);
    if (!m) throw new Error(t('live.video.mediaNotFound', 'Media not found: {name}', { name: spec.media }));
    let opts;
    if (kind === 'music') {
      // On replace the old music is still on the timeline (removed after the add): leave it out of the auto duration.
      opts = optsOf('music', spec, MUSIC_FIELDS, m, op.op === 'replace' ? S.entries.get(key)?.iid : null, true);
      opts.track = 'a';
    } else {
      opts = optsOf('clip', spec, CLIP_FIELDS, m);
      opts.track = spec.track || (m.type === 'audio' ? 'a' : 'v1');
      if (opts.start == null && opts.track !== 'v1') opts.start = 0;
      // A replaced main-track clip without "start" goes back to its slot in the sequence (as on reopen),
      // not to the end of the track.
      else if (opts.start == null && op.op === 'replace') opts.start = seqStartV1(key);
    }
    const clip = await placeClip(m, opts, kind === 'music' ? 'Ses' : m.type === 'audio' ? 'Ses' : 'Kurgu');
    register(key, clip.id, spec);
    if (genName) S.entries.get(key).gen = genName;
    touch(key, null);
    peek(clip.start, clip.dur);
  };

  const updateItem = async (op) => {
    const { kind, key, spec, changed } = op;
    const e = S.entries.get(key);
    const pub = pubOf(e.iid);
    // Generated music: the piece on the timeline (a new length is rendered after the ops, see refreshGenMusic).
    const m = kind === 'text' ? null : kind === 'music' && isGenMusic(spec) ? api.media().find((x) => x.id === pub?.mid) || null : mediaFor(spec.media);
    const fields = fieldsFor(kind, spec);
    // Kesin değerler: değişen alanlar; kaldırılan alanlar varsayılana döner.
    // Some fields reset others the way a reopen would build the clip:
    // - speed / in rescale or clamp the duration, so the file's duration (or its default) is applied again;
    // - a new shape type brings its own size / radius / position / colour unless the file gives them.
    const applied = [...changed];
    const timedNow = kind === 'music' || (kind === 'clip' && spec.kind !== 'shape' && m && m.type !== 'image');
    if (timedNow && (changed.includes('speed') || changed.includes('in')) && !applied.includes('duration')) applied.push('duration');
    if (kind === 'clip' && spec.kind === 'shape' && changed.includes('shape'))
      for (const f of ['w', 'h', 'radius', 'y', 'color']) if (spec[f] === undefined && !applied.includes(f)) applied.push(f);
    const exact = optsOf(kind, spec, applied, m, e.iid);
    for (const f of applied) {
      if (exact[f] !== undefined) continue;
      // Removed "start" on the main track: back to the clip's slot in the sequence.
      const d = f === 'start' && kind === 'clip' && !isSynthKind(spec.kind) && pub?.track === 'v1' ? seqStartV1(key) : defaultOf(kind, f, pub, m, api, spec);
      if (d !== undefined) exact[f] = d;
    }
    if (show) {
      const ag = D.pick(kind === 'text' ? 'Yazı' : kind === 'music' ? 'Ses' : spec.kind === 'draw' && changed.includes('code') ? 'Kod' : 'Düzen');
      await scrollToTime(has(exact, 'start') ? exact.start : pub?.start);
      await D.click(ag, api.el.clip(e.iid), false);
      api.select(e.iid);
      await sleep(30);
      D.flash(ag, api.el.clip(e.iid), label(kind, spec, m), 600);
      // Çok alan değiştiyse ilk 6'sı panelde gösterilir, gerisi doğrudan uygulanır.
      const shownFields = fields.filter((f) => has(exact, f) && !(f === 'duration' && exact[f] >= 1e5)).slice(0, 6);
      const ok = selOk(e.iid);
      for (const f of shownFields) {
        if (!ensureSel(e.iid)) break; // klip silindi ya da seçilemiyor: kesin değerler aşağıda API ile
        await uiAny(D, ag, f, exact[f], ok);
      }
    }
    api.updateClip(e.iid, exact);
    if (has(exact, 'code')) syncCodeBox(api, e.iid, codeStr(exact.code));
    e.spec = clone(spec);
    touch(key, applied);
    if (show) {
      const p = pubOf(e.iid);
      D.flash(D.pick('Zaman'), api.el.clip(e.iid), changed.join(', '), 800);
      if (p) peek(p.start, p.dur);
    }
  };

  const runOp = async (op) => {
    if (op.op === 'markers') {
      if (show) {
        D.flash(D.pick('Zaman'), api.el.ruler?.() || $('#v-ruler'), t('live.video.markers', '{n} markers', { n: op.markers.length }), 700);
        await D.wait(300);
      }
      api.setMarkers?.(op.markers);
      return;
    }
    if (op.op === 'tracks') {
      const cur = api.tracks?.() || {};
      if (show) {
        const ag = D.pick('Düzen');
        for (const [track, flags] of Object.entries(TRACK_FLAG_NAMES)) {
          for (const f of flags) {
            if (!!cur[track]?.[f] === !!op.tracks[track]?.[f]) continue;
            await D.click(ag, api.el.trackFlag?.(track, f), false);
          }
        }
      }
      const all = {};
      for (const track of Object.keys(TRACK_FLAG_NAMES)) all[track] = op.tracks[track] || {};
      api.setTracks?.(all);
      return;
    }
    if (op.op === 'settings') {
      const s = op.set;
      const ag = show ? D.pick('Düzen') : null;
      if (s.resolution) {
        if (show) {
          await D.click(ag, $('#v-res'), false);
          D.flash(ag, $('#v-canvas'), s.resolution.replace('x', ' × '), 1000);
        }
        api.setResolution(s.resolution);
      }
      if (s.fps != null || s.background) {
        if (show) api.select(null);
        if (s.fps != null) {
          if (show) await D.click(ag, $('#vp-fps'), false);
          api.setFps(s.fps);
        }
        if (s.background) {
          if (show) await D.color(ag, $('#vp-bg'), s.background);
          api.setBackground(s.background);
        }
      }
      return;
    }
    if (op.op === 'media') {
      const file = await env.loadFile(op.path);
      const audio = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name || op.path);
      const ag = show ? D.pick(audio ? 'Ses' : 'Kurgu') : null;
      if (show) await D.click(ag, $('#v-import'), false);
      const m = await api.addMedia(file, file.name || fileOf(op.path));
      if (!m) throw new Error(t('live.video.mediaOpenFailed', 'Could not open media: {path}', { path: op.path }));
      const old = S.media.get(op.key);
      if (old && old.m !== m) staleMedia.set(old.m.id, { key: op.key, path: old.path });
      S.media.set(op.key, { m, path: op.path });
      if (show) D.flash(ag, api.el.mediaCard(m.id), m.name, 700);
      return;
    }
    if (op.op === 'remove') {
      const e = S.entries.get(op.key);
      if (e) await removeIid(e.iid, label(op.kind, e.spec, mediaFor(e.spec?.media)));
      unregister(op.key);
      return;
    }
    if (op.op === 'replace') {
      // The new clip is added first: if it cannot be added (media missing, track rejects the kind),
      // addItem throws and the old clip stays on the timeline with its mapping.
      const old = S.entries.get(op.key);
      const oldIid = old && pubOf(old.iid) ? old.iid : null;
      await addItem(op);
      if (oldIid) await removeIid(oldIid, '');
      aliveIids = aliveNow();
      return;
    }
    if (op.op === 'add') return addItem(op);
    if (op.op === 'update') return updateItem(op);
  };

  try {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        await runOp(op);
      } catch (e) {
        const msg = e?.message || String(e);
        errors.push(msg);
        console.warn('[canlı video]', op.op, op.key || '', e);
        env.note?.(t('live.video.note', 'Video: {msg}', { msg }));
      }
      if (show) A.progress(i + 1, total, t('live.video.changes', 'changes'));
    }
    aliveIids = aliveNow();

    // Dokunulmayan öğelerin spec'i yenilenir (alan dışı anahtarlar da korunur); base, kullanıcının
    // henüz yazılmamış arayüz değişikliklerini kaybetmemek için yalnız dokunulanlarda güncellenir.
    const items = [
      ...(N.clips || []).map((c) => ['c:' + c.id, c]),
      ...(N.texts || []).map((x) => ['t:' + x.id, x]),
      ...(isObj(N.music) ? [[MUSIC_KEY, N.music]] : []),
    ];
    for (const [key, item] of items) {
      const e = S.entries.get(key);
      if (e && aliveIids.has(e.iid)) e.spec = clone(item);
    }

    // Generated music: the length it must cover changed (clips added / moved, its own duration / speed / in),
    // so the matching piece is rendered (or reused from medya/) and swapped in.
    const mg = S.entries.get(MUSIC_KEY);
    if (dirty && mg && aliveIids.has(mg.iid) && isGenMusic(N.music)) {
      try {
        const want = musicFileName(genParams(N.music), genSeconds(api, N.music, mg.iid));
        if (show && mg.gen !== want) {
          const ag = D.pick('Ses');
          D.flash(ag, api.el.clip(mg.iid), t('live.video.genMusic', 'generating music · {style}', { style: String(genParams(N.music).style || 'upbeat') }), 900);
        }
        if (await refreshGenMusic(api, env)) {
          touch(MUSIC_KEY, ['duration']);
          aliveIids = aliveNow();
        }
      } catch (err) {
        const msg = err?.message || String(err);
        errors.push(msg);
        console.warn('[canlı video] music', err);
        env.note?.(t('live.video.note', 'Video: {msg}', { msg }));
      }
    }

    // Müzik süresi "auto": video süresi değiştiyse müziği ona uydur.
    const me = S.entries.get(MUSIC_KEY);
    if (dirty && me && aliveIids.has(me.iid) && isObj(N.music) && isAuto(N.music.duration)) {
      const pub = pubOf(me.iid);
      const m = isGenMusic(N.music) ? api.media().find((x) => x.id === pub?.mid) || null : mediaFor(N.music.media);
      if (pub && m) {
        const want = autoMusicDur(api, m, pub.start, pub.inP, me.iid, pub.speed);
        if (Math.abs(pub.dur - want) > 0.01) {
          api.updateClip(me.iid, { duration: want });
          touch(MUSIC_KEY, ['duration']);
        }
      }
    }

    // Kullanılmayan eski medya: yeniden yüklenenlerin eskisi ve projeden çıkarılanlar.
    // (Geri al ile dönebilirler: kimlik/yol hatırlanır, snapshot aynı adla yazar.)
    for (const [id, r] of staleMedia) if (api.removeMedia?.(id)) S.retired.set(id, r);
    // Generated pieces no clip uses (music removed, switched to a file, or regenerated).
    if (dirty) dropGen(api, S.entries.get(MUSIC_KEY)?.gen);
    for (const [k, v] of [...S.media]) {
      if (has(N.media, k)) continue;
      if (api.removeMedia?.(v.m.id)) {
        S.retired.set(v.m.id, { key: k, path: v.path });
        S.media.delete(k);
      }
    }

    // base yalnız uygulanan alanlarda yenilenir: kullanıcının aynı öğedeki henüz yazılmamış başka
    // alan değişikliği (ör. saydamlık) snapshot'ta kullanıcı değişikliği olarak kalır.
    for (const [key, fs] of touched) {
      const e = S.entries.get(key);
      const p = e && pubOf(e.iid);
      if (!p) continue;
      if (!fs || !e.base) {
        e.base = p;
        continue;
      }
      const nb = { ...e.base, id: p.id };
      for (const f of fs) {
        const k = PANEL_KEY[f] || f;
        nb[k] = p[k];
      }
      e.base = nb;
    }
    if (dirty) {
      api.select(null);
      api.commit();
    }
  } finally {
    if (startedHud) await A.stop({ keep: false });
  }
  S.proj = clone(N);
  return { changes: total, errors };
}

/** Defaults of a fresh shape of this type (mirrors video-mode makeShapeClip). */
function shapeDefaults(shape, proj) {
  const d = SHAPE_DEFAULTS;
  const s = SHAPES.includes(shape) ? shape : d.shape;
  const o = { duration: 3, shape: s, color: d.color, w: d.w, h: d.h, radius: d.radius, x: 0, y: 0, scale: 1, opacity: 1, fadeIn: 0, fadeOut: 0 };
  if (s === 'circle') {
    const pw = +proj?.w > 0 ? +proj.w : 1080;
    const ph = +proj?.h > 0 ? +proj.h : 1920;
    o.w = 0.3;
    o.h = Math.round(((0.3 * pw) / ph) * 1000) / 1000;
  } else if (s === 'bar') Object.assign(o, { w: 0.86, h: 0.012, y: 0.44, color: '#ffffff', radius: 1 });
  else if (s === 'rounded') o.radius = 0.5;
  return o;
}

/** Projeden kaldırılan alanın varsayılanı (video-mode makeClip/makeTextClip/makeShapeClip ile aynı). */
function defaultOf(kind, f, pub, m, api, spec) {
  if (kind === 'music' && has(MUSIC_DEFAULTS, f)) return MUSIC_DEFAULTS[f];
  // A new item without "start" is placed at 0 s (main-track clips are handled by the caller).
  if (f === 'start') return 0;
  if (kind === 'text') {
    const p = api.project?.() || { w: 1080, h: 1920 };
    const T = { text: '', duration: 3, size: 9, color: '#ffffff', stroke: true, box: false, boxColor: '#000000', anim: 'pop', x: 0, y: p.h > p.w ? 0.25 : 0.32, scale: 1, opacity: 1, fadeIn: 0, fadeOut: 0 };
    return has(T, f) ? T[f] : OPTIONAL_DEFAULTS[f];
  }
  if (pub?.kind === 'shape') {
    // Per shape type, from the shape the file asks for (a removed "shape" is a rect).
    const SH = shapeDefaults(spec?.shape, api.project?.());
    return has(SH, f) ? SH[f] : OPTIONAL_DEFAULTS[f];
  }
  if (pub?.kind === 'draw') {
    // Mirrors video-mode makeDrawClip.
    const DR = { duration: 5, code: '', x: 0, y: 0, scale: 1, opacity: 1, fadeIn: 0, fadeOut: 0 };
    return has(DR, f) ? DR[f] : OPTIONAL_DEFAULTS[f];
  }
  if (has(OPTIONAL_DEFAULTS, f)) return OPTIONAL_DEFAULTS[f];
  const C = { in: 0, x: 0, y: 0, scale: pub?.track === 'v2' ? 0.5 : 1, opacity: 1, fit: 'contain', volume: 1, fadeIn: 0, fadeOut: 0 };
  if (f === 'duration') return m?.type === 'image' ? 3 : 1e6; // 1e6: medyanın kalan süresine sıkıştırılır
  return C[f];
}

function label(kind, spec, m) {
  if (kind === 'text') return String(spec?.text ?? '').split('\n')[0].slice(0, 24) || t('live.video.text', 'text');
  if (kind === 'music' && isGenMusic(spec)) return t('live.video.music', 'music') + ' · ' + String(genParams(spec).style || 'upbeat');
  if (kind === 'music') return t('live.video.music', 'music') + (m ? ' · ' + m.name : '');
  if (spec?.kind === 'shape') return t('live.video.shape', 'shape') + ' · ' + (spec.shape || 'rect');
  if (spec?.kind === 'draw') {
    // A "// Title" first line names the drawing (as on the timeline).
    const title = /^\s*\/\/\s*(.+)/.exec(codeStr(spec.code).split('\n')[0] || '');
    return t('live.video.drawing', 'drawing') + (title ? ' · ' + title[1].trim().slice(0, 24) : '');
  }
  return m?.name || String(spec?.media || t('live.video.clip', 'clip'));
}

// ---------------------------------------------------------------- dışa aktarma

/** Açık projeyi dışa aktarır → { outputs: [tam yol] }. */
export async function exportNow(proj, env, opts = {}) {
  const api = env.modes.mvid.api;
  const A = agentsOf(env);
  // Süren bir uygulama bitmeden kayda başlanmaz (zaman çizelgesi kaydın ortasında değişmesin).
  while (S.applying > 0) await sleep(150);
  // Generated music must fit the timeline as it is now (a refresh queued by snapshot() runs right away).
  clearTimeout(S.genT);
  S.genT = 0;
  S.applying++;
  try {
    await refreshGenMusic(api, env); // no history entry (as for the background refresh)
  } catch (e) {
    console.warn('[canlı video] music', e);
    env.note?.(t('live.video.note', 'Video: {msg}', { msg: e?.message || String(e) }));
  } finally {
    S.applying--;
  }
  env.switchTab?.('mvid');
  await sleep(30);
  const P = normalize(proj || S.proj || {});
  const out = opts.file || (typeof P.output === 'string' ? P.output : P.output?.file) || `${P.name || 'video'}.mp4`;
  let path = platform.resolvePath(String(out), env.outDir || platform.paths.out);
  if (!/\.(mp4|webm)$/i.test(path)) path += '.mp4';

  const hud = env.show !== false && A.active;
  const prevQuiet = busy.quiet;
  if (hud) {
    busy.quiet = true;
    const ag = A.pick('Render');
    await A.click(ag, $('#v-export'), { real: false });
    A.progress(0, 100, t('live.video.exporting', 'exporting'));
  }
  try {
    api.select(null);
    const quality = isObj(P.output) && ['low', 'medium', 'high'].includes(P.output.quality) ? P.output.quality : undefined;
    const blob = await api.exportVideo({
      quality,
      onProgress: hud ? (p, txt) => A.progress(Math.round(p * 100), 100, txt ? t('live.video.exportingWith', 'exporting · {txt}', { txt }) : t('live.video.exporting', 'exporting')) : undefined,
    });
    if (!blob) throw new Error(t('live.video.exportFailed', 'Could not export the video (the timeline is empty or the export was cancelled)'));
    const p = await platform.saveVideoFile(blob, path);
    if (hud) A.progress(100, 100, t('live.video.exported', 'exported'));
    return { outputs: [p] };
  } finally {
    busy.quiet = prevQuiet;
  }
}

// ---------------------------------------------------------------- anlık görüntü

/** Mevcut durum, proje.json video biçiminde. Kimlikler korunur; arayüzde eklenen öğelere yeni kimlik verilir. */
export function snapshot(env) {
  const api = env.modes.mvid.api;
  // Müzik "auto" ise ve kullanıcı videoyu kısalttı/uzattıysa müzik ona uyar (proje.json "auto" kalır).
  // commit bir mode-change daha doğurur; sonraki snapshot'ta fark kalmadığı için döngü olmaz.
  if (syncAutoMusic(api)) api.commit?.();
  // Generated music whose file no longer fits the needed length: rendered again in the background.
  queueGenRefresh(api, env);
  const base = S.proj ? clone(S.proj) : { type: 'video', name: 'video' };
  const out = { ...base, type: base.type || 'video' };

  // Proje ayarları: değer aynıysa yazılış biçimi ("vertical" vb.) korunur.
  const pj = api.project ? api.project() : null;
  if (pj) {
    const eb = effSettings(base);
    if (eb.resolution !== pj.res) out.resolution = pj.res;
    if (eb.fps !== pj.fps) out.fps = pj.fps;
    if (eb.background !== String(pj.bg).toLowerCase()) out.background = pj.bg;
  }

  // Medya
  const lib = api.media();
  const libSet = new Set(lib);
  const media = {};
  const midToKey = new Map();
  // Projedeki medya her zaman korunur: henüz yüklenemeyen (dosya yok, kodek açılamadı) medya da
  // proje.json'dan silinmez; sonraki farkta yeniden denenir. (Arayüzde medya kaldırma yok.)
  const baseMedia = isObj(base.media) ? base.media : {};
  for (const [k, p] of Object.entries(baseMedia)) {
    const v = S.media.get(k);
    if (v && libSet.has(v.m)) {
      media[k] = v.path;
      midToKey.set(v.m.id, k);
    } else media[k] = p;
  }
  for (const [k, v] of S.media) {
    if (has(media, k) || !libSet.has(v.m)) continue;
    media[k] = v.path;
    midToKey.set(v.m.id, k);
  }
  const takenKeys = new Set(Object.keys(media));
  for (const m of lib) {
    // Generated music lives in "music.generate", never in "media".
    if (midToKey.has(m.id) || S.genMids.has(m.id)) continue;
    // Kaldırılmışken geri al ile dönen medya: eski adıyla (aynı yol zaten varsa o kimlikle) yazılır.
    const r = S.retired.get(m.id);
    if (r) {
      const same = Object.keys(media).find((k) => normPath(media[k]) === normPath(r.path));
      if (same) {
        midToKey.set(m.id, same);
        continue;
      }
    }
    const k = r && !takenKeys.has(r.key) ? r.key : uniqueKey(keyFromFile(r ? r.key : m.name), takenKeys);
    takenKeys.add(k);
    const path = r ? r.path : relPath(m.path, env?.dir) || `medya/${m.name}`;
    media[k] = path;
    S.media.set(k, { m, path });
    S.retired.delete(m.id);
    midToKey.set(m.id, k);
  }
  out.media = media;

  // Klipler
  const pubs = api.clips();
  const byId = new Map(pubs.map((p) => [p.id, p]));
  const seen = new Set();
  const takenIds = { c: new Set(), t: new Set() };
  for (const key of S.entries.keys()) {
    const [pre, id] = [key.slice(0, 1), key.slice(2)];
    if (takenIds[pre]) takenIds[pre].add(id);
  }
  for (const c of base.clips || []) takenIds.c.add(String(c.id));
  for (const x of base.texts || []) takenIds.t.add(String(x.id));

  const clipsOut = [];
  const textsOut = [];
  let musicOut = null;
  const emitMapped = (key) => {
    const e = S.entries.get(key);
    const pub = e && byId.get(e.iid);
    if (!pub || seen.has(pub.id)) return;
    seen.add(pub.id);
    const kind = key === MUSIC_KEY ? 'music' : pub.kind === 'text' ? 'text' : 'clip';
    const fields = kind === 'text' ? TEXT_FIELDS : kind === 'music' ? MUSIC_FIELDS : FRESH_FIELDS[pub.kind] || CLIP_FIELDS;
    const o = mergeSnap(e.spec || { id: key.slice(2) }, e.base, pub, fields);
    if (kind !== 'text' && e.base) {
      if (kind === 'clip' && pub.track !== e.base.track) o.track = pub.track;
      if (pub.mid !== e.base.mid && midToKey.has(pub.mid)) o.media = midToKey.get(pub.mid);
    }
    if (kind === 'music') delete o.id;
    e.spec = clone(o);
    e.base = pub;
    if (kind === 'music') musicOut = o;
    else (kind === 'text' ? textsOut : clipsOut).push(o);
  };
  /**
   * Projedeki öğe: hiç uygulanamadıysa (eşleme yok; ör. "Medya bulunamadı") olduğu gibi korunur ve sonraki
   * farkta yeniden denenir; eşlenmiş klibi arayüzde silinmişse çıkarılır (kullanıcı sildi); yoksa güncel hâli.
   */
  const emitBase = (key, item, sink) => {
    const e = S.entries.get(key);
    if (!e) sink.push(clone(item));
    else if (byId.has(e.iid)) emitMapped(key);
  };
  for (const c of base.clips || []) emitBase('c:' + c.id, c, clipsOut);
  for (const x of base.texts || []) emitBase('t:' + x.id, x, textsOut);
  emitMapped(MUSIC_KEY);
  // Generated music brought back by undo (an earlier piece's clip): it is still the project's music.
  const me = S.entries.get(MUSIC_KEY);
  if (!musicOut && me && isGenMusic(me.spec)) {
    const back = pubs.find((p) => !seen.has(p.id) && p.track === 'a' && S.genMids.has(p.mid) && !S.byIid.has(p.id));
    if (back) {
      if (S.byIid.get(me.iid) === MUSIC_KEY) S.byIid.delete(me.iid);
      me.iid = back.id;
      me.gen = S.genMids.get(back.mid);
      me.base = back; // its own length is not a user change ("auto" stays)
      S.byIid.set(back.id, MUSIC_KEY);
      emitMapped(MUSIC_KEY);
      queueGenRefresh(api, env);
    }
  }
  for (const pub of pubs) {
    if (seen.has(pub.id)) continue;
    const known = S.byIid.get(pub.id);
    if (known) {
      emitMapped(known);
      continue;
    }
    // Medyası çözülemeyen klip medyasız (kırık) yazılmaz.
    if (pub.kind !== 'text' && !isSynthKind(pub.kind) && !midToKey.has(pub.mid)) continue;
    seen.add(pub.id);
    const isText = pub.kind === 'text';
    const id = nextId(isText ? 't' : 'c', takenIds[isText ? 't' : 'c']);
    const o = freshSnap(pub, id, midToKey.get(pub.mid));
    register((isText ? 't:' : 'c:') + id, pub.id, o);
    S.entries.get((isText ? 't:' : 'c:') + id).base = pub;
    (isText ? textsOut : clipsOut).push(o);
  }
  if (clipsOut.length || Array.isArray(base.clips)) out.clips = clipsOut;
  if (textsOut.length || Array.isArray(base.texts)) out.texts = textsOut;
  // Müzik: canlıysa güncel hâli; eşlenmiş ama arayüzde silinmişse null (yönetici {...dosya, ...snap}
  // birleştirdiği için anahtar silinirse eski müzik dosyada kalırdı); hiç uygulanamadıysa olduğu gibi.
  if (musicOut) out.music = musicOut;
  else if (S.entries.has(MUSIC_KEY)) out.music = null;

  // Markers and track flags: written when they differ from the file (its own spelling is kept otherwise).
  if (api.markers) {
    const mk = normMarkers(api.markers());
    if (!same(mk, normMarkers(base.markers))) out.markers = mk;
  }
  if (api.tracks) {
    const tr = normTracks(api.tracks());
    if (!same(tr, normTracks(base.tracks))) out.tracks = tr;
  }

  S.proj = clone(out);
  return out;
}
