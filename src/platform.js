// Platform köprüsü: Masaüstünde (Neutralino) gerçek dosya sistemi, tarayıcıda indirme/seçici.
import { pickFilesBrowser, baseName, extOf, toast } from './util.js';
import { t } from './i18n.js';

const N = () => window.Neutralino;
export const isNative = () => typeof window.Neutralino !== 'undefined' && typeof window.NL_PORT !== 'undefined';

export const paths = { docs: '', root: '', out: '', jobs: '', app: '' };
export let args = [];

const MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', stl: 'model/stl', json: 'application/json',
};
export const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

export const join = (...parts) =>
  parts
    .filter((p) => p != null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
    .replace(/\\/g, '/');

export const isAbs = (p) => /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p);
export const resolvePath = (p, base) => (isAbs(p) ? String(p).replace(/\\/g, '/') : join(base, p));
export const dirOf = (p) => String(p).replace(/\\/g, '/').replace(/\/[^/]*$/, '');

/** Masaüstü: Neutralino'yu başlatır, klasörleri hazırlar. Tarayıcıda hiçbir şey yapmaz. */
export async function init() {
  if (!isNative()) return false;
  N().init();
  await new Promise((r) => N().events.on('ready', r));
  args = (window.NL_ARGS || []).slice(1);
  paths.app = window.NL_PATH;
  paths.docs = (await N().os.getPath('documents')).replace(/\\/g, '/');
  paths.root = join(paths.docs, 'HafifStudyo');
  paths.out = join(paths.root, 'çıktılar');
  paths.jobs = join(paths.root, 'isler');
  for (const d of [paths.root, paths.out, paths.jobs]) await mkdirp(d);
  return true;
}

export async function exists(p) {
  try {
    await N().filesystem.getStats(p);
    return true;
  } catch {
    return false;
  }
}

export async function mkdirp(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  let cur = '';
  for (const part of parts) {
    cur = cur ? cur + '/' + part : part;
    if (/^[a-zA-Z]:$/.test(cur) || !part) continue;
    if (!(await exists(cur))) {
      try {
        await N().filesystem.createDirectory(cur);
      } catch (e) {
        if (!(await exists(cur))) throw e;
      }
    }
  }
}

export async function readBlob(p) {
  const buf = await N().filesystem.readBinaryFile(p);
  const f = new File([buf], baseName(p), { type: mimeOf(p) });
  f.path = String(p).replace(/\\/g, '/');
  return f;
}
export const readText = (p) => N().filesystem.readFile(p);
export async function writeBlob(p, blob) {
  await mkdirp(dirOf(p));
  await N().filesystem.writeBinaryFile(p, await blob.arrayBuffer());
  return p;
}
export async function writeText(p, text) {
  await mkdirp(dirOf(p));
  await N().filesystem.writeFile(p, text);
  return p;
}
export const listDir = (p) => N().filesystem.readDirectory(p);
export const removeFile = (p) => N().filesystem.remove(p);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/**
 * Kullanıcının seçtiği yere kaydeder (masaüstünde "Farklı kaydet" penceresi,
 * varsayılan klasör Belgeler\HafifStudyo\çıktılar). Kaydedilen yolu ya da null döner.
 */
