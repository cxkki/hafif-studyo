// Canlı proje — 3D uygulayıcı (docs/CANLI.md "Uygulayıcı arayüzü").
// proje.json'daki 3D farkını (sahne, kamera, nesneler) ajanlarla, gerçek arayüz işlemleriyle uygular:
// araç çubuğu düğmesi, panel kutularına yazma, kaydırıcılar, renk seçici. Her adımın sonunda kesin değer
// mod API'siyle verilir; show=false ya da 'instant' hızda aynı sonuç animasyonsuz üretilir.
// Nesneler three-mode nesnesine userData.lid (kalıcı kimlik) ile bağlanır; doku yolu userData.ltex,
// model yolu userData.lsrc, model sığdırma çarpanı userData.lbase (proje GLB'sine de yazılır).
import { $, $$, sleep, extOf } from './util.js';
import * as platform from './platform.js';
import { agents as agentsModule } from './agents.js';
import { t } from './i18n.js';

// ------------------------------------------------------------------ saf yardımcılar (DOM'suz)

const SHAPES = ['cube', 'sphere', 'cylinder', 'cone', 'wedge', 'torus', 'capsule', 'plane', 'text'];
const SHAPE_ALIAS = { kup: 'cube', küp: 'cube', box: 'cube', kure: 'sphere', küre: 'sphere', silindir: 'cylinder', koni: 'cone', rampa: 'wedge', ramp: 'wedge', simit: 'torus', kapsul: 'capsule', kapsül: 'capsule', zemin: 'plane', ground: 'plane', yazı: 'text', yazi: 'text', metin: 'text' };
const CURVED = new Set(['sphere', 'cylinder', 'cone', 'torus', 'capsule']);
const XYZ = ['position', 'rotation', 'scale'];
/**
 * Nesne alanları (fark ve kesin uygulama bu sırayla).
 * Text shape: text, font, color (= text colour), background, size. Lights: color, intensity, distance, angle, penumbra.
 */
export const FIELDS = [
  'name', 'position', 'rotation', 'scale', 'color', 'metalness', 'roughness', 'emissive', 'emissiveIntensity', 'opacity',
  'wireframe', 'detail', 'texture', 'text', 'font', 'background', 'size', 'intensity', 'distance', 'angle', 'penumbra', 'visible',
];
const SCENE_KEYS = ['background', 'background2', 'turntable', 'light', 'ambient', 'grid', 'shadows'];
/** Camera presets accepted in camera.preset (poses are computed by the 3D mode: api.cameraPose). */
export const CAMERA_PRESETS = ['front', 'right', 'side', 'top', 'persp', 'orbit', 'close', 'hero'];

/** One-click material presets: spec "preset" fills the fields the object does not set itself. Kept in sync with three-mode.js. */
export const MATERIAL_PRESETS = {
  matte: { metalness: 0, roughness: 1 },
  plastic: { metalness: 0, roughness: 0.25 },
  metal: { metalness: 1, roughness: 0.25 },
  gold: { color: '#ffc94d', metalness: 1, roughness: 0.3 },
  glass: { color: '#cfe9ff', metalness: 0, roughness: 0.05, opacity: 0.35 },
  glow: { metalness: 0, roughness: 0.5, emissiveIntensity: 1.6, glow: true },
};
const LIGHT_DEFAULTS = {
  point: { intensity: 30, distance: 0 },
  spot: { intensity: 60, distance: 0, angle: 40, penumbra: 0.3 },
};
const TEXT_DEFAULTS = { text: 'Text', font: 'Segoe UI', color: '#ffffff', background: '', size: 1 };
/** Same as MAX_LIGHTS in three-mode.js (api.addLight refuses more). */
const MAX_LIGHTS = 8;
/** Shape palette of three-mode.js (used for a "glow" preset on a shape without a colour). */
const GLOW_PALETTE = ['#4f8cff', '#ff7a45', '#3ecf8e', '#f5c542', '#c58bff', '#ef5b6b', '#8fa3b8', '#2fbfd0'];
const hashStr = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
const DEG = Math.PI / 180;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const rnd = (v, d = 3) => +num(v).toFixed(d);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const normPath = (p) => String(p).replace(/\\/g, '/');
const pathKey = (p) => normPath(p).replace(/^\.\//, '').toLowerCase();

/** Proje klasörü altındaki mutlak yolu göreliye çevirir (proje.json taşınabilir kalsın); değilse aynen. */
export function relToDir(p, dir) {
  if (p == null || p === '') return p;
  const s = normPath(p);
  const d = dir ? normPath(dir).replace(/\/+$/, '') : '';
  return d && s.toLowerCase().startsWith(d.toLowerCase() + '/') ? s.slice(d.length + 1) : p;
}

/** Sahne/kamera varsayılanları (three-mode.js api.defaults() yoksa; değerler onunla aynı). */
const DEFAULT_VIEW = {
  scene: { background: '#2a2d33', background2: null, turntable: false, light: 1.6, ambient: 1.1, grid: true, shadows: false },
  camera: { position: [6, 5, 8], target: [0, 0.5, 0], fov: 50 },
};

/** 'küp' / 'Cube' -> 'cube'; bilinmiyorsa null. */
export function shapeKind(s) {
  const raw = String(s ?? '').trim().toLocaleLowerCase('tr');
  const k = SHAPE_ALIAS[raw] || raw || 'cube';
  return SHAPES.includes(k) ? k : null;
}

/** 'point' | 'spot' for light specs ("light": "point"|"spot", or shape: "pointlight"/"spotlight"), else null. */
export function lightType(spec) {
  const raw = String(spec?.light ?? '').toLowerCase();
  const sh = String(spec?.shape ?? '').toLowerCase();
  const l = raw && raw !== 'false' ? raw : /^(point|spot)(light)?$|^light$/.test(sh) ? sh : '';
  if (!l) return null;
  return l.includes('spot') ? 'spot' : 'point';
}

/** Nesnenin türü: 'model', 'light' ya da şekil adı (null = bilinmeyen şekil). */
export const kindOf = (spec) => (spec?.model ? 'model' : lightType(spec) ? 'light' : shapeKind(spec?.shape));

/** Scene object -> same kinds ('model' | 'light' | shape kind). */
const isModelObj = (obj) => !obj.userData.hs && !obj.userData.hl;

/** '#ABC' -> '#aabbcc'; sayı -> hex; diğerleri küçük harf. */
export function normColor(c) {
  if (c == null || c === '') return null;
  if (typeof c === 'number') return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
  let s = String(c).trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + [...s.slice(1)].map((h) => h + h).join('');
  if (/^[0-9a-f]{6}$/.test(s)) s = '#' + s;
  return s;
}

/** Sayı -> [v,v,v]; dizi -> 3 sayı; geçersiz -> [d,d,d]. */
export function vec3(v, d = 0) {
  if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v))) return [+v, +v, +v];
  if (Array.isArray(v)) return [0, 1, 2].map((i) => num(v[i], d));
  return [d, d, d];
}

