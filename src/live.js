// Canlı proje yöneticisi (docs/CANLI.md): proje klasörünü açar, proje.json'u izler, farkları uygulayıcılara
// (live-video.js / live-3d.js) ajanlı olarak uygulatır, kullanıcı düzenlemelerini proje.json'a geri yazar,
// istenince dışa aktarır. Web projelerinde web-mode.js'in canlı motorunu (modes.mweb.api.live) kullanır.
//
// Boşta maliyet: izleyici olay tabanlı, zamanlayıcılar yalnızca olay gelince kurulur; her uygulamadan sonra
// agents.stop({keep:true}) ile ajan döngüsü durur (HUD ekranda kalır), yeni değişiklikte agents.start ile döner.
import { bus, baseName } from './util.js';
import { t } from './i18n.js';
import * as platform from './platform.js';
import { agents } from './agents.js';
import * as liveVideo from './live-video.js';
import * as live3d from './live-3d.js';
import { generateMusic, musicFileName } from './music-gen.js';

const MODE_OF = { video: 'mvid', '3d': 'm3d', web: 'mweb' };
const AGENT_MODE = { video: 'video', '3d': '3d', web: 'web' };
const PROJ = 'proje.json';
const DEBOUNCE_FILE = 300; // proje.json / medya değişikliği
const DEBOUNCE_USER = 600; // kullanıcı commit'i → geri yazma
const QUIET_AFTER_APPLY = 400; // uygulama sonrası mode-change olayları yok sayılır

let ctx = null;

const S = {
  active: false,
  gen: 0,
  dir: '',
  type: '',
  name: '',
  modeId: '',
  applier: null,
  show: true,
  speed: '1x',
  count: 12,
  proj: null, // ekranda kurulu olan son hâl (uygulanmış)
  target: null, // şu an uygulanan / uygulanacak hâl
  fileProj: null, // proje.json'daki son geçerli içerik (normalize edilmiş)
  lastHash: '', // proje.json'un son görülen/yazılan içerik özeti (yankı önleme)
  pending: null, // { proj, media:Set, initial }
  running: false,
  applying: false,
  exporting: false,
  lastApplyEnd: 0,
  hud: false, // bizim açtığımız ajan HUD'u ekranda mı
  watchId: null,
  fileT: 0,
  userT: 0,
  projDirty: false,
  userDirty: false, // kullanıcı düzenlemesi henüz proje.json'a yazılmadı
  writing: 0, // sürmekte olan proje.json yazımı
  writeSeq: 0, // proje.json yazım sayacı (okuma sırasında yazım oldu mu?)
  reloading: 0, // sürmekte olan reload (okuma/normalize yazımı)
  mediaDirty: new Set(),
  waiters: [],
  changes: 0,
  userEdits: 0,
  outputs: [],
};

const now = () => performance.now();
const normDir = (d) => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '');
const errMsg = (e) => String((e && e.message) || e || t('live.unknownError', 'unknown error'));

/** Küçük içerik özeti (djb2); satır sonları ve BOM farkı yok sayılır. */
function hashText(t) {
  const s = String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + ':' + s.length;
}
const parseProj = (t) => JSON.parse(String(t).replace(/^﻿/, ''));
const projText = (p) => JSON.stringify(p, null, 2) + '\n';
const strip = (p) => (p ? JSON.stringify({ ...p, rev: undefined }) : '');
const sameProj = (a, b) => strip(a) === strip(b);

// ---------------------------------------------------------------- dosya erişimi