export async function saveAs(blob, name, title = t('platform.save', 'Save')) {
  if (!isNative()) {
    download(blob, name);
    return name;
  }
  const ext = extOf(name);
  let p = await N().os.showSaveDialog(title, {
    defaultPath: join(paths.out, name),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!p) return null;
  if (!extOf(p) || extOf(p) !== ext) p += '.' + ext;
  await writeBlob(p, blob);
  return p;
}

/** Diyalogsuz: çıktılar klasörüne (ya da verilen tam yola) yazar. */
export async function saveOutput(blob, nameOrPath, dir = paths.out) {
  if (!isNative()) {
    download(blob, baseName(nameOrPath));
    return baseName(nameOrPath);
  }
  return writeBlob(resolvePath(nameOrPath, dir), blob);
}

/** Dosya seçici. accept: ".glb,.obj" ya da "video/*,audio/*". File[] döner. */
export async function openFiles(accept, multiple = true, title = t('platform.pickFile', 'Choose a file')) {
  if (!isNative()) return pickFilesBrowser(accept, multiple);
  const exts = accept
    .split(',')
    .map((s) => s.trim())
    .flatMap((s) => {
      if (s.startsWith('.')) return [s.slice(1)];
      const kind = s.split('/')[0];
      return Object.keys(MIME).filter((k) => MIME[k].startsWith(kind + '/'));
    });
  const sel = await N().os.showOpenDialog(title, {
    defaultPath: paths.root,
    multiSelections: multiple,
    filters: [
      { name: t('platform.filterSupported', 'Supported'), extensions: [...new Set(exts)] },
      { name: t('platform.filterAll', 'All'), extensions: ['*'] },
    ],
  });
  const files = [];
  for (const p of sel || []) {
    try {
      files.push(await readBlob(p));
    } catch (e) {
      toast(t('platform.readError', 'Could not read: {name}', { name: baseName(p) }));
    }
  }
  return files;
}

export async function pickFolder(title = t('platform.pickFolder', 'Choose a folder')) {
  if (!isNative()) return null;
  return (await N().os.showFolderDialog(title, { defaultPath: paths.root })) || null;
}

export function reveal(p) {
  if (!isNative()) return;
  N().os.execCommand(`explorer /select,"${String(p).replace(/\//g, '\\')}"`, { background: true });
}

// ---------------------------------------------------------------- ffmpeg

let ffmpegPath;
/** ffmpeg yolunu bulur (PATH ya da yaygın klasörler). Yoksa null. */
export async function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  ffmpegPath = null;
  if (!isNative()) return null;
  try {
    const r = await N().os.execCommand('where ffmpeg');
    const first = r.stdOut.split(/\r?\n/).map((s) => s.trim()).find((s) => /ffmpeg\.exe$/i.test(s));
    if (first) ffmpegPath = first;
  } catch {}
  if (!ffmpegPath) {
    const local = (await N().os.getEnv('LOCALAPPDATA')) || '';
    for (const c of [local + '\\Programs\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
      if (await exists(c)) {
        ffmpegPath = c;
        break;
      }
    }
  }
  return ffmpegPath;
}

const q = (s) => `"${String(s).replace(/\//g, '\\')}"`;

/** ffmpeg'i çalıştırır, bitince {exitCode, stdErr} döner. */
export async function ffmpeg(argStr) {
  const bin = await findFfmpeg();
  if (!bin) throw new Error(t('platform.ffmpegMissing', 'ffmpeg not found'));
  return N().os.execCommand(`${q(bin)} -hide_banner -loglevel error -y ${argStr}`);
}

/**
 * Kaydedilmiş videoyu oynatıcı dostu MP4'e çevirir.
 * MP4 (avc1) ise sadece yeniden paketler (hızlı), WebM ise H.264'e çevirir.
 * ffmpeg yoksa ya da hata olursa null döner (orijinal dosya kalır).
 */
export async function toMp4(srcPath, dstPath) {
  if (!(await findFfmpeg())) return null;
  const isMp4 = extOf(srcPath) === 'mp4';
  const tmp = isMp4 ? dstPath.replace(/\.mp4$/i, '.tmp.mp4') : dstPath;
  const codec = isMp4
    ? '-c copy'
    : '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k';
  const r = await ffmpeg(`-i ${q(srcPath)} ${codec} -movflags +faststart ${q(tmp)}`);
  if (r.exitCode !== 0) {
    console.warn('ffmpeg', r.stdErr);
    return null;
  }
  if (isMp4) {
    // Önce taşı, sonra kaynağı sil: hedef kilitliyse (oynatıcıda açık) kaynak kaybolmasın.
    try {
      await N().filesystem.move(tmp, dstPath);
    } catch (e) {
      console.warn('toMp4 taşıma', dstPath, e);
      await N().filesystem.remove(tmp).catch(() => {});
      return null;
    }
    await N().filesystem.remove(srcPath).catch(() => {});
  }
  return dstPath;
}

/**
 * MediaRecorder çıktısını diske yazar; ffmpeg varsa MP4'e çevirir/yeniden paketler.
 * path'in uzantısı ne olursa olsun son dosyanın gerçek yolunu döner.
 */
export async function saveVideoFile(blob, path) {
  const realExt = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
  const wantMp4 = extOf(path) !== 'webm';
  const base = path.replace(/\.(mp4|webm)$/i, '');
  if (!isNative()) {
    download(blob, baseName(base) + '.' + realExt);
    return baseName(base) + '.' + realExt;
  }
  const raw = realExt === 'mp4' ? base + '.rec.mp4' : base + '.webm';
  await writeBlob(raw, blob);
  if (wantMp4) {
    const mp4 = await toMp4(raw, base + '.mp4').catch(() => null);
    if (mp4) {
      if (realExt === 'webm') await N().filesystem.remove(raw).catch(() => {});
      return mp4;
    }
  }
  if (realExt === 'mp4') {
    // Taşıma başarısızsa (hedef kilitli vb.) gerçek dosyanın yolunu (.rec.mp4) bildir.
    try {
      await N().filesystem.move(raw, base + '.mp4');
      return base + '.mp4';
    } catch (e) {
      console.warn('video taşıma', base + '.mp4', e);
      return raw;
    }
  }
  return raw;
}

/** "Farklı kaydet" penceresiyle video kaydı (MP4 önerilir). */
export async function saveVideoAs(blob, name = 'video.mp4') {
  if (!isNative()) return saveVideoFile(blob, name);
  let p = await N().os.showSaveDialog(t('platform.saveVideo', 'Save video'), {
    defaultPath: join(paths.out, name),
    filters: [{ name: t('platform.filterVideo', 'Video'), extensions: ['mp4', 'webm'] }],
  });
  if (!p) return null;
  if (!/\.(mp4|webm)$/i.test(p)) p += '.mp4';
  return saveVideoFile(blob, p);
}

/**
 * Ekranın bir bölgesini ffmpeg (gdigrab) ile kaydeder. Döndürülen stop() bitince yolu verir.
 * rect: ekran pikseli {x,y,w,h}; out: {w,h} çıktı boyutu (oran korunur, siyah kenar eklenir).
 */
/**
 * Kayıt bölgesinde gerçekten bu pencere mi görünüyor? Pencereyi bir anlığına düz renkle kaplar,
 * ffmpeg ile o bölgeden tek kare alır ve rengi kontrol eder. Başka bir pencere üstteyse ya da
 * bölge yanlışsa false döner (kullanıcının ekranındaki başka içerik kaydedilmesin diye).
 */
async function regionShowsUs(bin, rect, w, h) {
  const probe = join(paths.root, '.kayit-kontrol.png');
  const veil = document.createElement('div');
  veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ff00ff;pointer-events:none';
  document.body.appendChild(veil);
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 150));
    const r = await N().os.execCommand(
      `${q(bin)} -hide_banner -loglevel error -y -f gdigrab -draw_mouse 0 -offset_x ${Math.round(rect.x)} -offset_y ${Math.round(rect.y)} -video_size ${w}x${h} -i desktop -frames:v 1 -vf scale=24:24 ${q(probe)}`,
    );
    if (r.exitCode !== 0) return { ok: false, frac: 0, err: (r.stdErr || "").trim().slice(0, 300) };
  } finally {
    veil.remove();
  }
  let ok = false;
  try {
    const bmp = await createImageBitmap(await readBlob(probe));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let hit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 70 && px[i + 2] > 200) hit++;
    const frac = hit / (px.length / 4);
    ok = frac > 0.8;
    return { ok, frac };
  } catch (e) {
    return { ok: false, frac: 0, err: String(e && e.message || e) };
  } finally {
    // Başarısız kontrol karesi (24×24) tanı için saklanır; başarılıysa silinir.
    if (ok) N().filesystem.remove(probe).catch(() => {});
    else {
      const keep = join(paths.root, ".kayit-kontrol-hata.png");
      N().filesystem.remove(keep).catch(() => {}).finally(() => N().filesystem.move(probe, keep).catch(() => {}));
    }
  }
}