export function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => eq(v, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

/**
 * Bir alanın karşılaştırılabilir değeri. undefined = "bu alan yoksa dokunma" (renk, ad, detay).
 * Konum/dönüş/ölçek/malzeme alanları yoksa varsayılana döner (alan silinince sıfırlanır).
 */
export function fieldVal(spec, key) {
  const v = spec?.[key];
  const kind = kindOf(spec);
  const model = kind === 'model';
  const light = kind === 'light';
  const text = kind === 'text';
  const lt = light ? lightType(spec) : null;
  switch (key) {
    case 'name':
      return v == null ? undefined : String(v);
    case 'position':
      return v == null ? (model || kind === 'plane' ? [0, 0, 0] : light ? [0, 3, 0] : text ? [0, 1, 0] : [0, 0.5, 0]) : vec3(v, 0);
    case 'rotation':
      return vec3(v ?? 0, 0);
    case 'scale':
      return vec3(v ?? 1, 1);
    case 'visible':
      return v == null ? true : !!v;
    case 'texture':
      return model || light || text ? undefined : v ? normPath(v) : null;
    case 'color':
      if (light || text) return normColor(v ?? (text ? TEXT_DEFAULTS.color : '#ffffff')) || '#ffffff';
      return model || v == null ? undefined : normColor(v);
    case 'metalness':
      return model || light ? undefined : num(v ?? 0);
    case 'roughness':
      return model || light ? undefined : num(v ?? 0.6, 0.6);
    case 'emissive':
      return model || light ? undefined : normColor(v ?? '#000000') || '#000000';
    case 'emissiveIntensity':
      return model || light ? undefined : num(v ?? 1, 1);
    case 'opacity':
      return model || light ? undefined : Math.max(0, Math.min(1, num(v ?? 1, 1)));
    case 'wireframe':
      return model || light ? undefined : !!v;
    case 'detail':
      return model || light || v == null || !CURVED.has(kind) ? undefined : Math.max(3, Math.min(64, Math.round(num(v, 24))));
    // Text shape fields
    case 'text':
      return text ? String(v ?? TEXT_DEFAULTS.text) : undefined;
    case 'font':
      return text ? String(v ?? TEXT_DEFAULTS.font) : undefined;
    case 'background':
      return text ? (v ? normColor(v) : '') : undefined;
    case 'size':
      return text ? Math.max(0.05, num(v ?? 1, 1)) : undefined;
    // Light fields
    case 'intensity':
      return light ? num(v ?? LIGHT_DEFAULTS[lt].intensity, LIGHT_DEFAULTS[lt].intensity) : undefined;
    case 'distance':
      return light ? Math.max(0, num(v ?? 0)) : undefined;
    case 'angle':
      return light && lt === 'spot' ? Math.max(1, Math.min(89, num(v ?? LIGHT_DEFAULTS.spot.angle, 40))) : undefined;
    case 'penumbra':
      return light && lt === 'spot' ? Math.max(0, Math.min(1, num(v ?? LIGHT_DEFAULTS.spot.penumbra, 0.3))) : undefined;
  }
  return undefined;
}

/** a -> b'de değişen alanlar (b'de "dokunma" sayılan eksik alanlar hariç). */
export function diffFields(a, b) {
  return FIELDS.filter((k) => {
    const vb = fieldVal(b, k);
    return vb !== undefined && !eq(fieldVal(a, k), vb);
  });
}

/** Şekil türü, model dosyası ya da sığdırma değişirse nesne yeniden kurulur. */
export function needsRebuild(a, b) {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) return true;
  if (kb === 'light' && lightType(a) !== lightType(b)) return true;
  if (kb === 'model') return normPath(a.model) !== normPath(b.model) || num(a.fit, 0) !== num(b.fit, 0);
  return false;
}

function sceneVal(s, k) {
  const v = s?.[k];
  // background2: null / false / '' (key present) clears the gradient.
  if (k === 'background2') return s && k in s ? normColor(v || '') || '' : undefined;
  if (v == null) return undefined;
  if (k === 'background') return normColor(v);
  if (k === 'grid' || k === 'shadows' || k === 'turntable') return !!v;
  return num(v);
}

/** Sahne farkı: next.scene'de olup prev'den farklı anahtarlar ({} değilse). */
export function diffScene(prevScene, nextScene) {
  if (!isObj(nextScene)) return null;
  const out = {};
  for (const k of SCENE_KEYS) {
    const vb = sceneVal(nextScene, k);
    if (vb === undefined) continue;
    if (!prevScene || !eq(sceneVal(prevScene, k), vb)) out[k] = vb;
  }
  // A gradient / turntable that was on and whose key was removed from the file is switched off.
  if (prevScene) {
    if (sceneVal(prevScene, 'background2') && !('background2' in nextScene)) out.background2 = '';
    if (sceneVal(prevScene, 'turntable') && !('turntable' in nextScene)) out.turntable = false;
  }
  return Object.keys(out).length ? out : null;
}