function resolve(rel) {
  return platform.resolvePath(String(rel).replace(/\\/g, '/').replace(/^\.\//, ''), S.dir);
}

async function readProjText(dir) {
  if (platform.isNative()) return platform.readText(platform.join(dir, PROJ));
  const res = await fetch(dir + '/' + PROJ, { cache: 'no-store' });
  if (!res.ok) throw new Error(t('live.projNotFound', '{file} not found ({status}): {path}', { file: PROJ, status: res.status, path: dir + '/' + PROJ }));
  return res.text();
}

async function writeProj(proj) {
  const text = projText(proj);
  S.lastHash = hashText(text); // izleyici yankısı bu özetle elenir (yazmadan önce ayarlanır)
  if (!platform.isNative()) return false;
  const g = S.gen;
  S.writeSeq++;
  S.writing++;
  try {
    await platform.writeText(platform.join(S.dir, PROJ), text);
  } finally {
    if (g === S.gen) S.writing = Math.max(0, S.writing - 1);
  }
  return true;
}

async function loadFile(rel) {
  const full = resolve(rel);
  if (platform.isNative()) {
    if (!(await platform.exists(full))) throw new Error(t('live.fileNotFound', 'File not found: {path}', { path: full }));
    return platform.readBlob(full);
  }
  const res = await fetch(full, { cache: 'no-cache' });
  if (!res.ok) throw new Error(t('live.fileNotFound', 'File not found: {path}', { path: full }));
  const b = await res.blob();
  const f = new File([b], baseName(full), { type: b.type || platform.mimeOf(full) });
  f.path = full;
  return f;
}

function makeEnv(mediaChanged) {
  return {
    modes: ctx.modes,
    switchTab: ctx.switchTab,
    dir: S.dir,
    resolve,
    loadFile,
    agents,
    show: S.show,
    speed: S.speed,
    note,
    outDir: S.dir + '/cikti',
    mediaChanged: mediaChanged || new Set(),
  };
}

/** Projede geçen göreli dosya yolları (medya/model/müzik); izleyicide ilgisiz dosyaları elemek için. */
function referencedPaths(proj) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/\.[a-z0-9]{2,5}$/i.test(v) && !/^[a-z]+:\/\//i.test(v)) {
        let p = v.replace(/\\/g, '/').replace(/^\.\//, '');
        const pre = S.dir.toLowerCase() + '/';
        if (p.toLowerCase().startsWith(pre)) p = p.slice(pre.length);
        out.add(p.toLowerCase());
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(proj);
  return out;
}

// ---------------------------------------------------------------- bildirim balonu

let noteEl = null;
let noteT = 0;
function note(text) {
  const msg = String(text ?? '').trim();
  if (!msg) return;
  // Web sekmesindeyken web motorunun kendi balonu kullanılır.
  const L = ctx?.modes?.mweb?.api?.live;
  if (S.active && S.type === 'web' && ctx.current?.() === 'mweb' && L?.active && typeof L.note === 'function') {
    try {
      L.note(msg);
      return;
    } catch {}
  }
  if (!noteEl) {
    noteEl = document.createElement('div');
    noteEl.className = 'lv-note';
    noteEl.setAttribute('role', 'status');
    noteEl.setAttribute('aria-live', 'polite');
    noteEl.innerHTML = '<b></b><span></span>';
    noteEl.firstChild.textContent = t('live.noteLabel', 'Claude:');
    document.body.appendChild(noteEl);
  }
  noteEl.lastChild.textContent = msg;
  noteEl.title = msg;
  noteEl.classList.add('show');
  clearTimeout(noteT);
  noteT = setTimeout(() => noteEl.classList.remove('show'), 6000);
}

function emitState() {
  bus.dispatchEvent(
    new CustomEvent('live-change', { detail: { active: S.active, dir: S.dir, type: S.type, name: S.name } }),
  );
}

// ---------------------------------------------------------------- uygulama kuyruğu

function enqueue(proj, media, initial = false) {
  if (S.pending) {
    S.pending.proj = proj; // ara hâller birleşir: yalnızca son hâl
    for (const m of media || []) S.pending.media.add(m);
    S.pending.initial ||= initial;
  } else S.pending = { proj, media: new Set(media || []), initial };
  pump();
}

function flushWaiters() {
  const w = S.waiters.splice(0);
  w.forEach((r) => r());
}

/** Kuyruk boşalana kadar bekler (açık proje yoksa hemen döner). */
async function idle() {
  while (S.active && (S.running || S.pending)) await new Promise((r) => S.waiters.push(r));
}

function startAgents() {
  agents.start({ count: S.count, mode: AGENT_MODE[S.type], title: S.name, speed: S.speed });
  agents.onClose = () => live.close().catch((e) => console.error(e));
  S.hud = true;
}

async function pump() {
  // Dışa aktarma sürerken uygulanmaz: bekleyen iş exportNow'ın finally'sinden başlar.
  if (S.running || S.exporting || !S.active) return;
  S.running = true;
  const g = S.gen;
  let started = false;
  try {
    while (S.pending && g === S.gen) {
      const job = S.pending;
      S.pending = null;
      const prev = job.initial ? null : S.proj;
      S.target = job.proj;
      if (ctx.current?.() !== S.modeId) ctx.switchTab(S.modeId);
      if (S.show && !started) {
        startAgents();
        started = true;
      }
      let ok = false;
      S.applying = true;
      try {
        await S.applier.apply(prev, job.proj, makeEnv(job.media));
        ok = true;
      } catch (e) {
        console.error('live apply', e);
        if (g === S.gen) note(t('live.applyFailed', 'Could not apply the change: {error}', { error: errMsg(e) }));
      } finally {
        S.applying = false;
        S.lastApplyEnd = now();
      }
      if (g !== S.gen) break;
      if (ok) {
        S.proj = job.proj;
        if (!job.initial) S.changes++;
      } else {
        // Yarım kalan uygulamada ekrandaki gerçek durumu bir sonraki farkın tabanı yap (çift ekleme olmasın).
        let snap = null;
        try {
          snap = S.applier.snapshot?.(makeEnv());
        } catch {}
        S.proj = snap ? { ...job.proj, ...snap } : job.proj;
      }
    }
  } finally {
    // Ajanlar kenara çekilir, döngü durur; HUD (X ile kapatma) ekranda kalır.
    if (started && g === S.gen) await agents.stop({ keep: true }).catch(() => {});
    S.running = false;
    if (g === S.gen && S.active && S.pending && !S.exporting) pump();
    else {
      flushWaiters();
      // Uygulama sürerken bekleyen kullanıcı düzenlemesi: ekrandaki son hâl (Claude + kullanıcı) şimdi yazılır.
      if (g === S.gen && S.active && S.userDirty && !S.pending && !S.exporting) scheduleWriteBack();
    }
  }
}

// ---------------------------------------------------------------- izleme (masaüstü)

function onWatch(filename, action, eventDir) {
  if (!S.active || !filename) return;
  const full = normDir(eventDir || S.dir) + '/' + String(filename).replace(/\\/g, '/');
  const pre = S.dir.toLowerCase() + '/';
  if (!full.toLowerCase().startsWith(pre)) return;
  const rel = full.slice(pre.length);
  const low = rel.toLowerCase();
  if (low === PROJ) {
    if (action === 'delete') return; // atomik yazımda önce silinip sonra eklenebilir
    S.projDirty = true;
    // Dosyadaki değişiklik önce uygulanır; bekleyen kullanıcı yazımı reload bitince (ikisi birlikte) yapılır.
    clearTimeout(S.userT);
  } else {
    if (S.type === 'web') return; // site dosyalarını web motoru kendisi izler
    if (low.startsWith('cikti/') || action === 'delete') return;
    if (action === 'add' && !/\.[a-z0-9]{1,6}$/i.test(rel)) return; // klasör oluşturma
    if (!low.startsWith('medya/') && !referencedPaths(S.fileProj || S.proj).has(low)) return;
    S.mediaDirty.add(rel);
  }
  clearTimeout(S.fileT);
  S.fileT = setTimeout(reload, DEBOUNCE_FILE);
}

function scheduleReload(ms = DEBOUNCE_FILE) {
  clearTimeout(S.fileT);
  S.fileT = setTimeout(reload, ms);
}

async function reload() {
  if (!S.active) return;
  if (S.writing) return scheduleReload(); // kendi yazımımız sürüyor: bitince oku
  const g = S.gen;
  S.reloading++;
  let ok = false;
  try {
    ok = await reloadNow(g);
  } finally {
    if (g === S.gen) {
      S.reloading = Math.max(0, S.reloading - 1);
      if (ok && S.active && S.userDirty && !S.pending && !S.running && !S.projDirty) scheduleWriteBack();
    }
  }
}

/** true: dosya işlendi (değişiklik yok ya da sıraya alındı); false: okunamadı / geçersiz / yeniden okunacak. */
async function reloadNow(g) {
  const media = S.mediaDirty;
  const projDirty = S.projDirty;
  S.mediaDirty = new Set();
  S.projDirty = false;
  let proj = S.fileProj;
  if (projDirty) {
    const seq = S.writeSeq;
    let text;
    try {
      text = await readProjText(S.dir);
    } catch (e) {
      if (g === S.gen) note(t('live.projReadFailed', 'Could not read proje.json: {error}', { error: errMsg(e) }));
      return false;
    }
    if (g !== S.gen) return false;
    if (S.writeSeq !== seq || S.writing) {
      // Okuma sürerken uygulama dosyaya yazdı: okunan içerik eski olabilir, yeniden oku.
      S.projDirty = true;
      for (const m of media) S.mediaDirty.add(m);
      scheduleReload();
      return false;
    }
    const h = hashText(text);
    if (h !== S.lastHash) {
      let parsed;
      try {
        parsed = parseProj(text);
      } catch (e) {
        note(t('live.projReadFailed', 'Could not read proje.json: {error}', { error: errMsg(e) })); // son geçerli hâl ekranda kalır
        return false;
      }
      if (!parsed || typeof parsed !== 'object') {
        note(t('live.projNotObject', 'Could not read proje.json: an object was expected'));
        return false;
      }
      S.lastHash = h;
      if (parsed.type && parsed.type !== S.type) {
        note(t('live.typeChanged', 'Project type changed ({from} → {to}); reopen the project', { from: S.type, to: parsed.type }));
        return false;
      }
      proj = await acceptProj(parsed);
      if (g !== S.gen) return false;
    }
  }
  if (!proj) return true;
  // Medya değişikliklerinde yalnızca projede kullanılan dosyalar önemlidir.
  const used = referencedPaths(proj);
  const mediaUsed = [...media].filter((m) => used.has(m.toLowerCase()));
  if (S.type === 'web') {
    applyWebSettings(proj);
    return true;
  }
  const latest = S.pending?.proj ?? S.target ?? S.proj;
  if (!mediaUsed.length && sameProj(proj, latest)) return true;
  enqueue(proj, mediaUsed);
  return true;
}

/** Ayrıştırılmış proje.json'u normalize eder; id eklendiyse dosyaya geri yazar. Son geçerli hâl olur. */
async function acceptProj(parsed) {
  const norm = S.applier.normalize ? S.applier.normalize(parsed) : parsed;
  S.fileProj = norm;
  if (JSON.stringify(norm) !== JSON.stringify(parsed)) {
    await writeProj(norm).catch((e) => note(t('live.projWriteFailed', 'Could not write proje.json: {error}', { error: errMsg(e) })));
  }
  return norm;
}

// ---------------------------------------------------------------- kullanıcı düzenlemesi → proje.json

function onModeChange(e) {
  if (!S.active || S.type === 'web' || !S.applier?.snapshot) return;
  if (e?.detail?.mode !== S.modeId) return;
  if (S.applying || S.exporting || now() - S.lastApplyEnd < QUIET_AFTER_APPLY) return;
  S.userDirty = true;
  scheduleWriteBack();
}

function scheduleWriteBack() {
  clearTimeout(S.userT);
  S.userT = setTimeout(writeBack, DEBOUNCE_USER);
}

/** Claude'un dosya değişikliği okunuyor/uygulanıyor, dışa aktarma ya da bir yazım sürüyor mu? */
const fileBusy = () =>
  S.applying || S.running || S.exporting || !!S.pending || S.projDirty || S.reloading > 0 || S.writing > 0;

async function writeBack() {
  // Claude'un bekleyen/uygulanan değişikliği önceliklidir; o bitince (pump/reload/export sonu) yeniden denenir.
  if (!S.active || !S.userDirty || fileBusy()) return;
  const g = S.gen;
  if (platform.isNative()) {
    // Yazmadan hemen önce: dosyada henüz okunmamış bir değişiklik var mı? (Claude az önce yazmış olabilir)
    let text = null;
    try {
      text = await readProjText(S.dir);
    } catch {}
    if (g !== S.gen || !S.active) return;
    if (text != null && hashText(text) !== S.lastHash) {
      S.projDirty = true;
      scheduleReload(50); // önce dosyadaki değişiklik uygulanır; sonra kullanıcınınkiyle birlikte yazılır
      return;
    }
    if (fileBusy()) return; // okurken durum değişti; o işin sonu yeniden tetikler
  }
  let snap;
  try {
    snap = S.applier.snapshot(makeEnv());
  } catch (e) {
    console.warn('live snapshot', e);
    return;
  }
  if (!snap || typeof snap !== 'object') return;
  const base = S.fileProj || S.proj || {};
  const merged = { ...base, ...snap }; // snapshot'ın bilmediği üst düzey alanlar korunur
  S.userDirty = false;
  if (sameProj(merged, base)) return;
  merged.rev = (+base.rev || 0) + 1;
  S.fileProj = S.proj = S.target = merged;
  S.userEdits++;
  try {
    await writeProj(merged);
  } catch (e) {
    note(t('live.projWriteFailed', 'Could not write proje.json: {error}', { error: errMsg(e) }));
  }
}

// ---------------------------------------------------------------- web projesi

/**
 * Music of a live web project. "music.generate" (no file) is rendered once for the recording (duration seconds,
 * 90 s by default) and cached in <project>/medya/<musicFileName>; the browser build keeps it in memory.
 */
async function webMusic(proj) {
  const m = proj.music;
  if (m && typeof m === 'object' && m.generate && !m.file && !m.media) {
    const g = typeof m.generate === 'object' ? m.generate : { style: String(m.generate) };
    const seconds = Math.min(180, Math.max(3, Number.isFinite(+m.duration) && +m.duration > 0 ? +m.duration : 90));
    const params = { style: g.style, bpm: g.bpm, seed: g.seed, key: g.key };
    const name = musicFileName(params, seconds);
    const { generate: _g, ...rest } = m;
    if (platform.isNative() && S.dir) {
      const full = resolve('medya/' + name);
      try {
        if (!(await platform.exists(full))) {
          await platform.mkdirp(platform.dirOf(full));
          await platform.writeBlob(full, await generateMusic({ ...params, duration: seconds }));
        }
        return { ...rest, file: full };
      } catch (e) {
        console.warn('[live web] generated music', e);
        return undefined;
      }
    }
    try {
      return new File([await generateMusic({ ...params, duration: seconds })], name, { type: 'audio/wav' });
    } catch (e) {
      console.warn('[live web] generated music', e);
      return undefined;
    }
  }
  return webMusicSync(proj);
}

function webMusicSync(proj) {
  const m = proj.music;
  if (!m) return undefined;
  const media = proj.media && typeof proj.media === 'object' ? proj.media : {};
  const pathOf = (v) => (media[v] ? resolve(media[v]) : resolve(v));
  if (typeof m === 'string') return pathOf(m);
  if (typeof m === 'object') {
    const src = m.file || (m.media && media[m.media]) || m.media;
    return src ? { ...m, file: pathOf(src) } : undefined;
  }
  return undefined;
}

function webApi() {
  const L = ctx.modes.mweb?.api?.live;
  if (!L || typeof L.start !== 'function') throw new Error(t('live.webEngineMissing', 'Web live engine (modes.mweb.api.live) not found'));
  return L;
}

async function startWeb(proj) {
  const L = webApi();
  const g = S.gen;
  L.onEnd = (res) => {
    // Oturum web tarafında bittiyse (Canlıyı bitir / HUD X) yönetici de kapanır.
    if (g === S.gen && S.active) finish(res || null);
  };
  ctx.switchTab('mweb');
  S.applying = true;
  try {
    await L.start({
      site: resolve(proj.site || 'site'),
      entry: proj.entry || 'index.html',
      record: !!proj.record,
      orientation: proj.orientation,
      name: proj.name || S.name,
      count: S.count,
      speed: S.speed,
      music: await webMusic(proj),
    });
  } finally {
    S.applying = false;
    S.lastApplyEnd = now();
  }
  S.proj = S.target = proj;
}

function applyWebSettings(proj) {
  const prev = S.proj || {};
  S.proj = S.target = proj;
  S.name = proj.name || S.name;
  const keys = ['site', 'entry', 'orientation', 'record', 'music'];
  if (keys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(proj[k])))
    note(t('live.webSettingChanged', 'Web project setting changed; the new setting applies when you reopen the project'));
  emitState();
}

// ---------------------------------------------------------------- kapatma

async function finish(webRes) {
  if (!S.active) return null;
  S.gen++;
  S.active = false;
  clearTimeout(S.fileT);
  clearTimeout(S.userT);
  S.pending = null;
  S.userDirty = false;
  S.mediaDirty = new Set();
  const watchId = S.watchId;
  S.watchId = null;
  await platform.unwatchDir(watchId).catch(() => {});
  if (S.type === 'web') {
    const L = ctx.modes.mweb?.api?.live;
    if (L) L.onEnd = null;
  } else if (S.hud) {
    agents.onClose = null;
    await agents.stop({ keep: false }).catch(() => {});
  }
  S.hud = false;
  flushWaiters();
  platform.win.setTitle('Hafif Stüdyo');
  const outputs = [...S.outputs];
  if (webRes?.video) outputs.push(webRes.video);
  const res = {
    dir: S.dir,
    name: S.name,
    type: S.type,
    changes: S.type === 'web' ? webRes?.changes ?? 0 : S.changes,
    userEdits: S.userEdits,
    outputs,
  };
  if (webRes?.files) res.files = webRes.files;
  emitState();
  try {
    live.onEnd?.(res);
  } catch (e) {
    console.error('live onEnd', e);
  }
  return res;
}

// ---------------------------------------------------------------- dışa açık nesne

export const live = {
  /**
   * Proje klasörünü canlı açar. dir: masaüstünde klasör yolu, tarayıcıda URL yolu (ör. /ornekler/canli-test).
   * opts.show=false: ajan animasyonu yok; opts.speed: '1x'|'2x'|'5x'|'instant' (yoksa proje.agents.speed, sonra 1x).
   */
  async open(dir, opts = {}) {
    if (!ctx) throw new Error('initLive was not called');
    if (S.active) {
      // Eski oturumun sonu, yeni oturum için atanmış onEnd'e (ör. runProject'in bekleyicisi) gitmesin.
      const cb = live.onEnd;
      live.onEnd = null;
      try {
        await live.close();
      } finally {
        live.onEnd = cb;
      }
    }
    dir = normDir(dir);
    if (!dir) throw new Error(t('live.noDir', 'No project folder given'));
    const g = ++S.gen;
    let text;
    try {
      text = await readProjText(dir);
    } catch (e) {
      throw new Error(t('live.projReadFailed', 'Could not read proje.json: {error}', { error: errMsg(e) }));
    }
    let parsed;
    try {
      parsed = parseProj(text);
    } catch (e) {
      throw new Error(t('live.projReadFailed', 'Could not read proje.json: {error}', { error: errMsg(e) }));
    }
    if (g !== S.gen) throw new Error(t('live.otherOpened', 'Another project was opened'));
    const type = String(parsed?.type || '').toLowerCase();
    const applier = type === 'video' ? liveVideo : type === '3d' ? live3d : type === 'web' ? null : undefined;
    if (applier === undefined) throw new Error(t('live.unknownType', 'Unknown project type: "{type}" (must be video, 3d or web)', { type: parsed?.type ?? '' }));

    Object.assign(S, {
      active: true,
      dir,
      type,
      modeId: MODE_OF[type],
      applier: applier || { normalize: (p) => ({ ...p }) },
      name: parsed.name || baseName(dir),
      show: opts.show != null ? opts.show !== false : parsed.agents?.show !== false,
      speed: opts.speed || parsed.agents?.speed || '1x',
      count: +parsed.agents?.count || +parsed.count || (type === 'web' ? 20 : 12),
      proj: null,
      target: null,
      fileProj: null,
      lastHash: hashText(text),
      pending: null,
      running: false,
      applying: false,
      exporting: false,
      lastApplyEnd: 0,
      hud: false,
      projDirty: false,
      userDirty: false,
      writing: 0,
      writeSeq: 0,
      reloading: 0,
      mediaDirty: new Set(),
      changes: 0,
      userEdits: 0,
      outputs: [],
    });
    platform.win.setTitle(`Hafif Stüdyo — ${S.name}`);
    emitState();
    try {
      const proj = await acceptProj({ ...parsed, type });
      if (g !== S.gen) return null;
      if (platform.isNative()) S.watchId = await platform.watchDir(dir, onWatch);
      if (g !== S.gen) return null;
      // Proje geçerli ve izleniyor: çağıran (runProject → canli.proje) artık "açıldı" diyebilir.
      if (opts.onReady) {
        try {
          await opts.onReady({ dir, type, name: S.name });
        } catch (e) {
          console.warn('live onReady', e);
        }
        if (g !== S.gen) return null;
      }
      if (type === 'web') await startWeb(proj);
      else {
        enqueue(proj, [], true);
        await idle();
      }
    } catch (e) {
      if (g === S.gen) await live.close().catch(() => {});
      throw e;
    }
    return g === S.gen ? { dir: S.dir, type: S.type, name: S.name } : null;
  },

  /** Oturumu kapatır; web projesinde canlı motor durdurulur. onEnd({changes, outputs, ...}) çağrılır. */
  async close({ tour = false } = {}) {
    if (!S.active) return null;
    let webRes = null;
    if (S.type === 'web') {
      const L = ctx.modes.mweb?.api?.live;
      if (L) {
        L.onEnd = null; // stop'un kendi onEnd'i ikinci kez kapatmasın
        if (L.active) webRes = await Promise.resolve(L.stop({ tour })).catch((e) => (note(t('live.webCloseFailed', 'Could not close the web session: {error}', { error: errMsg(e) })), null));
      }
    }
    return finish(webRes);
  },

  /** Açık projeyi dışa aktarır → { outputs: [tam yol] }. */
  async exportNow({ file } = {}) {
    if (!S.active) throw new Error(t('live.noOpen', 'No live project is open'));
    // Web canlı motoru oturum boyunca meşguldür (record() her zaman reddeder); video oturum kapanırken üretilir.
    if (S.type === 'web')
      throw new Error(
        t('live.webExport', 'For web projects, video is produced during -Close in a session opened with "record": true in proje.json; -Export is not supported for web projects.'),
      );
    await idle();
    while (S.active && (S.running || S.pending)) await idle();
    if (!S.active) throw new Error(t('live.closed', 'The live project was closed'));
    if (S.exporting) throw new Error(t('live.exportBusy', 'An export is already in progress'));
    S.exporting = true;
    try {
      const res = await S.applier.exportNow(S.proj, makeEnv(), file ? { file } : {});
      const outputs = (res?.outputs || []).filter(Boolean);
      S.outputs.push(...outputs);
      return { outputs };
    } finally {
      S.exporting = false;
      S.lastApplyEnd = now();
      if (S.active && S.pending) pump();
      else if (S.active && S.userDirty) scheduleWriteBack();
    }
  },

  /** Üstte "Claude:" balonu. */
  note,

  /** Test kancası: proje.json yerine metinden uygular (dosya değişmiş gibi). Uygulama bitince döner. */
  async applyText(jsonText) {
    if (!S.active) throw new Error(t('live.noOpen', 'No live project is open'));
    let parsed;
    try {
      parsed = typeof jsonText === 'string' ? parseProj(jsonText) : JSON.parse(JSON.stringify(jsonText));
    } catch (e) {
      note(t('live.projReadFailed', 'Could not read proje.json: {error}', { error: errMsg(e) }));
      throw e;
    }
    if (parsed.type && String(parsed.type).toLowerCase() !== S.type) throw new Error(t('live.typeLocked', 'The project type cannot be changed'));
    const norm = S.applier.normalize ? S.applier.normalize({ ...parsed, type: S.type }) : parsed;
    S.fileProj = norm;
    if (S.type === 'web') {
      applyWebSettings(norm);
      return { applied: false };
    }
    const latest = S.pending?.proj ?? S.target ?? S.proj;
    if (sameProj(norm, latest)) return { applied: false };
    enqueue(norm, []);
    await idle();
    return { applied: true, proj: S.proj };
  },

  get active() {
    return S.active;
  },
  get dir() {
    return S.active ? S.dir : '';
  },
  get type() {
    return S.active ? S.type : '';
  },
  get name() {
    return S.active ? S.name : '';
  },
  /** Ekranda kurulu son hâl (kopya). */
  get project() {
    return S.proj ? JSON.parse(JSON.stringify(S.proj)) : null;
  },
  get busy() {
    return S.running || S.exporting || !!S.pending;
  },
  /** Atanabilir: oturum bitince ({dir, name, type, changes, userEdits, outputs}). */
  onEnd: null,
};

/** ctx: main.js'teki { modes, switchTab, current, ... } */
export function initLive(c) {
  ctx = c;
  bus.addEventListener('mode-change', onModeChange);
  return live;
}