export async function startScreenRecord(rectOrFn, outPath, { fps = 30, out, verify = true } = {}) {
  const bin = await findFfmpeg();
  if (!bin) throw new Error(t('platform.ffmpegMissing', 'ffmpeg not found'));
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2); // aşağı yuvarla: bölge ekrandan taşmasın
  // rect bir fonksiyon olabilir: pencere öne alındıktan sonra konum yeniden ölçülür.
  // Bölge biraz (1 px) içeri alınır; ffmpeg masaüstü dışına 1 piksel bile taşan bölgeyi reddeder.
  // Taşarsa ffmpeg gerçek masaüstü sınırını hata mesajında verir: onu öğrenip bölgeyi içine kırparız.
  let desk = null;
  const fit = (r) => {
    let x0 = r.x + 1, y0 = r.y + 1, x1 = r.x + r.w - 1, y1 = r.y + r.h - 1;
    if (desk) {
      x0 = Math.max(x0, desk.x0); y0 = Math.max(y0, desk.y0);
      x1 = Math.min(x1, desk.x1); y1 = Math.min(y1, desk.y1);
    }
    return { x: Math.round(x0), y: Math.round(y0), w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
  };
  const learnDesk = (err) => {
    const m = /window area \((-?\d+),(-?\d+)\),\((-?\d+),(-?\d+)\)/.exec(err || '');
    if (m) desk = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    return !!m;
  };
  const measure = async () => fit(typeof rectOrFn === "function" ? await rectOrFn() : rectOrFn);
  let rect = await measure();
  let w = even(rect.w), h = even(rect.h);
  // verify=false: bölge az önce doğrulandıysa (ör. canlı moddaki ardışık parçalar) mor kontrol karesi atlanır.
  let chk = verify ? await regionShowsUs(bin, rect, w, h) : { ok: true };
  for (let i = 0; i < 3 && !chk.ok; i++) {
    if (learnDesk(chk.err)) {
      // Sadece sınır sorunu: pencereyi oynatmadan kırpılmış bölgeyle tekrar dene.
      rect = await measure();
      w = even(rect.w);
      h = even(rect.h);
      chk = await regionShowsUs(bin, rect, w, h);
      continue;
    }
    // Pencereyi yeniden öne al, biraz bekle, konumu yeniden ölç ve tekrar dene.
    await win.show();
    await win.focus();
    await win.onTop(true);
    await new Promise((r) => setTimeout(r, 800));
    rect = await measure();
    w = even(rect.w);
    h = even(rect.h);
    chk = await regionShowsUs(bin, rect, w, h);
  }
  if (!chk.ok)
    throw new Error(
      t('platform.recordNotShown', 'Screen recording did not start: the Hafif Stüdyo window is not visible in the recording area (another window is on top, or the window is off-screen). Keep the window visible and try again.') +
        ' ' +
        t('platform.recordRegion', '[region {x},{y} {w}×{h}, match {pct}%{err}]', {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w,
          h,
          pct: Math.round((chk.frac || 0) * 100),
          err: chk.err ? ', ' + chk.err : '',
        }),
    );
  const vf = out
    ? `-vf "scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d10,format=yuv420p"`
    : '-pix_fmt yuv420p';
  await mkdirp(dirOf(outPath));
  const cmd = `${q(bin)} -hide_banner -loglevel error -y -f gdigrab -framerate ${fps} -draw_mouse 0 -offset_x ${Math.round(rect.x)} -offset_y ${Math.round(rect.y)} -video_size ${w}x${h} -i desktop ${vf} -c:v libx264 -preset ultrafast -crf 22 -movflags +faststart ${q(outPath)}`;
  const proc = await N().os.spawnProcess(cmd);
  let exitRes;
  let errText = '';
  let exitCode = null;
  const exited = new Promise((res) => {
    exitRes = res;
  });
  const handler = (e) => {
    if (e.detail.id !== proc.id) return;
    if (e.detail.action === 'stdErr') errText = (errText + e.detail.data).slice(-2000);
    if (e.detail.action === 'exit') {
      exitCode = e.detail.data;
      exitRes(e.detail.data);
    }
  };
  N().events.on('spawnedProcess', handler);
  return {
    async stop() {
      try {
        await N().os.updateSpawnedProcess(proc.id, 'stdIn', 'q');
        await N().os.updateSpawnedProcess(proc.id, 'stdInEnd');
      } catch {}
      const killTimer = setTimeout(() => N().os.updateSpawnedProcess(proc.id, 'exit').catch(() => {}), 8000);
      await exited;
      clearTimeout(killTimer);
      N().events.off('spawnedProcess', handler);
      if (!(await exists(outPath)))
        throw new Error(t('platform.recordNoFile', 'Screen recording was not created (ffmpeg exit {code}): {err} | command: {cmd}', { code: exitCode, err: errText.trim() || '-', cmd }));
      return outPath;
    },
    /** Kayıt hâlâ sürüyor mu (ffmpeg erken çıktıysa false). */
    get alive() {
      return exitCode === null;
    },
    get error() {
      return errText;
    },
  };
}