/** Kamera farkı: değiştiyse next.camera (temizlenmiş), değilse null. */
export function diffCamera(prevCam, nextCam) {
  if (!isObj(nextCam)) return null;
  const pick = (c) => ({
    position: c?.position != null ? vec3(c.position) : undefined,
    target: c?.target != null ? vec3(c.target) : undefined,
    fov: c?.fov != null ? num(c.fov, 50) : undefined,
  });
  const a = pick(prevCam);
  const b = pick(nextCam);
  const changed = !prevCam || ['position', 'target', 'fov'].some((k) => b[k] !== undefined && !eq(a[k], b[k]));
  if (!changed) return null;
  const out = {};
  for (const k of ['position', 'target', 'fov']) if (b[k] !== undefined) out[k] = b[k];
  return Object.keys(out).length ? out : null;
}

/**
 * id'leri eksik nesnelere o1, o2… atar (var olanlarla çakışmadan; tekrar eden id'ye yenisi verilir).
 * media dizi biçimindeyse nesneye çevrilir. Girdiyi değiştirmez, kopya döner.
 */
export function normalize(proj) {
  const p = clone(isObj(proj) ? proj : {}) || {};
  if (Array.isArray(p.media)) p.media = Object.fromEntries(p.media.map((m, i) => [m?.id || `m${i + 1}`, m?.path || m?.file]));
  if (!Array.isArray(p.objects)) {
    if (p.objects != null) p.objects = [];
    return p;
  }
  p.objects = p.objects.filter(isObj);
  const used = new Set();
  const all = new Set(p.objects.map((o) => (o.id != null && o.id !== '' ? String(o.id) : null)).filter(Boolean));
  let n = 0;
  const fresh = () => {
    let id;
    do id = `o${++n}`;
    while (all.has(id) || used.has(id));
    return id;
  };
  for (const o of p.objects) {
    let id = o.id != null && o.id !== '' ? String(o.id) : null;
    if (!id || used.has(id)) id = fresh();
    o.id = id;
    used.add(id);
  }
  // "preset": fills material fields the object does not set itself (then the key is dropped).
  for (const o of p.objects) {
    if (o.preset == null) continue;
    const pr = MATERIAL_PRESETS[String(o.preset).toLowerCase()];
    delete o.preset;
    const kind = kindOf(o);
    if (!pr || kind === 'model' || kind === 'light') continue;
    for (const k of ['color', 'metalness', 'roughness', 'emissiveIntensity', 'opacity']) {
      // Like the panel preset: for text "color" is the text colour, a preset never recolours it.
      if (k === 'color' && kind === 'text') continue;
      if (o[k] == null && pr[k] !== undefined) o[k] = pr[k];
    }
    if (pr.glow && o.emissive == null) {
      // Like the panel preset, glow uses the object's own colour. A shape without one gets a palette
      // colour chosen from its id (stable, so normalize stays idempotent) instead of a blown-out white.
      if (o.color == null && kind !== 'text') o.color = GLOW_PALETTE[hashStr(o.id) % GLOW_PALETTE.length];
      o.emissive = normColor(o.color) || '#ffffff';
    } else if (o.emissive == null && kind !== 'text') o.emissive = '#000000';
  }
  // "array": {count, axis, spacing} expands into `count` extra copies (ids "<id>.2", "<id>.3", ...), offset along the axis.
  const expanded = [];
  // Light copies are capped so the scene keeps at most MAX_LIGHTS lights (the 3D mode refuses more).
  let lightBudget = MAX_LIGHTS - p.objects.filter((o) => kindOf(o) === 'light').length;
  for (const o of p.objects) {
    expanded.push(o);
    if (!isObj(o.array)) {
      delete o.array;
      continue;
    }
    const a = o.array;
    delete o.array;
    let count = Math.max(0, Math.min(100, Math.round(num(a.count, 0))));
    if (kindOf(o) === 'light') {
      count = Math.min(count, Math.max(0, lightBudget));
      lightBudget -= count;
    }
    const ax = ['x', 'y', 'z'].indexOf(String(a.axis || 'x').toLowerCase());
    const spacing = num(a.spacing, 1);
    const base = fieldVal(o, 'position') || [0, 0, 0];
    for (let i = 1; i <= count; i++) {
      const c = clone(o);
      let id = `${o.id}.${i + 1}`;
      while (used.has(id)) id += '_';
      used.add(id);
      c.id = id;
      if (o.name != null) c.name = `${o.name} ${i + 1}`;
      const pos = [...base];
      pos[ax < 0 ? 0 : ax] += i * spacing;
      c.position = pos.map((x) => rnd(x));
      expanded.push(c);
    }
  }
  p.objects = expanded;
  return p;
}

/**
 * prev -> next 3D fark planı. current: sahnede olup prev'de olmayan id'ler için taban (id -> spec).
 * @returns {{scene, camera, removed: string[], added: object[], rebuilt: object[], changed: {id, spec, fields}[]}}
 */
export function planDiff(prev, next, current = new Map()) {
  const objsOf = (p) => (Array.isArray(p?.objects) ? p.objects.filter(isObj) : []);
  const pm = new Map(objsOf(prev).map((o) => [o.id, o]));
  const nextObjs = objsOf(next);
  const nm = new Set(nextObjs.map((o) => o.id));
  const plan = {
    scene: diffScene(prev ? prev.scene || {} : null, next?.scene),
    camera: diffCamera(prev ? prev.camera || {} : null, next?.camera),
    removed: [...pm.keys()].filter((id) => !nm.has(id)),
    added: [],
    rebuilt: [],
    changed: [],
  };
  for (const b of nextObjs) {
    const a = pm.get(b.id) || current.get(b.id);
    if (!a) plan.added.push(b);
    else if (needsRebuild(a, b)) plan.rebuilt.push(b);
    else {
      const fields = diffFields(a, b);
      if (fields.length) plan.changed.push({ id: b.id, spec: b, fields });
    }
  }
  return plan;
}

/** Yeni id: used kümesinde olmayan ilk oN. */
export function freshId(used) {
  let n = 0;
  let id;
  do id = `o${++n}`;
  while (used.has(id));
  used.add(id);
  return id;
}

/** Varsayılanla aynı olan ve önceki spec'te bulunmayan alanlar yazılmaz (proje.json sade kalsın). */
const DEFAULTS = { rotation: [0, 0, 0], scale: [1, 1, 1], metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 1, opacity: 1, wireframe: false, visible: true };

