// Tarif çalıştırıcı: docs/TARIF.md'deki JSON tarifini gerçek mod API'leriyle uygular.
// Ajan modu açıksa her adım bir ajana atanır; imleç ilgili düğmeye/kanala/kaydırıcıya gider ve
// işlemi gerçekten o yapar (DOM olayları). Headless'ta ajan animasyonu atlanır, sadece sonuç üretilir.
import { $, $$, busy, sleep, baseName, stripExt, extOf, toast } from './util.js';
import * as platform from './platform.js';
import { agents } from './agents.js';
import { t } from './i18n.js';
import { generateMusic, musicFileName } from './music-gen.js';

// ------------------------------------------------------------------ yardımcılar

export function parseRecipeText(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

const SPEEDS = ['1x', '2x', '5x', 'instant'];
const normSpeed = (s) => {
  s = String(s || '').toLowerCase().replace('anında', 'instant').replace('aninda', 'instant');
  return SPEEDS.includes(s) ? s : null;
};

const RES_ALIAS = { vertical: '1080x1920', dikey: '1080x1920', horizontal: '1920x1080', yatay: '1920x1080', square: '1080x1080', kare: '1080x1080' };

/** Kod paneli için okunaklı JSON: nesne dizileri satır başına bir öğe. Her öğenin satır numarasını da verir. */
function prettyRecipe(r) {
  const lines = ['{'];
  const index = {};
  const keys = Object.keys(r);
  keys.forEach((k, ki) => {
    const v = r[k];
    const comma = ki < keys.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
      index[k] = lines.length;
      lines.push(`  "${k}": [`);
      v.forEach((item, i) => {
        index[`${k}.${i}`] = lines.length;
        lines.push(`    ${JSON.stringify(item)}${i < v.length - 1 ? ',' : ''}`);
      });
      lines.push(`  ]${comma}`);
    } else if (v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length > 70) {
      index[k] = lines.length;
      lines.push(`  "${k}": {`);
      const sub = Object.keys(v);
      sub.forEach((sk, si) => {
        index[`${k}.${sk}`] = lines.length;
        lines.push(`    "${sk}": ${JSON.stringify(v[sk])}${si < sub.length - 1 ? ',' : ''}`);
      });
      lines.push(`  }${comma}`);
    } else {
      index[k] = lines.length;
      lines.push(`  "${k}": ${JSON.stringify(v)}${comma}`);
    }
  });
  lines.push('}');
  return { text: lines.join('\n'), index };
}

const fmtNum = (v) => String(+(+v).toFixed(2));
const setVal = (el, v, ev = 'input') => {
  el.value = v;
  el.dispatchEvent(new Event(ev, { bubbles: true }));
};