// ---------------------------------------------------------------- pencere / uygulama

/** Pencerenin istemci alanının ekrandaki sol-üst köşesi (fiziksel piksel). */
export async function clientOrigin() {
  const dpr = devicePixelRatio || 1;
  if (!isNative()) return { x: screenX * dpr, y: screenY * dpr, dpr };
  // Pencere gösterildikten sonra Windows/Neutralino onu kayıtlı konumuna taşıyabiliyor (ilk ~1 sn içinde
  // konum birkaç kez değişiyor). Ardışık iki okuma aynı olana kadar bekle (en fazla ~3 sn).
  let pos = await N().window.getPosition();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const p2 = await N().window.getPosition();
    if (p2.x === pos.x && p2.y === pos.y && Math.abs(pos.x) < 16000) break;
    pos = p2;
  }
  const size = await N().window.getSize();
  // Gizli başlatılıp sonra gösterilen pencerede Neutralino eski (ekran dışı, 32767) konumu bildirebiliyor.
  // Bu durumda pencereyi bulunduğu ekranın ortasına taşı; böylece konumu kesin biliriz.
  if (Math.abs(pos.x) > 16000 || Math.abs(pos.y) > 16000) {
    const sw = (screen.availWidth || screen.width) * dpr;
    const sh = (screen.availHeight || screen.height) * dpr;
    const x = Math.max(0, Math.round((sw - size.width) / 2));
    const y = Math.max(0, Math.round((sh - size.height) / 2));
    await N().window.move(x, y);
    await new Promise((r) => setTimeout(r, 150));
    pos = await N().window.getPosition();
    if (Math.abs(pos.x) > 16000 || Math.abs(pos.y) > 16000) pos = { x, y };
  }
  // Pencere çerçevesi: dış genişlikle iç genişlik farkının yarısı kenarlık, kalan üst başlık çubuğu.
  const border = Math.max(0, Math.round((size.width - innerWidth * dpr) / 2));
  const title = Math.max(0, Math.round(size.height - innerHeight * dpr - border));
  return { x: pos.x + border, y: pos.y + title, dpr };
}