/**
 * Sahne nesnesinin düz özeti (THREE'siz; obj yalnız okunur) -> proje.json nesnesi.
 * prevSpec verilirse bilinmeyen alanları, şekil yazımı ve sayı/dizi biçimi korunur. Model yolu ve sığdırma
 * sahneden (userData.lsrc / lfit) gelir; dir verilirse proje klasörü altındaki mutlak model yolu göreli yazılır.
 */
export function objToSpec(obj, prevSpec = null, dir = '') {
  const ud = obj.userData || {};
  const prev = isObj(prevSpec) ? prevSpec : null;
  const out = prev ? { ...prev } : {};
  if (ud.lid != null) out.id = ud.lid;
  const light = !!ud.hl;
  const text = ud.kind === 'text';
  const model = !ud.hs && !light;
  if (light) {
    out.light = ud.light?.kind === 'spot' ? 'spot' : 'point';
    delete out.shape;
    delete out.model;
    delete out.fit;
  } else if (model) {
    // Sahnedeki model (ör. geri alma ile dönen eski model) önceliklidir; aynı dosyaysa önceki yazım korunur.
    let src = ud.lsrc ? relToDir(ud.lsrc, dir) : prev?.model;
    if (src && prev?.model && pathKey(prev.model) === pathKey(src)) src = prev.model;
    if (!src) return null; // diskte yolu bilinmeyen model proje.json'a yazılamaz
    out.model = src;
    if (ud.lfit != null) out.fit = ud.lfit;
    else delete out.fit;
    delete out.shape;
  } else {
    out.shape = prev && shapeKind(prev.shape) === ud.kind ? prev.shape : ud.kind;
    delete out.model;
    delete out.fit;
  }
  const has = (k) => !!prev && k in prev;
  const put = (k, v) => {
    const d = DEFAULTS[k];
    if (d !== undefined && eq(Array.isArray(d) ? vec3(v) : v, d) && !has(k)) delete out[k];
    else out[k] = v;
  };
  const vecOut = (k, arr) => {
    const uniform = arr.every((x) => eq(x, arr[0]));
    put(k, uniform && !Array.isArray(prev?.[k]) && k === 'scale' ? arr[0] : arr);
  };
  out.name = obj.name;
  out.position = obj.position.toArray().slice(0, 3).map((v) => rnd(v));
  vecOut('rotation', [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((v) => rnd(v / DEG, 2)));
  const base = model ? num(ud.lbase, 1) || 1 : 1;
  vecOut('scale', obj.scale.toArray().slice(0, 3).map((v) => rnd(v / base)));
  if (light) {
    const L = ud.light || {};
    out.color = normColor(L.color) || '#ffffff';
    out.intensity = rnd(L.intensity, 2);
    if (L.distance || (prev && 'distance' in prev)) out.distance = rnd(L.distance || 0, 2);
    if (L.kind === 'spot') {
      out.angle = rnd(L.angle, 1);
      out.penumbra = rnd(L.penumbra, 2);
    }
  } else if (!model) {
    const m = obj.material || {};
    if (text) {
      const tx = ud.tx || {};
      out.text = tx.text;
      if (tx.font !== TEXT_DEFAULTS.font || has('font')) out.font = tx.font;
      out.color = normColor(tx.color) || '#ffffff';
      if (tx.background || has('background')) out.background = tx.background || '';
      out.size = rnd(tx.size ?? 1);
    } else if (m.color?.getHexString) out.color = '#' + m.color.getHexString();
    if (m.emissive?.getHexString) {
      put('emissive', '#' + m.emissive.getHexString());
      put('emissiveIntensity', rnd(m.emissiveIntensity ?? 1));
      put('opacity', rnd(m.opacity ?? 1));
    }
    put('metalness', rnd(m.metalness ?? 0));
    put('roughness', rnd(m.roughness ?? 0.6));
    put('wireframe', !!m.wireframe);
    if (CURVED.has(ud.kind) && ud.seg) out.detail = ud.seg;
    else delete out.detail;
    const tex = text ? null : ud.ltex || (m.map ? prev?.texture : null);
    if (tex) out.texture = tex;
    else delete out.texture;
  }
  put('visible', obj.visible !== false);
  // id en başta, sonra tür alanı: okunaklı sıra.
  const { id, shape, model: mdl, ...rest } = out;
  return { ...(id != null ? { id } : {}), ...(shape != null ? { shape } : {}), ...(mdl != null ? { model: mdl } : {}), ...rest };
}

// ------------------------------------------------------------------ modül durumu

/** Son uygulanan proje (snapshot'ta 3D dışı alanlar ve nesne biçimleri buradan korunur). */
let last = null;

const findObj = (api, id) => api.objects().find((o) => o.userData?.lid === id) || null;
const fmtNum = (v, d = 3) => String(+num(v).toFixed(d));

function fire(el, type) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/** Ajanlı ya da ajansız adımlar. anim=false iken panel işlemleri atlanır (sadece kesin API çağrıları). */
function makeOps(A, anim) {
  return {
    anim,
    pick: (role) => A.pick(role),
    async click(ag, el, real = false) {
      if (!el) return;
      if (anim) await A.click(ag, el, { real });
      else if (real) el.click();
    },
    async type(ag, el, text) {
      if (anim && el) await A.typeInto(ag, el, String(text));
    },
    async slide(ag, el, v) {
      if (anim && el && v != null) await A.slide(ag, el, v);
    },
    async color(ag, el, v) {
      if (!anim || !el || !v) return;
      await A.click(ag, el, { real: false });
      el.value = v;
      fire(el, 'input');
      fire(el, 'change');
    },
    flash(ag, target, label, hold = 900, extra = {}) {
      if (anim && target) A.select(ag, target, { label, hold, ...extra });
    },
    async move(ag, target) {
      if (anim && target) await A.moveTo(ag, target);
    },
    idle(ag, ms) {
      if (anim) A.busy(ag, ms);
    },
  };
}

/** Kırmızımsı ajan (silme işlemleri için). */
const redAgent = (A) => A.list?.find((a) => /^#(f43f5e|ef4444)$/i.test(a.color)) || A.pick('Efekt');

/**
 * Kesin değerleri API ile verir (yalnız keys). Doku env.loadFile ile yüklenir; yüklenemezse diğer alanlar
 * yine uygulanır, doku eski hâlinde kalır ve sonra err.texture işaretli hata fırlatılır.
 */
async function applyExact(api, env, obj, spec, keys) {
  const o = {};
  const model = isModelObj(obj);
  let texErr = null;
  let texPath = null;
  for (const k of keys) {
    const v = fieldVal(spec, k);
    if (v === undefined) continue;
    if (k === 'scale' && model) o.scale = v.map((x) => x * (num(obj.userData.lbase, 1) || 1));
    else if (k === 'texture') {
      if (v) {
        try {
          o.texture = await env.loadFile(v);
          texPath = spec.texture;
          const c = fieldVal(spec, 'color');
          if (c) o.color = c;
        } catch (e) {
          texErr = new Error(t('l3d.texLoad', 'texture could not be loaded ({path}): {error}', { path: spec.texture, error: e?.message || e }));
          texErr.texture = true;
        }
      } else {
        o.texture = null;
        delete obj.userData.ltex;
      }
    } else o[k] = v;
  }
  const job = Object.keys(o).length ? api.update(obj, o) : null;
  if (texPath != null) {
    // The file loaded; the image is decoded asynchronously. Only a decoded texture counts as applied
    // (otherwise ltex keeps the previous path, so the next diff retries and failedTex reports it).
    const ok = job && typeof job.then === 'function' ? await job : true;
    if (ok === false) {
      texErr = new Error(t('l3d.texDecode', 'texture could not be decoded ({path})', { path: spec.texture }));
      texErr.texture = true;
    } else obj.userData.ltex = texPath;
  }
  if (texErr) throw texErr;
}

/** Seçili nesnenin panelinde yalnız verilen alanlar için ajan işlemleri. */
async function panelOps(ops, ag, api, obj, spec, keys) {
  if (!ops.anim) return;
  const model = isModelObj(obj);
  const light = !!obj.userData.hl;
  const base = model ? num(obj.userData.lbase, 1) || 1 : 1;
  for (const k of keys) {
    const v = fieldVal(spec, k);
    if (v === undefined) continue;
    if (XYZ.includes(k)) {
      const inputs = $$(`#d-props .xyz[data-v="${k}"] input`);
      const cur =
        k === 'rotation' ? [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((r) => r / DEG) : obj[k].toArray().slice(0, 3);
      const want = k === 'scale' ? v.map((x) => x * base) : v;
      for (let i = 0; i < 3 && i < inputs.length; i++) {
        if (Math.abs(cur[i] - want[i]) > 1e-4) await ops.type(ag, inputs[i], fmtNum(want[i], k === 'rotation' ? 1 : 3));
      }
    } else if (k === 'name') await ops.type(ag, $('#p-name'), v);
    else if (k === 'color') await ops.color(ag, $(light ? '#p-lcol' : '#p-col'), /^#[0-9a-f]{6}$/.test(v) ? v : null);
    else if (k === 'metalness') await ops.slide(ag, $('#p-met'), v);
    else if (k === 'roughness') await ops.slide(ag, $('#p-rou'), v);
    else if (k === 'emissive') await ops.color(ag, $('#p-emi'), /^#[0-9a-f]{6}$/.test(v) ? v : null);
    else if (k === 'emissiveIntensity') await ops.slide(ag, $('#p-emii'), v);
    else if (k === 'opacity') await ops.slide(ag, $('#p-opa'), v);
    else if (k === 'text') await ops.type(ag, $('#p-text'), v);
    else if (k === 'font') await ops.type(ag, $('#p-font'), v);
    else if (k === 'size') await ops.slide(ag, $('#p-tsize'), v);
    else if (k === 'intensity') await ops.slide(ag, $('#p-lint'), v);
    else if (k === 'distance') await ops.slide(ag, $('#p-ldist'), v);
    else if (k === 'angle') await ops.slide(ag, $('#p-lang'), v);
    else if (k === 'penumbra') await ops.slide(ag, $('#p-lpen'), v);
    else if (k === 'detail') await ops.slide(ag, $('#p-seg'), v);
    else if (k === 'wireframe') {
      const el = $('#p-wf');
      await ops.click(ag, el, !!el && el.checked !== v);
    } else if (k === 'visible') {
      const i = api.objects().indexOf(obj);
      await ops.click(ag, $(`#d-outl [data-eye="${i}"]`), false);
    } else if (k === 'texture') {
      await ops.move(ag, api.el.viewport());
      ops.idle(ag, 500);
    }
  }
  // Odakta kalan kutu panel tazelemesinde eşitlenmeyi engellemesin.
  const ae = document.activeElement;
  if (ae && api.el.props()?.contains(ae)) ae.blur();
}

/** Yeni nesne (şekil ya da model) ekler; lid bağlar. Sahne nesnesini döner. */
async function addObject(api, env, ops, spec, quick) {
  const kind = kindOf(spec);
  let obj;
  if (kind === 'model') {
    const file = await env.loadFile(spec.model);
    const ag = ops.pick('3D');
    if (ops.anim) await agentsOf(env).drag(ag, $('#d-import'), api.el.viewport(), { label: file.name, onDrop: async () => {} });
    obj = await api.importModel(file, { fit: spec.fit, name: spec.name });
    obj.userData.lsrc = spec.model;
    if (spec.fit != null) obj.userData.lfit = spec.fit;
    else delete obj.userData.lfit;
    if (obj.userData.lbase == null) obj.userData.lbase = obj.scale.x;
    obj.userData.lid = spec.id;
    if (ops.anim && !quick) {
      api.select(obj);
      await sleep(20);
      await panelOps(ops, ag, api, obj, spec, ['position']);
    }
    await applyExact(api, env, obj, spec, ['name', 'position', 'rotation', 'scale', 'visible']);
    return obj;
  }
  if (kind === 'light') {
    const lt = lightType(spec);
    const ag = ops.pick('Işık');
    await ops.click(ag, api.el.addButton(lt + 'light'), false);
    const lfull = {};
    for (const k of FIELDS) {
      const v = fieldVal(spec, k);
      if (v !== undefined && k !== 'texture') lfull[k] = v;
    }
    obj = api.addLight(lt, lfull);
    obj.userData.lid = spec.id;
    if (ops.anim && !quick) {
      api.select(obj);
      await sleep(20);
      await panelOps(ops, ag, api, obj, spec, ['position', 'color', 'intensity']);
    }
    await applyExact(api, env, obj, spec, FIELDS);
    return obj;
  }
  if (!kind) throw new Error(t('l3d.unknownShape', 'Unknown shape: {shape} (valid: {valid})', { shape: spec.shape, valid: SHAPES.join(', ') }));
  const ag = ops.pick(kind === 'plane' ? 'Düzen' : '3D');
  const full = {};
  for (const k of FIELDS) {
    const v = fieldVal(spec, k);
    if (v !== undefined && k !== 'texture') full[k] = v;
  }
  if (ops.anim && !quick) {
    // Düğmeye tıklanır, şekil varsayılan konumda/renkte doğar; ajan konumu yazar, rengi seçer, kaydırır.
    await ops.click(ag, api.el.addButton(kind), false);
    const start = { name: full.name, detail: full.detail, rotation: full.rotation, scale: full.scale, wireframe: full.wireframe, visible: full.visible };
    obj = api.addShape(kind, start);
    obj.userData.lid = spec.id;
    api.select(obj);
    await sleep(20);
    await panelOps(ops, ag, api, obj, spec, ['position', 'color', 'metalness', 'roughness']);
  } else {
    if (ops.anim) await ops.click(ag, api.el.addButton(kind), false);
    obj = api.addShape(kind, full);
    obj.userData.lid = spec.id;
  }
  try {
    await applyExact(api, env, obj, spec, FIELDS);
  } catch (e) {
    if (e?.texture) e.obj = obj; // nesne sahnede; yalnız doku eksik
    throw e;
  }
  return obj;
}

const agentsOf = (env) => env?.agents || agentsModule;

/** Kamerayı küresel ara değerlerle (hedef etrafında dönerek) yeni konuma taşır; sonra kesin değer. */
async function tweenCamera(api, A, to, anim) {
  const from = api.camera();
  const goal = {
    position: to.position || from.position,
    target: to.target || from.target,
    fov: to.fov ?? from.fov,
  };
  const ms = anim ? (A.dur ? A.dur(900) : 900) : 0;
  // Gizli/küçültülmüş pencerede rAF durur: animasyon atlanır (kesin değer aşağıda verilir).
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (ms > 30 && !hidden && typeof requestAnimationFrame === 'function') {
    const sph = (p, t) => {
      const x = p[0] - t[0], y = p[1] - t[1], z = p[2] - t[2];
      const r = Math.hypot(x, y, z) || 1e-6;
      return { r, th: Math.atan2(x, z), ph: Math.acos(Math.max(-1, Math.min(1, y / r))) };
    };
    const s0 = sph(from.position, from.target);
    const s1 = sph(goal.position, goal.target);
    let dth = s1.th - s0.th;
    if (dth > Math.PI) dth -= 2 * Math.PI;
    if (dth < -Math.PI) dth += 2 * Math.PI;
    const lerp = (a, b, k) => a + (b - a) * k;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const t0 = performance.now();
    await new Promise((resolve) => {
      // Yedek zamanlayıcı: animasyon sırasında pencere gizlenirse rAF durur, uygulama asılı kalmasın.
      let fin = false;
      const res = () => {
        if (fin) return;
        fin = true;
        clearTimeout(tm);
        resolve();
      };
      const tm = setTimeout(res, ms + 250);
      const step = (now) => {
        if (fin) return;
        const k = ease(Math.min(1, (now - t0) / ms));
        const tg = [0, 1, 2].map((i) => lerp(from.target[i], goal.target[i], k));
        const r = lerp(s0.r, s1.r, k), th = s0.th + dth * k, ph = lerp(s0.ph, s1.ph, k);
        api.setCamera({
          target: tg,
          position: [tg[0] + r * Math.sin(ph) * Math.sin(th), tg[1] + r * Math.cos(ph), tg[2] + r * Math.sin(ph) * Math.cos(th)],
          fov: lerp(from.fov, goal.fov, k),
        });
        if (now - t0 < ms) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
  }
  api.setCamera(goal);
}

// ------------------------------------------------------------------ uygulayıcı arayüzü

/**
 * prev -> next 3D farkını ajanlarla uygular. prev null ise sahne boşaltılıp sıfırdan kurulur.
 * Nesne hatası (bulunamayan model/doku, bilinmeyen şekil) tüm işi durdurmaz: env.note ile bildirilir.
 */
export async function apply(prev, next, env) {
  const api = env.modes.m3d.api;
  const A = agentsOf(env);
  next = normalize(next);
  prev = prev ? normalize(prev) : null;
  const anim = env.show !== false && env.speed !== 'instant';
  const ops = makeOps(A, anim);
  const note = (m) => {
    console.warn('[live 3d]', m);
    env.note?.(m);
  };

  if (!prev || anim) {
    env.switchTab?.('m3d');
    await sleep(anim ? 50 : 0);
  }
  if (!prev) {
    // Sıfırdan kurulum: önceki oturumun/kullanıcının sahne ve kamera ayarları projeye sızmasın.
    api.clear();
    const d = api.defaults?.() || DEFAULT_VIEW;
    api.setScene({ ...d.scene, persist: false });
    api.setCamera(d.camera);
  }
  const startSel = api.selected();

  // Sahnedeki (prev'de olmayan) kimlikli nesneler fark tabanı olur.
  const current = new Map();
  for (const o of api.objects()) {
    const lid = o.userData?.lid;
    if (lid == null) continue;
    const s = objToSpec(o, null, env.dir);
    if (s) current.set(lid, s);
  }
  const plan = planDiff(prev, next, current);
  // Diskte değişen doku/model dosyaları (ör. önce yüklenemeyen doku sonradan eklendi): alan aynı olsa da yeniden uygulanır.
  const mc = new Set([...(env.mediaChanged || [])].map((m) => pathKey(relToDir(m, env.dir))));
  if (prev && mc.size) {
    const hit = (p) => !!p && mc.has(pathKey(relToDir(p, env.dir)));
    const placedIds = new Set([...plan.added, ...plan.rebuilt].map((o) => o.id));
    for (const b of next.objects || []) {
      if (placedIds.has(b.id)) continue;
      if (kindOf(b) === 'model') {
        if (!hit(b.model)) continue;
        plan.changed = plan.changed.filter((c) => c.id !== b.id);
        plan.rebuilt.push(b);
      } else if (fieldVal(b, 'texture') && hit(b.texture)) {
        const ch = plan.changed.find((c) => c.id === b.id);
        if (!ch) plan.changed.push({ id: b.id, spec: b, fields: ['texture'] });
        else if (!ch.fields.includes('texture')) ch.fields.push('texture');
      }
    }
  }
  // Uygulanamayanlar: fark tabanı (dönen applied) bunları uygulanmış saymaz.
  const failedTex = new Set();
  const failedObj = new Set();
  const total = (plan.scene ? 1 : 0) + (plan.camera ? 1 : 0) + plan.removed.length + plan.added.length + plan.rebuilt.length + plan.changed.length;
  let done = 0;
  const tick = () => {
    done++;
    if (anim && A.active) A.progress(Math.min(done, total), total, '3D');
  };
  // Çok nesnede yazma/kaydırma animasyonları kısalır (ilk birkaçı tam gösterilir).
  let objOps = 0;
  const objTotal = plan.added.length + plan.rebuilt.length + plan.changed.length;
  const quickNow = () => objTotal > 8 && ++objOps > 6;

  // 1) Sahne ayarları paneli
  if (plan.scene) {
    const s = plan.scene;
    if (anim) {
      api.select(null);
      await sleep(20);
      const ag = ops.pick('Işık');
      await ops.move(ag, api.el.props());
      if (s.background && /^#[0-9a-f]{6}$/.test(s.background)) await ops.color(ag, $('#p-bg'), s.background);
      if (s.light != null) await ops.slide(ag, $('#p-light'), s.light);
      if (s.grid != null) {
        const el = $('#p-grid');
        if (el && el.checked !== s.grid) await ops.click(ag, el, true);
      }
      if (s.shadows != null) {
        const el = $('#p-sh');
        if (el && !el.disabled && el.checked !== s.shadows) await ops.click(ag, el, true);
      }
      if (s.ambient != null) ops.idle(ag, 400);
    }
    api.setScene({ ...s, persist: false });
    tick();
  }

  // 2) Silinenler
  for (const id of plan.removed) {
    const obj = findObj(api, id);
    if (obj) {
      if (anim) {
        const ag = redAgent(A);
        api.select(obj);
        await sleep(20);
        const box = api.screenOf(obj);
        await ops.move(ag, box || api.el.viewport());
        ops.flash(ag, box, t('l3d.del', 'delete'), 800, { color: '#ef4444', tone: 'danger' });
        await ops.click(ag, $('#p-del'), false);
      }
      api.remove(obj);
    }
    tick();
  }

  // 3) Yeniden kurulanlar (şekil/model değişti) ve eklenenler
  const placed = [];
  for (const spec of [...plan.rebuilt, ...plan.added]) {
    try {
      const old = findObj(api, spec.id);
      if (old) api.remove(old);
      const obj = await addObject(api, env, ops, spec, quickNow());
      placed.push(obj);
      ops.flash(ops.pick('Ölçek'), api.screenOf(obj), obj.name);
    } catch (e) {
      if (e?.texture) {
        failedTex.add(spec.id);
        if (e.obj) placed.push(e.obj);
        note(t('l3d.texFailed', '3D texture could not be applied ({id}): {error}', { id: spec.id, error: e.message || e }));
      } else {
        failedObj.add(spec.id);
        note(t('l3d.addFailed', '3D object could not be added ({id}): {error}', { id: spec.id, error: e.message || e }));
      }
    }
    tick();
  }

  // 4) Değişen alanlar
  for (const ch of plan.changed) {
    try {
      let obj = findObj(api, ch.id);
      if (!obj) {
        // Sahneden kalkmış (ör. kullanıcı sildi): yeniden ekle.
        obj = await addObject(api, env, ops, ch.spec, quickNow());
      } else {
        const quick = quickNow();
        if (anim) {
          api.select(obj);
          await sleep(20);
          const ag = ops.pick(ch.fields.some((k) => ['color', 'metalness', 'roughness', 'texture', 'wireframe'].includes(k)) ? 'Malzeme' : 'Düzen');
          ops.flash(ag, api.screenOf(obj), obj.name, 600);
          if (!quick) await panelOps(ops, ag, api, obj, ch.spec, ch.fields);
        }
        await applyExact(api, env, obj, ch.spec, ch.fields);
      }
      ops.flash(ops.pick('Ölçek'), api.screenOf(obj), obj.name);
    } catch (e) {
      if (e?.texture) {
        failedTex.add(ch.id);
        note(t('l3d.texFailed', '3D texture could not be applied ({id}): {error}', { id: ch.id, error: e.message || e }));
      } else {
        failedObj.add(ch.id);
        note(t('l3d.updateFailed', '3D object could not be updated ({id}): {error}', { id: ch.id, error: e.message || e }));
      }
    }
    tick();
  }

  // Seçimi eski hâline getir (panel sahne ayarlarına ya da kullanıcının seçimine döner).
  api.select(startSel && api.objects().includes(startSel) ? startSel : null);

  // 5) Kamera: görünüm alanına gidilir, kamera yumuşakça döner.
  // camera.preset (front/right/top/persp/orbit/close/hero) is resolved now that all objects exist; it
  // only applies when it is new (first apply, or different from the previous file's preset).
  let camPlan = plan.camera;
  const presetName = isObj(next.camera) && next.camera.preset != null ? String(next.camera.preset).toLowerCase() : '';
  if (presetName && (!prev || String(prev.camera?.preset ?? '').toLowerCase() !== presetName)) {
    const pose = CAMERA_PRESETS.includes(presetName) ? api.cameraPose?.(presetName) : null;
    if (pose) camPlan = { ...(camPlan || {}), ...pose };
    else note(t('l3d.presetUnknown', '3D camera.preset unknown: {name} (valid: {valid})', { name: presetName, valid: CAMERA_PRESETS.join(', ') }));
  }
  if (camPlan) {
    const ag = ops.pick('Kamera');
    await ops.move(ag, api.el.viewport());
    ops.idle(ag, 700);
    await tweenCamera(api, A, camPlan, anim);
    tick();
  }

  api.commit();
  // Uygulanamayan alanlar sahnedeki gerçek hâle çekilir: sonraki farkta yeniden denenir, kullanıcı
  // düzenlemesinin snapshot'ı Claude'un diğer değerlerini geri almaz.
  let applied = next;
  if ((failedTex.size || failedObj.size) && Array.isArray(next.objects)) {
    applied = clone(next);
    applied.objects = applied.objects.flatMap((o) => {
      const cur = findObj(api, o.id);
      if (failedObj.has(o.id)) {
        const s = cur ? objToSpec(cur, o, env.dir) : null;
        return s ? [s] : [];
      }
      if (failedTex.has(o.id)) {
        const tex = cur?.userData.ltex;
        if (tex) o.texture = tex;
        else delete o.texture;
      }
      return [o];
    });
  }
  last = applied;
  return { changes: total, applied };
}

/** Mevcut sahne -> proje.json 3d biçimi. Kimliksiz (arayüzde eklenen) nesnelere yeni id verilir. */
export function snapshot(env) {
  const api = env.modes.m3d.api;
  const base = last ? clone(last) : { type: '3d' };
  const prevById = new Map((Array.isArray(base.objects) ? base.objects : []).filter(isObj).map((o) => [o.id, o]));
  const objs = api.objects();
  const used = new Set([...prevById.keys(), ...objs.map((o) => o.userData?.lid).filter((v) => v != null)]);
  const seen = new Set();
  const objects = [];
  for (const o of objs) {
    let lid = o.userData.lid;
    if (lid == null || seen.has(lid)) o.userData.lid = lid = freshId(used);
    seen.add(lid);
    const spec = objToSpec(o, prevById.get(lid), env.dir);
    if (spec) objects.push(spec);
  }
  const sc = api.scene ? api.scene() : null;
  const cam = api.camera();
  const out = base;
  if (!out.type) out.type = '3d';
  if (sc) {
    out.scene = { ...(isObj(base.scene) ? base.scene : {}), background: normColor(sc.background), light: rnd(sc.light, 2), ambient: rnd(sc.ambient, 2), grid: !!sc.grid, shadows: !!sc.shadows };
    if (sc.background2) out.scene.background2 = normColor(sc.background2);
    else delete out.scene.background2;
    if (sc.turntable) out.scene.turntable = true;
    else delete out.scene.turntable;
  }
  out.camera = { ...(isObj(base.camera) ? base.camera : {}), position: cam.position.map((v) => rnd(v)), target: cam.target.map((v) => rnd(v)), fov: rnd(cam.fov, 2) };
  delete out.camera.preset; // a preset is a one-shot command, the pose above is the state
  out.objects = objects;
  last = clone(out);
  return out;
}

/** proj.outputs (yoksa png) -> dosyalar. Göreli yollar env.outDir altında. opts.file: tek çıktı, türü uzantıdan. */
export async function exportNow(proj, env, opts = {}) {
  const api = env.modes.m3d.api;
  const A = agentsOf(env);
  const anim = env.show !== false && env.speed !== 'instant';
  const ops = makeOps(A, anim);
  const name = String(proj?.name || 'proje');
  const outDir = env.outDir || platform.paths.out;
  const outPath = (file, defExt) => {
    const f = file || `${name}.${defExt}`;
    return platform.resolvePath(extOf(f) ? f : `${f}.${defExt}`, outDir);
  };
  let outs;
  if (opts.file) {
    const ext = extOf(opts.file);
    const kind = ext === 'mp4' || ext === 'webm' ? 'spin' : ['obj', 'stl', 'glb'].includes(ext) ? ext : 'png';
    const spec = (proj?.outputs || []).find((o) => isObj(o) && String(o.kind || 'png').toLowerCase() === kind) || {};
    outs = [{ ...spec, kind, file: opts.file }];
  } else {
    outs = Array.isArray(proj?.outputs) && proj.outputs.length ? proj.outputs : proj?.output ? [proj.output] : [{ kind: 'png' }];
  }
  const outputs = [];
  for (const raw of outs) {
    const out = typeof raw === 'string' ? (extOf(raw) ? { kind: extOf(raw) === 'mp4' ? 'spin' : extOf(raw), file: raw } : { kind: raw }) : raw || {};
    const kind = String(out.kind || 'png').toLowerCase();
    const ag = ops.pick('Render');
    if (kind === 'png') {
      await ops.click(ag, $('#d-png'), false);
      const blob = await api.renderPNG(out.width || 1920, out.height || 1080);
      outputs.push(await platform.saveOutput(blob, outPath(out.file, 'png')));
    } else if (kind === 'spin' || kind === 'video') {
      await ops.click(ag, $('[data-send="spin"]')?.closest('details')?.querySelector('summary'), false);
      const blob = await api.recordSpin({
        seconds: out.seconds || 6,
        width: out.width || 1080,
        height: out.height || 1920,
        fps: out.fps || 30,
        turns: out.turns || 1,
      });
      if (!blob) throw new Error(t('l3d.spinFailed', 'Could not record the turntable video'));
      outputs.push(await platform.saveVideoFile(blob, outPath(out.file || `${name}-donen`, 'mp4')));
    } else if (['obj', 'stl', 'glb'].includes(kind)) {
      await ops.click(ag, $('#m3d details.menu summary'), false);
      const blob = await api.exportModel(kind);
      outputs.push(await platform.saveOutput(blob, outPath(out.file || name, kind)));
    } else if (kind === 'project') {
      await ops.click(ag, $('#d-save'), false);
      const blob = await api.saveProject();
      outputs.push(await platform.saveOutput(blob, outPath(out.file || `${name}-proje`, 'glb')));
    } else throw new Error(t('l3d.unknownOutput', 'Unknown output type: {kind}', { kind }));
  }
  return { outputs };
}
