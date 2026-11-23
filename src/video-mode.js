// Video düzenleme modu.
// Medya kütüphanesi, 4 kanallı zaman çizelgesi (Yazı / Üst katman / Ana video / Ses), canvas önizleme,
// Web Audio miksajı ve MediaRecorder ile gerçek zamanlı dışa aktarma.
//
// Performans: boşta hiçbir döngü dönmez. Önizleme sadece bir şey değişince tek kare çizilir
// (requestDraw). Sürekli döngü yalnızca oynatma ve dışa aktarma sırasında vardır ve iş bitince durur.
//
// NLE features (helpers in video-fx.js): per-clip effects + looks (ctx.filter, vignette gradient), start
// transitions (fade / crossfade / slide / zoom / wipe / blur; the previous clip on the track is drawn past its
// end underneath), Ken Burns motion, rotation, crop, speed (playbackRate), styled/animated text, shape clips,
// track mute/hide/lock, markers, ripple delete, J/K/L shuttle, zoom to fit, export dialog (presets, fps,
// quality, PNG frame). Everything is stored on the clip model, so undo and live projects cover it.
import { $, $$, bus, store, settings, toast, busy, fmtTime, clamp, uid, sleep, esc, waitEvent, pickMime, isTyping, baseName } from './util.js';
import * as platform from './platform.js';
import { t, currentLanguage } from './i18n.js';
import * as FX from './video-fx.js';
import { createDrawRenderer, hashCode, STICK_EXAMPLE } from './draw-clip.js';

/** Hangi kanal hangi medya türünü kabul eder. */
const TRACK_ACCEPTS = {
  t: ['text'],
  v2: ['video', 'image', 'shape', 'draw'],
  v1: ['video', 'image', 'shape', 'draw'],
  a: ['audio'],
};
const kindLabel = (k) =>
  ({
    video: t('video.kind.video', 'Video'),
    image: t('video.kind.image', 'Image'),
    audio: t('video.kind.audio', 'Audio'),
    text: t('video.kind.text', 'Text'),
    shape: t('video.kind.shape', 'Shape'),
    draw: t('video.kind.draw', 'Drawing'),
  })[k] || k;
/** Clip kinds that take effects / transitions / motion. Crop and fit only apply to media (video / image). */
const hasFx = (c) => c.kind === 'video' || c.kind === 'image' || c.kind === 'shape' || c.kind === 'draw';
const isMediaVisual = (c) => c.kind === 'video' || c.kind === 'image';
/** Longest accepted drawing code (characters); keeps the undo history small. */
const DRAW_CODE_MAX = 100000;
/** Track order top to bottom (matches the .tl-heads rows in index.html). */
const TRACK_ORDER = ['t', 'v2', 'v1', 'a'];
/** Which header buttons each track gets. */
const TRACK_FLAGS = { t: ['hide', 'lock'], v2: ['mute', 'hide', 'lock'], v1: ['mute', 'hide', 'lock'], a: ['mute', 'lock'] };
/** Object-valued clip fields: null clears them, a whole object replaces, "a.b" panel keys merge. */
const OBJ_FIELDS = ['effects', 'transition', 'motion', 'crop'];
const SHUTTLE_MAX = 8;

/** Dışa aktarma için MediaRecorder türleri (ilk desteklenen kullanılır). */
const EXPORT_MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const resLabel = (res) =>
  ({
    '1080x1920': t('video.res.vertical', 'Vertical 1080×1920 (TikTok, Shorts)'),
    '1920x1080': t('video.res.horizontal', 'Horizontal 1920×1080 (YouTube)'),
    '1280x720': t('video.res.light', 'Horizontal 1280×720 (light)'),
    '1080x1080': t('video.res.square', 'Square 1080×1080'),
  })[res];

const IMAGE_DEFAULT_DUR = 3; // sn
const HISTORY_LIMIT = 100;
const TYPE_CPS = 14; // "Harf harf" animasyonu: saniyede harf
const ECO_FRAME_MS = 32; // Eko modda oynatma çizimi ~30 fps
const FONT = '"Segoe UI", Arial, sans-serif';

/** api'nin kabul ettiği okunaklı adlar → iç alan adları. */
const OPT_ALIASES = { duration: 'dur', in: 'inP', volume: 'vol', box: 'bg', boxColor: 'bgColor' };

const isTimed = (clip) => clip.kind === 'video' || clip.kind === 'audio';
const isActiveAt = (clip, tm) => tm >= clip.start && tm < clip.start + clip.dur;
/** Playback speed of a clip (video/audio): source seconds per timeline second. */
const speedOf = (clip) => (isTimed(clip) && clip.speed > 0 ? clip.speed : 1);
/** Source-time span covered by the clip on the timeline. */
const srcSpan = (clip) => clip.dur * speedOf(clip);
const isObjV = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const deepCopy = (v) => JSON.parse(JSON.stringify(v));

/** Panel value of a (possibly dotted) field, with the default when the field is absent. */
function valueOf(c, key) {
  const parts = key.split('.');
  if (parts[0] === 'effects') return c.effects?.[parts[1]] ?? FX.EFFECT_DEFAULTS[parts[1]];
  if (parts[0] === 'transition') return (c.transition || FX.TRANSITION_DEFAULT)[parts[1]];
  if (parts[0] === 'motion') return parts[2] ? (c.motion?.[parts[1]]?.[parts[2]] ?? FX.MOTION_POINT[parts[2]]) : (c.motion?.[parts[1]] ?? 'ease-in-out');
  if (parts[0] === 'crop') return c.crop?.[parts[1]] ?? 0;
  if (c[key] !== undefined) return c[key];
  if (key === 'speed') return 1;
  if (key === 'rotation') return 0;
  if (c.kind === 'text' && key in FX.TEXT_DEFAULTS) return FX.TEXT_DEFAULTS[key];
  if (c.kind === 'shape' && key in FX.SHAPE_DEFAULTS) return FX.SHAPE_DEFAULTS[key];
  return undefined;
}

/** Text style with defaults filled in. */
const textStyle = (c) => {
  const s = {};
  for (const k of Object.keys(FX.TEXT_DEFAULTS)) s[k] = c[k] ?? FX.TEXT_DEFAULTS[k];
  return s;
};

/** Transition state at time tm: { type, duration, p (0..1), e (eased) } or null outside the transition. */
function transitionAt(clip, tm) {
  const tr = clip.transition;
  if (!tr || clip.kind === 'text' || clip.kind === 'audio') return null;
  const d = Math.min(tr.duration, clip.dur);
  const local = tm - clip.start;
  if (!(d > 0) || local < 0 || local >= d) return null;
  const p = local / d;
  return { ...tr, p, e: FX.ease('ease-in-out', p) };
}

/** Klibin t anındaki solma çarpanı (belirerek gir / kaybolarak çık). */
function fadeAt(clip, tm) {
  const local = tm - clip.start;
  let k = 1;
  if (clip.fadeIn > 0) k = Math.min(k, local / clip.fadeIn);
  if (clip.fadeOut > 0) k = Math.min(k, (clip.dur - local) / clip.fadeOut);
  return clamp(k, 0, 1);
}

/** Fade level a clip ends on: its tail under the next clip's transition keeps it (a faded-out clip stays out). */
const endFade = (clip) => fadeAt(clip, clip.start + clip.dur - 1e-6);