/**
 * Shows the window and brings it back on screen. Windows saves a minimized window's position as -32000,-32000;
 * Neutralino restores that saved state on the next start, so the window would open invisible, off screen.
 */
async function showOnScreen() {
  const w = N().window;
  await w.show();
  try {
    if (typeof w.unminimize === 'function') await w.unminimize().catch(() => {});
    // Right after a hidden start the position can briefly read 32767; give it a moment, as clientOrigin does.
    let pos = await w.getPosition();
    if (Math.abs(pos.x) >= 30000 || Math.abs(pos.y) >= 30000) {
      await new Promise((r) => setTimeout(r, 150));
      pos = await w.getPosition();
    }
    const off = Math.abs(pos.x) >= 10000 || Math.abs(pos.y) >= 10000;
    if (!off) return;
    const size = await w.getSize().catch(() => ({ width: 0, height: 0 }));
    const width = Math.max(1280, Math.min(screen.availWidth || 1400, size.width || 1400));
    const height = Math.max(760, Math.min(screen.availHeight || 860, size.height || 860));
    await w.setSize({ width, height }).catch(() => {});
    await w.move(Math.max(0, Math.round(((screen.availWidth || width) - width) / 2)), Math.max(0, Math.round(((screen.availHeight || height) - height) / 3)));
    await w.focus().catch(() => {});
  } catch (e) {
    console.warn('window position', e);
  }
}