/** Ajanlı ya da ajansız adımlar için yönetmen. show=false iken tüm görseller atlanır. */
function makeDirector(show, codeIndex) {
  let done = 0;
  let total = 1;
  const D = {
    show,
    setTotal(n) {
      total = Math.max(1, n);
      if (show) agents.progress(done, total, t('recipe.step', 'step'));
    },
    tick(label) {
      done++;
      if (show) agents.progress(Math.min(done, total), total, label || t('recipe.step', 'step'));
    },
    line(key) {
      if (!show) return;
      // Alt anahtar indekslenmemişse (kısa nesne tek satırda yazıldıysa) üst anahtarın satırına düş.
      const i = codeIndex[key] ?? codeIndex[String(key).split('.')[0]];
      if (i != null) agents.codeLine(i);
    },
    pick: (role) => agents.pick(role),
    async click(ag, el, real = true) {
      if (!el) return;
      if (show) await agents.click(ag, el, { real });
      else if (real) el.click();
    },
    async type(ag, el, text) {
      if (!el) return;
      if (show) await agents.typeInto(ag, el, String(text));
      else {
        setVal(el, text);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    async slide(ag, el, v) {
      if (!el || v == null) return;
      if (show) await agents.slide(ag, el, v);
      else {
        setVal(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    async color(ag, el, v) {
      if (!el || !v) return;
      if (show) await agents.click(ag, el, { real: false });
      setVal(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    flash(ag, target, label, hold = 900) {
      if (show && target) agents.select(ag, target, { label, hold });
    },
    async move(ag, target) {
      if (show && target) await agents.moveTo(ag, target);
    },
    idle(ag, ms) {
      if (show) agents.busy(ag, ms);
    },
  };
  return D;
}

async function loadFile(p, baseDir) {
  const full = platform.resolvePath(p, baseDir);
  if (platform.isNative()) {
    if (!(await platform.exists(full))) throw new Error(t('recipe.fileNotFound', 'File not found: {path}', { path: full }));
    return platform.readBlob(full);
  }
  const res = await fetch(full);
  if (!res.ok) throw new Error(t('recipe.fileNotFound', 'File not found: {path}', { path: full }));
  const b = await res.blob();
  return new File([b], baseName(full), { type: b.type || platform.mimeOf(full) });
}

// ------------------------------------------------------------------ generated music / drawing code

/** "music": {"generate": {...}} without a file: procedural music (src/music-gen.js). */
const isGenMusic = (m) => !!m && typeof m === 'object' && m.generate != null && m.generate !== false && !m.media && !m.file;
/** "generate": {...} | "lofi" | true → generator parameters. */
function genParams(m) {
  const g = m?.generate;
  if (g && typeof g === 'object') return { style: g.style, bpm: g.bpm, seed: g.seed, key: g.key };
  return typeof g === 'string' ? { style: g } : {};
}
/** Seconds the piece must cover ("in" + length × speed), rounded up to 0.5 s; 3..180 s. */
function genSeconds(m, length) {
  const sp = Number.isFinite(+m.speed) && +m.speed > 0 ? Math.min(4, Math.max(0.25, +m.speed)) : 1;
  const need = Math.max(0, +m.in || 0) + Math.max(0, length) * sp;
  return Math.min(180, Math.max(3, Math.ceil(need * 2 - 1e-6) / 2));
}
/**
 * Renders the piece in memory (recipes have no project folder to cache it in) → File named by musicFileName.
 * @returns {Promise<File>}
 */
async function genMusicFile(m, seconds) {
  const params = genParams(m);
  const name = musicFileName(params, seconds);
  const blob = await generateMusic({ ...params, duration: seconds });
  return new File([blob], name, { type: 'audio/wav' });
}
/** Draw clip code as a string (an array of lines is joined). */
const codeStr = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).join('\n') : v == null ? '' : String(v));

// ------------------------------------------------------------------ ana giriş

/**
 * @param recipe  tarif nesnesi
 * @param ctx     {modes, switchTab, baseDir, headless, recordBuild, speed, name, onLog}
 * @returns {outputs: string[], log: string[], seconds}
 */
export async function runRecipe(recipe, ctx) {
  const t0 = performance.now();
  let type = String(recipe.type || '').toLowerCase();
  if (type === 'canli' || type === 'web-canli') type = 'web-live';
  if (!['3d', 'video', 'web', 'web-live', 'proje'].includes(type))
    throw new Error(t('recipe.badType', 'Recipe "type" must be "3d", "video", "web", "web-live" or "proje"'));
  // Canlı proje: proje.json'u açık tutar; Claude düzenledikçe ajanlarla uygulanır (docs/CANLI.md).
  if (type === 'proje') return runProject(recipe, ctx, t0);
  // Canlı mod (Claude siteyi yazarken izle) ayrı akış: ajan yönetmeni ve pencere kaydı kendi içinde.
  if (type === 'web-live') return runLive(recipe, ctx, t0);
  // Tarifteki baseDir (mutlak) göreli yolların kökünü ezer: iş klasörüne kopyalanan tarifler için.
  const baseDir = recipe.baseDir || ctx.baseDir || platform.paths.root;
  const name = recipe.name || ctx.name || 'is';
  const outSpec = ctx.outDir || recipe.outputDir;
  const outDir = outSpec ? platform.resolvePath(outSpec, platform.paths.out) : platform.paths.out;
  const log = [];
  const say = (m) => {
    log.push(m);
    ctx.onLog?.(m);
    console.log('[tarif]', m);
  };
  const outputs = [];
  const outPath = (file, defExt) => {
    const f = file || `${name}.${defExt}`;
    return platform.resolvePath(extOf(f) ? f : `${f}.${defExt}`, outDir);
  };

  const a = recipe.agents || {};
  const headless = !!ctx.headless && type !== 'web';
  // recordBuild: true ya da {"file": "x-yapilis.mp4"} (tariften ya da ctx'ten); dosya adı ayrı tutulur.
  const rbRaw = ctx.recordBuild || recipe.recordBuild;
  const rbObj = [ctx.recordBuild, recipe.recordBuild].find((v) => v && typeof v === 'object' && v.file);
  const recordBuild = !!rbRaw;
  const recordBuildFile = rbObj ? String(rbObj.file) : null;
  const show = !headless && a.show !== false;
  const speed = normSpeed(ctx.speed) || normSpeed(a.speed) || (recordBuild ? '1x' : '2x');
  const count = Math.max(1, Math.min(20, a.count || (type === 'web' ? 20 : 12)));

  if (!headless) platform.win.show();
  const { text: code, index } = prettyRecipe(recipe);
  const D = makeDirector(show && type !== 'web', index);

  let rec = null;
  busy.quiet = show;
  try {
    if (recordBuild && type !== 'web') rec = await startWindowRecord(outPath(recordBuildFile || `${name}-yapilis`, 'mp4'), say);
    if (D.show) {
      agents.start({ count, mode: type, title: name, total: 1, speed, code });
      agents.onClose = () => agents.setSpeed('instant');
      busy.onProgress = (p, detail) => agents.progress(Math.round(p * 100), 100, detail ? t('recipe.exportingDetail', 'exporting · {detail}', { detail }) : t('recipe.exporting', 'exporting'));
    }
    if (type === '3d') await run3d(recipe, ctx, D, { baseDir, outPath, outputs, say, name });
    else if (type === 'video') await runVideo(recipe, ctx, D, { baseDir, outPath, outputs, say, name });
    else await runWeb(recipe, ctx, { baseDir, outPath, outputs, say, name, count, speed, recordBuildFile, show: !ctx.headless || true });
    if (D.show) {
      agents.progress(1, 1, t('recipe.progress.done', 'done'));
      await sleep(agents.instant ? 100 : 900);
    }
  } finally {
    busy.quiet = false;
    busy.onProgress = null;
    if (D.show) {
      agents.onClose = null;
      agents.onTour = null;
      agents.stop({ keep: false });
    }
    if (rec) {
      await sleep(600);
      const p = await rec.stop().catch((e) => say(t('recipe.sayRecordStopFail', 'could not stop recording: {msg}', { msg: e.message })));
      platform.win.onTop(false);
      if (p) {
        outputs.push(p);
        say(t('recipe.sayBuildVideo', 'build video: {path}', { path: p }));
      }
    }
  }
  return { outputs, log, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
}

/** Tüm pencere içeriğini ffmpeg ile kaydeder (--record-build). */
async function startWindowRecord(path, say) {
  if (!platform.isNative()) {
    say(t('recipe.recordNativeOnly', 'record-build is only available in the desktop app'));
    return null;
  }
  if (!(await platform.findFfmpeg())) {
    say(t('recipe.recordNeedsFfmpeg', 'record-build needs ffmpeg; recording skipped'));
    return null;
  }
  await platform.win.show();
  await platform.win.focus();
  await platform.win.onTop(true);
  await sleep(700);
  const rect = async () => {
    const o = await platform.clientOrigin();
    return { x: o.x, y: o.y, w: innerWidth * o.dpr, h: innerHeight * o.dpr };
  };
  const rec = await platform.startScreenRecord(rect, path, { fps: 30 });
  say(t('recipe.recordStarted', 'build recording started'));
  return rec;
}

// ------------------------------------------------------------------ 3D

const SHAPES = ['cube', 'sphere', 'cylinder', 'cone', 'wedge', 'torus', 'capsule', 'plane', 'text'];
const SHAPE_ALIAS = { kup: 'cube', küp: 'cube', box: 'cube', kure: 'sphere', küre: 'sphere', silindir: 'cylinder', koni: 'cone', rampa: 'wedge', ramp: 'wedge', simit: 'torus', kapsul: 'capsule', kapsül: 'capsule', zemin: 'plane', ground: 'plane', yazı: 'text', yazi: 'text', metin: 'text' };

async function run3d(r, ctx, D, o) {
  const mode = ctx.modes.m3d;
  const api = mode.api;
  ctx.switchTab('m3d');
  await sleep(50);
  const objs = r.objects || [];
  const outs = r.outputs || [{ kind: 'png' }];
  D.setTotal(2 + objs.length + outs.length);

  if (r.clear !== false) api.clear();
  api.select(null);

  // Sahne
  if (r.scene) {
    D.line('scene');
    const ag = D.pick('Işık');
    const s = r.scene;
    if (D.show) {
      await D.color(ag, $('#p-bg'), s.background);
      await D.slide(ag, $('#p-light'), s.light);
    }
    api.setScene(s);
    o.say(t('recipe.sceneSet', 'scene set'));
  }
  D.tick(t('recipe.tick.scene', 'scene'));

  // Nesneler
  let prev = null;
  for (let i = 0; i < objs.length; i++) {
    const spec = { ...objs[i] };
    D.line(`objects.${i}`);
    if (spec.texture) spec.texture = await loadFile(spec.texture, o.baseDir);
    let obj;
    if (spec.model) {
      const file = await loadFile(spec.model, o.baseDir);
      const ag = D.pick('3D');
      if (D.show) {
        await agents.drag(ag, $('#d-import'), api.el.viewport(), {
          label: file.name,
          onDrop: async () => {},
        });
      }
      obj = await api.importModel(file, spec);
      if (spec.name) api.update(obj, { name: spec.name });
      o.say(t('recipe.model', 'model: {name}', { name: file.name }));
    } else if (spec.light || /^(point|spot)light$/i.test(String(spec.shape || ''))) {
      // Light object: {light:"point"|"spot", color, intensity, distance, angle, penumbra, position, rotation}.
      const lk = String(spec.light || spec.shape).toLowerCase().startsWith('spot') ? 'spot' : 'point';
      if (D.show) await D.click(D.pick('Işık'), api.el.addButton(lk + 'light'), false);
      obj = api.addLight(lk, spec);
      o.say(t('recipe.shape', 'shape: {kind}', { kind: lk + ' light' }));
    } else {
      const kind = SHAPE_ALIAS[String(spec.shape || '').toLowerCase()] || String(spec.shape || 'cube').toLowerCase();
      if (!SHAPES.includes(kind)) throw new Error(t('recipe.unknownShape', 'Unknown shape: {shape} (valid: {valid})', { shape: spec.shape, valid: SHAPES.join(', ') }));
      const ag = D.pick(i % 2 ? 'Düzen' : '3D');
      if (D.show) {
        // Nesneyi iki yolda da addShape kurar (aynı renk/konum/ad); düğme tıklaması yalnız görsel.
        await D.click(ag, api.el.addButton(kind), false);
        obj = api.addShape(kind, spec);
        api.select(obj);
        const heavy = objs.length > 10 && i > 5; // çok nesnede yazmayı kısalt
        if (!heavy && spec.position) {
          const inputs = $$('#d-props .xyz[data-v="position"] input');
          for (let k = 0; k < 3 && k < inputs.length; k++) await D.type(ag, inputs[k], fmtNum(spec.position[k] ?? 0));
        }
        if (!heavy && spec.color) await D.color(ag, $('#p-col'), spec.color);
        if (!heavy && spec.metalness != null) await D.slide(ag, $('#p-met'), spec.metalness);
        if (!heavy && spec.roughness != null) await D.slide(ag, $('#p-rou'), spec.roughness);
        // Yazma/kaydırıcı animasyonları değeri yuvarlayabilir: kesin değerleri yeniden uygula
        // (doku addShape'te bağlandı; ikinci kez yüklenmesin).
        api.update(obj, { ...spec, texture: undefined });
      } else {
        obj = api.addShape(kind, spec);
      }
      o.say(t('recipe.shape', 'shape: {kind}', { kind }));
    }
    // Material preset and array copies (same fields as proje.json).
    if (obj && spec.preset && api.presets().includes(spec.preset)) api.applyPreset(obj, spec.preset);
    if (obj && spec.array && +spec.array.count > 0) api.array(obj, spec.array);
    if (D.show && obj) {
      D.flash(D.pick('Ölçek'), api.screenOf(obj), obj.name);
      if (prev) D.flash(D.pick('Malzeme'), api.screenOf(prev), prev.name, 700);
    }
    prev = obj;
    D.tick(t('recipe.tick.object', 'object'));
  }
  api.select(null);
  api.commit();

  // Kamera
  if (r.camera) {
    D.line('camera');
    const ag = D.pick('Kamera');
    await D.move(ag, api.el.viewport());
    D.idle(ag, 600);
    const pose = r.camera.preset ? api.cameraPose(r.camera.preset) : null;
    api.setCamera(pose ? { ...r.camera, ...pose } : r.camera);
  }
  D.tick(t('recipe.tick.camera', 'camera'));
  if (D.show) agents.onTour = () => orbitPreview(api);

  // Çıktılar
  for (let i = 0; i < outs.length; i++) {
    const out = typeof outs[i] === 'string' ? { kind: outs[i] } : outs[i];
    const kind = String(out.kind || 'png').toLowerCase();
    D.line(`outputs.${i}`);
    const ag = D.pick('Render');
    if (kind === 'png') {
      await D.click(ag, $('#d-png'), false);
      const blob = await api.renderPNG(out.width || 1920, out.height || 1080);
      o.outputs.push(await platform.saveOutput(blob, o.outPath(out.file, 'png')));
    } else if (kind === 'spin' || kind === 'video') {
      await D.click(ag, $('[data-send="spin"]')?.closest('details')?.querySelector('summary'), false);
      const blob = await api.recordSpin({
        seconds: out.seconds || 6,
        width: out.width || 1080,
        height: out.height || 1920,
        fps: out.fps || 30,
        turns: out.turns || 1,
      });
      if (!blob) throw new Error(t('recipe.spinFail', 'Could not record the spin video'));
      o.outputs.push(await platform.saveVideoFile(blob, o.outPath(out.file || `${o.name}-donen`, 'mp4')));
    } else if (['obj', 'stl', 'glb'].includes(kind)) {
      await D.click(ag, $('#m3d details.menu summary'), false);
      const blob = await api.exportModel(kind);
      o.outputs.push(await platform.saveOutput(blob, o.outPath(out.file || o.name, kind)));
    } else if (kind === 'project') {
      await D.click(ag, $('#d-save'), false);
      const blob = await api.saveProject();
      o.outputs.push(await platform.saveOutput(blob, o.outPath(out.file || `${o.name}-proje`, 'glb')));
    } else throw new Error(t('recipe.unknownOutput', 'Unknown output type: {kind}', { kind }));
    o.say(t('recipe.output', 'output: {path}', { path: o.outputs.at(-1) }));
    D.tick(t('recipe.tick.output', 'output'));
  }
}

/** HUD "Tur": kamerayı hedefin etrafında bir tur döndürür (kayıt yok). */
async function orbitPreview(api) {
  const cam = api.camera?.();
  if (!cam || !api.setCamera) return;
  const { position: p, target: t } = cam;
  const dx = p[0] - t[0], dz = p[2] - t[2];
  const r = Math.hypot(dx, dz), a0 = Math.atan2(dz, dx);
  const t0 = performance.now(), dur = 4000;
  await new Promise((res) => {
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const a = a0 + k * Math.PI * 2;
      api.setCamera({ position: [t[0] + Math.cos(a) * r, p[1], t[2] + Math.sin(a) * r], target: t });
      if (k < 1) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });
}

// ------------------------------------------------------------------ video

async function runVideo(r, ctx, D, o) {
  const mode = ctx.modes.mvid;
  const api = mode.api;
  ctx.switchTab('mvid');
  await sleep(50);

  const mediaSpec = Array.isArray(r.media)
    ? Object.fromEntries(r.media.map((m, i) => [m.id || `m${i}`, m.path || m.file]))
    : { ...(r.media || {}) };
  // Kod paneli satırı: dizi biçiminde indeks "media.<sıra>", harita biçiminde "media.<kimlik>".
  const mediaLine = Array.isArray(r.media) ? Object.fromEntries(r.media.map((m, i) => [m.id || `m${i}`, `media.${i}`])) : {};
  const clips = r.clips || [];
  const texts = r.texts || [];
  const music = typeof r.music === 'string' ? { file: r.music } : r.music;
  // Kliplerde doğrudan dosya yolu verilmişse onu da medya say.
  for (const c of [...clips, music].filter(Boolean)) {
    const ref = c.media || c.file;
    if (ref && !(ref in mediaSpec)) mediaSpec[ref] = ref;
  }
  const mediaKeys = Object.keys(mediaSpec);
  D.setTotal(2 + mediaKeys.length + clips.length + texts.length + (music ? 1 : 0));

  if (r.clear !== false) api.clear();

  // Proje ayarları
  const res = RES_ALIAS[String(r.resolution || '').toLowerCase()] || r.resolution || '1080x1920';
  const resStr = Array.isArray(res) ? res.join('x') : String(res);
  D.line('resolution');
  if (D.show) {
    const ag = D.pick('Düzen');
    const sel = $('#v-res');
    await D.click(ag, sel, false);
    D.flash(ag, $('#v-canvas'), resStr.replace('x', ' × '), 1000);
  }
  api.setResolution(resStr);
  if (r.fps) api.setFps(+r.fps);
  if (r.background) api.setBackground(r.background);
  D.tick(t('recipe.tick.project', 'project'));

  // Medya
  const media = {};
  for (const key of mediaKeys) {
    D.line(mediaLine[key] || `media.${key}`);
    const file = await loadFile(mediaSpec[key], o.baseDir);
    const ag = D.pick(/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name) ? 'Ses' : 'Kurgu');
    await D.click(ag, $('#v-import'), false);
    const m = await api.addMedia(file, file.name);
    if (!m) throw new Error(t('recipe.mediaOpenFail', 'Could not open media: {name}', { name: mediaSpec[key] }));
    media[key] = m;
    D.flash(ag, api.el.mediaCard(m.id), m.name, 700);
    o.say(t('recipe.mediaSay', 'media: {name}', { name: m.name }));
    D.tick(t('recipe.tick.media', 'media'));
  }

  const placeClip = async (spec, track, lineKey, role) => {
    D.line(lineKey);
    const m = media[spec.media || spec.file];
    if (!m) throw new Error(t('recipe.mediaNotFound', 'Media not found: {name}', { name: spec.media || spec.file }));
    const opts = { ...spec, track: spec.track || track || (m.type === 'audio' ? 'a' : 'v1') };
    delete opts.media;
    delete opts.file;
    // Tarifte başlangıç yoksa: ana videoda sıradaki boşluk (sıralı kurgu), diğer kanallarda 0.
    if (opts.start == null && opts.track !== 'v1') opts.start = 0;
    let clip;
    if (D.show) {
      const ag = D.pick(role);
      const tr = api.el.track(opts.track || (m.type === 'audio' ? 'a' : 'v1'));
      const tb = tr?.getBoundingClientRect();
      const to = tb ? { x: Math.min(tb.right - 20, Math.max(tb.left + 10, api.el.timeToX(opts.start || 0) + 12)), y: tb.top + tb.height / 2 } : tr;
      await agents.drag(ag, api.el.mediaCard(m.id), to, {
        label: m.name,
        onDrop: () => {
          clip = api.addClip(m, opts);
        },
      });
      if (!clip) clip = api.addClip(m, opts);
      api.select(clip.id);
      await sleep(30);
      if (spec.fadeIn) await D.slide(ag, $('#v-props [data-k="fadeIn"]'), spec.fadeIn);
      if (spec.fadeOut) await D.slide(ag, $('#v-props [data-k="fadeOut"]'), spec.fadeOut);
      if (spec.volume != null) await D.slide(ag, $('#v-props [data-k="vol"]'), spec.volume);
      api.updateClip(clip.id, opts);
      D.flash(D.pick('Zaman'), api.el.clip(clip.id), t('recipe.seconds', '{n} s', { n: (opts.start || 0).toFixed(1) }), 700);
    } else clip = api.addClip(m, opts);
    return clip;
  };

  // Shape clip (rectangle, circle, progress bar...): no media; {kind:"shape"} or a "shape" field without media.
  const isShape = (spec) => spec.kind === 'shape' || (spec.shape && !spec.media && !spec.file);
  const placeShape = async (spec, lineKey) => {
    D.line(lineKey);
    const opts = { ...spec, kind: 'shape', start: spec.start ?? 0 };
    if (D.show) {
      const ag = D.pick('Görsel');
      const btn = api.el.shapeButton && api.el.shapeButton();
      if (btn) await D.click(ag, btn, false);
    }
    const clip = api.addShape(opts);
    if (D.show) {
      api.select(clip.id);
      D.flash(D.pick('Zaman'), api.el.clip(clip.id), t('recipe.seconds', '{n} s', { n: (+opts.start || 0).toFixed(1) }), 700);
    }
    return clip;
  };

  // Draw clip (a layer drawn by JavaScript): {kind:"draw", code}, or "code" without media / shape.
  const isDraw = (spec) =>
    spec.kind === 'draw' || (spec.kind == null && (typeof spec.code === 'string' || Array.isArray(spec.code)) && !spec.media && !spec.file && !spec.shape);
  const placeDraw = async (spec, lineKey) => {
    D.line(lineKey);
    const code = codeStr(spec.code);
    const { kind: _k, media: _m, file: _f, ...rest } = spec;
    const opts = { ...rest, code, start: spec.start ?? 0, track: spec.track === 'v1' ? 'v1' : 'v2' };
    let clip;
    if (D.show) {
      // The "Code" agent clicks "Drawing", types the first lines into the code box and points at Apply;
      // the exact code is then set through the API.
      const ag = D.pick('Kod');
      const btn = api.el.drawButton && api.el.drawButton();
      if (btn) await D.click(ag, btn, false);
      clip = api.addDraw({ ...opts, code: '' });
      api.select(clip.id);
      await sleep(30);
      const box = (api.el.drawCode && api.el.drawCode()) || $('#v-props [data-draw-code]');
      if (box) {
        let head = code.split('\n').slice(0, 4).join('\n');
        if (head.length > 240) head = head.slice(0, 240);
        setVal(box, '');
        await D.type(ag, box, head);
        // The rest appears at once; the box then holds exactly the applied code (no "not applied" draft).
        const full = (api.el.drawCode && api.el.drawCode()) || box;
        if (full.value !== code) setVal(full, code);
        await D.click(ag, (api.el.drawApply && api.el.drawApply()) || $('#v-props [data-act="draw-apply"]'), false);
      }
      const { track: _t, ...upd } = opts;
      clip = api.updateClip(clip.id, upd);
      D.flash(D.pick('Zaman'), api.el.clip(clip.id), t('recipe.seconds', '{n} s', { n: (+opts.start || 0).toFixed(1) }), 700);
    } else clip = api.addDraw(opts);
    return clip;
  };

  for (let i = 0; i < clips.length; i++) {
    if (isDraw(clips[i])) await placeDraw(clips[i], `clips.${i}`);
    else if (isShape(clips[i])) await placeShape(clips[i], `clips.${i}`);
    else await placeClip(clips[i], clips[i].track, `clips.${i}`, i % 2 ? 'Geçiş' : 'Kurgu');
    D.tick(t('recipe.tick.clip', 'clip'));
  }

  for (let i = 0; i < texts.length; i++) {
    // Metin sayı vb. de olabilir ("text": 2025): her yerde dizgeye çevrilir.
    const txt = String(texts[i].text ?? '');
    const tx = { ...texts[i], text: txt };
    D.line(`texts.${i}`);
    if (D.show) {
      const ag = D.pick(i % 2 ? 'Yazı' : 'Metin');
      api.seek(tx.start || 0);
      const before = new Set(api.clips().map((c) => c.id));
      await D.click(ag, $('#v-text'), true);
      const clip = api.clips().find((c) => !before.has(c.id));
      if (clip) {
        api.select(clip.id);
        await sleep(30);
        await D.type(ag, $('#v-props textarea'), txt);
        if (tx.size) await D.slide(ag, $('#v-props [data-k="size"]'), tx.size);
        if (tx.color) await D.color(ag, $('#v-props [data-k="color"]'), tx.color);
        api.updateClip(clip.id, { ...tx, track: 't' });
        D.flash(D.pick('Font'), $('#v-canvas'), txt.split('\n')[0].slice(0, 24), 600);
      } else api.addText(tx);
    } else api.addText(tx);
    o.say(t('recipe.textSay', 'text: {text}', { text: txt.slice(0, 30) }));
    D.tick(t('recipe.tick.text', 'text'));
  }

  if (music) {
    const total = Math.max(0.5, api.duration());
    let key = music.media || music.file;
    if (isGenMusic(music)) {
      // Generated music: rendered for the length it must cover ("auto" = the video's length; 30 s if it is empty).
      D.line('music');
      const st = +music.start || 0;
      const vlen = api.duration();
      const len = +music.duration > 0 ? +music.duration : vlen - st > 0.1 ? vlen - st : 30;
      const ag = D.pick('Ses');
      await D.click(ag, $('#v-import'), false);
      const file = await genMusicFile(music, genSeconds(music, len));
      const gm = await api.addMedia(file, file.name, 'audio');
      if (!gm) throw new Error(t('recipe.mediaOpenFail', 'Could not open media: {name}', { name: file.name }));
      key = file.name;
      media[key] = gm;
      D.flash(ag, api.el.mediaCard(gm.id), gm.name, 700);
      o.say(t('recipe.mediaSay', 'media: {name}', { name: gm.name }));
    }
    const m = media[key];
    if (!m) throw new Error(t('recipe.mediaNotFound', 'Media not found: {name}', { name: key }));
    const dur = +music.duration > 0 ? +music.duration : Math.min(total - (music.start || 0), m.dur - (music.in || 0));
    const { generate: _g, ...mus } = music;
    await placeClip({ ...mus, media: key, track: 'a', start: music.start ?? 0, duration: dur, volume: music.volume ?? 0.8, fadeOut: music.fadeOut ?? 1.5, fadeIn: music.fadeIn ?? 0.3 }, 'a', 'music', 'Ses');
    D.tick(t('recipe.tick.music', 'music'));
  }
  api.select(null);
  api.commit();
  if (D.show) agents.onTour = () => $('#v-play')?.click();

  // Dışa aktar
  D.line('output');
  const ag = D.pick('Render');
  await D.click(ag, $('#v-export'), false);
  const outFile = typeof r.output === 'string' ? r.output : r.output?.file;
  const blob = await api.exportVideo({ onProgress: (p, d) => busy.onProgress?.(p, d) });
  if (!blob) throw new Error(t('recipe.videoExportFail', 'Could not export the video'));
  const p = await platform.saveVideoFile(blob, o.outPath(outFile, 'mp4'));
  o.outputs.push(p);
  o.say(t('recipe.videoSay', 'video: {path}', { path: p }));
  D.tick(t('recipe.tick.export', 'export'));
}

// ------------------------------------------------------------------ web

/** Canlı proje oturumu: şablondan oluştur ya da var olan projeyi aç; oturum kapanana kadar sürer. */
async function runProject(r, ctx, t0) {
  const { live } = await import('./live.js');
  let dir = r.path ? platform.resolvePath(r.path, r.baseDir || ctx.baseDir || platform.paths.root) : null;
  if (!dir && r.template) {
    const { createFromTemplate } = await import('./templates.js');
    dir = await createFromTemplate(r.template, r.name || r.template);
  }
  if (!dir) throw new Error(t('recipe.projectNeedsPath', 'A project needs "path" (folder) or "template" (template id)'));
  if (platform.isNative() && !(await platform.exists(platform.join(dir, 'proje.json'))))
    throw new Error(t('recipe.projectJsonMissing', 'proje.json not found: {dir}', { dir }));
  // Arayüzde açık bir proje varsa önce kapanır: onun sonu bu işin bekleyicisine gitmesin.
  if (live.active) await live.close();
  const ended = new Promise((res) => {
    live.onEnd = res;
  });
  try {
    // Hız/gösterim canli.json'da açıkça verilmediyse proje.json'daki agents ayarı geçerli olsun (live.open öyle seçer).
    await live.open(dir, {
      ...(r.agents?.show === false ? { show: false } : {}),
      ...(normSpeed(r.agents?.speed) ? { speed: normSpeed(r.agents.speed) } : {}),
      // Açık projenin yolu: hs-run -New/-Open bunu okuyup Claude'a söyler. proje.json okunup türü doğrulandıktan
      // ve izleme başladıktan sonra yazılır; açılış hatası "açıldı" diye bildirilmesin.
      onReady: () =>
        platform.isNative() ? platform.writeText(platform.join(platform.paths.jobs, 'canli.proje'), dir).catch(() => {}) : null,
    });
  } catch (e) {
    live.onEnd = null;
    throw e;
  }
  const res = (await ended) || {};
  live.onEnd = null;
  const outputs = res.outputs || [];
  return {
    outputs,
    log: [t('recipe.logProject', 'project: {dir}', { dir }), t('recipe.logLiveEnd', 'live session ended: {n} changes', { n: res.changes || 0 })],
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    project: dir,
  };
}

/**
 * Canlı mod: site klasörünü izler; Claude dosyaları yazdıkça Web sekmesinde ajanlarla gösterir.
 * Oturum canli.stop dosyası, HUD'daki X ya da 20 dk boşta kalınca biter. Bu iş o ana kadar sürer.
 */
async function runLive(r, ctx, t0) {
  if (!r.site) throw new Error(t('recipe.liveNeedsSite', 'Live mode needs "site" (folder path)'));
  const api = ctx.modes.mweb.api;
  if (!api.live) throw new Error(t('recipe.noLive', 'Live mode is not available in this version'));
  const baseDir = r.baseDir || ctx.baseDir || platform.paths.root;
  const site = platform.isNative() ? platform.resolvePath(r.site, baseDir) : r.site;
  if (platform.isNative() && !(await platform.exists(site))) await platform.mkdirp(site);
  const name = r.name || ctx.name || 'canli';
  const music = await webMusic(r.music, baseDir);
  platform.win.show();
  ctx.switchTab('mweb');
  await sleep(80);
  const ended = new Promise((res) => {
    api.live.onEnd = res;
  });
  await api.live.start({
    site,
    entry: r.entry || 'index.html',
    record: !!r.record,
    orientation: r.orientation || 'horizontal',
    name,
    count: Math.max(1, Math.min(20, r.agents?.count || 12)),
    speed: normSpeed(r.agents?.speed) || '1x',
    music,
    musicVolume: r.music?.volume,
  });
  const res = (await ended) || {};
  api.live.onEnd = null;
  const outputs = res.video ? [res.video] : [];
  const log = [res.files?.length ? t('recipe.logLiveEndFiles', 'live session ended: {n} changes ({files})', { n: res.changes || 0, files: res.files.join(', ') }) : t('recipe.logLiveEnd', 'live session ended: {n} changes', { n: res.changes || 0 })];
  if (res.video) log.push(t('recipe.logLiveVideo', 'live video: {path}', { path: res.video }));
  return { outputs, log, seconds: +((performance.now() - t0) / 1000).toFixed(1), changes: res.changes || 0 };
}

/**
 * Music of a web build video: a file path, or a generated piece (Blob, in memory) when "music" has "generate".
 * The build's length is not known in advance: the piece covers "duration" seconds (90 s by default); the
 * recording fades it out at its end.
 */
async function webMusic(music, baseDir) {
  if (!music) return null;
  if (isGenMusic(music)) return genMusicFile(music, genSeconds(music, +music.duration > 0 ? +music.duration : 90));
  const file = typeof music === 'string' ? music : music.file || music.media;
  return file ? platform.resolvePath(file, baseDir) : null;
}

async function runWeb(r, ctx, o) {
  const api = ctx.modes.mweb.api;
  ctx.switchTab('mweb');
  await sleep(80);
  if (!r.site) throw new Error(t('recipe.webNeedsSite', 'A web recipe needs "site" (folder path)'));
  const dir = platform.isNative() ? platform.resolvePath(r.site, o.baseDir) : r.site;
  const entry = r.entry || 'index.html';
  if (platform.isNative() && !/^https?:/i.test(String(r.site))) {
    // site doğrudan bir .html dosyası da olabilir (loadSite onu giriş dosyası sayar).
    const entryPath = /\.html?$/i.test(dir) ? dir : platform.join(dir, entry);
    if (!(await platform.exists(dir))) throw new Error(t('recipe.siteDirMissing', 'Site folder not found: {dir}', { dir }));
    if (!(await platform.exists(entryPath))) throw new Error(t('recipe.siteEntryMissing', 'Site entry file not found: {path}', { path: entryPath }));
  }
  if ((await api.loadSite(dir, entry)) === false) throw new Error(t('recipe.siteOpenFail', 'Could not open site: {dir}', { dir }));
  const outFile = typeof r.output === 'string' ? r.output : r.output?.file;
  const opts = {
    orientation: r.orientation || 'vertical',
    count: o.count,
    speed: o.speed,
    hold: r.hold ?? 2,
    tour: r.tour !== false,
    intro: r.intro,
    music: await webMusic(r.music, o.baseDir),
    musicVolume: r.music?.volume,
  };
  if (r.output === false) {
    await api.build(opts);
    return;
  }
  const p = await api.record({ ...opts, file: o.outPath(outFile || o.recordBuildFile || `${o.name}-yapilis`, 'mp4') });
  if (p) o.outputs.push(p);
  o.say(t('recipe.webVideoSay', 'web build video: {path}', { path: p }));
}