/** Dosyanın medya türü: önce MIME, sonra uzantı. */
function kindOf(file, name) {
  const type = file.type || '';
  if (type.startsWith('video')) return 'video';
  if (type.startsWith('audio')) return 'audio';
  if (type.startsWith('image')) return 'image';
  const ext = String(name || file.name || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  return null;
}

/** Bir video/resim kaynağından 192×108 JPEG küçük resim. */
function makeThumb(source, w, h) {
  const c = document.createElement('canvas');
  c.width = 192;
  c.height = 108;
  const g = c.getContext('2d');
  const k = Math.min(192 / w, 108 / h);
  g.fillStyle = '#111';
  g.fillRect(0, 0, 192, 108);
  g.drawImage(source, (192 - w * k) / 2, (108 - h * k) / 2, w * k, h * k);
  return c.toDataURL('image/jpeg', 0.7);
}

/** Ses dosyasından 400 noktalık dalga formu (peaks) çıkarır; bitince onDone. */
async function computePeaks(file, m, onDone) {
  try {
    // A low sample rate is plenty for 400 peaks and keeps the decoded PCM small (decodeAudioData resamples to it).
    let octx;
    try {
      octx = new OfflineAudioContext(1, 1, 8000);
    } catch {
      octx = new OfflineAudioContext(1, 1, 44100);
    }
    const decoded = await octx.decodeAudioData(await file.arrayBuffer());
    const data = decoded.getChannelData(0);
    const count = 400;
    const step = Math.floor(data.length / count) || 1;
    const stride = step > 256 ? 8 : 1;
    m.peaks = Array.from({ length: count }, (_, i) => {
      let peak = 0;
      for (let j = i * step; j < (i + 1) * step && j < data.length; j += stride) peak = Math.max(peak, Math.abs(data[j]));
      return peak;
    });
    onDone();
  } catch {}
}

/** Ses klibinin kırpılmış aralığına düşen dalga formu SVG'si. */
function waveSvg(clip, m) {
  if (!m || !m.peaks) return '';
  const n = m.peaks.length;
  const from = Math.floor((clip.inP / m.dur) * n);
  const to = Math.ceil(((clip.inP + srcSpan(clip)) / m.dur) * n);
  const pk = m.peaks.slice(from, to);
  if (!pk.length) return '';
  const last = Math.max(1, pk.length - 1);
  const top = pk.map((p, i) => `${(i / last) * 100},${9 - p * 9} `).join('');
  const bottom = pk.map((_, i) => `${((pk.length - 1 - i) / last) * 100},${9 + pk[pk.length - 1 - i] * 9} `).join('');
  return `<svg class="wave" viewBox="0 0 100 18" preserveAspectRatio="none"><polygon points="${top}${bottom}" fill="#fff"/></svg>`;
}

/** Klibin dışarıya verilen kopyası: iç adların yanında okunaklı adlar da bulunur. */
function publicClip(c) {
  const out = { ...deepCopy(c), duration: c.dur, in: c.inP };
  if (isTimed(c)) {
    out.volume = c.vol;
    out.speed = speedOf(c);
  }
  if (c.kind !== 'audio') out.rotation = c.rotation || 0;
  if (c.kind === 'text') {
    out.box = c.bg;
    out.boxColor = c.bgColor;
    Object.assign(out, textStyle(c));
  }
  if (hasFx(c)) {
    out.effects = out.effects || null;
    out.transition = out.transition || null;
    out.motion = out.motion || null;
    if (isMediaVisual(c)) out.crop = out.crop || null;
  }
  if (c.kind === 'draw') out.code = c.code || '';
  return out;
}

export function createVideoMode() {
  // ------------------------------------------------------------------ DOM
  const section = $('#mvid');
  const canvas = $('#v-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const tlInner = $('#v-tli');
  const tlScroll = $('#v-tls');
  const playBtn = $('#v-play');
  const dropZone = $('#v-drop');
  const mediaListEl = $('#v-mlist');
  const propsEl = $('#v-props');
  const resSelect = $('#v-res');
  const qualitySelect = $('#v-q');
  const zoomSlider = $('#v-zoom');
  const snapCheck = $('#v-snapchk');

  // ------------------------------------------------------------------ durum
  const savedProj = store.get('vproj', { res: '1080x1920', bg: '#000000', fps: 30 });
  const proj = { w: 1080, h: 1920, res: savedProj.res || '1080x1920', bg: savedProj.bg || '#000000', fps: +savedProj.fps || 30 };
  let quality = +store.get('vq', settings.eco ? 0.25 : 0.5) || 0.5; // önizleme çözünürlük çarpanı

  let mediaItems = []; // {id,name,type,url,dur,w,h,thumb,img,peaks}
  let clips = []; // eklenme sırasına göre
  let time = 0; // oynatma çizgisi (sn)
  let playing = false;
  let playRate = 1; // J/K/L shuttle (negative = reverse)
  let selectedId = null;
  let zoom = 60; // zaman çizelgesi: piksel / saniye
  let active = false;
  let exp = null; // dışa aktarma durumu (sürüyorsa)

  // Draw clips (kind:'draw'): frames rendered by a sandboxed worker per clip (src/draw-clip.js).
  // Workers start lazily on the first frame request and are terminated when the clip leaves the timeline,
  // the project is cleared or the mode deactivates.
  const drawer = createDrawRenderer({
    onFrame: () => {
      if (!playing) requestDraw();
    },
    onError: (clipId) => {
      if (active) renderTimeline();
      const box = propsEl.querySelector('.vdraw-err');
      if (box && selectedId === clipId) {
        const err = drawer.error(clipId);
        box.textContent = err || '';
        box.hidden = !err;
      }
      requestDraw();
    },
  });
  const drawDrafts = new Map(); // clipId -> unapplied code typed in the panel

  // Oynatma döngüsü
  let rafId = 0;
  let timerId = 0;
  let lastTick = 0;
  let lastDraw = 0;

  // Web Audio: her zamanlı klibin kendi <video>/<audio> öğesi ve GainNode'u var.
  const players = new Map(); // clipId -> HTMLMediaElement
  const clipGains = new Map(); // clipId -> GainNode
  let audioCtx = null;
  let masterGain = null;
  let audioDest = null; // MediaStreamDestination (dışa aktarmada ses izi)

  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state !== 'closed') audioCtx.resume().catch(() => {}); // also queued after a pending suspend()
      return;
    }
    try {
      audioCtx = new AudioContext();
      masterGain = audioCtx.createGain();
      masterGain.connect(audioCtx.destination);
      audioDest = audioCtx.createMediaStreamDestination();
      masterGain.connect(audioDest);
      for (const [clipId, el] of players) connectPlayer(el, clipId);
    } catch (e) {
      console.warn(e);
    }
  }

  /** Idle: suspend the audio graph (its render thread otherwise keeps running); ensureAudio() resumes it. */
  function idleAudio() {
    if (audioCtx && !playing && !exp && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
  }

  function connectPlayer(el, clipId) {
    if (!audioCtx || clipGains.has(clipId)) return;
    const gain = audioCtx.createGain();
    audioCtx.createMediaElementSource(el).connect(gain).connect(masterGain);
    clipGains.set(clipId, gain);
  }

  function disposePlayer(clipId) {
    const el = players.get(clipId);
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    clipGains.get(clipId)?.disconnect();
    players.delete(clipId);
    clipGains.delete(clipId);
  }

  // ------------------------------------------------------------------ medya kütüphanesi

  // Kütüphaneden kaldırılmış ama geçmişte (geri al) hâlâ kullanılan medya: URL'si açık tutulur,
  // geri alınan klip onu kullanırsa kütüphaneye döner; geçmişten düşünce serbest bırakılır.
  let trashMedia = [];
  const mediaById = (id) => mediaItems.find((m) => m.id === id) || trashMedia.find((m) => m.id === id) || null;
  const mediaOf = (clip) => mediaById(clip.mid);
  const midTag = (id) => '"mid":' + JSON.stringify(id);

  /**
   * Dosyayı kütüphaneye ekler. Başarısızsa Error fırlatır.
   * fallbackDur: süresi okunamayan (ör. MediaRecorder webm) dosyalar için.
   */
  async function loadMedia(file, name, type, fallbackDur) {
    name = name || file.name || t('video.mediaDefault', 'media');
    type = type || kindOf(file, name);
    if (!['video', 'audio', 'image'].includes(type)) throw new Error(t('video.err.unsupportedFile', 'Unsupported file: {name}', { name }));
    // path: masaüstünde diskten okunan dosyanın tam yolu (platform.readBlob ekler); canlı projede geri yazmak için.
    const m = { id: uid(), name, type, url: URL.createObjectURL(file), dur: 0, w: 0, h: 0, thumb: '', img: null, peaks: null, path: file.path || '' };
    try {
      if (type === 'video') {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.src = m.url;
        if (!(await waitEvent(v, 'loadedmetadata'))) throw new Error(t('video.err.videoOpen', 'Could not open video: {name}', { name }));
        if (!isFinite(v.duration)) {
          // MediaRecorder webm'lerinde süre Infinity gelir: sona atlayınca gerçek süre öğrenilir.
          v.currentTime = 1e7;
          await waitEvent(v, 'durationchange', 3000);
        }
        m.dur = isFinite(v.duration) && v.duration > 0 ? v.duration : fallbackDur || 5;
        m.w = v.videoWidth;
        m.h = v.videoHeight;
        v.currentTime = Math.min(0.5, m.dur / 2);
        await waitEvent(v, 'seeked', 3000);
        if (m.w && m.h) m.thumb = makeThumb(v, m.w, m.h);
        v.removeAttribute('src');
        v.load();
      } else if (type === 'audio') {
        const a = new Audio();
        a.preload = 'metadata';
        a.src = m.url;
        await waitEvent(a, 'loadedmetadata');
        m.dur = isFinite(a.duration) && a.duration > 0 ? a.duration : fallbackDur || 10;
        // Gate on the estimated decoded size (the decoder holds full-rate float PCM: ~48 kHz × 2 ch × 4 B per second),
        // not the file size: a long, highly compressed file would need hundreds of MB just for the waveform.
        if (file.size < 4e7 && m.dur * 48000 * 2 * 4 < 1.6e8) computePeaks(file, m, renderTimeline);
      } else {
        const img = new Image();
        // decode() pencere çizim yapmıyorken (gizli/küçültülmüş) bekleyip kalabiliyor; load olayı her durumda gelir.
        const loaded = new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error(t('video.err.imageOpen', 'Could not open image: {name}', { name })));
        });
        img.src = m.url;
        try {
          await Promise.race([loaded, img.decode().catch(() => loaded)]);
        } catch {
          throw new Error(t('video.err.imageOpen', 'Could not open image: {name}', { name }));
        }
        if (!img.naturalWidth) throw new Error(t('video.err.imageOpen', 'Could not open image: {name}', { name }));
        m.img = img;
        m.w = img.naturalWidth;
        m.h = img.naturalHeight;
        m.thumb = m.url;
      }
    } catch (e) {
      URL.revokeObjectURL(m.url);
      throw e;
    }
    mediaItems.push(m);
    renderMediaList();
    if (!selectedClip()) renderProps();
    return m;
  }

  /** Arayüzden gelen dosyalar (seçici / sürükle-bırak). */
  async function addFiles(files) {
    let ok = 0;
    for (const f of files) {
      try {
        await loadMedia(f, f.name);
        ok++;
      } catch (e) {
        toast(e.message);
      }
    }
    if (files.length && ok) {
      toast(t('video.filesAdded', '{n} files added. Use "+" to put them on the timeline.', { n: files.length }));
      notifyChange();
    }
  }

  function renderMediaList() {
    mediaListEl.innerHTML = mediaItems
      .map(
        (m) => `
      <div class="mcard" draggable="true" data-mid="${m.id}" title="${esc(m.name)}">
        <div class="th" style="${m.thumb ? `background-image:url(${m.thumb})` : ''}">${m.type === 'audio' ? '♪ ' + esc(kindLabel('audio')) : ''}</div>
        <span class="ty">${esc(kindLabel(m.type))}</span>
        <button class="add" data-quick="${m.id}" title="${esc(t('video.addToTimeline', 'Add to timeline'))}">+</button>
        <div class="meta"><b>${esc(m.name)}</b><span>${m.type === 'image' ? '' : fmtTime(m.dur).replace(/\.\d+$/, '')}</span></div>
      </div>`,
      )
      .join('');
  }

  mediaListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (btn) quickAdd(mediaById(btn.dataset.quick));
  });
  mediaListEl.addEventListener('dblclick', (e) => {
    const card = e.target.closest('[data-mid]');
    if (card) quickAdd(mediaById(card.dataset.mid));
  });

  // Kütüphaneden kanala sürükleme
  let draggedMediaId = null;
  mediaListEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-mid]');
    if (!card) return;
    draggedMediaId = card.dataset.mid;
    e.dataTransfer.setData('text/plain', draggedMediaId);
    e.dataTransfer.effectAllowed = 'copy';
  });
  mediaListEl.addEventListener('dragend', () => {
    draggedMediaId = null;
    $$('.track.over', tlInner).forEach((el) => el.classList.remove('over'));
  });

  // Dosya ekleme: tıkla / "Medya ekle" / pencereye sürükle-bırak
  const pickAndAdd = async () => addFiles(await platform.openFiles('video/*,audio/*,image/*', true));
  dropZone.onclick = pickAndAdd;
  $('#v-import').onclick = pickAndAdd;
  section.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('over');
  });
  section.addEventListener('dragleave', (e) => {
    if (e.target === dropZone || !section.contains(e.relatedTarget)) dropZone.classList.remove('over');
  });
  section.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    dropZone.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });

  // ------------------------------------------------------------------ klipler

  const totalDuration = () => clips.reduce((mx, c) => Math.max(mx, c.start + c.dur), 0);
  const trackEnd = (track) => clips.filter((c) => c.track === track).reduce((mx, c) => Math.max(mx, c.start + c.dur), 0);
  const selectedClip = () => clips.find((c) => c.id === selectedId) || null;
  const clipById = (id) => clips.find((c) => c.id === id) || null;

  function makeClip(m, track, start) {
    return {
      id: uid(),
      mid: m.id,
      kind: m.type,
      track,
      start: Math.max(0, start),
      inP: 0, // kaynak başı (kaynağın kaçıncı saniyesinden başlar)
      dur: m.type === 'video' || m.type === 'audio' ? m.dur : IMAGE_DEFAULT_DUR,
      x: 0,
      y: 0,
      scale: track === 'v2' ? 0.5 : 1,
      opacity: 1,
      vol: 1,
      fadeIn: 0,
      fadeOut: 0,
      fit: 'contain',
    };
  }

  function makeTextClip(start) {
    return {
      id: uid(),
      kind: 'text',
      track: 't',
      start: Math.max(0, start),
      inP: 0,
      dur: 3,
      text: t('video.newText', 'New text'),
      size: 9,
      color: '#ffffff',
      stroke: true,
      bg: false, // kutu
      bgColor: '#000000',
      anim: 'pop',
      x: 0,
      y: proj.h > proj.w ? 0.25 : 0.32,
      scale: 1,
      opacity: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
  }

  /** Shape clip (rectangle / rounded / circle / progress bar). w is a fraction of the frame width, h of the height. */
  function makeShapeClip(shape, start, track = 'v2') {
    const d = FX.SHAPE_DEFAULTS;
    const c = { id: uid(), kind: 'shape', track, start: Math.max(0, start), inP: 0, dur: 3, shape: FX.SHAPES.includes(shape) ? shape : d.shape, color: d.color, w: d.w, h: d.h, radius: d.radius, x: 0, y: 0, scale: 1, opacity: 1, fadeIn: 0, fadeOut: 0 };
    if (c.shape === 'circle') {
      c.w = 0.3;
      c.h = Math.round(((0.3 * proj.w) / proj.h) * 1000) / 1000;
    } else if (c.shape === 'bar') {
      Object.assign(c, { w: 0.86, h: 0.012, y: 0.44, color: '#ffffff', radius: 1 });
    } else if (c.shape === 'rounded') c.radius = 0.5;
    return c;
  }

  /** Draw clip: a full-frame layer drawn by JavaScript (body of function (ctx, t, w, h, p, H)). */
  function makeDrawClip(code, start, track = 'v2') {
    return { id: uid(), kind: 'draw', track, start: Math.max(0, start), inP: 0, dur: 5, code: String(code || '').slice(0, DRAW_CODE_MAX), x: 0, y: 0, scale: 1, opacity: 1, fadeIn: 0, fadeOut: 0 };
  }

  /** Default value of an object field when a panel key ("motion.to.scale") is edited for the first time. */
  function defaultObj(root) {
    if (root === 'transition') return { ...FX.TRANSITION_DEFAULT };
    if (root === 'motion') return { from: { ...FX.MOTION_POINT }, to: { ...FX.MOTION_POINT }, ease: 'ease-in-out' };
    if (root === 'crop') return { l: 0, t: 0, r: 0, b: 0 };
    return {};
  }

  /**
   * Klibe seçenek uygular (api + özellik paneli ortak). Hem okunaklı (duration/in/volume/box/boxColor)
   * hem iç adları (dur/inP/vol/bg/bgColor) kabul eder; değerleri geçerli aralığa sıkıştırır.
   * Object fields (effects / transition / motion / crop): a whole object replaces, null clears,
   * dotted panel keys ("effects.brightness") merge onto the current value.
   */
  function applyClipOpts(c, opts = {}) {
    const o = {};
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined) continue;
      const key = OPT_ALIASES[k] || k;
      const root = key.split('.')[0];
      if (v === null && !OBJ_FIELDS.includes(root)) continue;
      if (key.includes('.')) {
        if (!OBJ_FIELDS.includes(root)) continue;
        if (!isObjV(o[root])) o[root] = deepCopy(c[root] || defaultObj(root));
        const parts = key.split('.').slice(1);
        let tgt = o[root];
        for (let i = 0; i < parts.length - 1; i++) {
          if (!isObjV(tgt[parts[i]])) tgt[parts[i]] = {};
          tgt = tgt[parts[i]];
        }
        tgt[parts[parts.length - 1]] = v;
      } else o[key] = v;
    }
    const m = mediaOf(c);
    const timed = isTimed(c);
    const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
    const ok = (v) => Number.isFinite(num(v));
    const setObj = (k, v) => {
      if (v == null) delete c[k];
      else c[k] = v;
    };

    if (o.track != null && o.track !== c.track) {
      if (!TRACK_ACCEPTS[o.track]?.includes(c.kind)) throw new Error(t('video.err.trackRejects', 'Track "{track}" does not accept {kind}', { track: o.track, kind: kindLabel(c.kind) }));
      c.track = o.track;
    }
    // Speed first: it rescales the duration (the source span stays), then an explicit duration wins.
    if (timed && ok(o.speed)) {
      const ns = Math.round(clamp(num(o.speed), 0.25, 4) * 1000) / 1000;
      const old = speedOf(c);
      if (ns !== old) {
        c.dur = (c.dur * old) / ns;
        if (ns === 1) delete c.speed;
        else c.speed = ns;
      }
    }
    const maxDur = () => (timed && m ? Math.max(0.1, (m.dur - c.inP) / speedOf(c)) : 3600);
    if (ok(o.inP) && timed && m) c.inP = clamp(num(o.inP), 0, Math.max(0, m.dur - 0.1));
    if (timed && m) c.dur = Math.max(0.1, Math.min(c.dur, maxDur()));
    if (ok(o.start)) c.start = Math.max(0, num(o.start));
    if (ok(o.dur)) c.dur = clamp(num(o.dur), 0.1, maxDur());

    const ranges = { x: [-5, 5], y: [-5, 5], scale: [0.01, 10], opacity: [0, 1], vol: [0, 2], fadeIn: [0, 60], fadeOut: [0, 60], size: [1, 60] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      if (!ok(o[k])) continue;
      if (k === 'vol' && !timed) continue;
      if (k === 'size' && c.kind !== 'text') continue;
      c[k] = clamp(num(o[k]), lo, hi);
    }
    if (isMediaVisual(c) && (o.fit === 'contain' || o.fit === 'cover')) c.fit = o.fit;
    if (c.kind !== 'audio' && ok(o.rotation)) {
      const r = Math.round(clamp(num(o.rotation), -360, 360) * 100) / 100;
      if (r) c.rotation = r;
      else delete c.rotation;
    }
    if (hasFx(c)) {
      if ('effects' in o) setObj('effects', FX.sanitizeEffects(o.effects));
      if ('transition' in o) setObj('transition', FX.sanitizeTransition(o.transition));
      if ('motion' in o) setObj('motion', FX.sanitizeMotion(o.motion));
      if ('crop' in o && isMediaVisual(c)) setObj('crop', FX.sanitizeCrop(o.crop));
    }
    if (c.kind === 'draw' && typeof o.code === 'string') c.code = o.code.slice(0, DRAW_CODE_MAX);
    if (c.kind === 'shape') {
      if (FX.SHAPES.includes(o.shape)) c.shape = o.shape;
      if (typeof o.color === 'string') c.color = o.color;
      for (const [k, [lo, hi]] of Object.entries(FX.SHAPE_RANGES)) if (ok(o[k])) c[k] = clamp(num(o[k]), lo, hi);
    }
    if (c.kind === 'text') {
      if (o.text != null) c.text = String(o.text);
      if (typeof o.color === 'string') c.color = o.color;
      if (typeof o.bgColor === 'string') c.bgColor = o.bgColor;
      if (o.stroke != null) c.stroke = !!o.stroke;
      if (o.bg != null) c.bg = !!o.bg;
      if (FX.TEXT_ANIMS.includes(o.anim)) c.anim = o.anim;
      if (o.font != null) c.font = FX.sanitizeFont(o.font);
      if (ok(o.weight)) c.weight = clamp(Math.round(num(o.weight) / 100) * 100, 100, 900);
      for (const [k, [lo, hi]] of Object.entries(FX.TEXT_RANGES)) if (k !== 'weight' && ok(o[k])) c[k] = clamp(num(o[k]), lo, hi);
      for (const k of ['italic', 'shadow']) if (o[k] != null) c[k] = o[k] === 'false' ? false : !!o[k];
      for (const k of ['strokeColor', 'shadowColor']) if (typeof o[k] === 'string') c[k] = o[k];
      if (FX.TEXT_ALIGNS.includes(o.align)) c.align = o.align;
    }
    return c;
  }

  /** "+" / çift tık: ses → oynatma çizgisine, görüntü → ana videonun sonuna. */
  function quickAdd(m, silent) {
    if (!m) return null;
    const track = m.type === 'audio' ? 'a' : 'v1';
    if (isLocked(track)) {
      toast(t('video.track.lockedMsg', 'This track is locked'));
      return null;
    }
    const clip = track === 'a' ? makeClip(m, 'a', time) : makeClip(m, 'v1', trackEnd('v1'));
    clips.push(clip);
    selectedId = clip.id;
    commit();
    if (!silent) toast(t('video.clipAdded', '{kind} added', { kind: kindLabel(m.type) }));
    return clip;
  }

  /** "Yazı ekle" düğmesi: oynatma çizgisine yeni yazı, seçili ve metni düzenlemeye hazır. */
  function addTextFromUI() {
    if (isLocked('t')) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const clip = makeTextClip(time);
    clips.push(clip);
    selectedId = clip.id;
    commit();
    const ta = $('textarea', propsEl);
    if (ta) {
      ta.focus();
      ta.select();
    }
  }
  $('#v-text').onclick = addTextFromUI;

  // ---- "Shape" toolbar button + menu (created here: index.html is not owned by this module)
  const SHAPE_MENU = [
    ['rect', () => t('video.shape.rect', 'Rectangle')],
    ['rounded', () => t('video.shape.rounded', 'Rounded rectangle')],
    ['circle', () => t('video.shape.circle', 'Circle')],
    ['bar', () => t('video.shape.bar', 'Progress bar')],
    ['lower', () => t('video.shape.lower', 'Lower third')],
  ];
  const shapeBtn = document.createElement('button');
  shapeBtn.id = 'v-shape';
  shapeBtn.className = 'vshape-btn';
  shapeBtn.textContent = t('video.shape.add', 'Shape');
  shapeBtn.title = t('video.shape.title', 'Add a shape (rectangle, circle, progress bar, lower third) to the overlay track');
  $('#v-text').after(shapeBtn);
  const shapeMenu = document.createElement('div');
  shapeMenu.className = 'vmenu';
  shapeMenu.hidden = true;
  shapeMenu.innerHTML = SHAPE_MENU.map(([k, label]) => `<button data-shape="${k}"><i class="vsh vsh-${k}"></i>${esc(label())}</button>`).join('');
  document.body.appendChild(shapeMenu);
  const closeShapeMenu = () => (shapeMenu.hidden = true);
  shapeBtn.onclick = (e) => {
    e.stopPropagation();
    if (!shapeMenu.hidden) return closeShapeMenu();
    const r = shapeBtn.getBoundingClientRect();
    shapeMenu.style.left = Math.round(r.left) + 'px';
    shapeMenu.style.top = Math.round(r.bottom + 4) + 'px';
    shapeMenu.hidden = false;
  };
  shapeMenu.addEventListener('click', (e) => {
    const k = e.target.closest('[data-shape]')?.dataset.shape;
    if (!k) return;
    closeShapeMenu();
    addShapeFromUI(k);
  });
  addEventListener('pointerdown', (e) => {
    if (!shapeMenu.hidden && !shapeMenu.contains(e.target) && e.target !== shapeBtn) closeShapeMenu();
  });

  /** Adds a shape at the playhead on the overlay track (lower third = styled rounded bar). */
  function addShapeFromUI(kind) {
    if (isLocked('v2')) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const clip = makeShapeClip(kind === 'lower' ? 'rounded' : kind, time, 'v2');
    if (kind === 'lower') Object.assign(clip, { w: 0.72, h: 0.07, x: -0.08, y: proj.h > proj.w ? 0.3 : 0.33, color: '#111827', opacity: 0.85, radius: 0.35, transition: { type: 'slide-left', duration: 0.4 } });
    if (kind === 'bar') clip.dur = Math.max(1, totalDuration() - time) || 3;
    clips.push(clip);
    selectedId = clip.id;
    commit();
    return clip;
  }

  // ---- "Drawing" toolbar button: a draw clip (a layer drawn by JavaScript) starting with an example
  const drawBtn = document.createElement('button');
  drawBtn.id = 'v-draw';
  drawBtn.className = 'vshape-btn vdraw-btn';
  drawBtn.textContent = t('video.draw.add', 'Drawing');
  drawBtn.title = t('video.draw.title', 'Add a drawing layer: JavaScript code draws every frame (stick figures, motion graphics, diagrams)');
  shapeBtn.after(drawBtn);
  drawBtn.onclick = () => addDrawFromUI();

  /** Adds a draw clip at the playhead on the overlay track (example code: two neon stick figures). */
  function addDrawFromUI(code = STICK_EXAMPLE) {
    if (isLocked('v2')) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const clip = makeDrawClip(code, time, 'v2');
    clips.push(clip);
    selectedId = clip.id;
    commit();
    return clip;
  }

  // ---- track state (mute / hide / lock) and markers; both are part of the undo history
  let trackState = { t: {}, v2: {}, v1: {}, a: {} };
  let markers = []; // sorted times (s)
  const isLocked = (track) => !!trackState[track]?.lock;
  const isHidden = (track) => !!trackState[track]?.hide;
  const isMuted = (track) => !!trackState[track]?.mute;

  /** Oynatma çizgisinden böl (seçili klip; yoksa çizginin altındaki klip, öncelik ana video). */
  function splitAtPlayhead() {
    let c = selectedClip();
    if (!c || time <= c.start + 0.05 || time >= c.start + c.dur - 0.05) {
      const under = (k) => time > k.start + 0.05 && time < k.start + k.dur - 0.05 && !isLocked(k.track);
      // Main video first; other tracks only when nothing is selected.
      c = clips.find((k) => k.track === 'v1' && under(k)) || (selectedClip() ? null : clips.find(under));
    }
    if (!c) return toast(t('video.splitHint', 'Move the playhead over a clip to split it'));
    if (isLocked(c.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const cut = time - c.start;
    const right = { ...deepCopy(c), id: uid(), start: time, inP: c.inP + (isTimed(c) ? cut * speedOf(c) : 0), dur: c.dur - cut, fadeIn: 0 };
    delete right.transition;
    if (c.motion) {
      // Keep the camera move continuous across the cut: same position, and no ease that stops at the cut
      // (ease-in-out splits into ease-in + ease-out, exact at the midpoint; ease-in/out keep their exact half).
      const mid = FX.motionAt(c.motion, cut / c.dur);
      const ez = FX.EASE_KEYS.includes(c.motion.ease) ? c.motion.ease : 'ease-in-out';
      const leftEase = ez === 'ease-in-out' ? 'ease-in' : ez === 'ease-out' ? 'linear' : ez;
      const rightEase = ez === 'ease-in-out' ? 'ease-out' : ez === 'ease-in' ? 'linear' : ez;
      c.motion = { ...c.motion, to: { ...mid }, ease: leftEase };
      right.motion = { ...right.motion, from: { ...mid }, ease: rightEase };
    }
    c.dur = cut;
    c.fadeOut = 0;
    clips.push(right);
    selectedId = right.id;
    commit();
  }

  function deleteSelected() {
    if (!selectedId) return;
    if (isLocked(selectedClip()?.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
    clips = clips.filter((c) => c.id !== selectedId);
    disposePlayer(selectedId); // geri alınırsa getPlayer yeniden oluşturur
    selectedId = null;
    commit();
  }

  /** Ripple delete (Shift+Delete): removes the clip and pulls later clips on unlocked tracks left to close the gap. */
  function rippleDelete() {
    const c = selectedClip();
    if (!c) return;
    if (isLocked(c.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const end = c.start + c.dur;
    const gap = c.dur;
    clips = clips.filter((k) => k.id !== c.id);
    disposePlayer(c.id);
    for (const k of clips) if (!isLocked(k.track) && k.start >= end - 0.001) k.start = Math.max(0, k.start - gap);
    selectedId = null;
    commit();
  }

  function duplicateSelected() {
    const c = selectedClip();
    if (!c) return;
    if (isLocked(c.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const copy = { ...deepCopy(c), id: uid(), start: c.start + c.dur };
    clips.push(copy);
    selectedId = copy.id;
    commit();
  }

  $('#v-split').onclick = splitAtPlayhead;
  $('#v-del').onclick = deleteSelected;

  // ------------------------------------------------------------------ geri al / ileri al

  const emptyHistory = () => JSON.stringify({ clips: [], sel: null, tracks: { t: {}, v2: {}, v1: {}, a: {} }, markers: [] });
  let history = [emptyHistory()];
  let historyIndex = 0;

  /**
   * Canlı proje (src/live.js) için: kullanıcı değişikliği bildirimi. API'den gelen commit'ler de yayınlanır;
   * yönetici kendi uygulaması sürerken bunları yok sayar.
   */
  function notifyChange() {
    bus.dispatchEvent(new CustomEvent('mode-change', { detail: { mode: 'mvid' } }));
  }

  // A panel field edited live ('input') whose 'change' (the commit) has not come yet.
  let panelDirty = false;

  function pushHistory() {
    panelDirty = false;
    history = history.slice(0, historyIndex + 1);
    history.push(JSON.stringify({ clips, sel: selectedId, tracks: trackState, markers }));
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    purgeTrash();
    prunePlayers();
    pruneDrawers();
  }

  function commit() {
    pushHistory();
    refreshAll();
    notifyChange();
  }

  /**
   * The props panel is about to be rebuilt while a field edit is uncommitted (e.g. typing, then clicking the timeline:
   * the field is removed before its 'change' fires). Record it in the history and live project now.
   */
  function flushPanelEdit() {
    if (!panelDirty) return;
    pushHistory();
    notifyChange();
  }

  /** Releases media elements (decoders, buffers) of clips no longer on the timeline; getPlayer recreates them if an undo brings one back. */
  function prunePlayers() {
    if (!players.size) return;
    const ids = new Set(clips.map((c) => c.id));
    for (const id of [...players.keys()]) if (!ids.has(id)) disposePlayer(id);
  }

  /** Terminates the drawing workers of draw clips no longer on the timeline (an undo recreates them lazily). */
  function pruneDrawers() {
    const ids = new Set(clips.filter((c) => c.kind === 'draw').map((c) => c.id));
    for (const id of drawer.ids()) if (!ids.has(id)) drawer.dispose(id);
    for (const id of [...drawDrafts.keys()]) if (!ids.has(id)) drawDrafts.delete(id);
  }

  /** Geçmişte ve zaman çizelgesinde artık geçmeyen kaldırılmış medyayı serbest bırakır. */
  function purgeTrash() {
    if (!trashMedia.length) return;
    trashMedia = trashMedia.filter((m) => {
      const tag = midTag(m.id);
      if (clips.some((c) => c.mid === m.id) || history.some((h) => h.includes(tag))) return true;
      URL.revokeObjectURL(m.url);
      return false;
    });
  }

  /** Geri alınan klibin kullandığı kaldırılmış medya kütüphaneye döner. */
  function reviveMedia() {
    if (!trashMedia.length) return;
    const used = new Set(clips.map((c) => c.mid));
    const back = trashMedia.filter((m) => used.has(m.id));
    if (!back.length) return;
    trashMedia = trashMedia.filter((m) => !used.has(m.id));
    mediaItems.push(...back);
    renderMediaList();
  }

  function restore(snapshot) {
    panelDirty = false;
    const s = JSON.parse(snapshot);
    clips = s.clips;
    selectedId = s.sel;
    trackState = s.tracks || { t: {}, v2: {}, v1: {}, a: {} };
    markers = s.markers || [];
    reviveMedia();
    prunePlayers();
    pruneDrawers();
    refreshAll();
    notifyChange();
  }

  const undo = () => {
    if (historyIndex > 0) restore(history[--historyIndex]);
  };
  const redo = () => {
    if (historyIndex < history.length - 1) restore(history[++historyIndex]);
  };
  $('#v-undo').onclick = undo;
  $('#v-redo').onclick = redo;

  function refreshAll() {
    renderTimeline();
    renderProps();
    syncMedia();
    requestDraw();
    updateStatus();
  }

  // ------------------------------------------------------------------ medya öğeleri ve ses senkronu

  /** Klibin çizim/oynatma kaynağı: resimse <img>, değilse klibe özel <video>/<audio>. */
  function getPlayer(clip) {
    const m = mediaOf(clip);
    if (!m) return null;
    if (m.type === 'image') return m.img;
    let el = players.get(clip.id);
    if (!el || el._mid !== m.id) {
      if (el) disposePlayer(clip.id);
      el = document.createElement(m.type === 'video' ? 'video' : 'audio');
      el._mid = m.id;
      el.preload = 'auto';
      el.playsInline = true;
      el.src = m.url;
      el.addEventListener('seeked', () => {
        if (!playing) requestDraw();
      });
      el.addEventListener('loadeddata', requestDraw);
      players.set(clip.id, el);
      connectPlayer(el, clip.id);
    }
    return el;
  }

  /** Previous visual clip on the same track that ends where c starts (gap ≤ 0.1 s): drawn under c's transition. */
  function prevOnTrack(c) {
    let best = null;
    for (const k of clips) {
      if (k === c || k.track !== c.track || k.kind === 'audio' || k.kind === 'text') continue;
      const end = k.start + k.dur;
      if (k.start >= c.start || end > c.start + 0.05 || c.start - end > 0.1) continue;
      if (!best || end > best.start + best.dur) best = k;
    }
    return best;
  }

  /**
   * Clips shown past their end under the next clip's transition (crossfade, slide, zoom, wipe, blur)
   * at time tm: Map clipId -> { p (transition progress 0..1), over (incoming clip) }.
   */
  function transitionTails(tm) {
    const out = new Map();
    for (const c of clips) {
      if (!FX.usesUnderlay(c.transition)) continue;
      const tr = transitionAt(c, tm);
      if (!tr) continue;
      const prev = prevOnTrack(c);
      if (prev && prev.start + prev.dur <= tm + 1e-6) out.set(prev.id, { p: tr.p, over: c });
    }
    return out;
  }

  /** Medya öğelerini oynatma çizgisine göre oynatır/durdurur/konumlar, ses düzeyini ayarlar. */
  function syncMedia() {
    const used = new Set();
    const tails = transitionTails(time);
    const fwd = playing && playRate > 0; // J (reverse) shuttle: media paused, frames are sought
    for (const c of clips) {
      if (!isTimed(c)) continue;
      const el = getPlayer(c);
      if (!el) continue;
      used.add(c.id);
      const tail = tails.get(c.id);
      if (isActiveAt(c, time) || tail) {
        const m = mediaOf(c);
        const spd = speedOf(c);
        let srcTime = c.inP + (time - c.start) * spd;
        // Past the end of the source (only possible in a transition tail): hold the last frame.
        const hold = !!m && srcTime > m.dur - 0.04;
        if (hold) srcTime = Math.max(c.inP, m.dur - 0.04);
        let level = c.vol * (tail ? endFade(c) * (1 - tail.p) : fadeAt(c, time));
        if (isMuted(c.track) || hold) level = 0;
        const gain = clipGains.get(c.id);
        if (gain) {
          gain.gain.value = level;
          el.volume = 1;
        } else el.volume = clamp(level, 0, 1);
        el.muted = false;
        const rate = clamp(spd * (fwd ? playRate : 1), 0.0625, 16);
        if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
        const tol = Math.max(1, rate);
        if (fwd && !hold) {
          if (el.paused) {
            // Önceden doğru yere sarılmışsa yeniden arama yapma: arama sürerken kare boş kalır (kesmede siyah kare).
            if (Math.abs(el.currentTime - srcTime) > 0.15 * tol) el.currentTime = srcTime;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - srcTime) > 0.3 * tol) el.currentTime = srcTime;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - srcTime) > 0.03) el.currentTime = srcTime;
        }
      } else {
        if (!el.paused) el.pause();
        // Yaklaşan klibi önceden başına sar (geçişte takılmasın).
        if (c.start > time && c.start - time < 1.2 && el.paused && Math.abs(el.currentTime - c.inP) > 0.1) el.currentTime = c.inP;
      }
    }
    for (const [id, el] of players) if (!used.has(id) && !el.paused) el.pause();
  }

  // ------------------------------------------------------------------ çizim

  let drawPending = false;
  /** Tek kare çizimi ister (aynı karede birden çok istek birleşir). Oynatırken döngü zaten çizer. */
  function requestDraw() {
    if (drawPending || playing) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      draw();
    });
  }

  /** Preview scale (canvas px per project px). w/h: exact canvas size (export presets). */
  function setQuality(q, w, h) {
    quality = q;
    canvas.width = w || Math.round(proj.w * quality);
    canvas.height = h || Math.round(proj.h * quality);
    draw();
  }

  function draw() {
    const W = proj.w;
    const H = proj.h;
    ctx.setTransform(quality, 0, 0, quality, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = proj.bg;
    ctx.fillRect(0, 0, W, H);
    const tails = transitionTails(time);
    for (const track of ['v1', 'v2']) {
      if (isHidden(track)) continue;
      const onTrack = clips.filter((k) => k.track === track && (isActiveAt(k, time) || tails.has(k.id))).sort((a, b) => a.start - b.start);
      for (const c of onTrack) {
        const tail = tails.get(c.id);
        if (drawVisual(c, W, H, { tail })) continue;
        if (tail) continue;
        // Yeni klibin karesi henüz hazır değil (arama/çözme sürüyor): aynı kanaldaki önceki klibin son karesini tut.
        const prev = clips
          .filter((k) => k.track === track && k !== c && k.kind === 'video' && k.start + k.dur <= c.start + 0.05 && c.start - (k.start + k.dur) < 0.5)
          .sort((a, b) => b.start - a.start)[0];
        if (prev && !tails.has(prev.id)) drawVisual(prev, W, H, { alphaFrom: c });
      }
    }
    if (!isHidden('t')) for (const c of clips.filter((k) => k.track === 't' && isActiveAt(k, time)).sort((a, b) => a.start - b.start)) drawText(c, W, H);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    if (!exactDraw()) drawErrorBadges(W, H);
    if (!clips.length) {
      ctx.fillStyle = '#ffffff55';
      ctx.font = `600 ${Math.round(Math.min(W, H) * 0.04)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t('video.emptyHint', 'Add media and put it on the timeline with "+"'), W / 2, H / 2);
    }
  }

  /**
   * Draws a visual clip (video / image / shape) with motion, rotation, crop, effects and its start transition.
   * Returns false when there is no frame to draw yet.
   * o.alphaFrom: take opacity/fades from this clip (frame hold); o.tail: drawn under the next clip's transition.
   */
  function drawVisual(c, W, H, o = {}) {
    const isShape = c.kind === 'shape';
    const isDraw = c.kind === 'draw';
    let src = null;
    let sw = 0;
    let sh = 0;
    if (isDraw) {
      src = drawSource(c, o.tail ? c.dur : time - c.start);
      if (!src) return true; // no frame yet: draw nothing (never hold another clip's frame for an overlay)
    } else if (!isShape) {
      src = getPlayer(c);
      if (!src || (src.tagName === 'VIDEO' && src.readyState < 2)) return false;
      sw = src.videoWidth || src.naturalWidth;
      sh = src.videoHeight || src.naturalHeight;
      if (!sw || !sh) return false;
    }
    const af = o.alphaFrom || c;
    let alpha = o.tail ? c.opacity * endFade(c) : af.opacity * fadeAt(af, time);
    const u = clamp((time - c.start) / c.dur, 0, 1);
    const mo = FX.motionAt(c.motion, u);
    let x = (c.x + mo.x) * W;
    let y = (c.y + mo.y) * H;
    let scale = c.scale * mo.scale;
    const rot = (c.rotation || 0) + mo.rotation;
    let extraBlur = 0;
    let wipe = -1;
    const tr = o.tail || o.alphaFrom ? null : transitionAt(c, time);
    if (tr) {
      const e = tr.e;
      if (tr.type === 'fade' || tr.type === 'crossfade') alpha *= e;
      else if (tr.type === 'slide-left') x += (1 - e) * W;
      else if (tr.type === 'slide-up') y += (1 - e) * H;
      else if (tr.type === 'zoom') {
        scale *= 0.6 + 0.4 * e;
        alpha *= e;
      } else if (tr.type === 'wipe') wipe = e;
      else if (tr.type === 'blur') {
        extraBlur = (1 - e) * Math.min(W, H) * 0.04 * quality;
        alpha *= Math.min(1, e * 1.5);
      }
    }
    if (alpha <= 0.002 || wipe === 0) return true;
    ctx.save();
    if (wipe > 0) {
      ctx.beginPath();
      ctx.rect(0, 0, W * wipe, H);
      ctx.clip();
    }
    ctx.translate(W / 2 + x, H / 2 + y);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.globalAlpha = clamp(alpha, 0, 1);
    const filter = FX.filterOf(c.effects, (Math.min(W, H) / 1080) * quality, extraBlur);
    if (filter !== 'none') ctx.filter = filter;
    if (isShape) {
      const bw = c.w * W * scale;
      const bh = c.h * H * scale;
      FX.drawShape(ctx, c.shape, c.color, bw, bh, c.radius, c.shape === 'bar' ? u : 1);
    } else if (isDraw) {
      // The bitmap covers the whole frame (rendered at preview scale); scale/rotation/motion act on the layer.
      const w = W * scale;
      const h = H * scale;
      ctx.drawImage(src, -w / 2, -h / 2, w, h);
      if (c.effects?.vignette) {
        ctx.filter = 'none';
        FX.drawVignette(ctx, c.effects.vignette, -w / 2, -h / 2, w, h);
      }
    } else {
      const k = (c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)) * scale;
      const w = sw * k;
      const h = sh * k;
      const cr = c.crop;
      const l = cr?.l || 0;
      const tp = cr?.t || 0;
      const r = cr?.r || 0;
      const b = cr?.b || 0;
      const rx = -w / 2 + w * l;
      const ry = -h / 2 + h * tp;
      const rw = w * (1 - l - r);
      const rh = h * (1 - tp - b);
      if (rw > 0.5 && rh > 0.5) {
        if (cr) ctx.drawImage(src, sw * l, sh * tp, sw * (1 - l - r), sh * (1 - tp - b), rx, ry, rw, rh);
        else ctx.drawImage(src, rx, ry, rw, rh);
        if (c.effects?.vignette) {
          ctx.filter = 'none';
          FX.drawVignette(ctx, c.effects.vignette, rx, ry, rw, rh);
        }
      }
    }
    ctx.restore();
    return true;
  }

  // ---- draw clips: frame requests (preview: cached frame + one ahead; export / PNG: the exact frame)
  let frameExporting = false; // exportFrame (PNG) is rendering: exact frames, no error badges
  const exactDraw = () => !!exp || frameExporting;

  /** Clip-local frame index on the project fps grid (preview and export draw the same frames). */
  function drawFrameIndex(c, local) {
    const fps = proj.fps || 30;
    const last = Math.max(0, Math.floor(c.dur * fps + 1e-6));
    return clamp(Math.round(clamp(+local || 0, 0, c.dur) * fps), 0, last);
  }

  /** Bitmap to draw for a draw clip at clip-local time `local` (requests frames as needed); null = nothing yet. */
  function drawSource(c, local) {
    const fps = proj.fps || 30;
    const code = c.code || '';
    const last = Math.max(0, Math.floor(c.dur * fps + 1e-6));
    const n = drawFrameIndex(c, local);
    const want = (i) => drawer.frame(c.id, code, i / fps, proj.w, proj.h, quality, c.dur).catch(() => {});
    if (exactDraw()) {
      if (!drawer.has(c.id, code, n / fps, proj.w, proj.h, quality, c.dur)) {
        want(n);
        return null;
      }
      const bmp = drawer.cached(c.id);
      if (exp && n < last) want(n + 1); // render the next frame while this one is recorded
      return bmp;
    }
    if (!active) return drawer.cached(c.id); // no workers while the mode is inactive
    if (!drawer.has(c.id, code, n / fps, proj.w, proj.h, quality, c.dur)) {
      const dir = playing ? (playRate < 0 ? -1 : 1) : 0;
      want(clamp(n + dir, 0, last));
    }
    // A stale frame of older code is hidden once the current code has failed.
    if (drawer.error(c.id) && drawer.meta(c.id)?.hash !== hashCode(code)) return null;
    return drawer.cached(c.id);
  }

  /** Export / PNG: a promise that settles when the exact frames of the draw clips visible at tm are ready (null: all ready). */
  function drawWaits(tm) {
    const fps = proj.fps || 30;
    const tails = transitionTails(tm);
    const ps = [];
    for (const c of clips) {
      if (c.kind !== 'draw' || isHidden(c.track)) continue;
      const tail = tails.has(c.id);
      if (!tail && !isActiveAt(c, tm)) continue;
      const lt = drawFrameIndex(c, tail ? c.dur : tm - c.start) / fps;
      if (drawer.has(c.id, c.code || '', lt, proj.w, proj.h, quality, c.dur)) continue;
      ps.push(drawer.frame(c.id, c.code || '', lt, proj.w, proj.h, quality, c.dur).catch(() => {}));
    }
    return ps.length ? Promise.race([Promise.all(ps), sleep(3000)]) : null;
  }

  /** Preview only: a red note on the frame while a visible draw clip has an error. */
  function drawErrorBadges(W, H) {
    const bad = clips.filter((c) => c.kind === 'draw' && !isHidden(c.track) && isActiveAt(c, time) && drawer.error(c.id));
    if (!bad.length) return;
    const size = Math.round(Math.min(W, H) * 0.028);
    const msg = '⚠ ' + t('video.draw.errBadge', 'Drawing error: see the clip panel');
    ctx.save();
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(msg).width + size;
    ctx.fillStyle = '#b42318e6';
    ctx.fillRect(size * 0.6, size * 0.8, w, size * 1.5);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(msg, size * 1.1, size * 1.05);
    ctx.restore();
  }

  function drawText(c, W, H) {
    const st = textStyle(c);
    const lines = String(c.text || '').split('\n');
    const size = (c.size / 100) * Math.min(W, H);
    const lineH = size * st.lineHeight;
    const cx = W / 2 + c.x * W;
    const cy = H / 2 + c.y * H;
    const age = time - c.start;

    let pop = 1;
    let offY = 0;
    let animAlpha = 1;
    if (c.anim === 'pop') {
      const k = clamp(age / 0.25, 0, 1);
      pop = 0.6 + 0.4 * (1 - (1 - k) ** 3) + Math.sin(k * Math.PI) * 0.08;
    } else if (c.anim === 'slide') {
      offY = (1 - (1 - clamp(age / 0.35, 0, 1)) ** 3 - 1) * -size * 1.2;
      animAlpha = clamp(age / 0.2, 0, 1);
    } else if (c.anim === 'bounce') {
      offY = -(1 - FX.easeOutBounce(clamp(age / 0.7, 0, 1))) * size * 2.2;
      animAlpha = clamp(age / 0.12, 0, 1);
    } else if (c.anim === 'fade-up') {
      const k = clamp(age / 0.45, 0, 1);
      offY = (1 - k) ** 3 * size * 0.9;
      animAlpha = k;
    } else if (c.anim === 'zoom-in') {
      const k = clamp(age / 0.35, 0, 1);
      pop = 1 + (1 - k) ** 3 * 1.4;
      animAlpha = k;
    } else if (c.anim === 'wave') animAlpha = clamp(age / 0.25, 0, 1);

    ctx.save();
    ctx.globalAlpha = c.opacity * fadeAt(c, time) * animAlpha;
    ctx.translate(cx, cy + offY);
    if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
    ctx.scale(pop * c.scale, pop * c.scale);
    ctx.font = `${st.italic ? 'italic ' : ''}${st.weight} ${size}px ${FX.fontCss(st.font)}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${st.letterSpacing * size}px`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const widths = lines.map((l) => ctx.measureText(l).width);
    const maxW = Math.max(0, ...widths);
    const top = -((lines.length - 1) * lineH) / 2;
    // Lines are laid out left-aligned from a computed x so alignment and per-letter animations agree.
    const x0Of = (i) => (st.align === 'left' ? -maxW / 2 : st.align === 'right' ? maxW / 2 - widths[i] : -widths[i] / 2);

    if (c.bg) {
      // Kutu: tam metne göre (harf harf yazılırken de sabit kalır).
      const pad = size * st.boxPad;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * st.boxOpacity;
      ctx.fillStyle = c.bgColor;
      ctx.beginPath();
      ctx.roundRect(-maxW / 2 - pad, top - lineH / 2 - pad * 0.5, maxW + pad * 2, lines.length * lineH + pad, size * st.boxRadius);
      ctx.fill();
      ctx.globalAlpha = a;
    }

    // Shadow parameters are in canvas pixels (not affected by the transform).
    const sk = quality * pop * c.scale;
    const shadow = (on) => {
      ctx.shadowColor = on ? st.shadowColor : 'transparent';
      ctx.shadowBlur = on ? st.shadowBlur * size * sk : 0;
      ctx.shadowOffsetX = ctx.shadowOffsetY = on ? st.shadowDist * size * sk * 0.7071 : 0;
    };
    const stroked = c.stroke && st.strokeWidth > 0;
    /** Two passes (all outlines, then all fills) so outlines never cover neighbouring letters. */
    const paintRuns = (runs) => {
      if (stroked) {
        shadow(st.shadow);
        ctx.lineJoin = 'round';
        ctx.lineWidth = size * st.strokeWidth;
        ctx.strokeStyle = st.strokeColor;
        for (const r of runs) ctx.strokeText(r.text, r.x, r.y);
      }
      shadow(st.shadow && !stroked);
      ctx.fillStyle = c.color;
      for (const r of runs) ctx.fillText(r.text, r.x, r.y);
      shadow(false);
    };

    if (c.anim === 'type') drawTyped(c, st, lines, widths, x0Of, size, lineH, top, age, paintRuns);
    else if (c.anim === 'wave') {
      const runs = [];
      let n = 0;
      lines.forEach((line, i) => {
        let x = x0Of(i);
        for (const ch of Array.from(line)) {
          runs.push({ text: ch, x, y: top + i * lineH + Math.sin(age * 5 - n * 0.45) * size * 0.12 });
          x += ctx.measureText(ch).width;
          n++;
        }
      });
      paintRuns(runs);
    } else paintRuns(lines.map((line, i) => ({ text: line, x: x0Of(i), y: top + i * lineH })));
    ctx.restore();
  }

  /**
   * "Harf harf": harfler saniyede TYPE_CPS hızla belirir (satır sonu da bir harf sayılır),
   * yazılan yerde imleç çubuğu durur; yazı bitince imleç iki kez yanıp söner ve kaybolur.
   * Satırlar son konumlarından yazılır ki yazarken metin kaymasın.
   */
  function drawTyped(c, st, lines, widths, x0Of, size, lineH, top, age, paintRuns) {
    const charLines = lines.map((l) => Array.from(l));
    const totalChars = charLines.reduce((n, l) => n + l.length, 0) + lines.length - 1;
    let budget = Math.floor(Math.max(0, age) * TYPE_CPS);
    const typing = budget < totalChars;
    let cursor = null;
    const runs = [];
    charLines.forEach((chars, i) => {
      const x0 = x0Of(i);
      const y = top + i * lineH;
      const shown = chars.slice(0, clamp(budget, 0, chars.length)).join('');
      if (shown) runs.push({ text: shown, x: x0, y });
      if (!cursor && budget >= 0 && budget <= chars.length) cursor = { x: x0 + ctx.measureText(shown).width, y };
      if (!typing && i === charLines.length - 1) cursor = { x: x0 + widths[i], y };
      budget -= chars.length + 1;
    });
    paintRuns(runs);
    if (!cursor) return;
    const sinceDone = age - totalChars / TYPE_CPS;
    const visible = typing || (sinceDone < 1.2 && Math.floor(sinceDone * 2.5) % 2 === 0);
    if (!visible) return;
    const w = size * 0.07;
    const h = size * 0.9;
    const x = cursor.x + size * 0.05;
    if (c.stroke && st.strokeWidth > 0) {
      ctx.lineWidth = size * Math.min(0.06, st.strokeWidth);
      ctx.strokeStyle = st.strokeColor;
      ctx.strokeRect(x, cursor.y - h / 2, w, h);
    }
    ctx.fillStyle = c.color;
    ctx.fillRect(x, cursor.y - h / 2, w, h);
  }

  // ------------------------------------------------------------------ oynatma döngüsü

  /**
   * Bir sonraki adımı planlar. Dışa aktarırken rAF'in yanında zamanlayıcı da kurulur:
   * gizli/küçültülmüş pencerede rAF durabilir; hangisi önce gelirse o çalışır.
   */
  function scheduleTick() {
    rafId = requestAnimationFrame((now) => {
      clearTimeout(timerId);
      timerId = 0;
      rafId = 0;
      tick(now);
    });
    if (exp) {
      timerId = setTimeout(() => {
        cancelAnimationFrame(rafId);
        rafId = 0;
        timerId = 0;
        tick(performance.now());
      }, Math.max(4, Math.floor(1000 / proj.fps / 2)));
    }
  }

  function stopLoop() {
    cancelAnimationFrame(rafId);
    clearTimeout(timerId);
    rafId = 0;
    timerId = 0;
  }

  function tick(now) {
    if (!playing) return;
    if (exp) {
      // Kayıtta çizimi proje fps'iyle sınırla (gizli pencerede rAF 150+ fps dönebiliyor).
      const interval = 1000 / proj.fps;
      if (!exp.cancelled && now - lastDraw < interval - 2) return scheduleTick();
      time += Math.min(1, (now - lastTick) / 1000);
    } else {
      time += Math.min(0.1, (now - lastTick) / 1000) * playRate;
    }
    lastTick = now;
    if (!exp && playRate < 0 && time <= 0) {
      time = 0;
      draw();
      return stopPlayback();
    }

    const total = totalDuration();
    if (exp && (exp.cancelled || time >= total)) {
      // draw() yok: t = total anında hiçbir klip etkin değil, boş (arka plan renginde) kare
      // çizilir ve kaydın sonuna eklenirdi. Tuvalde son içerikli kare kalır.
      time = Math.min(time, total);
      updatePlayhead();
      return finishExport();
    }
    if (time >= total) {
      time = total;
      draw();
      return stopPlayback();
    }
    syncMedia();
    if (exp) {
      // Draw clips: record their exact frame; if a worker is still rendering it, wait (time keeps real time).
      const wait = drawWaits(time);
      if (!wait) return exportStep(now, total);
      const state = exp;
      wait.then(() => {
        if (exp === state && playing && !state.stopping) exportStep(performance.now(), total);
      });
      return;
    }
    if (!settings.eco || now - lastDraw >= ECO_FRAME_MS) {
      draw();
      lastDraw = now;
    }
    updatePlayhead();
    scheduleTick();
  }

  /** One recorded frame during export. */
  function exportStep(now, total) {
    const interval = 1000 / proj.fps;
    draw();
    lastDraw = now - lastDraw > 2 * interval ? now : lastDraw + interval;
    const p = time / total;
    const text = t('video.export.progress', '{time} / {total} · do not close the window', { time: fmtTime(time), total: fmtTime(total) });
    busy.progress(p, text);
    exp.onProgress?.(p, text);
    updatePlayhead();
    scheduleTick();
  }

  /** rate: 1 = normal; J/K/L shuttle uses ±1, ±2, ±4, ±8 (negative = reverse by seeking frames). */
  function play(rate = 1) {
    if (exp) return;
    rate = clamp(+rate || 1, -SHUTTLE_MAX, SHUTTLE_MAX);
    if (playing) {
      playRate = rate;
      lastTick = performance.now();
      syncMedia();
      return;
    }
    if (!clips.length) return toast(t('video.addFirst', 'Add something to the timeline first'));
    ensureAudio();
    playRate = rate;
    if (rate > 0 && time >= totalDuration() - 0.02) time = 0;
    if (rate < 0 && time <= 0.02) time = totalDuration();
    playing = true;
    playBtn.textContent = t('video.stop', 'Stop');
    lastTick = performance.now();
    lastDraw = 0;
    syncMedia();
    scheduleTick();
  }

  function stopPlayback() {
    if (exp) return;
    playing = false;
    playRate = 1;
    stopLoop();
    playBtn.textContent = t('video.play', 'Play');
    syncMedia();
    idleAudio();
    requestDraw();
    updatePlayhead();
  }

  const togglePlay = () => (playing ? stopPlayback() : play());

  /** J/K/L shuttle: L forward, J reverse, pressing again doubles the speed (up to 8×); K stops. */
  function shuttle(dir) {
    if (dir === 0) return stopPlayback();
    let rate = dir;
    if (playing && Math.sign(playRate) === dir) rate = clamp(playRate * 2, -SHUTTLE_MAX, SHUTTLE_MAX);
    play(rate);
    if (playing) toast((rate < 0 ? '◀ ' : '▶ ') + t('video.shuttle.rate', '{r}× speed', { r: Math.abs(rate) }), 900);
  }

  function seek(tm) {
    if (exp) return;
    time = clamp(+tm || 0, 0, Math.max(totalDuration(), 0));
    syncMedia();
    requestDraw();
    updatePlayhead();
  }

  playBtn.onclick = togglePlay;
  $('#v-start').onclick = () => seek(0);

  // ------------------------------------------------------------------ dışa aktarma

  /**
   * Zaman çizelgesini gerçek zamanlı oynatıp canvas + ses miksini MediaRecorder ile kaydeder.
   * Blob döner (kaydetmez); iptal edilirse ya da desteklenmiyorsa null.
   */
  /**
   * opts.scale: output size relative to the project (e.g. 0.667 = 1920×1080 project → 1280×720 file).
   * opts.quality: 'low' | 'medium' | 'high' (bitrate from output size and fps); opts.bitrate: explicit bits/s.
   * Without these the original behaviour is kept (project size, 10 / 6 Mbit/s).
   */
  async function exportVideo({ onProgress, scale, quality: q, bitrate } = {}) {
    if (exp) throw new Error(t('video.export.busy', 'An export is already running'));
    if (!clips.length) {
      toast(t('video.timelineEmpty', 'The timeline is empty'));
      return null;
    }
    const mime = pickMime(EXPORT_MIMES);
    if (mime == null || !canvas.captureStream) {
      toast(t('video.export.unsupported', 'This browser does not support video export. Use Chrome or Edge.'));
      return null;
    }
    if (playing) stopPlayback();
    ensureAudio();
    const prevQuality = quality;
    const k = Number.isFinite(+scale) && +scale > 0 ? clamp(+scale, 0.1, 4) : 1;
    const even = (v) => Math.max(16, Math.round(v / 2) * 2);
    const outW = even(proj.w * k);
    const outH = even(proj.h * k);
    setQuality(outW / proj.w, outW, outH);

    const videoTrack = canvas.captureStream(proj.fps).getVideoTracks()[0];
    const tracks = [videoTrack, ...(audioDest ? audioDest.stream.getAudioTracks() : [])].filter(Boolean);
    const big = outW * outH >= 1.9e6;
    const bps = +bitrate > 0 ? clamp(+bitrate, 5e5, 5e7) : q ? FX.bitrateFor(outW, outH, proj.fps, q) : big ? 1e7 : 6e6;
    let rec;
    try {
      rec = new MediaRecorder(new MediaStream(tracks), {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: bps,
        audioBitsPerSecond: 160000,
      });
    } catch (e) {
      videoTrack?.stop();
      setQuality(prevQuality);
      toast(t('video.export.recorderFailed', 'Could not start the recorder: {error}', { error: e.message }));
      return null;
    }

    return new Promise((resolve) => {
      const chunks = [];
      const state = { rec, cancelled: false, started: false, stopping: false, onProgress, prevQuality };
      exp = state;

      const done = (blob) => {
        videoTrack?.stop(); // ses izi ortak hedeften geliyor: onu durdurma
        busy.hide();
        exp = null;
        playing = false;
        stopLoop();
        playBtn.textContent = t('video.play', 'Play');
        setQuality(state.prevQuality);
        syncMedia();
        idleAudio();
        if (!active) drawer.disposeAll(); // export ran with the mode in the background
        updatePlayhead();
        updateStatus();
        resolve(blob);
      };

      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onerror = (e) => {
        console.warn('MediaRecorder', e.error || e);
        state.cancelled = true;
      };
      rec.onstop = () => {
        if (state.cancelled) {
          toast(t('video.export.cancelled', 'Export cancelled'));
          return done(null);
        }
        onProgress?.(1, t('video.export.done', 'Done'));
        done(new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' }));
      };
      state.finish = done;

      busy.show(t('video.export.exporting', 'Exporting video'), () => {
        state.cancelled = true;
        if (state.started) finishExport();
      });
      time = 0;
      syncMedia();
      draw();
      updatePlayhead();

      // Medya öğelerinin başa sarması için kısa bekleme (orijinal davranış).
      sleep(500).then(() => {
        if (state.cancelled) {
          toast(t('video.export.cancelled', 'Export cancelled'));
          return done(null);
        }
        draw();
        rec.start(500);
        state.started = true;
        playing = true;
        playRate = 1;
        playBtn.textContent = t('video.stop', 'Stop');
        lastTick = performance.now();
        lastDraw = 0;
        syncMedia();
        scheduleTick();
      });
    });
  }

  /** Kaydı bitirir (sona gelince ya da iptalde); kaydediciyi biraz gecikmeyle durdurur. */
  function finishExport() {
    const state = exp;
    if (!state || state.stopping) return;
    state.stopping = true;
    playing = false;
    stopLoop();
    syncMedia();
    setTimeout(() => {
      if (state.rec.state !== 'inactive') state.rec.stop();
      else state.finish(null);
    }, 200);
  }

  /** Saves a finished export blob with the "Save as" dialog (ffmpeg turns it into MP4 when available). */
  async function saveExport(blob) {
    try {
      toast(t('video.export.saving', 'Video ready, saving…'));
      const path = await platform.saveVideoAs(blob, 'video.mp4');
      if (path) toast(t('video.export.saved', '{name} saved', { name: baseName(path) }), 4000);
    } catch (e) {
      console.error(e);
      toast(t('video.export.saveFailed', 'Could not save: {error}', { error: e.message || e }), 5000);
    }
  }

  /** Current preview frame as a PNG blob, rendered at project size × scale. */
  async function exportFrame({ scale = 1 } = {}) {
    if (exp) throw new Error(t('video.export.busy', 'An export is already running'));
    const prev = quality;
    const k = clamp(+scale || 1, 0.1, 4);
    const even = (v) => Math.max(16, Math.round(v / 2) * 2);
    frameExporting = true;
    try {
      setQuality(k, even(proj.w * k), even(proj.h * k));
      const wait = drawWaits(time); // draw clips: the exact frame at this size
      if (wait) {
        await wait;
        draw();
      }
      return await new Promise((res) => canvas.toBlob(res, 'image/png'));
    } finally {
      frameExporting = false;
      setQuality(prev);
    }
  }

  // ---- export dialog: format presets, frame rate, quality, current frame as PNG
  let exportDlg = null;
  const exportPrefs = () => ({ preset: 'project', quality: 'medium', ...store.get('vexp', {}) });

  function presetLabel(id) {
    if (id === 'vertical') return t('video.export.preset.vertical', 'TikTok / Reels / Shorts · 1080×1920');
    if (id === 'youtube') return t('video.export.preset.youtube', 'YouTube 1080p · 1920×1080');
    if (id === 'light') return t('video.export.preset.light', '720p light · 1280×720');
    if (id === 'square') return t('video.export.preset.square', 'Square · 1080×1080');
    return t('video.export.preset.project', 'Project size · {w}×{h}', { w: proj.w, h: proj.h });
  }

  /** Same aspect ratio → the project is rendered scaled; another aspect → the project format changes. */
  function exportPlan(presetId) {
    const p = FX.EXPORT_PRESETS.find((x) => x.id === presetId) || FX.EXPORT_PRESETS[0];
    if (!p.res) return { res: null, scale: 1, w: proj.w, h: proj.h };
    const [w, h] = p.res.split('x').map(Number);
    if (Math.abs(w / h - proj.w / proj.h) < 0.01) return { res: null, scale: w / proj.w, w, h };
    return { res: p.res, scale: 1, w, h };
  }

  function buildExportDialog() {
    const el = document.createElement('div');
    el.className = 'ovl vx-ovl';
    el.hidden = true;
    el.innerHTML = `<div class="card vx-card" role="dialog" aria-modal="true" aria-labelledby="vx-title">
      <h2 id="vx-title">${esc(t('video.export.title', 'Export'))}</h2>
      <div class="row"><span>${esc(t('video.export.format', 'Format'))}</span><select id="vx-preset"></select></div>
      <div class="row"><span>${esc(t('video.export.fps', 'Frame rate'))}</span><select id="vx-fps">
        <option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></div>
      <div class="row"><span>${esc(t('video.export.quality', 'Quality'))}</span><select id="vx-q">
        <option value="low">${esc(t('video.export.q.low', 'Low · small file'))}</option>
        <option value="medium">${esc(t('video.export.q.medium', 'Medium · recommended'))}</option>
        <option value="high">${esc(t('video.export.q.high', 'High · large file'))}</option></select></div>
      <p class="vx-info" id="vx-info"></p>
      <div class="vx-btns">
        <button class="pri" data-x="video">${esc(t('video.export.video', 'Export video'))}</button>
        <button data-x="png" title="${esc(t('video.export.pngTitle', 'Save the frame under the playhead as a PNG image'))}">${esc(t('video.export.png', 'Current frame (PNG)'))}</button>
        <span class="spacer"></span>
        <button data-x="close">${esc(t('video.export.cancel', 'Cancel'))}</button>
      </div></div>`;
    document.body.appendChild(el);
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el) closeExportDialog();
    });
    el.addEventListener('change', updateExportInfo);
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-x]')?.dataset.x;
      if (act === 'close') closeExportDialog();
      else if (act === 'video') runDialogExport();
      else if (act === 'png') runFrameExport();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeExportDialog();
      }
    });
    return el;
  }

  const dlgVal = (id) => $('#' + id, exportDlg).value;

  function updateExportInfo() {
    const plan = exportPlan(dlgVal('vx-preset'));
    const fps = +dlgVal('vx-fps');
    const bps = FX.bitrateFor(plan.w, plan.h, fps, dlgVal('vx-q'));
    const total = totalDuration();
    const mb = ((bps + 160000) * total) / 8 / 1e6;
    let html = esc(t('video.export.info', 'Output {w}×{h} · {fps} fps · {mbps} Mbit/s · about {mb} MB', { w: plan.w, h: plan.h, fps, mbps: (bps / 1e6).toFixed(1), mb: Math.max(0.1, mb).toFixed(1) }));
    html += '<br>' + esc(t('video.export.realtime', 'Export runs in real time: this video takes about {s}.', { s: fmtTime(total).replace(/\.\d+$/, '') }));
    if (plan.res) html += `<br><b>${esc(t('video.export.reformat', 'This changes the project format to {res}; positions stay relative to the frame.', { res: plan.res.replace('x', '×') }))}</b>`;
    $('#vx-info', exportDlg).innerHTML = html;
  }

  function openExportDialog() {
    if (exp) return toast(t('video.export.busy', 'An export is already running'));
    if (!exportDlg) exportDlg = buildExportDialog();
    const prefs = exportPrefs();
    $('#vx-preset', exportDlg).innerHTML = FX.EXPORT_PRESETS.map((p) => `<option value="${p.id}">${esc(presetLabel(p.id))}</option>`).join('');
    $('#vx-preset', exportDlg).value = FX.EXPORT_PRESETS.some((p) => p.id === prefs.preset) ? prefs.preset : 'project';
    const fpsSel = $('#vx-fps', exportDlg);
    if (![...fpsSel.options].some((o) => +o.value === proj.fps)) fpsSel.add(new Option(proj.fps + ' fps', String(proj.fps)));
    fpsSel.value = String(proj.fps);
    $('#vx-q', exportDlg).value = FX.EXPORT_QUALITY[prefs.quality] ? prefs.quality : 'medium';
    updateExportInfo();
    exportDlg.hidden = false;
    $('[data-x="video"]', exportDlg).focus();
  }

  function closeExportDialog() {
    if (exportDlg) exportDlg.hidden = true;
  }
  const exportDialogOpen = () => !!exportDlg && !exportDlg.hidden;

  async function runDialogExport() {
    const presetId = dlgVal('vx-preset');
    const fps = +dlgVal('vx-fps');
    const q = dlgVal('vx-q');
    store.set('vexp', { preset: presetId, quality: q });
    const plan = exportPlan(presetId);
    closeExportDialog();
    // Same checks as exportVideo, before the project format is changed: a failed start must leave the project as it was.
    if (exp) return toast(t('video.export.busy', 'An export is already running'));
    if (!clips.length) return toast(t('video.timelineEmpty', 'The timeline is empty'));
    if (pickMime(EXPORT_MIMES) == null || !canvas.captureStream) return toast(t('video.export.unsupported', 'This browser does not support video export. Use Chrome or Edge.'));
    const prevRes = proj.res;
    const prevFps = proj.fps;
    if (plan.res && plan.res !== proj.res) {
      setResolution(plan.res);
      notifyChange();
    }
    if (fps && fps !== proj.fps) {
      setFps(fps);
      notifyChange();
    }
    // The recorder can still fail to start (exportVideo returns null without recording): undo the format change then.
    const revert = () => {
      if (exp) return;
      if (proj.res !== prevRes) {
        setResolution(prevRes);
        notifyChange();
      }
      if (proj.fps !== prevFps) {
        setFps(prevFps);
        notifyChange();
      }
    };
    let blob;
    let started = false;
    try {
      const run = exportVideo({ scale: plan.scale, quality: q });
      started = !!exp; // exportVideo sets exp synchronously once recording is set up
      blob = await run;
    } catch (e) {
      revert();
      return toast(e.message);
    }
    if (!started) return revert();
    if (blob) await saveExport(blob);
  }

  async function runFrameExport() {
    const plan = exportPlan(dlgVal('vx-preset'));
    closeExportDialog();
    try {
      // A different aspect ratio would need a project change: the frame is saved at project aspect instead.
      const blob = await exportFrame({ scale: plan.res ? 1 : plan.scale });
      if (!blob) throw new Error('PNG');
      const name = `frame-${fmtTime(time).replace(/[:.]/g, '-')}.png`;
      const path = await platform.saveAs(blob, name, t('video.export.saveFrame', 'Save frame'));
      if (path) toast(t('video.export.saved', '{name} saved', { name: baseName(path) }), 3000);
    } catch (e) {
      console.error(e);
      toast(t('video.export.saveFailed', 'Could not save: {error}', { error: e.message || e }), 5000);
    }
  }

  $('#v-export').onclick = openExportDialog;

  // ------------------------------------------------------------------ zaman çizelgesi

  function clipLabel(c, m) {
    if (c.kind === 'text') return (c.text || '').split('\n')[0] || kindLabel('text');
    if (c.kind === 'shape') return shapeName(c.shape);
    if (c.kind === 'draw') {
      // "// Title" on the first line of the code names the clip.
      const first = /^\s*\/\/\s*(.+)/.exec(c.code || '');
      return first ? first[1].trim().slice(0, 60) : kindLabel('draw');
    }
    return m ? m.name : '?';
  }
  const shapeName = (s) => (SHAPE_MENU.find(([k]) => k === s)?.[1] || (() => s))();

  function renderTimeline() {
    const viewW = tlScroll.clientWidth || 800;
    const fullW = Math.max(viewW, (totalDuration() + 15) * zoom);
    tlInner.style.width = fullW + 'px';
    for (const trackEl of $$('.track', tlInner)) {
      const track = trackEl.dataset.track;
      trackEl.classList.toggle('vt-hide', isHidden(track));
      trackEl.classList.toggle('vt-lock', isLocked(track));
      trackEl.classList.toggle('vt-mute', isMuted(track));
      trackEl.innerHTML = clips
        .filter((c) => c.track === track)
        .map((c) => {
          const m = mediaOf(c);
          const label = clipLabel(c, m);
          const thumb = (c.kind === 'video' || c.kind === 'image') && m && m.thumb ? `background-image:url(${m.thumb});` : '';
          const shapeCol = c.kind === 'shape' && /^#[0-9a-f]{3,8}$/i.test(c.color) ? `--shc:${c.color};` : '';
          const tr = c.transition ? `<div class="vtr" style="width:${Math.max(4, Math.min(c.transition.duration, c.dur) * zoom)}px" title="${esc(transitionName(c.transition.type))}"></div>` : '';
          const drawErr = c.kind === 'draw' ? drawer.error(c.id) : null;
          const badges = [drawErr ? '⚠' : '', c.effects ? 'fx' : '', speedOf(c) !== 1 ? `${speedOf(c)}×` : '', c.motion ? '↗' : ''].filter(Boolean);
          return `<div class="clip k-${c.kind} ${c.id === selectedId ? 'sel' : ''}${drawErr ? ' verr' : ''}" data-id="${c.id}"${drawErr ? ` title="${esc(drawErr)}"` : ''} style="left:${c.start * zoom}px;width:${Math.max(8, c.dur * zoom)}px;${thumb}${shapeCol}">
          ${tr}<div class="h l"></div><div class="cn">${esc(label)}</div>${badges.length ? `<div class="vbadges">${badges.map((b) => `<b>${esc(b)}</b>`).join('')}</div>` : ''}${c.kind === 'audio' ? waveSvg(c, m) : ''}<div class="h r"></div></div>`;
        })
        .join('');
    }
    // Cetvel: yakınlaştırmaya göre adım
    const step = zoom >= 160 ? 0.5 : zoom >= 70 ? 1 : zoom >= 35 ? 2 : zoom >= 15 ? 5 : zoom >= 6 ? 10 : zoom >= 3 ? 30 : 60;
    let html = '';
    for (let s = 0; s * zoom < fullW; s += step) {
      html += `<i style="left:${s * zoom}px"></i>`;
      if (Math.round(s / step) % 2 === 0) {
        const label = s >= 60 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : t('video.ruler.sec', '{n} s', { n: s });
        html += `<span style="left:${s * zoom}px">${label}</span>`;
      }
    }
    const mkTitle = t('video.marker.title', 'Marker {time} · click: jump · double-click: remove');
    html += markers.map((m) => `<b class="vmk" data-t="${m}" style="left:${m * zoom}px" title="${esc(mkTitle.replace('{time}', fmtTime(m)))}"></b>`).join('');
    $('#v-ruler').innerHTML = html;
    renderTrackHeads();
    updatePlayhead();
  }

  // ---- track headers: mute / hide / lock buttons (injected into the existing .tl-heads rows)
  const FLAG_ICONS = {
    mute: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/><path d="M11 5.5c1.2 1.2 1.2 3.8 0 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    hide: '<svg viewBox="0 0 16 16"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  };
  const flagTitle = (f) =>
    f === 'mute' ? t('video.track.mute', 'Mute track') : f === 'hide' ? t('video.track.hide', 'Hide track (not drawn in preview or export)') : t('video.track.lock', 'Lock track (no selecting, moving or deleting)');
  const headRows = $$('.tl-heads > div', section);
  headRows.forEach((row, i) => {
    const track = TRACK_ORDER[i];
    if (!track) return;
    row.classList.add('vth');
    row.dataset.track = track;
    const box = document.createElement('span');
    box.className = 'vth-btns';
    box.innerHTML = TRACK_FLAGS[track].map((f) => `<button class="vth-b" data-flag="${f}" title="${esc(flagTitle(f))}" aria-label="${esc(flagTitle(f))}">${FLAG_ICONS[f]}</button>`).join('');
    row.appendChild(box);
  });
  section.addEventListener('click', (e) => {
    const b = e.target.closest('.vth-b');
    if (!b) return;
    const track = b.closest('[data-track]')?.dataset.track;
    if (track) setTrackFlag(track, b.dataset.flag, !trackState[track]?.[b.dataset.flag]);
  });

  function renderTrackHeads() {
    for (const row of headRows) {
      const track = row.dataset.track;
      for (const b of $$('.vth-b', row)) {
        const on = !!trackState[track]?.[b.dataset.flag];
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  /** Sets one track flag (mute / hide / lock) and records it in the history. */
  function setTrackFlag(track, flag, on, silent) {
    if (!TRACK_FLAGS[track]?.includes(flag)) return false;
    const cur = { ...(trackState[track] || {}) };
    if (on) cur[flag] = true;
    else delete cur[flag];
    trackState = { ...trackState, [track]: cur };
    if (flag === 'lock' && on && selectedClip()?.track === track) selectedId = null;
    if (!silent) commit();
    return true;
  }

  function updatePlayhead() {
    $('#v-ph').style.left = time * zoom + 'px';
    $('#v-now').textContent = fmtTime(time);
    $('#v-total').textContent = fmtTime(totalDuration());
    if (playing) {
      const x = time * zoom;
      if (x > tlScroll.scrollLeft + tlScroll.clientWidth - 40) tlScroll.scrollLeft = x - 80;
      else if (playRate < 0 && x < tlScroll.scrollLeft + 40) tlScroll.scrollLeft = Math.max(0, x - tlScroll.clientWidth + 80);
    }
  }

  const xToTime = (clientX) => (clientX - tlInner.getBoundingClientRect().left) / zoom;

  /** Yapıştırma: yakın klip kenarına / 0'a / oynatma çizgisine / işaretçilere (8 piksel içinde). */
  function snap(tm, ignoreId) {
    if (!snapCheck.checked) return tm;
    let best = tm;
    let bestDist = 8 / zoom;
    const points = [0, time, ...markers];
    for (const c of clips) if (c.id !== ignoreId) points.push(c.start, c.start + c.dur);
    for (const p of points) {
      const d = Math.abs(p - tm);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  // ---- markers (M adds / removes at the playhead; click jumps; double-click removes)
  const normMarkers = (list) => [...new Set(list.filter((v) => Number.isFinite(+v) && +v >= 0).map((v) => Math.round(+v * 1000) / 1000))].sort((a, b) => a - b);
  function toggleMarker(at = time) {
    const near = markers.find((m) => Math.abs(m - at) < Math.max(0.05, 4 / zoom));
    markers = near != null ? markers.filter((m) => m !== near) : normMarkers([...markers, at]);
    commit();
  }

  let drag = null; // {mode:'seek'|'move'|'trimL'|'trimR', clip, x0, orig, changed}
  tlInner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || exp) return;
    const mk = e.target.closest('.vmk');
    if (mk) {
      if (playing) stopPlayback();
      seek(+mk.dataset.t);
      e.preventDefault();
      return;
    }
    let clipEl = e.target.closest('.clip');
    // Clips on a locked track behave like empty track space (no select / move / trim).
    if (clipEl && isLocked(clipEl.closest('.track')?.dataset.track)) clipEl = null;
    if (e.target.closest('#v-ruler') || (!clipEl && e.target.closest('.track'))) {
      if (!clipEl && selectedId) {
        selectedId = null;
        renderTimeline();
        renderProps();
      }
      if (playing) stopPlayback();
      seek(xToTime(e.clientX));
      drag = { mode: 'seek' };
      return;
    }
    if (!clipEl) return;
    const clip = clipById(clipEl.dataset.id);
    if (!clip) return;
    if (selectedId !== clip.id) {
      selectedId = clip.id;
      renderTimeline();
      renderProps();
    }
    const mode = e.target.classList.contains('l') ? 'trimL' : e.target.classList.contains('r') ? 'trimR' : 'move';
    drag = { mode, clip, x0: e.clientX, orig: { ...clip }, changed: false };
    e.preventDefault();
  });
  tlInner.addEventListener('dblclick', (e) => {
    const mk = e.target.closest('.vmk');
    if (!mk) return;
    markers = markers.filter((m) => m !== +mk.dataset.t);
    commit();
  });

  addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'seek') return seek(xToTime(e.clientX));
    const { clip, orig } = drag;
    const dt = (e.clientX - drag.x0) / zoom;
    if (Math.abs(e.clientX - drag.x0) > 2) drag.changed = true;
    if (!drag.changed) return;
    const m = mediaOf(clip);
    const spd = speedOf(clip);
    if (drag.mode === 'move') {
      // Başı ya da sonu, hangisi daha yakınsa ona yapıştır.
      let start = Math.max(0, orig.start + dt);
      const byStart = snap(start, clip.id);
      const byEnd = snap(start + orig.dur, clip.id) - orig.dur;
      start = Math.abs(byStart - start) <= Math.abs(byEnd - start) ? byStart : byEnd;
      clip.start = Math.max(0, start);
      // Kanal değiştirme (tür uyumluysa)
      const trackEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.track');
      if (trackEl && TRACK_ACCEPTS[trackEl.dataset.track].includes(clip.kind) && !isLocked(trackEl.dataset.track)) clip.track = trackEl.dataset.track;
    } else if (drag.mode === 'trimL') {
      const minStart = isTimed(clip) ? orig.start - orig.inP / spd : 0;
      const start = clamp(snap(orig.start + dt, clip.id), Math.max(0, minStart), orig.start + orig.dur - 0.1);
      clip.start = start;
      if (isTimed(clip)) clip.inP = Math.max(0, orig.inP + (start - orig.start) * spd);
      clip.dur = orig.dur - (start - orig.start);
    } else {
      const maxDur = isTimed(clip) && m ? (m.dur - orig.inP) / spd : 3600;
      const end = snap(orig.start + orig.dur + dt, clip.id);
      clip.dur = clamp(end - orig.start, 0.1, maxDur);
    }
    renderTimeline();
    syncMedia();
    requestDraw();
  });

  addEventListener('pointerup', () => {
    if (drag && drag.changed) commit();
    drag = null;
  });

  // Kütüphaneden kanala bırakma
  for (const trackEl of $$('.track', tlInner)) {
    trackEl.addEventListener('dragover', (e) => {
      const m = mediaById(draggedMediaId);
      if (m && TRACK_ACCEPTS[trackEl.dataset.track].includes(m.type) && !isLocked(trackEl.dataset.track)) {
        e.preventDefault();
        trackEl.classList.add('over');
      }
    });
    trackEl.addEventListener('dragleave', () => trackEl.classList.remove('over'));
    trackEl.addEventListener('drop', (e) => {
      trackEl.classList.remove('over');
      // Dışarıdan dosya bırakılıyorsa pencere işleyicisine bırak (kütüphaneye eklenir).
      if (!draggedMediaId && e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const m = mediaById(draggedMediaId || e.dataTransfer.getData('text/plain'));
      if (!m || !TRACK_ACCEPTS[trackEl.dataset.track].includes(m.type)) return;
      if (isLocked(trackEl.dataset.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
      const clip = makeClip(m, trackEl.dataset.track, snap(xToTime(e.clientX)));
      clips.push(clip);
      selectedId = clip.id;
      commit();
    });
  }

  // Yakınlaştırma: kaydırıcı + Ctrl+tekerlek
  // Low minimum so "fit" works for long edits too (the slider's own min in index.html is raised to this).
  const ZOOM_MIN = 1;
  zoomSlider.min = String(ZOOM_MIN);
  function setZoom(z) {
    zoom = clamp(+z || ZOOM_MIN, ZOOM_MIN, 300);
    zoomSlider.value = zoom;
    renderTimeline();
  }
  /** Shift+Z: the whole timeline fits the visible width. */
  function zoomToFit() {
    const total = Math.max(1, totalDuration());
    setZoom((Math.max(200, tlScroll.clientWidth) - 40) / total);
    tlScroll.scrollLeft = 0;
  }
  tlScroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 0.87));
    },
    { passive: false },
  );
  zoomSlider.oninput = (e) => setZoom(+e.target.value);
  const fitBtn = document.createElement('button');
  fitBtn.className = 'vfit-btn';
  fitBtn.textContent = t('video.timeline.fit', 'Fit');
  fitBtn.title = t('video.timeline.fitTitle', 'Zoom to fit the whole timeline (Shift+Z)');
  zoomSlider.after(fitBtn);
  fitBtn.onclick = zoomToFit;

  // ------------------------------------------------------------------ özellik paneli

  const fmtVal = (v) => {
    const n = +v;
    if (!Number.isFinite(n)) return '';
    return Math.abs(n) >= 100 ? String(Math.round(n)) : String(+n.toFixed(2));
  };

  function field(label, key, kind, attrs = '') {
    const v = valueOf(selectedClip(), key);
    if (kind === 'range') return `<div class="row vrow"><span>${label}</span><input type="range" data-k="${key}" ${attrs} value="${v}"><output>${fmtVal(v)}</output></div>`;
    if (kind === 'number') return `<div class="row"><span>${label}</span><input type="number" data-k="${key}" ${attrs} value="${(+v).toFixed(2)}"></div>`;
    if (kind === 'color') return `<div class="row"><span>${label}</span><input type="color" data-k="${key}" value="${esc(v)}"></div>`;
    if (kind === 'check') return `<div class="row"><span>${label}</span><label class="chk"><input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}> ${esc(t('video.props.on', 'On'))}</label></div>`;
    return '';
  }

  function choice(label, key, options) {
    const v = valueOf(selectedClip(), key);
    return `<div class="row"><span>${label}</span><select data-k="${key}">${options
      .map(([val, text]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(text)}</option>`)
      .join('')}</select></div>`;
  }

  /** Checkbox with an i18n "On" label (new fields). */
  const toggleField = (label, key) => {
    const v = valueOf(selectedClip(), key);
    return `<div class="row"><span>${label}</span><label class="chk"><input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}> ${esc(t('video.props.on', 'On'))}</label></div>`;
  };

  // Collapsible panel sections (open state kept while the app runs).
  const openSecs = new Set(['transition', 'effects']);
  const section_ = (id, title, body) => `<details class="sec vsec" data-sec="${id}" ${openSecs.has(id) ? 'open' : ''}><summary><h3>${esc(title)}</h3></summary>${body}</details>`;
  propsEl.addEventListener(
    'toggle',
    (e) => {
      const id = e.target.dataset?.sec;
      if (!id) return;
      if (e.target.open) openSecs.add(id);
      else openSecs.delete(id);
    },
    true,
  );

  const transitionName = (type) =>
    ({
      none: t('video.transition.none', 'None'),
      fade: t('video.transition.fade', 'Fade from black'),
      crossfade: t('video.transition.crossfade', 'Crossfade'),
      'slide-left': t('video.transition.slideLeft', 'Slide left'),
      'slide-up': t('video.transition.slideUp', 'Slide up'),
      zoom: t('video.transition.zoom', 'Zoom'),
      wipe: t('video.transition.wipe', 'Wipe'),
      blur: t('video.transition.blur', 'Blur'),
    })[type] || type;

  const LOOK_NAMES = () => ({
    cinematic: t('video.look.cinematic', 'Cinematic'),
    warm: t('video.look.warm', 'Warm'),
    cool: t('video.look.cool', 'Cool'),
    bw: t('video.look.bw', 'B&W'),
    vintage: t('video.look.vintage', 'Vintage'),
    vivid: t('video.look.vivid', 'Vivid'),
  });

  /** Sections for the new clip properties (transition, effects, motion, crop, text style, shape). */
  function extraSections(c) {
    let html = '';
    if (c.kind === 'draw') {
      const err = drawer.error(c.id);
      const draft = drawDrafts.get(c.id);
      const dirty = draft != null && draft !== (c.code || '');
      html += `<div class="sec vdraw"><h3>${esc(t('video.draw.section', 'DRAWING CODE'))}</h3>
        <p class="empty vhint">${esc(t('video.draw.hint', 'JavaScript body of function (ctx, t, w, h, p, H): t = seconds since the clip start, p = progress 0..1, w × h = frame size. Helpers: H.stick, H.text, H.circle, H.line, H.rect, H.poly, H.bg, H.glow, H.ease, H.wave, H.seg, H.rand, H.lerp. Runs in a sandbox without network access.'))}</p>
        <textarea class="vdraw-code" data-draw-code spellcheck="false" autocomplete="off" aria-label="${esc(t('video.draw.codeLabel', 'Drawing code'))}">${esc(dirty ? draft : c.code || '')}</textarea>
        <pre class="vdraw-err" role="status" ${err ? '' : 'hidden'}>${esc(err || '')}</pre>
        <div class="btns vdraw-btns"><button class="pri" data-act="draw-apply" title="${esc(t('video.draw.applyTitle', 'Apply the code (Ctrl+Enter)'))}">${esc(t('video.draw.apply', 'Apply'))}</button><button data-act="draw-example" title="${esc(t('video.draw.exampleTitle', 'Replace the code with the stick figure example'))}">${esc(t('video.draw.example', 'Example'))}</button><span class="vdraw-dirty" ${dirty ? '' : 'hidden'}>${esc(t('video.draw.unapplied', 'Not applied yet'))}</span></div>
      </div>`;
    }
    if (c.kind === 'shape') {
      html += `<div class="sec"><h3>${esc(t('video.shape.section', 'SHAPE'))}</h3>
        ${choice(t('video.shape.kind', 'Shape'), 'shape', FX.SHAPES.map((s) => [s, shapeName(s)]))}
        ${field(t('video.shape.color', 'Colour'), 'color', 'color')}
        ${field(t('video.shape.w', 'Width'), 'w', 'range', 'min="0.01" max="1.2" step="0.005"')}
        ${field(t('video.shape.h', 'Height'), 'h', 'range', 'min="0.005" max="1.2" step="0.005"')}
        ${c.shape === 'rounded' || c.shape === 'bar' ? field(t('video.shape.radius', 'Corners'), 'radius', 'range', 'min="0" max="1" step="0.01"') : ''}
        ${c.shape === 'bar' ? `<p class="empty vhint">${esc(t('video.shape.barHint', 'The bar fills from left to right over the clip duration.'))}</p>` : ''}
      </div>`;
    }
    if (c.kind === 'text') {
      const st = textStyle(c);
      const fonts = FX.FONTS.includes(st.font) ? FX.FONTS : [st.font, ...FX.FONTS];
      html += section_(
        'tstyle',
        t('video.text.style', 'TEXT STYLE'),
        `${choice(t('video.text.font', 'Font'), 'font', fonts.map((f) => [f, f]))}
        ${choice(t('video.text.weight', 'Weight'), 'weight', [
          [400, t('video.text.w400', 'Regular')],
          [600, t('video.text.w600', 'Semibold')],
          [700, t('video.text.w700', 'Bold')],
          [800, t('video.text.w800', 'Extra bold')],
          [900, t('video.text.w900', 'Black')],
        ])}
        ${toggleField(t('video.text.italic', 'Italic'), 'italic')}
        ${choice(t('video.text.align', 'Align'), 'align', [
          ['left', t('video.text.left', 'Left')],
          ['center', t('video.text.center', 'Centre')],
          ['right', t('video.text.right', 'Right')],
        ])}
        ${field(t('video.text.spacing', 'Letter spacing'), 'letterSpacing', 'range', 'min="-0.1" max="0.6" step="0.01"')}
        ${field(t('video.text.lineHeight', 'Line height'), 'lineHeight', 'range', 'min="0.7" max="2.5" step="0.05"')}
        ${field(t('video.text.rotation', 'Rotation'), 'rotation', 'range', 'min="-180" max="180" step="1"')}
        ${c.stroke ? field(t('video.text.strokeColor', 'Outline colour'), 'strokeColor', 'color') + field(t('video.text.strokeWidth', 'Outline width'), 'strokeWidth', 'range', 'min="0" max="0.4" step="0.01"') : ''}
        ${toggleField(t('video.text.shadow', 'Shadow'), 'shadow')}
        ${
          st.shadow
            ? field(t('video.text.shadowColor', 'Shadow colour'), 'shadowColor', 'color') +
              field(t('video.text.shadowBlur', 'Shadow blur'), 'shadowBlur', 'range', 'min="0" max="1.5" step="0.01"') +
              field(t('video.text.shadowDist', 'Shadow distance'), 'shadowDist', 'range', 'min="0" max="0.5" step="0.01"')
            : ''
        }
        ${
          c.bg
            ? field(t('video.text.boxPad', 'Box padding'), 'boxPad', 'range', 'min="0" max="1.5" step="0.01"') +
              field(t('video.text.boxRadius', 'Box corners'), 'boxRadius', 'range', 'min="0" max="1" step="0.01"') +
              field(t('video.text.boxOpacity', 'Box opacity'), 'boxOpacity', 'range', 'min="0" max="1" step="0.01"')
            : ''
        }`,
      );
    }
    if (hasFx(c)) {
      const tr = c.transition || FX.TRANSITION_DEFAULT;
      html += section_(
        'transition',
        t('video.transition.section', 'TRANSITION IN'),
        `${choice(
          t('video.transition.type', 'Type'),
          'transition.type',
          FX.TRANSITION_TYPES.map((x) => [x, transitionName(x)]),
        )}
        ${c.transition ? field(t('video.transition.duration', 'Duration'), 'transition.duration', 'range', 'min="0.1" max="2" step="0.05"') : ''}
        ${c.transition && FX.usesUnderlay(tr) ? `<p class="empty vhint">${esc(t('video.transition.hint', 'Plays over the end of the previous clip on this track.'))}</p>` : ''}`,
      );
      const looks = LOOK_NAMES();
      html += section_(
        'effects',
        t('video.fx.section', 'EFFECTS'),
        `<div class="vlooks">${FX.LOOK_KEYS.map((k) => `<button data-act="look" data-look="${k}" class="vlook vlook-${k}${JSON.stringify(FX.sanitizeEffects(k)) === JSON.stringify(c.effects || null) ? ' on' : ''}">${esc(looks[k])}</button>`).join('')}</div>
        ${field(t('video.fx.brightness', 'Brightness'), 'effects.brightness', 'range', 'min="0" max="2" step="0.01"')}
        ${field(t('video.fx.contrast', 'Contrast'), 'effects.contrast', 'range', 'min="0" max="2" step="0.01"')}
        ${field(t('video.fx.saturation', 'Saturation'), 'effects.saturation', 'range', 'min="0" max="3" step="0.01"')}
        ${field(t('video.fx.hue', 'Hue'), 'effects.hue', 'range', 'min="-180" max="180" step="1"')}
        ${field(t('video.fx.blur', 'Blur'), 'effects.blur', 'range', 'min="0" max="40" step="0.5"')}
        ${field(t('video.fx.grayscale', 'Grayscale'), 'effects.grayscale', 'range', 'min="0" max="1" step="0.01"')}
        ${field(t('video.fx.sepia', 'Sepia'), 'effects.sepia', 'range', 'min="0" max="1" step="0.01"')}
        ${c.kind !== 'shape' ? field(t('video.fx.vignette', 'Vignette'), 'effects.vignette', 'range', 'min="0" max="1" step="0.01"') : ''}
        <div class="btns"><button data-act="fx-reset" ${c.effects ? '' : 'disabled'}>${esc(t('video.fx.reset', 'Reset effects'))}</button></div>`,
      );
      const mp = [
        ['off', t('video.motion.off', 'Off')],
        ['zoom-in', t('video.motion.zoomIn', 'Zoom in')],
        ['zoom-out', t('video.motion.zoomOut', 'Zoom out')],
        ['pan-left', t('video.motion.panLeft', 'Pan left')],
        ['pan-right', t('video.motion.panRight', 'Pan right')],
      ];
      const pt = (end) =>
        ['x', 'y', 'scale', 'rotation']
          .map((k) => `<input type="number" data-k="motion.${end}.${k}" step="${k === 'rotation' ? 1 : 0.01}" value="${fmtVal(valueOf(c, `motion.${end}.${k}`))}" title="${esc((end === 'from' ? t('video.motion.from', 'From') : t('video.motion.to', 'To')) + ' ' + ({ x: 'X', y: 'Y', scale: t('video.motion.scale', 'Scale'), rotation: t('video.motion.rot', 'Rot.') })[k])}">`)
          .join('');
      html += section_(
        'motion',
        t('video.motion.section', 'MOTION (KEN BURNS)'),
        `<div class="vlooks">${mp.map(([k, label]) => `<button data-act="motion" data-motion="${k}" class="${(k === 'off' && !c.motion) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>
        ${
          c.motion
            ? `<div class="vmo-head"><span></span><i>X</i><i>Y</i><i>${esc(t('video.motion.scale', 'Scale'))}</i><i>${esc(t('video.motion.rot', 'Rot.'))}</i></div>
        <div class="vmo"><span>${esc(t('video.motion.from', 'From'))}</span>${pt('from')}</div>
        <div class="vmo"><span>${esc(t('video.motion.to', 'To'))}</span>${pt('to')}</div>
        ${choice(t('video.motion.ease', 'Easing'), 'motion.ease', [
          ['linear', t('video.ease.linear', 'Linear')],
          ['ease-in', t('video.ease.in', 'Ease in')],
          ['ease-out', t('video.ease.out', 'Ease out')],
          ['ease-in-out', t('video.ease.inOut', 'Ease in and out')],
        ])}`
            : `<p class="empty vhint">${esc(t('video.motion.hint', 'Animates position, scale and rotation from the clip start to its end.'))}</p>`
        }`,
      );
      if (isMediaVisual(c)) {
        html += section_(
          'crop',
          t('video.crop.section', 'CROP'),
          `${field(t('video.crop.l', 'Left'), 'crop.l', 'range', 'min="0" max="0.45" step="0.005"')}
          ${field(t('video.crop.t', 'Top'), 'crop.t', 'range', 'min="0" max="0.45" step="0.005"')}
          ${field(t('video.crop.r', 'Right'), 'crop.r', 'range', 'min="0" max="0.45" step="0.005"')}
          ${field(t('video.crop.b', 'Bottom'), 'crop.b', 'range', 'min="0" max="0.45" step="0.005"')}`,
        );
      }
    }
    return html;
  }

  function renderProps() {
    flushPanelEdit();
    const c = selectedClip();
    if (!c) {
      const fpsOpts = [
        [30, t('video.fps.recommended', '{fps} fps (recommended)', { fps: 30 })],
        [60, '60 fps'],
      ];
      if (!fpsOpts.some(([v]) => v === proj.fps)) fpsOpts.push([proj.fps, proj.fps + ' fps']);
      propsEl.innerHTML = `<div class="sec"><h3>${esc(t('video.proj.section', 'PROJECT'))}</h3>
        <div class="row"><span>${esc(t('video.proj.background', 'Background'))}</span><input type="color" id="vp-bg" value="${esc(proj.bg)}"></div>
        <div class="row"><span>${esc(t('video.export.fps', 'Frame rate'))}</span><select id="vp-fps">${fpsOpts
          .map(([v, lbl]) => `<option value="${v}" ${proj.fps === v ? 'selected' : ''}>${lbl}</option>`)
          .join('')}</select></div>
        <p class="empty">${esc(t('video.proj.counts', '{media} media · {clips} clips', { media: mediaItems.length, clips: clips.length }))}</p></div>
        <div class="sec"><h3>${esc(t('video.howto.section', 'HOW TO USE'))}</h3><p class="empty" style="margin:0">${[
          t('video.howto.1', '1. Pick files with "Add media".'),
          t('video.howto.2', '2. Put them on the timeline with the "+" on the card, or drag them there.'),
          t('video.howto.3', '3. Drag clips, trim from their edges, split with S.'),
          t('video.howto.4', '4. Save with "Export video".'),
        ]
          .map(esc)
          .join('<br>')}<br><br>${esc(t('video.howto.note', 'Export runs in real time: a 30 s video takes 30 s, but it does not strain your computer.'))}</p></div>
        <div class="sec"><h3>${esc(t('video.keys.section', 'SHORTCUTS'))}</h3><p class="empty vkeys">${[
          ['J / K / L', t('video.keys.shuttle', 'Reverse / stop / forward (press again for faster)')],
          ['M', t('video.keys.marker', 'Add or remove a marker at the playhead')],
          ['Shift+Delete', t('video.keys.ripple', 'Ripple delete (closes the gap)')],
          ['Shift+Z', t('video.keys.fit', 'Zoom timeline to fit')],
          ['S', t('video.keys.split', 'Split at the playhead')],
        ]
          .map(([k, d]) => `<b>${esc(k)}</b> ${esc(d)}`)
          .join('<br>')}</p></div>`;
      $('#vp-bg').oninput = (e) => {
        setBackground(e.target.value);
        notifyChange();
      };
      $('#vp-fps').onchange = (e) => {
        setFps(+e.target.value);
        notifyChange();
      };
      return;
    }
    const visual = c.kind !== 'audio';
    const timed = isTimed(c);
    const anims = [
      ['none', t('video.anim.none', 'None')],
      ['pop', t('video.anim.pop', 'Pop')],
      ['slide', t('video.anim.slide', 'Slide')],
      ['type', t('video.anim.type', 'Typewriter')],
      ['bounce', t('video.anim.bounce', 'Bounce')],
      ['fade-up', t('video.anim.fadeUp', 'Fade up')],
      ['zoom-in', t('video.anim.zoomIn', 'Zoom in')],
      ['wave', t('video.anim.wave', 'Wave (per letter)')],
    ];
    const head =
      c.kind === 'shape'
        ? t('video.shape.clip', 'SHAPE CLIP')
        : c.kind === 'draw'
          ? t('video.draw.clip', 'DRAWING CLIP')
          : t('video.props.clipHead', '{kind} CLIP', { kind: kindLabel(c.kind).toLocaleUpperCase(currentLanguage()) });
    propsEl.innerHTML = `<div class="sec"><h3>${esc(head)}</h3>
      ${
        c.kind === 'text'
          ? `<div class="row" style="grid-template-columns:1fr"><textarea data-k="text" placeholder="${esc(t('video.props.textPlaceholder', 'Enter your text'))}">${esc(c.text)}</textarea></div>`
          : c.kind === 'shape' || c.kind === 'draw'
            ? ''
            : `<p class="empty" style="margin:0 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(mediaOf(c)?.name || '')}</p>`
      }
      ${field(t('video.props.start', 'Start'), 'start', 'number', 'step="0.1" min="0"')}
      ${field(t('video.props.duration', 'Duration'), 'dur', 'number', 'step="0.1" min="0.1"')}
      ${timed ? field(t('video.props.sourceIn', 'Source start'), 'inP', 'number', 'step="0.1" min="0"') : ''}
      ${
        timed
          ? field(t('video.props.speed', 'Speed'), 'speed', 'range', 'min="0.25" max="4" step="0.05"') +
            `<div class="btns vspeed">${[0.5, 1, 1.5, 2].map((v) => `<button data-act="speed" data-v="${v}" class="${speedOf(c) === v ? 'on' : ''}">${v}×</button>`).join('')}</div>`
          : ''
      }
    </div>
    ${
      c.kind === 'text'
        ? `<div class="sec"><h3>${esc(t('video.text.section', 'TEXT'))}</h3>
      ${field(t('video.props.size', 'Size'), 'size', 'range', 'min="2" max="25" step="0.5"')}
      ${field(t('video.props.color', 'Colour'), 'color', 'color')}
      ${field(t('video.props.outline', 'Outline'), 'stroke', 'check')}
      ${field(t('video.props.box', 'Box'), 'bg', 'check')}
      ${c.bg ? field(t('video.props.boxColor', 'Box colour'), 'bgColor', 'color') : ''}
      ${choice(t('video.props.animation', 'Animation'), 'anim', anims)}
    </div>`
        : ''
    }
    ${
      visual
        ? `<div class="sec"><h3>${esc(t('video.props.appearance', 'APPEARANCE'))}</h3>
      ${field(t('video.props.x', 'Horizontal'), 'x', 'range', 'min="-0.5" max="0.5" step="0.01"')}
      ${field(t('video.props.y', 'Vertical'), 'y', 'range', 'min="-0.5" max="0.5" step="0.01"')}
      ${field(t('video.props.size', 'Size'), 'scale', 'range', 'min="0.1" max="3" step="0.01"')}
      ${field(t('video.props.opacity', 'Opacity'), 'opacity', 'range', 'min="0" max="1" step="0.01"')}
      ${c.kind !== 'text' ? field(t('video.props.rotation', 'Rotation'), 'rotation', 'range', 'min="-180" max="180" step="1"') : ''}
      ${
        isMediaVisual(c)
          ? choice(t('video.props.fit', 'Fit'), 'fit', [
              ['contain', t('video.props.fitContain', 'Show everything')],
              ['cover', t('video.props.fitCover', 'Fill the frame')],
            ])
          : ''
      }
    </div>`
        : ''
    }
    ${extraSections(c)}
    <div class="sec"><h3>${esc(t('video.props.audioFades', 'AUDIO AND FADES'))}</h3>
      ${timed ? field(t('video.props.volume', 'Volume'), 'vol', 'range', 'min="0" max="2" step="0.01"') : ''}
      ${field(t('video.props.fadeIn', 'Fade in'), 'fadeIn', 'range', 'min="0" max="3" step="0.1"')}
      ${field(t('video.props.fadeOut', 'Fade out'), 'fadeOut', 'range', 'min="0" max="3" step="0.1"')}
      <div class="btns" style="margin-top:10px"><button data-act="split">${esc(t('video.split', 'Split'))}</button><button data-act="dup">${esc(t('video.props.duplicate', 'Duplicate'))}</button><button data-act="center">${esc(t('video.props.center', 'Centre'))}</button><button data-act="del">${esc(t('video.props.delete', 'Delete'))}</button></div>
    </div>`;
  }

  // Panel alanları canlı uygular (input), bırakınca geçmişe işler (change → commit, panel yenilenir).
  propsEl.addEventListener('input', (e) => {
    if (e.target.matches?.('[data-draw-code]')) {
      const c = selectedClip();
      if (c?.kind !== 'draw') return;
      drawDrafts.set(c.id, e.target.value);
      const flag = $('.vdraw-dirty', propsEl);
      if (flag) flag.hidden = e.target.value === (c.code || '');
      return;
    }
    const key = e.target.dataset.k;
    const c = selectedClip();
    if (!key || !c) return;
    const inp = e.target;
    const value = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' || inp.type === 'number' ? parseFloat(inp.value) : inp.value;
    if (typeof value === 'number' && isNaN(value)) return;
    try {
      applyClipOpts(c, { [key]: value });
    } catch (err) {
      return toast(err.message);
    }
    panelDirty = true;
    const out = inp.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = fmtVal(valueOf(c, key));
    if (['start', 'dur', 'inP', 'text', 'speed', 'shape', 'color'].includes(key) || key.startsWith('transition.') || key.startsWith('effects.') || key.startsWith('motion.')) renderTimeline();
    syncMedia();
    requestDraw();
  });
  propsEl.addEventListener('change', (e) => {
    if (e.target.dataset.k) commit();
  });
  propsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    const c = selectedClip();
    if (act === 'split') splitAtPlayhead();
    else if (act === 'dup') duplicateSelected();
    else if (act === 'del') deleteSelected();
    else if (!c) return;
    else if (act === 'center') {
      c.x = 0;
      c.y = 0;
      commit();
    } else if (act === 'look') {
      applyClipOpts(c, { effects: btn.dataset.look });
      commit();
    } else if (act === 'fx-reset') {
      applyClipOpts(c, { effects: null });
      commit();
    } else if (act === 'motion') {
      const k = btn.dataset.motion;
      applyClipOpts(c, { motion: k === 'off' ? null : k });
      commit();
    } else if (act === 'speed') {
      applyClipOpts(c, { speed: +btn.dataset.v });
      commit();
    } else if (act === 'draw-apply' && c.kind === 'draw') {
      const ta = $('[data-draw-code]', propsEl);
      applyDrawCode(c, ta ? ta.value : c.code || '');
    } else if (act === 'draw-example' && c.kind === 'draw') applyDrawCode(c, STICK_EXAMPLE);
  });

  // Drawing code editor: Ctrl+Enter applies, Tab indents.
  propsEl.addEventListener('keydown', (e) => {
    const ta = e.target;
    if (!ta.matches?.('[data-draw-code]')) return;
    const c = selectedClip();
    if (c?.kind !== 'draw') return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      applyDrawCode(c, ta.value);
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  /** Applies drawing code (undoable); the same code again retries after an error. Keeps the editor focus and caret. */
  function applyDrawCode(c, code) {
    if (isLocked(c.track)) return toast(t('video.track.lockedMsg', 'This track is locked'));
    const ta = $('[data-draw-code]', propsEl);
    const focused = !!ta && document.activeElement === ta;
    const sel = ta ? [ta.selectionStart, ta.selectionEnd, ta.scrollTop] : null;
    drawDrafts.delete(c.id);
    code = String(code).slice(0, DRAW_CODE_MAX);
    drawer.retry(c.id);
    if (code === (c.code || '')) {
      refreshAll();
    } else {
      applyClipOpts(c, { code });
      commit();
    }
    const nta = $('[data-draw-code]', propsEl);
    if (nta && focused && sel) {
      nta.focus();
      nta.setSelectionRange(Math.min(sel[0], nta.value.length), Math.min(sel[1], nta.value.length));
      nta.scrollTop = sel[2];
    }
  }

  // ------------------------------------------------------------------ proje ayarları

  const saveProj = () => store.set('vproj', { res: proj.res, bg: proj.bg, fps: proj.fps });

  function setResolution(res) {
    const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(String(res));
    if (!match) throw new Error(t('video.err.badResolution', 'Invalid resolution: {res}', { res }));
    const even = (v) => clamp(Math.round(+v / 2) * 2, 16, 4096);
    proj.w = even(match[1]);
    proj.h = even(match[2]);
    proj.res = `${proj.w}x${proj.h}`;
    if (![...resSelect.options].some((o) => o.value === proj.res)) {
      resSelect.add(new Option(resLabel(proj.res) || t('video.res.custom', 'Custom {w}×{h}', { w: proj.w, h: proj.h }), proj.res));
    }
    resSelect.value = proj.res;
    saveProj();
    setQuality(quality);
    updateStatus();
  }

  function setFps(fps) {
    fps = Math.round(+fps);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(t('video.err.badFps', 'Invalid frame rate: {fps}', { fps }));
    proj.fps = clamp(fps, 1, 120);
    saveProj();
    if (!selectedClip()) renderProps();
  }

  function setBackground(color) {
    proj.bg = String(color);
    saveProj();
    requestDraw();
    const input = $('#vp-bg');
    if (input && input.value !== proj.bg && /^#[0-9a-f]{6}$/i.test(proj.bg)) input.value = proj.bg;
  }

  // The recording canvas must not be resized mid-export (a quiet live/agent export leaves the toolbar usable).
  const blockedByExport = (sel, value) => {
    if (!exp) return false;
    sel.value = value;
    toast(t('video.export.busySettings', 'An export is running: change this after it finishes'));
    return true;
  };
  resSelect.onchange = (e) => {
    if (blockedByExport(resSelect, proj.res)) return;
    setResolution(e.target.value);
    notifyChange();
  };
  qualitySelect.onchange = (e) => {
    if (blockedByExport(qualitySelect, String(exp?.prevQuality ?? quality))) return;
    store.set('vq', +e.target.value);
    setQuality(+e.target.value);
    updateStatus();
  };

  function updateStatus() {
    if (!active) return;
    $('#st-left').textContent = t('video.status.left', '{clips} clips · duration {dur} · {w}×{h}', { clips: clips.length, dur: fmtTime(totalDuration()), w: proj.w, h: proj.h });
    $('#st-right').textContent = t('video.status.preview', 'Preview {pct}%', { pct: Math.round(quality * 100) }) + (settings.eco ? t('video.status.eco', ' · Eco mode: preview 30 fps') : '');
  }

  // ------------------------------------------------------------------ kısayollar

  addEventListener('keydown', (e) => {
    if (!active || isTyping(e) || exp || !$('#help').hidden || exportDialogOpen()) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // A focused slider / checkbox keeps its own arrow, Home/End and Space keys.
    if (e.target?.matches?.('input[type=range], input[type=checkbox]') && /^(arrow(left|right|up|down)|home|end|pageup|pagedown| )$/.test(key)) return;
    if (mod && key === 'z' && !e.shiftKey) undo();
    else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) redo();
    else if (mod && key === 'd') duplicateSelected();
    else {
      if (mod || e.altKey) return;
      if (e.key === ' ') togglePlay();
      else if ((key === 'delete' || key === 'backspace') && e.shiftKey) rippleDelete();
      else if (key === 'delete' || key === 'backspace') deleteSelected();
      else if (key === 'z' && e.shiftKey) zoomToFit();
      else if (e.shiftKey && key !== 'arrowleft' && key !== 'arrowright') return;
      else if (key === 's') splitAtPlayhead();
      else if (key === 'm') toggleMarker();
      else if (key === 'j') shuttle(-1);
      else if (key === 'k') shuttle(0);
      else if (key === 'l') shuttle(1);
      else if (key === 'arrowleft') seek(time - (e.shiftKey ? 1 : 1 / proj.fps));
      else if (key === 'arrowright') seek(time + (e.shiftKey ? 1 : 1 / proj.fps));
      else if (key === 'home') seek(0);
      else if (key === 'end') seek(totalDuration());
      else if (key === 'escape') {
        selectedId = null;
        renderTimeline();
        renderProps();
      } else return;
    }
    e.preventDefault();
  });

  new ResizeObserver(() => active && renderTimeline()).observe(tlScroll);

  // ------------------------------------------------------------------ api

  function clear() {
    if (exp) throw new Error(t('video.err.clearWhileExporting', 'Cannot clear while an export is running'));
    if (playing) stopPlayback();
    for (const id of [...players.keys()]) disposePlayer(id);
    drawer.disposeAll();
    drawDrafts.clear();
    for (const m of mediaItems) URL.revokeObjectURL(m.url);
    for (const m of trashMedia) URL.revokeObjectURL(m.url);
    mediaItems = [];
    trashMedia = [];
    clips = [];
    selectedId = null;
    time = 0;
    trackState = { t: {}, v2: {}, v1: {}, a: {} };
    markers = [];
    history = [emptyHistory()];
    historyIndex = 0;
    panelDirty = false;
    renderMediaList();
    refreshAll();
  }

  function addClip(mediaOrId, opts = {}) {
    if (mediaOrId == null && opts && opts.kind === 'shape') return addShape(opts);
    // Draw clip: kind:'draw', or no kind with a code string (and no media).
    if (mediaOrId == null && opts && (opts.kind === 'draw' || (opts.kind == null && typeof opts.code === 'string'))) return addDraw(opts);
    const m = typeof mediaOrId === 'string' ? mediaById(mediaOrId) : mediaById(mediaOrId?.id);
    if (!m || !mediaItems.includes(m)) throw new Error(t('video.err.mediaNotFound', 'Media not found'));
    const track = opts.track || (m.type === 'audio' ? 'a' : 'v1');
    if (!TRACK_ACCEPTS[track]?.includes(m.type)) throw new Error(t('video.err.trackRejects', 'Track "{track}" does not accept {kind}', { track, kind: kindLabel(m.type) }));
    const start = opts.start != null && Number.isFinite(+opts.start) ? +opts.start : track === 'v1' ? trackEnd('v1') : time;
    const clip = makeClip(m, track, start);
    const { track: _t, start: _s, ...rest } = opts;
    applyClipOpts(clip, rest);
    clips.push(clip);
    refreshAll();
    return publicClip(clip);
  }

  function addText(opts = {}) {
    const start = opts.start != null && Number.isFinite(+opts.start) ? +opts.start : time;
    const clip = makeTextClip(start);
    const { track: _t, start: _s, ...rest } = opts;
    applyClipOpts(clip, rest);
    clips.push(clip);
    refreshAll();
    return publicClip(clip);
  }

  /** Shape clip: opts {shape:'rect'|'rounded'|'circle'|'bar', color, w, h, radius, track:'v2'|'v1', start, duration, x, y, ...}. */
  function addShape(opts = {}) {
    const track = opts.track === 'v1' ? 'v1' : 'v2';
    const start = opts.start != null && Number.isFinite(+opts.start) ? +opts.start : time;
    const clip = makeShapeClip(opts.shape, start, track);
    const { track: _t, start: _s, kind: _k, ...rest } = opts;
    applyClipOpts(clip, rest);
    clips.push(clip);
    refreshAll();
    return publicClip(clip);
  }

  /**
   * Draw clip: opts {code (body of function (ctx, t, w, h, p, H)), track:'v2'|'v1' (default v2), start, duration (default 5),
   * x, y, scale, opacity, rotation, fadeIn, fadeOut, effects, transition, motion}. No history entry; the caller commits.
   */
  function addDraw(opts = {}) {
    const track = opts.track === 'v1' ? 'v1' : 'v2';
    const start = opts.start != null && Number.isFinite(+opts.start) ? +opts.start : time;
    const clip = makeDrawClip(typeof opts.code === 'string' ? opts.code : '', start, track);
    const { track: _t, start: _s, kind: _k, code: _c, ...rest } = opts;
    applyClipOpts(clip, rest);
    clips.push(clip);
    refreshAll();
    return publicClip(clip);
  }

  function updateClip(id, opts = {}) {
    const c = clipById(id);
    if (!c) throw new Error(t('video.err.clipNotFound', 'Clip not found: {id}', { id }));
    applyClipOpts(c, opts);
    refreshAll();
    return publicClip(c);
  }

  function select(id) {
    selectedId = id && clipById(id) ? id : null;
    renderTimeline();
    renderProps();
  }

  /** Klibi siler (geçmişe işlemez; çağıran commit eder). Yoksa false. */
  function removeClip(id) {
    if (!clipById(id)) return false;
    clips = clips.filter((c) => c.id !== id);
    disposePlayer(id);
    drawer.dispose(id);
    drawDrafts.delete(id);
    if (selectedId === id) selectedId = null;
    refreshAll();
    return true;
  }

  /**
   * Kütüphaneden medyayı kaldırır; bir klip kullanıyorsa kaldırmaz (false). Geçmişte (geri al) hâlâ
   * kullanılıyorsa URL'si açık kalır: geri alınan klip çizilebilsin, medya kütüphaneye dönsün.
   */
  function removeMedia(id) {
    const m = mediaItems.find((x) => x.id === id) || null;
    if (!m || clips.some((c) => c.mid === id)) return false;
    mediaItems = mediaItems.filter((x) => x !== m);
    const tag = midTag(id);
    if (history.some((h) => h.includes(tag))) trashMedia.push(m);
    else URL.revokeObjectURL(m.url);
    renderMediaList();
    if (!selectedClip()) renderProps();
    return true;
  }

  /** Track flags { t:{hide,lock}, v2:{mute,hide,lock}, v1:{...}, a:{mute,lock} } (only true flags are present). */
  const getTracks = () => deepCopy(trackState);
  /** Replaces the flags of the given tracks (no history entry; the caller commits). */
  function setTracks(obj = {}) {
    for (const track of TRACK_ORDER) {
      if (!(track in obj)) continue;
      const want = obj[track] || {};
      for (const f of TRACK_FLAGS[track]) setTrackFlag(track, f, !!want[f], true);
    }
    refreshAll();
  }
  /** Replaces the markers (seconds; no history entry; the caller commits). */
  function setMarkers(list = []) {
    markers = normMarkers(Array.isArray(list) ? list : []);
    renderTimeline();
  }

  const api = {
    clear,
    setResolution,
    setFps,
    setBackground,
    addMedia: (file, name, type) => loadMedia(file, name, type),
    addClip,
    addText,
    addShape,
    addDraw,
    /** Current error text of a draw clip (syntax / runtime / timeout), or null. */
    drawError: (id) => drawer.error(id),
    updateClip,
    select,
    seek,
    duration: totalDuration,
    clips: () => clips.map(publicClip),
    media: () => mediaItems.slice(),
    commit,
    exportVideo,
    /** Current frame as PNG blob ({scale}). */
    exportFrame,
    /** Opens the export dialog (presets, fps, quality, PNG frame). */
    openExportDialog,
    // Belgede olmayan küçük ekler
    play,
    pause: stopPlayback,
    shuttle,
    time: () => time,
    undo,
    redo,
    removeClip,
    removeMedia,
    rippleDelete,
    tracks: getTracks,
    setTracks,
    markers: () => markers.slice(),
    setMarkers,
    /** Seçili klibin kimliği (yoksa null). */
    selected: () => selectedId,
    /** Dışa aktarma (arayüzden ya da API'den) sürüyor mu. */
    exporting: () => !!exp,
    /** Proje ayarları: { res: "1080x1920", w, h, fps, bg }. */
    project: () => ({ res: proj.res, w: proj.w, h: proj.h, fps: proj.fps, bg: proj.bg }),
    el: {
      mediaCard: (id) => mediaListEl.querySelector(`[data-mid="${CSS.escape(id)}"]`),
      clip: (id) => tlInner.querySelector(`.clip[data-id="${CSS.escape(id)}"]`),
      track: (k) => tlInner.querySelector(`.track[data-track="${CSS.escape(k)}"]`),
      props: () => propsEl,
      scroll: () => tlScroll,
      timeToX: (tm) => tlInner.getBoundingClientRect().left + tm * zoom,
      /** Toolbar "Shape" button. */
      shapeButton: () => shapeBtn,
      /** Toolbar "Drawing" button (adds a draw clip with the example code). */
      drawButton: () => drawBtn,
      /** Code editor / Apply button of the selected draw clip in the panel (null when not shown). */
      drawCode: () => propsEl.querySelector('[data-draw-code]'),
      drawApply: () => propsEl.querySelector('[data-act="draw-apply"]'),
      /** Track header row ('t' | 'v2' | 'v1' | 'a') and its flag button. */
      trackHead: (k) => headRows.find((r) => r.dataset.track === k) || null,
      trackFlag: (k, flag) => headRows.find((r) => r.dataset.track === k)?.querySelector(`[data-flag="${flag}"]`) || null,
      ruler: () => $('#v-ruler'),
    },
  };

  // ------------------------------------------------------------------ başlangıç

  qualitySelect.value = String(quality);
  zoomSlider.value = zoom;
  try {
    setResolution(proj.res);
  } catch {
    setResolution('1080x1920');
  }
  renderMediaList();
  refreshAll();

  return {
    activate() {
      active = true;
      renderTimeline();
      updateStatus();
      requestDraw();
    },
    deactivate() {
      active = false;
      // Dışa aktarma sürüyorsa durdurma (pencere küçültülse de kayıt bitmeli).
      if (playing && !exp) stopPlayback();
      idleAudio();
      // Drawing workers stop with the mode (recreated lazily); an export in progress keeps them.
      if (!exp) drawer.disposeAll();
    },
    eco() {
      updateStatus();
    },
    /** 3D modundan gelen çıktı ("to-video"): kütüphaneye ekler ve zaman çizelgesine koyar. */
    async fromBlob({ blob, name, type, dur }) {
      try {
        const m = await loadMedia(blob, name, type, dur);
        quickAdd(m, true);
        return m;
      } catch (e) {
        toast(e.message);
        return null;
      }
    },
    api,
  };
}