export const win = {
  hide: () => isNative() && N().window.hide(),
  show: () => isNative() && showOnScreen(),
  focus: () => isNative() && N().window.focus(),
  setTitle: (t) => (isNative() ? N().window.setTitle(t) : (document.title = t)),
  maximize: () => isNative() && N().window.maximize(),
  onTop: (v) => isNative() && N().window.setAlwaysOnTop(!!v),
};

export function exit(code = 0) {
  if (isNative()) N().app.exit(code);
}

export async function mount(urlPath, dir) {
  try {
    await N().server.unmount(urlPath);
  } catch {}
  await N().server.mount(urlPath, dir);
}

/** Klasördeki değişiklikleri izler; cb(dosyaAdı, eylem). */
const watchHandlers = new Map();
/**
 * Klasördeki değişiklikleri izler (alt klasörler dahil); cb(dosyaAdı, eylem, olayınKlasörü).
 * Dönen kimlik unwatchDir ile kapatılır.
 */
export async function watchDir(dir, cb) {
  if (!isNative()) return null;
  const id = await N().filesystem.createWatcher(dir);
  const h = (e) => {
    if (e.detail.id === id) cb(e.detail.filename, e.detail.action, String(e.detail.dir || dir).replace(/\\/g, '/'));
  };
  watchHandlers.set(id, h);
  N().events.on('watchFile', h);
  return id;
}
export async function unwatchDir(id) {
  if (!isNative() || id == null) return;
  const h = watchHandlers.get(id);
  if (h) N().events.off('watchFile', h);
  watchHandlers.delete(id);
  try {
    await N().filesystem.removeWatcher(id);
  } catch {}
}

/** Aynı ayarlarla kaydedilmiş MP4 parçalarını yeniden kodlamadan birleştirir. */
export async function concatVideos(parts, outPath) {
  if (!parts.length) return null;
  if (parts.length === 1) {
    await N().filesystem.move(parts[0], outPath).catch(async () => {
      await N().filesystem.copy(parts[0], outPath);
    });
    return outPath;
  }
  const list = outPath.replace(/\.mp4$/i, '') + '.parcalar.txt';
  // ffmpeg concat listesi: tek tırnak içindeki ' karakteri '\'' olarak yazılır.
  const line = (p) => "file '" + String(p).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
  await writeText(list, parts.map(line).join('\n'));
  const r = await ffmpeg(`-f concat -safe 0 -i ${q(list)} -c copy -movflags +faststart ${q(outPath)}`);
  await N().filesystem.remove(list).catch(() => {});
  if (r.exitCode !== 0) throw new Error(t('platform.concatError', 'Could not join the video parts: {msg}', { msg: (r.stdErr || '').slice(0, 300) }));
  for (const p of parts) await N().filesystem.remove(p).catch(() => {});
  return outPath;
}

export function onWindowClose(cb) {
  if (isNative()) N().events.on('windowClose', cb);
}
