// 3D modelleme modu.
//
// Performans: sürekli çizim döngüsü YOK. Bir şey değişince requestRender() tek bir kare ister
// (render-on-demand). Tek istisna recordSpin(): kayıt süresince fps ile sınırlı bir döngü döner
// ve kayıt bitince kendini durdurur.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

import { $, $$, bus, store, settings, toast, busy, pickMime, isTyping, esc, extOf, stripExt, baseName } from './util.js';
import * as platform from './platform.js';
import { t } from './i18n.js';

const DEG = Math.PI / 180;
const UNDO_LIMIT = 80;

/** Kayıt için denenen video türleri (ilk desteklenen kullanılır). */
const RECORD_MIMES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

// ---------------------------------------------------------------- şekil tanımları

/** Rampa: dik üçgen kesitli prizma, 1×1×1 kutuya ortalanmış. */
function wedgeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(1, 0);
  shape.lineTo(0, 1);
  shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geo.translate(-0.5, -0.5, -0.5);
  geo.rotateY(-Math.PI / 2);
  return geo;
}

/** Yardımcı: ana segment sayısının yarısı, en az `min`. */
const halfSeg = (seg, min) => Math.max(min, Math.round(seg / 2));

/** Auto-name labels; resolved lazily so t() runs after the language is loaded. */
const SHAPE_LABELS = {
  cube: ['three.shape.cube', 'Cube'],
  sphere: ['three.shape.sphere', 'Sphere'],
  cylinder: ['three.shape.cylinder', 'Cylinder'],
  cone: ['three.shape.cone', 'Cone'],
  wedge: ['three.shape.wedge', 'Ramp'],
  torus: ['three.shape.torus', 'Torus'],
  capsule: ['three.shape.capsule', 'Capsule'],
  plane: ['three.shape.plane', 'Ground'],
};

/**
 * kind -> { label, curved (detay ayarı var mı), geo({seg}) }.
 * Etiketler otomatik isimlendirmede kullanılır (Küp, Küp.001, ...).
 */
const SHAPES = {
  cube: { geo: () => new THREE.BoxGeometry(1, 1, 1) },
  sphere: { curved: true, geo: ({ seg }) => new THREE.SphereGeometry(0.5, seg, halfSeg(seg, 3)) },
  cylinder: { curved: true, geo: ({ seg }) => new THREE.CylinderGeometry(0.5, 0.5, 1, seg) },
  cone: { curved: true, geo: ({ seg }) => new THREE.ConeGeometry(0.5, 1, seg) },
  wedge: { geo: wedgeGeometry },
  torus: { curved: true, geo: ({ seg }) => new THREE.TorusGeometry(0.4, 0.15, halfSeg(seg, 3), seg) },
  capsule: {
    curved: true,
    geo: ({ seg }) => new THREE.CapsuleGeometry(0.3, 0.5, Math.max(1, Math.round(seg / 4)), seg),
  },
  plane: { geo: () => new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2) },
  // Flat text plane; the geometry/texture are rebuilt from userData.tx by setText().
  text: {
    get label() {
      return t('three.shape.text', 'Text');
    },
    geo: () => new THREE.PlaneGeometry(1, 1),
  },
};

for (const [k, [key, en]] of Object.entries(SHAPE_LABELS)) {
  Object.defineProperty(SHAPES[k], 'label', { get: () => t(key, en), enumerable: true });
}

/** Text shape defaults (userData.tx). size = em height in world units. */
const FONT_FALLBACK = 'system-ui, "Segoe UI", "Noto Sans", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Nirmala UI", "Leelawadee UI", "Segoe UI Symbol", sans-serif';
const textDefaults = () => ({ text: t('three.text.default', 'Text'), font: 'Segoe UI', color: '#ffffff', background: '', size: 1 });

/** Light defaults. Intensity is in candela (physically based), distance 0 = unlimited. */
const LIGHT_DEFAULTS = {
  point: { intensity: 30, distance: 0 },
  spot: { intensity: 60, distance: 0, angle: 40, penumbra: 0.3 },
};
const MAX_LIGHTS = 8;

/** One-click material presets (kept in sync with live-3d.js MATERIAL_PRESETS). */
const MATERIAL_PRESETS = {
  matte: { metalness: 0, roughness: 1 },
  plastic: { metalness: 0, roughness: 0.25 },
  metal: { metalness: 1, roughness: 0.25 },
  gold: { color: '#ffc94d', metalness: 1, roughness: 0.3 },
  glass: { color: '#cfe9ff', metalness: 0, roughness: 0.05, opacity: 0.35 },
  glow: { metalness: 0, roughness: 0.5, emissiveIntensity: 1.6, glow: true },
};
const PRESET_LABELS = {
  matte: ['three.preset.matte', 'Matte'],
  plastic: ['three.preset.plastic', 'Plastic'],
  metal: ['three.preset.metal', 'Metal'],
  gold: ['three.preset.gold', 'Gold'],
  glass: ['three.preset.glass', 'Glass'],
  glow: ['three.preset.glow', 'Glow'],
};

/** CSS font-family list for a user supplied family name (falls back through system fonts per glyph). */
function fontFamily(font) {
  const f = String(font || '').trim();
  if (!f) return FONT_FALLBACK;
  if (/[,"']/.test(f)) return f + ', ' + FONT_FALLBACK;
  return `"${f}", ${FONT_FALLBACK}`;
}

/** Draws the text into a canvas (max 2048 px per side). Returns { canvas, w, h } with w/h in world units. */
function drawTextCanvas(tx) {
  const px = 128;
  const lines = String(tx.text ?? '').split('\n');
  const font = `600 ${px}px ${fontFamily(tx.font)}`;
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d');
  ctx.font = font;
  const pad = px * 0.25;
  const lineH = px * 1.25;
  const textW = Math.max(px * 0.5, ...lines.map((l) => ctx.measureText(l).width));
  const cw = Math.ceil(textW + pad * 2);
  const ch = Math.ceil(lineH * lines.length + pad * 0.5);
  const k = Math.min(1, 2048 / cw, 2048 / ch);
  cv.width = Math.max(8, Math.ceil(cw * k));
  cv.height = Math.max(8, Math.ceil(ch * k));
  ctx = cv.getContext('2d');
  ctx.scale(k, k);
  if (tx.background) {
    ctx.fillStyle = tx.background;
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.font = font;
  ctx.fillStyle = tx.color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, cw / 2, pad * 0.25 + lineH * (i + 0.5)));
  const unit = tx.size / px;
  return { canvas: cv, w: cw * unit, h: ch * unit };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex6 = (c) => '#' + new THREE.Color(c).getHexString();

/** Yeni şekillerin sırayla aldığı renkler. */
const PALETTE = ['#4f8cff', '#ff7a45', '#3ecf8e', '#f5c542', '#c58bff', '#ef5b6b', '#8fa3b8', '#2fbfd0'];

/** İçe aktarılan OBJ/STL modellerin varsayılan gri malzemesi. */
const importedMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.7 });

const round = (v, digits = 3) => +(+v).toFixed(digits);
const toVec3 = (v) => (typeof v === 'number' ? [v, v, v] : v);
/** Varsayılan sahne ve kamera (canlı projede sıfırdan kurulum da bunlardan başlar: api.defaults, live-3d.js). */
const SCENE_DEFAULTS = { bg: '#2a2d33', bg2: null, grid: true, shadows: false, light: 1.6, ambient: 1.1 };
const CAMERA_DEFAULTS = { position: [6, 5, 8], target: [0, 0.5, 0], fov: 50 };

// ---------------------------------------------------------------- mod fabrikası

export function createThreeMode() {
  const viewport = $('#d-vp');
  const root = $('#m3d');
  const q = (sel) => $(sel, root);
  const qa = (sel) => $$(sel, root);

  // ---------- çizici, sahne, kamera, ışıklar

  // Antialias sadece başlangıçta seçilebilir (WebGL bağlamı kurulurken).
  const renderer = new THREE.WebGLRenderer({ antialias: !settings.eco, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  viewport.prepend(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  const sceneSettings = {
    ...SCENE_DEFAULTS,
    ...store.get('scene3d', {}),
  };
  /** Solid colour, or a vertical two-colour gradient texture when sceneSettings.bg2 is set. */
  function applyBackground() {
    const old = scene.background;
    if (sceneSettings.bg2) {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 256;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, sceneSettings.bg);
      grad.addColorStop(1, sceneSettings.bg2);
      g.fillStyle = grad;
      g.fillRect(0, 0, 2, 256);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      scene.background = tex;
    } else {
      scene.background = new THREE.Color(sceneSettings.bg);
    }
    if (old && old.isTexture) old.dispose();
  }
  applyBackground();
  /** Shadows currently on (scene setting and not eco); lights follow it. */
  let shadowsOn = false;

  const camera = new THREE.PerspectiveCamera(CAMERA_DEFAULTS.fov, 1, 0.05, 2000);
  camera.position.fromArray(CAMERA_DEFAULTS.position);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444955, sceneSettings.ambient);
  const sunLight = new THREE.DirectionalLight(0xffffff, sceneSettings.light);
  sunLight.position.set(6, 12, 5);
  sunLight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunLight.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 0.5, far: 60 });
  scene.add(hemiLight, sunLight);

  const grid = new THREE.GridHelper(40, 40, 0x5a5f6a, 0x3a3f47);
  grid.material.transparent = true;
  grid.material.opacity = 0.8;
  grid.visible = sceneSettings.grid;
  scene.add(grid);

  // Gölgeleri yakalayan görünmez zemin (sadece gölgeler açıkken).
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.3 }),
  );
  shadowCatcher.receiveShadow = true;
  shadowCatcher.position.y = -0.001;
  scene.add(shadowCatcher);

  /** Kullanıcı nesnelerinin hepsi bu grubun doğrudan çocuklarıdır. */
  const world = new THREE.Group();
  world.name = 'HS_World';
  scene.add(world);

  const selectionBox = new THREE.BoxHelper(undefined, 0xffa040);
  selectionBox.visible = false;
  scene.add(selectionBox);

  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = false; // sönümleme sürekli çizim ister; kapalı
  orbit.target.fromArray(CAMERA_DEFAULTS.target);
  orbit.update();

  const gizmo = new TransformControls(camera, canvas);
  const gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);

  const wireOverlayMaterial = new THREE.MeshBasicMaterial({ color: 0xd8dee4, wireframe: true });

  // ---------- durum

  let selected = null;
  let active = true;
  let snapOn = false;
  let frameRequest = 0;
  /** Kayıt sürerken ekran çizimi ve yeniden boyutlandırma bekletilir. */
  let recording = false;
  /** Yüklenmekte olan dokular; render/kayıt öncesi beklenir. */
  const pendingLoads = new Set();

  // ---------- çizim (render-on-demand)

  function requestRender() {
    if (!frameRequest && active && !recording) frameRequest = requestAnimationFrame(drawFrame);
  }

  function drawFrame() {
    frameRequest = 0;
    if (recording) return;
    if (selected) selectionBox.setFromObject(selected);
    renderer.render(scene, camera);
  }

  /** Eko mod / gölge ayarlarını uygular. */
  function applyQuality() {
    renderer.setPixelRatio(settings.eco ? 0.75 : Math.min(devicePixelRatio, 1.5));
    const shadows = sceneSettings.shadows && !settings.eco;
    shadowsOn = shadows;
    world.children.forEach((o) => o.userData.hl && syncLight(o));
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows;
      sunLight.castShadow = shadows;
      // Gölge açılıp kapanınca malzemelerin shader'ı yeniden derlenmeli.
      scene.traverse((o) => {
        if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true));
      });
    }
    if (!shadows) {
      // Shadow render targets stay allocated after castShadow goes false: free them (recreated lazily).
      releaseShadow(sunLight);
      for (const o of reachableObjects()) {
        if (o.userData.hl) o.traverse((n) => n.isLight && releaseShadow(n));
      }
    }
    shadowCatcher.visible = shadows;
    resize();
  }

  function resize() {
    if (recording) return;
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }

  new ResizeObserver(resize).observe(viewport);
  // Kullanıcı kamerayı gerçekten oynattıysa (sürükleme/tekerlek) canlı projeye bildir.
  // Turntable steps also fire 'change' (turnStep sets turnUpdating): those do not count as a user move,
  // so a plain click while the turntable spins is not reported as a camera edit.
  let orbitStartKey = '';
  let orbitUserMoved = false;
  let turnUpdating = false;
  orbit.addEventListener('change', () => {
    if (!turnUpdating) orbitUserMoved = true;
    requestRender();
  });
  const cameraKey = () => JSON.stringify([camera.position.toArray().map((v) => round(v)), orbit.target.toArray().map((v) => round(v))]);
  orbit.addEventListener('start', () => {
    orbitStartKey = cameraKey();
    orbitUserMoved = false;
  });
  orbit.addEventListener('end', () => {
    if (orbitStartKey && orbitUserMoved && orbitStartKey !== cameraKey()) emitChange();
    orbitStartKey = '';
    orbitUserMoved = false;
  });
  gizmo.addEventListener('change', requestRender);
  let dragStartState = null;
  const transformKey = (o) => (o ? JSON.stringify([o.position.toArray(), o.rotation.toArray(), o.scale.toArray()]) : '');
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) {
      dragStartState = transformKey(gizmo.object);
      return;
    }
    // Sürükleme bitti: gerçekten bir şey değiştiyse geri alma adımı (kola sadece tıklamak adım eklemez).
    if (dragStartState == null || dragStartState !== transformKey(gizmo.object)) commit();
    dragStartState = null;
  });
  gizmo.addEventListener('objectChange', () => syncTransformInputs());

  // ---------- isimlendirme ve şekil üretimi

  const nameCounters = {};
  /** "Küp", "Küp.001", "Küp.002" ... */
  function autoName(base) {
    nameCounters[base] = (nameCounters[base] || 0) + 1;
    const n = nameCounters[base];
    return n === 1 ? base : `${base}.${String(n - 1).padStart(3, '0')}`;
  }

  let paletteIndex = 0;

  /** Yeni bir temel şekil Mesh'i üretir (sahneye eklemez). */
  function makeShape(kind, { seg, color, metalness, roughness, name, emissive, emissiveIntensity, opacity, tx } = {}) {
    const def = SHAPES[kind];
    if (!def) throw new Error(t('three.err.unknownShape', 'Unknown shape: {kind}', { kind }));
    const isText = kind === 'text';
    seg = seg || (settings.eco ? 16 : 24);
    const material = new THREE.MeshStandardMaterial({
      // For text the material stays white; "color" is the text colour (userData.tx.color).
      color: isText ? '#ffffff' : color || PALETTE[paletteIndex++ % PALETTE.length],
      metalness: metalness ?? 0,
      roughness: roughness ?? 0.6,
      side: kind === 'plane' || isText ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (emissive != null) material.emissive.set(emissive);
    if (emissiveIntensity != null) material.emissiveIntensity = +emissiveIntensity;
    if (isText) {
      material.userData.txt = true;
      material.alphaTest = 0.01;
    }
    setOpacity(material, opacity ?? 1);
    const mesh = new THREE.Mesh(def.geo({ seg }), material);
    mesh.name = name || autoName(def.label);
    // userData GLB'ye "extras" olarak yazılır; proje açılırken şekil buradan yeniden kurulur.
    mesh.userData = { hs: 1, kind, seg };
    mesh.castShadow = mesh.receiveShadow = true;
    if (isText) {
      mesh.userData.tx = { ...textDefaults(), ...(color ? { color: hex6(color) } : {}), ...(tx || {}) };
      setText(mesh, {});
    }
    return mesh;
  }

  /** Opacity < 1 (or a text plane) turns on blending. */
  function setOpacity(mat, v) {
    mat.opacity = clamp(+v, 0, 1);
    const tr = mat.opacity < 1 || !!mat.userData.txt;
    if (mat.transparent !== tr) {
      mat.transparent = tr;
      mat.needsUpdate = true;
    }
  }

  /** Updates the text shape: merges the patch into userData.tx and rebuilds the canvas texture + plane. */
  function setText(mesh, patch = {}) {
    const tx = Object.assign(mesh.userData.tx, patch);
    tx.text = String(tx.text ?? '');
    tx.size = Math.max(0.05, +tx.size || 1);
    const { canvas: cv, w, h } = drawTextCanvas(tx);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const mat = mesh.material;
    const old = mat.map;
    mat.map = tex;
    if (!old) mat.needsUpdate = true;
    if (old) old.dispose();
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(w, h);
  }

  // ---------- lights (point / spot) as scene objects

  /** Helper meshes and the three.js light live here (kept out of userData so GLB export stays JSON-clean). */
  const lightParts = new WeakMap();
  const lightLabel = (kind) => (kind === 'spot' ? t('three.light.spot', 'Spot light') : t('three.light.point', 'Point light'));
  const lightCount = () => world.children.filter((o) => o.userData.hl).length;

  /**
   * Light object: a Group with userData.hl = 1 and userData.light = {kind, color, intensity, distance, angle?, penumbra?}.
   * A spot light points down its local -Y axis, so the rotation fields aim it.
   */
  function makeLight(kind, params = {}, name) {
    kind = kind === 'spot' ? 'spot' : 'point';
    const g = new THREE.Group();
    g.name = name || autoName(lightLabel(kind));
    const prm = { kind, color: '#ffffff', ...LIGHT_DEFAULTS[kind] };
    if (params.color != null) prm.color = hex6(params.color);
    for (const k of ['intensity', 'distance', 'angle', 'penumbra']) {
      if (params[k] != null && Number.isFinite(+params[k]) && (k in prm)) prm[k] = +params[k];
    }
    g.userData = { hl: 1, light: prm };
    const lt = kind === 'spot' ? new THREE.SpotLight(0xffffff, 1, 0, 0.7, 0.3, 2) : new THREE.PointLight(0xffffff, 1, 0, 2);
    g.add(lt);
    if (kind === 'spot') {
      lt.target.position.set(0, -1, 0);
      g.add(lt.target);
    }
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    marker.userData.helper = 1;
    g.add(marker);
    let cone = null;
    if (kind === 'spot') {
      cone = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 }));
      cone.userData.helper = 1;
      cone.raycast = () => {}; // the cone must never steal clicks
      g.add(cone);
    }
    lightParts.set(g, { lt, marker, cone, coneAngle: -1 });
    syncLight(g);
    return g;
  }

  /** Pushes userData.light onto the three.js light + helper gizmo. */
  function syncLight(g) {
    const parts = lightParts.get(g);
    const p = g.userData.light;
    if (!parts || !p) return;
    const { lt, marker, cone } = parts;
    lt.color.set(p.color);
    lt.intensity = Math.max(0, p.intensity);
    lt.distance = Math.max(0, p.distance || 0);
    lt.decay = 2;
    // Shadows only outside eco mode (point-light shadows render 6 faces: keep the map small).
    lt.castShadow = shadowsOn;
    lt.shadow.mapSize.set(512, 512);
    lt.shadow.bias = -0.0005;
    marker.material.color.set(p.color);
    if (cone) {
      const ang = clamp(p.angle ?? 40, 1, 89);
      lt.angle = ang * DEG;
      lt.penumbra = clamp(p.penumbra ?? 0.3, 0, 1);
      cone.material.color.set(p.color);
      if (parts.coneAngle !== ang) {
        parts.coneAngle = ang;
        const len = 1.5;
        const geo = new THREE.ConeGeometry(Math.tan(ang * DEG) * len, len, 20, 1, true);
        geo.translate(0, -len / 2, 0); // apex at the origin, opening towards -Y
        cone.geometry.dispose();
        cone.geometry = geo;
      }
    }
    requestRender();
  }

  /** Light helper meshes of the current scene (hidden during renders/exports). */
  function helperMeshes() {
    const out = [];
    world.traverse((o) => o.userData.helper && out.push(o));
    return out;
  }

  /** Applies material preset values to a shape (no undo step; caller commits). */
  function applyPreset(mesh, key) {
    const pr = MATERIAL_PRESETS[key];
    if (!pr || !mesh.userData.hs) return;
    const m = mesh.material;
    const isText = mesh.userData.kind === 'text';
    if (pr.color && !isText) m.color.set(pr.color);
    m.metalness = pr.metalness;
    m.roughness = pr.roughness;
    const base = isText ? mesh.userData.tx.color : '#' + m.color.getHexString();
    m.emissive.set(pr.glow ? base : '#000000');
    m.emissiveIntensity = pr.emissiveIntensity ?? 1;
    setOpacity(m, pr.opacity ?? 1);
    requestRender();
  }

  /** Temel şeklin detayını (segment) değiştirir. */
  function setSegments(mesh, seg) {
    mesh.userData.seg = seg;
    mesh.geometry.dispose();
    mesh.geometry = SHAPES[mesh.userData.kind].geo({ seg });
  }

  /** Nesne başına son doku isteği: geç biten eski yükleme yenisini (ya da kaldırılmış dokuyu) ezmesin. */
  const textureTokens = new WeakMap();

  /** Malzemenin dokusunu değiştirir; eskisini başka nesne kullanmıyorsa GPU'dan bırakır. */
  function setMap(mesh, tex) {
    const mat = mesh.material;
    const old = mat.map;
    if (old === tex) return;
    mat.map = tex;
    mat.needsUpdate = true;
    if (old && !world.children.some((o) => o !== mesh && o.material?.map === old)) old.dispose();
  }

  /**
   * Resim dosyasını malzemenin dokusu yapar (asenkron; pendingLoads ile izlenir).
   * Resolves true when applied (or superseded by a newer request), false when the image could not be decoded.
   */
  function applyTexture(mesh, blob) {
    const token = (textureTokens.get(mesh) || 0) + 1;
    textureTokens.set(mesh, token);
    if (!blob) {
      if (mesh.material.map) {
        setMap(mesh, null);
        requestRender();
      }
      return Promise.resolve(true);
    }
    const url = URL.createObjectURL(blob);
    const job = new THREE.TextureLoader()
      .loadAsync(url)
      .then((tex) => {
        if (textureTokens.get(mesh) !== token) {
          tex.dispose(); // bu arada başka doku istendi ya da doku kaldırıldı
          return true;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        setMap(mesh, tex);
        requestRender();
        return true;
      })
      .catch((e) => {
        console.error(e);
        toast(t('three.err.texture', 'Could not load texture: {name}', { name: blob.name || t('three.image', 'image') }));
        return false;
      })
      .finally(() => {
        URL.revokeObjectURL(url);
        pendingLoads.delete(job);
      });
    pendingLoads.add(job);
    return job;
  }

  const waitForLoads = () => Promise.all([...pendingLoads]);

  // ---------- seçim ve sahne işlemleri

  /** Verilen nesneyi (ya da onu içeren World çocuğunu) seçer; null seçimi kaldırır. */
  function selectObject(obj) {
    while (obj && obj.parent && obj.parent !== world) obj = obj.parent;
    selected = obj && obj.parent === world ? obj : null;
    if (selected) {
      gizmo.attach(selected);
      selectionBox.visible = true;
    } else {
      gizmo.detach();
      selectionBox.visible = false;
    }
    renderOutliner();
    renderProps();
    requestRender();
  }

  /** Araç çubuğundaki "Ekle" düğmeleri: seçili nesnenin yanına ekler ve seçer. */
  function addFromToolbar(kind) {
    if (kind === 'pointlight' || kind === 'spotlight') {
      if (lightCount() >= MAX_LIGHTS) return toast(t('three.light.max', 'At most {n} lights per scene (keeps the app fast)', { n: MAX_LIGHTS }));
      const l = makeLight(kind === 'spotlight' ? 'spot' : 'point');
      l.position.set(selected ? selected.position.x + 1.2 : 0, 3, 0);
      world.add(l);
      selectObject(l);
      commit();
      return;
    }
    const mesh = makeShape(kind);
    if (kind === 'text') {
      mesh.position.y = 1;
      if (selected) mesh.position.x = selected.position.x + 1.2;
    } else if (kind !== 'plane') {
      mesh.position.y = 0.5;
      if (selected) mesh.position.x = selected.position.x + 1.2;
    }
    world.add(mesh);
    selectObject(mesh);
    commit();
  }

  function removeObject(obj = selected) {
    if (!obj) return;
    world.remove(obj);
    selectObject(selected === obj ? null : selected);
    commit();
  }

  /** Makes an independent copy of a world object (not added to the scene). Same transform as the source. */
  function cloneObject(src) {
    let copy;
    if (src.userData.hl) {
      copy = makeLight(src.userData.light.kind, src.userData.light);
    } else if (src.userData.hs) {
      const mat = src.material;
      copy = makeShape(src.userData.kind, {
        seg: src.userData.seg,
        color: '#' + mat.color.getHexString(),
        metalness: mat.metalness,
        roughness: mat.roughness,
        emissive: '#' + mat.emissive.getHexString(),
        emissiveIntensity: mat.emissiveIntensity,
        opacity: mat.opacity,
        tx: src.userData.tx ? { ...src.userData.tx } : undefined,
        name: autoName(SHAPES[src.userData.kind].label),
      });
      copy.material.wireframe = mat.wireframe;
      // Kendi Texture nesnesi (görüntü ortak): dokusu değişince eskisi güvenle bırakılabilir.
      if (mat.map && src.userData.kind !== 'text') copy.material.map = mat.map.clone();
    } else {
      copy = src.clone(true);
      copy.name = t('three.copyName', '{name} copy', { name: src.name });
    }
    copy.position.copy(src.position);
    copy.quaternion.copy(src.quaternion);
    copy.scale.copy(src.scale);
    copy.visible = src.visible;
    // Canlı proje kimliği kopyaya geçmesin (yeni nesneye yeni kimlik verilir); doku yolu kalabilir.
    delete copy.userData.lid;
    if (src.userData.ltex) copy.userData.ltex = src.userData.ltex;
    return copy;
  }

  function duplicateObject(src = selected) {
    if (!src) return;
    if (src.userData.hl && lightCount() >= MAX_LIGHTS) return toast(t('three.light.max', 'At most {n} lights per scene (keeps the app fast)', { n: MAX_LIGHTS }));
    const copy = cloneObject(src);
    copy.position.x += 1;
    world.add(copy);
    selectObject(copy);
    commit();
    setGizmoMode('translate');
  }

  /**
   * Array tool: `count` copies of src, each offset by `spacing` more along `axis` ('x'|'y'|'z').
   * Adds the copies only (no undo step; the caller commits once). Returns the copies.
   */
  function arrayObject(src, { count = 3, axis = 'x', spacing = 1.5 } = {}) {
    if (!src || src.parent !== world) return [];
    const ax = ['x', 'y', 'z'].includes(axis) ? axis : 'x';
    const n = clamp(Math.round(+count || 0), 0, 100);
    const made = [];
    for (let i = 1; i <= n; i++) {
      if (src.userData.hl && lightCount() >= MAX_LIGHTS) {
        toast(t('three.light.max', 'At most {n} lights per scene (keeps the app fast)', { n: MAX_LIGHTS }));
        break;
      }
      const c = cloneObject(src);
      c.position[ax] += i * (+spacing || 0);
      world.add(c);
      made.push(c);
    }
    return made;
  }

  function toggleVisible(obj) {
    obj.visible = !obj.visible;
    commit();
    requestRender();
  }

  function dropToGround(obj) {
    const box = objectBox(obj);
    if (box.isEmpty()) return;
    obj.position.y -= box.min.y;
    syncTransformInputs();
    requestRender();
    commit();
  }

  // ---------- geri al / ileri al

  /** Sahnenin anlık görüntüsü (nesne referansları + değiştirilebilir alanlar). */
  function snapshot() {
    return world.children.map((o) => ({
      obj: o,
      name: o.name,
      visible: o.visible,
      position: o.position.toArray(),
      rotation: o.rotation.toArray(),
      scale: o.scale.toArray(),
      material: o.userData.hs
        ? {
            color: o.material.color.getHex(),
            metalness: o.material.metalness,
            roughness: o.material.roughness,
            wireframe: o.material.wireframe,
            seg: o.userData.seg,
            emissive: o.material.emissive.getHex(),
            emissiveIntensity: o.material.emissiveIntensity,
            opacity: o.material.opacity,
            tx: o.userData.tx ? { ...o.userData.tx } : null,
          }
        : null,
      light: o.userData.hl ? { ...o.userData.light } : null,
    }));
  }

  let history = [snapshot()];
  let historyIndex = 0;

  /** Kullanıcı değişikliğini canlı proje yöneticisine bildirir (src/live.js). */
  function emitChange() {
    bus.dispatchEvent(new CustomEvent('mode-change', { detail: { mode: 'm3d' } }));
  }

  /**
   * Geri alma adımı ekler. Olay dinleyicisi olarak da kullanılır (argüman Event olur); kullanıcı
   * işlemlerinde 'mode-change' yayınlanır, API'den gelen {silent:true} çağrılarda yayınlanmaz.
   */
  function commit(o) {
    const dropped = history.slice(historyIndex + 1); // redo states discarded by this new step
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot());
    if (history.length > UNDO_LIMIT) dropped.push(history.shift());
    historyIndex = history.length - 1;
    if (dropped.length) releaseDropped(dropped);
    renderOutliner();
    updateStatus();
    if (!o?.silent) emitChange();
  }

  /** Objects still reachable: in the scene or in any undo/redo state. */
  function reachableObjects() {
    const set = new Set(world.children);
    for (const state of history) for (const s of state) set.add(s.obj);
    return set;
  }

  /** Textures referenced by a material (map, normalMap, ...). */
  const texturesOf = (mat) => Object.values(mat).filter((v) => v && v.isTexture);

  /**
   * Frees the GPU resources (geometry, materials, textures, shadow maps) of objects that were only
   * referenced by the dropped history states. Resources still used by a reachable object (e.g. an
   * imported model copy sharing geometry/materials) are kept.
   */
  function releaseDropped(states) {
    const reach = reachableObjects();
    const gone = new Set();
    for (const state of states) for (const s of state) if (!reach.has(s.obj)) gone.add(s.obj);
    if (!gone.size) return;
    const used = new Set();
    for (const o of reach) {
      o.traverse((n) => {
        if (n.geometry) used.add(n.geometry);
        if (n.material) [].concat(n.material).forEach((m) => {
          used.add(m);
          texturesOf(m).forEach((tx) => used.add(tx));
        });
      });
    }
    const freed = new Set();
    const free = (r) => {
      if (!r || used.has(r) || freed.has(r)) return;
      freed.add(r);
      r.dispose();
    };
    for (const o of gone) {
      o.traverse((n) => {
        // A texture still loading for this mesh is dropped when it arrives (see applyTexture).
        if (textureTokens.has(n)) textureTokens.set(n, textureTokens.get(n) + 1);
        free(n.geometry);
        if (n.material) [].concat(n.material).forEach((m) => {
          texturesOf(m).forEach(free);
          free(m);
        });
        if (n.isLight && n.shadow) releaseShadow(n);
      });
    }
  }

  /** Disposes a light's shadow map; three recreates it lazily if the light casts shadows again. */
  function releaseShadow(lt) {
    const sh = lt.shadow;
    if (!sh || !sh.map) return;
    sh.dispose();
    sh.map = null;
    sh.mapPass = null;
  }

  function restore(state) {
    world.clear();
    for (const s of state) {
      const o = s.obj;
      o.name = s.name;
      o.visible = s.visible;
      o.position.fromArray(s.position);
      o.rotation.fromArray(s.rotation);
      o.scale.fromArray(s.scale);
      if (s.material) {
        o.material.color.setHex(s.material.color);
        o.material.metalness = s.material.metalness;
        o.material.roughness = s.material.roughness;
        o.material.wireframe = s.material.wireframe;
        o.material.emissive.setHex(s.material.emissive ?? 0);
        o.material.emissiveIntensity = s.material.emissiveIntensity ?? 1;
        setOpacity(o.material, s.material.opacity ?? 1);
        if (o.userData.seg !== s.material.seg) setSegments(o, s.material.seg);
        if (s.material.tx && JSON.stringify(o.userData.tx) !== JSON.stringify(s.material.tx)) setText(o, s.material.tx);
      }
      if (s.light) {
        o.userData.light = { ...s.light };
        syncLight(o);
      }
      world.add(o);
    }
    selectObject(selected && selected.parent === world ? selected : null);
    updateStatus();
  }

  function undo() {
    if (historyIndex > 0) {
      restore(history[--historyIndex]);
      emitChange();
    }
  }
  function redo() {
    if (historyIndex < history.length - 1) {
      restore(history[++historyIndex]);
      emitChange();
    }
  }

  // ---------- tıklayarak seçme (sürüklemeyle karışmaz)

  const raycaster = new THREE.Raycaster();
  let pointerStart = null;
  canvas.addEventListener('pointerdown', (e) => {
    // TransformControls kendi pointerdown dinleyicisini bizden önce eklediği için bu anda gizmo.axis
    // doludur; pointerup'ta ise onun dinleyicisi axis'i çoktan sıfırlamış olur. Bu yüzden burada kaydedilir.
    pointerStart = { x: e.clientX, y: e.clientY, button: e.button, onGizmo: !!(gizmo.axis || gizmo.dragging) };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!pointerStart || pointerStart.button !== 0) return;
    const moved = Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 4;
    const onGizmo = pointerStart.onGizmo;
    pointerStart = null;
    if (moved || onGizmo || gizmo.dragging || gizmo.axis) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      camera,
    );
    // The raycaster ignores visibility: accept a hit only if the mesh and every ancestor up to World are visible.
    const shown = (o) => {
      for (let n = o; n && n !== world; n = n.parent) if (!n.visible) return false;
      return true;
    };
    const hit = raycaster.intersectObjects(world.children, true).find((h) => shown(h.object));
    selectObject(hit ? hit.object : null);
  });

  // ---------- kamera görünümleri

  const VIEW_DIRS = { front: [0, 0, 1], right: [1, 0, 0], side: [1, 0, 0], top: [0, 1, 1e-4], persp: [0.55, 0.45, 0.7] };
  /** Presets that frame the scene: azimuth/elevation in degrees, distance as a multiple of the fit distance. */
  const FRAMED_VIEWS = {
    orbit: { az: 40, el: 28, dist: 1.15 },
    close: { az: 25, el: 14, dist: 0.7 },
    hero: { az: -35, el: -8, dist: 1.05, lift: 0.2 },
  };

  /**
   * World-space box of an object's real content, skipping editor-only helper gizmos (light marker /
   * spot cone, which are hidden in renders). Light-only objects give an empty box.
   */
  function contentBox(root) {
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    root.updateWorldMatrix(true, true);
    const walk = (n) => {
      if (n.userData?.helper) return;
      if (n.geometry) {
        if (n.boundingBox !== undefined) {
          // InstancedMesh / SkinnedMesh keep their own box
          if (n.boundingBox === null) n.computeBoundingBox();
          part.copy(n.boundingBox);
        } else {
          if (n.geometry.boundingBox === null) n.geometry.computeBoundingBox();
          part.copy(n.geometry.boundingBox);
        }
        part.applyMatrix4(n.matrixWorld);
        box.union(part);
      }
      n.children.forEach(walk);
    };
    walk(root);
    return box;
  }

  /** contentBox, falling back to the full box (helpers included) for helper-only objects such as lights. */
  function objectBox(obj) {
    const box = contentBox(obj);
    return box.isEmpty() ? new THREE.Box3().setFromObject(obj) : box;
  }

  /** Bounding box of the visible objects (or of one object); a small default box when the scene is empty. */
  function boundsOf(obj) {
    const box = new THREE.Box3();
    const list = obj ? [obj] : world.children.filter((o) => o.visible);
    list.forEach((o) => {
      const b = contentBox(o);
      if (!b.isEmpty()) box.union(b);
    });
    if (box.isEmpty() && obj) {
      // a light alone: frame a small box around its position
      const p = obj.getWorldPosition(new THREE.Vector3());
      box.setFromCenterAndSize(p, new THREE.Vector3(1, 1, 1));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /** Half-angle (radians) of the narrower field of view at the given aspect (used to fit a sphere). */
  const fitHalfFov = (aspect) => {
    const v = (camera.fov * DEG) / 2;
    return aspect >= 1 ? v : Math.atan(Math.tan(v) * aspect);
  };
  /** Identifies a framed pose independent of the orbit angle (the turntable keeps target, distance and fov). */
  const fitKey = (pos, target) => JSON.stringify([target.toArray().map((v) => round(v)), round(pos.distanceTo(target)), round(camera.fov)]);
  /** Last framed preset pose {key, halfFov}; null when none. */
  let presetFit = null;

  /**
   * Camera pose {position, target} for a named view. Framed presets (orbit/close/hero) fit the
   * given object, or the whole scene; the classic views keep the current target and distance.
   */
  function viewPose(view, obj = null) {
    if (view === 'side') view = 'right';
    if (FRAMED_VIEWS[view]) {
      const f = FRAMED_VIEWS[view];
      const box = boundsOf(obj);
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
      const halfFov = fitHalfFov(camera.aspect);
      const dist = (radius / Math.sin(halfFov)) * f.dist;
      const target = center.clone();
      if (f.lift) target.y += radius * f.lift;
      const az = f.az * DEG;
      const el = f.el * DEG;
      const pos = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(target);
      if (pos.y < 0.15) pos.y = 0.15; // never dip under the grid
      // Remember the fit: a render/video at another aspect (e.g. a portrait spin) is refitted in withRenderSize.
      presetFit = { key: fitKey(pos, target), halfFov };
      return { position: pos.toArray(), target: target.toArray() };
    }
    const dirArr = VIEW_DIRS[view];
    if (!dirArr) return null;
    const target = orbit.target.clone();
    const dist = Math.max(6, camera.position.distanceTo(target));
    const pos = target.clone().addScaledVector(new THREE.Vector3(...dirArr).normalize(), dist);
    return { position: pos.toArray(), target: target.toArray() };
  }

  function setView(view) {
    const pose = viewPose(view, selected && FRAMED_VIEWS[view] ? selected : null);
    if (!pose) return;
    orbit.target.fromArray(pose.target);
    camera.position.fromArray(pose.position);
    camera.lookAt(orbit.target);
    orbit.update();
    requestRender();
    emitChange();
  }

  // ---------- turntable preview: rotates only the camera, only while enabled

  let turntable = false;
  let turnRaf = 0;
  let turnLast = 0;
  const TURN_SECONDS = 24; // seconds per full revolution
  const turnOffset = new THREE.Vector3();

  function turnStep(now) {
    turnRaf = 0;
    if (!turntable || !active || recording) return;
    const dt = now - turnLast;
    if (dt >= 33) { // ~30 fps cap keeps a weak GPU relaxed
      turnLast = now;
      turnOffset.copy(camera.position).sub(orbit.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ((dt / 1000) * Math.PI * 2) / TURN_SECONDS);
      camera.position.copy(orbit.target).add(turnOffset);
      camera.lookAt(orbit.target);
      turnUpdating = true;
      try {
        orbit.update(); // fires 'change' -> requestRender()
      } finally {
        turnUpdating = false;
      }
    }
    turnRaf = requestAnimationFrame(turnStep);
  }

  function stopTurnLoop() {
    if (turnRaf) cancelAnimationFrame(turnRaf);
    turnRaf = 0;
  }

  function startTurnLoop() {
    stopTurnLoop();
    if (turntable && active && !recording) {
      turnLast = performance.now();
      turnRaf = requestAnimationFrame(turnStep);
    }
  }

  function setTurntable(on, { silent = false } = {}) {
    on = !!on;
    if (on === turntable) return;
    turntable = on;
    root.querySelector('#d-turn')?.classList.toggle('on', on);
    if (on) startTurnLoop();
    else stopTurnLoop();
    if (!silent) emitChange();
  }

  function focusSelected() {
    if (!selected) return;
    const box = objectBox(selected);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const dir = camera.position.clone().sub(orbit.target).normalize();
    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, size * 1.8 + 1);
    orbit.update();
    requestRender();
    emitChange();
  }

  // ---------- sahne listesi

  const outliner = $('#d-outl');

  function renderOutliner() {
    if (!world.children.length) {
      outliner.innerHTML = `<li class="empty" style="cursor:default">${esc(t('three.outliner.empty', 'Scene is empty. Add a shape from the left.'))}</li>`;
      return;
    }
    outliner.innerHTML = world.children
      .map(
        (o, i) =>
          `<li data-i="${i}" class="${o === selected ? 'sel' : ''} ${o.visible ? '' : 'hid'}">` +
          `<span class="nm">${esc(o.name)}</span>` +
          `<button class="eye" data-eye="${i}" title="${esc(t('three.outliner.toggle', 'Hide/Show (H)'))}">${o.visible ? '●' : '○'}</button></li>`,
      )
      .join('');
  }

  outliner.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const obj = world.children[+eye.dataset.eye];
      if (obj) toggleVisible(obj);
      return;
    }
    const li = e.target.closest('li[data-i]');
    if (li) selectObject(world.children[+li.dataset.i]);
  });

  // ---------- özellik paneli

  const propsPanel = $('#d-props');

  /** Sahne panelinden (kullanıcı) gelen ayar değişikliği: sakla, çiz, canlı projeye bildir. */
  function saveSceneSettings() {
    store.set('scene3d', sceneSettings);
    requestRender();
    emitChange();
  }

  /** Last used array tool values (spacing null = auto from the object size). */
  const arraySettings = { count: 3, axis: 'x', spacing: null };

  /** Seçim yoksa sahne ayarları, varsa nesne özellikleri. */
  function renderProps() {
    const obj = selected;
    if (!obj) {
      propsPanel.innerHTML = `<h3>${esc(t('three.scene.title', 'SCENE SETTINGS'))}</h3>
        <div class="row"><span>${esc(t('three.scene.background', 'Background'))}</span><input type="color" id="p-bg" value="${sceneSettings.bg}"></div>
        <div class="row"><span>${esc(t('three.scene.gradient', 'Gradient'))}</span><label class="chk"><input type="checkbox" id="p-bg2on" ${sceneSettings.bg2 ? 'checked' : ''}> ${esc(t('three.scene.gradient2', '2nd colour'))}</label><input type="color" id="p-bg2" value="${sceneSettings.bg2 || '#0b0c10'}" ${sceneSettings.bg2 ? '' : 'disabled'}></div>
        <div class="row"><span>${esc(t('three.scene.light', 'Light'))}</span><input type="range" id="p-light" min="0" max="4" step="0.1" value="${sceneSettings.light}"></div>
        <div class="row"><span>${esc(t('three.scene.grid', 'Grid'))}</span><label class="chk"><input type="checkbox" id="p-grid" ${sceneSettings.grid ? 'checked' : ''}> ${esc(t('three.scene.show', 'Show'))}</label></div>
        <div class="row"><span>${esc(t('three.scene.shadows', 'Shadows'))}</span><label class="chk"><input type="checkbox" id="p-sh" ${sceneSettings.shadows ? 'checked' : ''} ${settings.eco ? 'disabled' : ''}> ${esc(t('three.scene.on', 'On'))} ${settings.eco ? esc(t('three.scene.ecoOff', '(off in eco mode)')) : ''}</label></div>
        <p class="empty" style="margin:10px 0 0">${esc(t('three.scene.hint', 'Click an object to see its settings here.'))}</p>`;
      $('#p-bg').oninput = (e) => {
        sceneSettings.bg = e.target.value;
        applyBackground();
        saveSceneSettings();
      };
      $('#p-bg2on').onchange = (e) => {
        sceneSettings.bg2 = e.target.checked ? $('#p-bg2').value : null;
        $('#p-bg2').disabled = !e.target.checked;
        applyBackground();
        saveSceneSettings();
      };
      $('#p-bg2').oninput = (e) => {
        if (!sceneSettings.bg2) return;
        sceneSettings.bg2 = e.target.value;
        applyBackground();
        saveSceneSettings();
      };
      $('#p-light').oninput = (e) => {
        sceneSettings.light = +e.target.value;
        sunLight.intensity = sceneSettings.light;
        saveSceneSettings();
      };
      $('#p-grid').onchange = (e) => {
        sceneSettings.grid = e.target.checked;
        grid.visible = sceneSettings.grid;
        saveSceneSettings();
      };
      $('#p-sh').onchange = (e) => {
        sceneSettings.shadows = e.target.checked;
        applyQuality();
        saveSceneSettings();
      };
      return;
    }

    const isLight = !!obj.userData.hl;
    const isShape = !!obj.userData.hs;
    const isText = obj.userData.kind === 'text';
    const def = isShape && SHAPES[obj.userData.kind];
    const L = obj.userData.light;
    const mat = isShape ? obj.material : null;
    const xyzRow = (label, prop, step) =>
      `<div class="row"><span>${label}</span><div class="xyz" data-v="${prop}">` +
      `<input type="number" step="${step}"><input type="number" step="${step}"><input type="number" step="${step}"></div></div>`;
    const range = (label, id, min, max, step, value, title = '') =>
      `<div class="row"><span>${esc(label)}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" ${title ? `title="${esc(title)}"` : ''}></div>`;

    let body = '';
    if (isLight) {
      body = `<h3 style="margin-top:14px">${esc(t('three.light.title', 'LIGHT'))}</h3>
      <div class="row"><span>${esc(t('three.light.color', 'Colour'))}</span><input type="color" id="p-lcol" value="${L.color}"></div>
      ${range(t('three.light.intensity', 'Intensity'), 'p-lint', 0, 200, 1, L.intensity)}
      ${range(t('three.light.distance', 'Distance'), 'p-ldist', 0, 100, 0.5, L.distance || 0, t('three.light.distanceTip', '0 = unlimited'))}
      ${L.kind === 'spot' ? range(t('three.light.angle', 'Angle'), 'p-lang', 5, 89, 1, L.angle) + range(t('three.light.penumbra', 'Softness'), 'p-lpen', 0, 1, 0.01, L.penumbra) : ''}
      <p class="empty" style="margin:6px 0 0">${esc(t('three.light.hint', 'Shadows are only drawn when Shadows is on and eco mode is off.'))}</p>`;
    } else if (isShape) {
      const tx = obj.userData.tx;
      body = `${
        isText
          ? `<h3 style="margin-top:14px">${esc(t('three.text.title', 'TEXT'))}</h3>
      <div class="row"><span>${esc(t('three.text.text', 'Text'))}</span><textarea id="p-text" rows="2" style="width:100%;resize:vertical">${esc(tx.text)}</textarea></div>
      <div class="row"><span>${esc(t('three.text.font', 'Font'))}</span><input type="text" id="p-font" value="${esc(tx.font)}" list="p-fonts"><datalist id="p-fonts"><option value="Segoe UI"><option value="Arial"><option value="Georgia"><option value="Impact"><option value="Consolas"><option value="Times New Roman"><option value="Noto Sans"></datalist></div>
      <div class="row"><span>${esc(t('three.text.color', 'Text colour'))}</span><input type="color" id="p-col" value="${tx.color}"></div>
      <div class="row"><span>${esc(t('three.text.background', 'Background'))}</span><label class="chk"><input type="checkbox" id="p-tbgon" ${tx.background ? 'checked' : ''}> ${esc(t('three.text.bgOn', 'Fill'))}</label><input type="color" id="p-tbg" value="${tx.background || '#000000'}" ${tx.background ? '' : 'disabled'}></div>
      ${range(t('three.text.size', 'Size'), 'p-tsize', 0.1, 6, 0.05, tx.size)}`
          : ''
      }
      <h3 style="margin-top:14px">${esc(t('three.mat.title', 'MATERIAL'))}</h3>
      <div class="hs-presets" id="p-presets">${Object.keys(MATERIAL_PRESETS)
        .map((k) => `<button data-preset="${k}">${esc(t(...PRESET_LABELS[k]))}</button>`)
        .join('')}</div>
      ${isText ? '' : `<div class="row"><span>${esc(t('three.mat.color', 'Colour'))}</span><input type="color" id="p-col" value="#${mat.color.getHexString()}"></div>`}
      <div class="row"><span>${esc(t('three.mat.metalness', 'Metalness'))}</span><input type="range" id="p-met" min="0" max="1" step="0.01" value="${mat.metalness}"></div>
      <div class="row"><span>${esc(t('three.mat.roughness', 'Roughness'))}</span><input type="range" id="p-rou" min="0" max="1" step="0.01" value="${mat.roughness}"></div>
      <div class="row"><span>${esc(t('three.mat.emissive', 'Emissive'))}</span><input type="color" id="p-emi" value="#${mat.emissive.getHexString()}"></div>
      ${range(t('three.mat.emissiveIntensity', 'Glow power'), 'p-emii', 0, 5, 0.05, mat.emissiveIntensity)}
      ${range(t('three.mat.opacity', 'Opacity'), 'p-opa', 0, 1, 0.01, mat.opacity)}
      <div class="row"><span>${esc(t('three.mat.wireframe', 'Wireframe'))}</span><label class="chk"><input type="checkbox" id="p-wf" ${mat.wireframe ? 'checked' : ''}> ${esc(t('three.scene.show', 'Show'))}</label></div>
      ${
        def.curved
          ? `<div class="row"><span>${esc(t('three.mat.detail', 'Detail'))}</span><input type="range" id="p-seg" min="3" max="64" step="1" value="${obj.userData.seg}" title="${esc(t('three.mat.detailTip', 'Low = fewer polygons, lighter'))}"></div>`
          : ''
      }`;
    } else {
      body = `<p class="empty">${esc(t('three.imported', 'Imported model: uses its own material.'))}</p>`;
    }

    // Array tool: spacing defaults to the object's size along the axis plus a small gap.
    const autoSpacing = () => {
      const size = objectBox(obj).getSize(new THREE.Vector3());
      return round(Math.max(0.2, size[arraySettings.axis] * 1.1), 2);
    };
    const spacing = arraySettings.spacing ?? autoSpacing();

    propsPanel.innerHTML = `<h3>${esc(t('three.obj.title', 'OBJECT'))}</h3>
      <div class="row"><span>${esc(t('three.obj.name', 'Name'))}</span><input type="text" id="p-name" value="${esc(obj.name)}"></div>
      ${xyzRow(esc(t('three.obj.position', 'Position')), 'position', 0.1)}
      ${xyzRow(esc(t('three.obj.rotation', 'Rotation (°)')), 'rotation', 5)}
      ${xyzRow(esc(t('three.obj.scale', 'Scale')), 'scale', 0.1)}
      ${body}
      <h3 style="margin-top:14px">${esc(t('three.array.title', 'ARRAY'))}</h3>
      <div class="row"><span>${esc(t('three.array.copies', 'Copies'))}</span><input type="number" id="p-acount" min="1" max="100" step="1" value="${arraySettings.count}"></div>
      <div class="row"><span>${esc(t('three.array.axis', 'Axis'))}</span><select id="p-aaxis"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></div>
      <div class="row"><span>${esc(t('three.array.spacing', 'Spacing'))}</span><input type="number" id="p-aspace" step="0.1" value="${spacing}"></div>
      <div class="btns" style="margin-top:6px"><button id="p-array">${esc(t('three.array.make', 'Create array'))}</button></div>
      <div class="btns" style="margin-top:12px"><button id="p-dup">${esc(t('three.obj.duplicate', 'Duplicate'))}</button><button id="p-focus">${esc(t('three.obj.focus', 'Focus'))}</button><button id="p-ground">${esc(t('three.obj.ground', 'Drop to ground'))}</button><button id="p-del">${esc(t('three.obj.delete', 'Delete'))}</button></div>`;

    syncTransformInputs();

    $('#p-name').oninput = (e) => {
      obj.name = e.target.value;
      renderOutliner();
    };
    $('#p-name').onchange = commit;

    $$('.xyz', propsPanel).forEach((group) => {
      const prop = group.dataset.v;
      $$('input', group).forEach((input, axisIndex) => {
        input.oninput = () => {
          const v = parseFloat(input.value);
          if (isNaN(v)) return;
          obj[prop]['xyz'[axisIndex]] = prop === 'rotation' ? v * DEG : v;
          requestRender();
        };
        input.onchange = commit;
      });
    });

    // Slider/colour input helper: updates live, commits one undo step on release.
    const bind = (id, apply) => {
      const el = $('#' + id);
      if (!el) return;
      el.oninput = (e) => {
        apply(e.target);
        requestRender();
      };
      el.onchange = commit;
    };

    if (isLight) {
      const upd = (k, conv = (v) => +v) => (el) => {
        L[k] = conv(el.value);
        syncLight(obj);
      };
      bind('p-lcol', upd('color', (v) => v));
      bind('p-lint', upd('intensity'));
      bind('p-ldist', upd('distance'));
      bind('p-lang', upd('angle'));
      bind('p-lpen', upd('penumbra'));
    }

    if (isShape) {
      const col = $('#p-col');
      col.oninput = (e) => {
        if (isText) setText(obj, { color: e.target.value });
        else mat.color.set(e.target.value);
        requestRender();
      };
      col.onchange = commit;
      bind('p-met', (el) => (mat.metalness = +el.value));
      bind('p-rou', (el) => (mat.roughness = +el.value));
      bind('p-emi', (el) => mat.emissive.set(el.value));
      bind('p-emii', (el) => (mat.emissiveIntensity = +el.value));
      bind('p-opa', (el) => setOpacity(mat, +el.value));
      $('#p-wf').onchange = (e) => {
        mat.wireframe = e.target.checked;
        requestRender();
        commit();
      };
      $('#p-presets').onclick = (e) => {
        const b = e.target.closest('[data-preset]');
        if (!b) return;
        applyPreset(obj, b.dataset.preset);
        commit();
        renderProps();
      };
      const segInput = $('#p-seg');
      if (segInput) {
        segInput.oninput = (e) => {
          setSegments(obj, +e.target.value);
          requestRender();
          updateStatus();
        };
        segInput.onchange = commit;
      }
      if (isText) {
        const tbgOn = $('#p-tbgon');
        const tbg = $('#p-tbg');
        $('#p-text').oninput = (e) => {
          setText(obj, { text: e.target.value });
          requestRender();
        };
        $('#p-text').onchange = commit;
        $('#p-font').oninput = (e) => {
          setText(obj, { font: e.target.value });
          requestRender();
        };
        $('#p-font').onchange = commit;
        bind('p-tsize', (el) => setText(obj, { size: +el.value }));
        tbgOn.onchange = (e) => {
          tbg.disabled = !e.target.checked;
          setText(obj, { background: e.target.checked ? tbg.value : '' });
          requestRender();
          commit();
        };
        tbg.oninput = (e) => {
          if (!tbgOn.checked) return;
          setText(obj, { background: e.target.value });
          requestRender();
        };
        tbg.onchange = commit;
      }
    }

    // Array tool
    $('#p-aaxis').value = arraySettings.axis;
    $('#p-aaxis').onchange = (e) => {
      arraySettings.axis = e.target.value;
      if (arraySettings.spacing == null) $('#p-aspace').value = autoSpacing();
    };
    $('#p-acount').oninput = (e) => (arraySettings.count = clamp(Math.round(+e.target.value) || 1, 1, 100));
    $('#p-aspace').oninput = (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) arraySettings.spacing = v;
    };
    $('#p-array').onclick = () => {
      const made = arrayObject(obj, { count: arraySettings.count, axis: arraySettings.axis, spacing: +$('#p-aspace').value || spacing });
      if (!made.length) return;
      commit(); // one undo step for the whole array
      requestRender();
    };

    $('#p-dup').onclick = () => duplicateObject();
    $('#p-focus').onclick = focusSelected;
    $('#p-del').onclick = () => removeObject();
    $('#p-ground').onclick = () => dropToGround(obj);
  }

  /** Paneldeki konum/dönüş/ölçek kutularını nesneyle eşitler (odaktaki kutuya dokunmaz). */
  function syncTransformInputs() {
    if (!selected) return;
    $$('#d-props .xyz').forEach((group) => {
      const prop = group.dataset.v;
      $$('input', group).forEach((input, axisIndex) => {
        if (document.activeElement === input) return;
        const v = selected[prop]['xyz'[axisIndex]];
        input.value = prop === 'rotation' ? round(v / DEG, 1) : round(v);
      });
    });
  }

  // ---------- durum çubuğu

  function updateStatus() {
    if (!active) return;
    let triangles = 0;
    world.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    $('#st-left').textContent = t('three.status.counts', '{objects} objects · {tris} triangles', { objects: world.children.length, tris: Math.round(triangles).toLocaleString() });
    $('#st-right').textContent = settings.eco ? t('three.status.eco', 'Eco mode on: low resolution, no shadows') : t('three.status.full', 'Full quality');
  }

  // ---------- araç düğmeleri

  function setGizmoMode(mode) {
    gizmo.setMode(mode);
    qa('[data-tmode]').forEach((b) => b.classList.toggle('on', b.dataset.tmode === mode));
  }

  /** Buttons for the new tools are created here (index.html stays untouched). */
  function buildExtraUI() {
    if (!document.getElementById('hs-three-css')) {
      const st = document.createElement('style');
      st.id = 'hs-three-css';
      st.textContent =
        '.hs-presets{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px}.hs-presets button{padding:3px 8px;font-size:12px}' +
        '#m3d .row textarea{font:inherit;box-sizing:border-box}#m3d .row select{font:inherit}';
      document.head.appendChild(st);
    }
    const tools = $('#d-tools', root);
    const mk = (kind, label, svg) => {
      const b = document.createElement('button');
      b.dataset.add = kind;
      b.innerHTML = svg + esc(label);
      return b;
    };
    const ico = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${inner}</svg>`;
    const plane = tools.querySelector('[data-add="plane"]');
    plane.after(mk('text', t('three.add.text', 'Text'), ico('<path d="M5 6h14M12 6v13M9 19h6"/>')));
    const toolLbl = tools.querySelector('[data-tmode]').previousElementSibling;
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = t('three.add.lights', 'Lights');
    const pl = mk('pointlight', t('three.add.point', 'Point light'), ico('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'));
    const sl = mk('spotlight', t('three.add.spot', 'Spot light'), ico('<path d="M8 3h8l-2 5h-4zM10 8 4 21M14 8l6 13"/>'));
    toolLbl.before(lbl, pl, sl);

    const ov = $('.vp-ov', root);
    const view = (v, label, title) => {
      const b = document.createElement('button');
      b.dataset.view = v;
      b.textContent = label;
      b.title = title;
      return b;
    };
    ov.append(
      view('orbit', t('three.view.orbit', 'Orbit 3/4'), t('three.view.orbitTip', 'Three-quarter view of the scene')),
      view('close', t('three.view.close', 'Close-up'), t('three.view.closeTip', 'Close-up of the selection (or the scene)')),
      view('hero', t('three.view.hero', 'Hero low'), t('three.view.heroTip', 'Low angle looking up, for a heroic look')),
    );
    const turn = document.createElement('button');
    turn.id = 'd-turn';
    turn.textContent = t('three.view.turntable', 'Turntable');
    turn.title = t('three.view.turntableTip', 'Slowly rotate the camera (preview only). Idle cost is zero when off.');
    turn.onclick = () => setTurntable(!turntable);
    ov.append(turn);
  }
  buildExtraUI();

  qa('[data-tmode]').forEach((b) => (b.onclick = () => setGizmoMode(b.dataset.tmode)));

  q('#d-snap').onclick = (e) => {
    snapOn = !snapOn;
    e.currentTarget.classList.toggle('on', snapOn);
    gizmo.setTranslationSnap(snapOn ? 0.5 : null);
    gizmo.setRotationSnap(snapOn ? 15 * DEG : null);
    gizmo.setScaleSnap(snapOn ? 0.25 : null);
    toast(snapOn ? t('three.snap.on', 'Snap on: 0.5 units, 15°') : t('three.snap.off', 'Snap off'));
  };

  qa('[data-add]').forEach((b) => (b.onclick = () => addFromToolbar(b.dataset.add)));
  qa('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  q('#d-wire').onclick = (e) => {
    scene.overrideMaterial = scene.overrideMaterial ? null : wireOverlayMaterial;
    e.currentTarget.classList.toggle('on', !!scene.overrideMaterial);
    requestRender();
  };
  q('#d-undo').onclick = undo;
  q('#d-redo').onclick = redo;

  // ---------- içe aktarma / proje dosyası

  const gltfLoader = new GLTFLoader();
  const parseGLTF = (data) => new Promise((resolve, reject) => gltfLoader.parse(data, '', (g) => resolve(g.scene), reject));

  /** Dosyayı uzantısına göre okuyup Object3D döner. */
  async function loadModelFile(file, nameHint) {
    const ext = extOf(file.name || nameHint || '');
    if (ext === 'glb' || ext === 'gltf') return parseGLTF(ext === 'glb' ? await file.arrayBuffer() : await file.text());
    if (ext === 'obj') {
      const obj = new OBJLoader().parse(await file.text());
      obj.traverse((m) => {
        if (m.isMesh) {
          m.material = importedMaterial();
          m.castShadow = m.receiveShadow = true;
        }
      });
      return obj;
    }
    if (ext === 'stl') {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, importedMaterial());
      mesh.castShadow = mesh.receiveShadow = true;
      return mesh;
    }
    throw new Error(t('three.err.fileType', 'Unsupported file type: {ext}', { ext }));
  }

  /**
   * Yüklenen modeli bir gruba sarıp World'e ekler.
   * fit verilirse en büyük boyut fit birim olur; verilmezse çok büyük/küçük modeller otomatik ölçeklenir.
   */
  function addImported(model, fileName, fit) {
    const group = new THREE.Group();
    group.add(model);
    const box = new THREE.Box3().setFromObject(model);
    if (fit > 0 && !box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) group.scale.setScalar(fit / maxDim);
    } else if (!box.isEmpty()) {
      const diag = box.getSize(new THREE.Vector3()).length();
      if (diag > 300 || (diag > 0 && diag < 0.02)) {
        group.scale.setScalar(4 / diag);
        toast(t('three.imp.rescaled', 'Model was too big/small; scaled to fit the scene'));
      }
    }
    group.name = autoName(stripExt(baseName(fileName || t('three.defaultModel', 'Model'))));
    // Sığdırma çarpanı: canlı projede "scale" bu çarpana göre yazılır/okunur (live-3d.js).
    group.userData.lbase = group.scale.x;
    world.add(group);
    return group;
  }

  /** Proje GLB'sinden World çocuklarını geri kurar (temel şekiller düzenlenebilir hâle döner). */
  function rebuildFromProject(loadedScene) {
    const src = loadedScene.getObjectByName('HS_World') || loadedScene;
    const result = [];
    let lights = 0;
    let skippedLights = 0;
    for (const child of [...src.children]) {
      const ud = child.userData || {};
      if (ud.hl && ud.light) {
        if (lights >= MAX_LIGHTS) {
          skippedLights++;
          continue;
        }
        lights++;
        // Lights are rebuilt from userData.light (gizmo meshes and the exported light node are discarded).
        const g = makeLight(ud.light.kind, ud.light, ud.nm || child.name);
        g.position.copy(child.position);
        g.quaternion.copy(child.quaternion);
        g.scale.copy(child.scale);
        g.visible = ud.vis !== false;
        if (ud.lid != null) g.userData.lid = ud.lid;
        result.push(g);
        continue;
      }
      // Eski kayıtlarda tel kafes şekiller LINES olarak yazılmış olabilir (LineSegments olarak okunur).
      if (ud.hs && SHAPES[ud.kind] && (child.isMesh || child.isLine)) {
        const cm = child.material || {};
        // Material extras are stored in userData.mx (the glTF emissive strength/alpha round trip is lossy).
        const mx = ud.mx || {};
        const mesh = makeShape(ud.kind, {
          seg: ud.seg,
          color: cm.color ? '#' + cm.color.getHexString() : undefined,
          metalness: cm.metalness,
          roughness: cm.roughness,
          emissive: mx.e ?? (cm.emissive ? '#' + cm.emissive.getHexString() : undefined),
          emissiveIntensity: mx.ei,
          opacity: mx.op ?? cm.opacity,
          tx: ud.tx,
          name: ud.nm || child.name,
        });
        mesh.material.wireframe = ud.wf != null ? !!ud.wf : !!cm.wireframe || !!child.isLine;
        if (cm.map && ud.kind !== 'text') mesh.material.map = cm.map;
        mesh.position.copy(child.position);
        mesh.quaternion.copy(child.quaternion);
        mesh.scale.copy(child.scale);
        // glTF görünürlük taşımaz; kayıtta userData.vis olarak saklanır.
        mesh.visible = ud.vis !== false;
        // Canlı proje kimliği ve doku yolu (live-3d.js) korunur.
        if (ud.lid != null) mesh.userData.lid = ud.lid;
        if (ud.ltex) mesh.userData.ltex = ud.ltex;
        result.push(mesh);
      } else {
        if (ud.nm) child.name = ud.nm;
        child.visible = ud.vis !== false;
        child.traverse((m) => {
          if (m.isMesh) m.castShadow = m.receiveShadow = true;
        });
        result.push(child);
      }
    }
    if (skippedLights) toast(t('three.light.max', 'At most {n} lights per scene (keeps the app fast)', { n: MAX_LIGHTS }));
    return result;
  }

  async function saveProjectBlob() {
    await waitForLoads();
    // GLTF düğüm adları değişebildiği için asıl adı userData'da da saklarız.
    // glTF görünürlük taşımaz, tel kafes malzemeyi de bozuk LINES olarak yazar: ikisi userData'da saklanır
    // ve dışa aktarma süresince tel kafes kapatılır (finally'de geri alınır).
    const wired = [];
    // Light gizmo meshes are editor-only: detach them while writing the file.
    const detached = helperMeshes().map((h) => [h.parent, h]);
    detached.forEach(([par, h]) => par.remove(h));
    world.children.forEach((o) => {
      o.userData.nm = o.name;
      o.userData.vis = o.visible;
      if (o.userData.hs && o.material) {
        const m = o.material;
        o.userData.mx = { e: '#' + m.emissive.getHexString(), ei: m.emissiveIntensity, op: m.opacity };
        o.userData.wf = !!o.material.wireframe;
        if (o.material.wireframe) {
          o.material.wireframe = false;
          wired.push(o);
        }
      }
    });
    try {
      const data = await new GLTFExporter().parseAsync(world, { binary: true, onlyVisible: false });
      return new Blob([data], { type: 'model/gltf-binary' });
    } finally {
      wired.forEach((o) => (o.material.wireframe = true));
      detached.forEach(([par, h]) => par.add(h));
    }
  }

  async function openProjectBlob(blob, silent = false) {
    const buf = blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer();
    const objs = rebuildFromProject(await parseGLTF(buf));
    world.clear();
    objs.forEach((o) => world.add(o));
    selectObject(null);
    commit({ silent });
  }

  async function exportBlob(format) {
    await waitForLoads();
    const visible = world.children.filter((o) => o.visible);
    if (!visible.length) return null;
    const group = new THREE.Group();
    visible.forEach((o) => group.add(o.clone(true)));
    // Drop editor-only light gizmos from the exported copy.
    const gizmos = [];
    group.traverse((o) => o.userData.helper && gizmos.push(o));
    gizmos.forEach((o) => o.parent.remove(o));
    // Editor userData (absolute source paths, live ids, light params...) must not leak into the file as glTF extras.
    group.traverse((o) => (o.userData = {}));
    group.updateMatrixWorld(true);
    if (format === 'obj') return new Blob([new OBJExporter().parse(group)], { type: 'text/plain' });
    if (format === 'stl') return new Blob([new STLExporter().parse(group, { binary: true })], { type: 'model/stl' });
    if (format === 'glb') {
      // Tel kafes malzeme GLB'ye bozuk LINES olarak yazılır: klonlarda malzemeyi kopyalayıp katı yaz.
      group.traverse((m) => {
        if (!m.isMesh || !m.material) return;
        const fix = (mat) => {
          if (!mat?.wireframe) return mat;
          const c = mat.clone();
          c.wireframe = false;
          return c;
        };
        m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material);
      });
      const data = await new GLTFExporter().parseAsync(group, { binary: true });
      return new Blob([data], { type: 'model/gltf-binary' });
    }
    throw new Error(t('three.err.format', 'Unknown format: {format}', { format }));
  }

  /** platform.saveAs + toast. Kaydedilen yolu (ya da null) döner. */
  async function saveWithToast(blob, name, message) {
    try {
      const path = await platform.saveAs(blob, name);
      if (path) toast(message ? message(baseName(path)) : t('three.saved', 'Saved: {name}', { name: baseName(path) }), 4000);
      return path;
    } catch (e) {
      console.error(e);
      toast(t('three.err.save', 'Could not save: {name}', { name }));
      return null;
    }
  }

  q('#d-import').onclick = async () => {
    const files = await platform.openFiles('.glb,.gltf,.obj,.stl');
    let added = 0;
    for (const f of files) {
      try {
        const g = addImported(await loadModelFile(f), f.name);
        // Masaüstünde dosyanın diskteki yolu bilinir: canlı proje "model" alanına yazılabilsin.
        if (f.path) g.userData.lsrc = f.path;
        added++;
      } catch (e) {
        toast(t('three.err.open', 'Could not open: {name}', { name: f.name }));
        console.error(e);
      }
    }
    if (added) {
      selectObject(world.children[world.children.length - 1]);
      commit();
    }
  };

  q('#d-open').onclick = async () => {
    const [file] = await platform.openFiles('.glb', false);
    if (!file) return;
    try {
      await openProjectBlob(file);
      toast(t('three.project.opened', 'Project opened: {name}', { name: file.name }));
    } catch (e) {
      toast(t('three.project.openFail', 'Could not open project'));
      console.error(e);
    }
  };

  q('#d-save').onclick = async () => {
    if (!world.children.length) return toast(t('three.sceneEmpty', 'Scene is empty'));
    await saveWithToast(
      await saveProjectBlob(),
      'proje.glb',
      (n) => t('three.project.saved', 'Saved: {name} (you can keep editing later with "Open")', { name: n }),
    );
  };

  qa('[data-exp]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.closest('details').open = false;
        const format = b.dataset.exp;
        try {
          const blob = await exportBlob(format);
          if (!blob) return toast(t('three.export.none', 'No visible objects to export'));
          await saveWithToast(blob, 'model.' + format, (n) =>
            format === 'obj' ? t('three.export.objReady', '{name} ready. Roblox Studio: Avatar > Import 3D', { name: n }) : t('three.export.done', 'Exported: {name}', { name: n }),
          );
        } catch (e) {
          console.error(e);
          toast(t('three.export.fail', 'Export failed'));
        }
      }),
  );

  // ---------- ekran dışı çizim (PNG / video)

  // Aynı anda tek bir ekran dışı çizim (PNG ve kayıt boyutu değiştirdiği için sıraya girer).
  let offscreenQueue = Promise.resolve();
  function exclusive(fn) {
    const run = offscreenQueue.then(fn, fn);
    offscreenQueue = run.catch(() => {});
    return run;
  }

  /**
   * Çiziciyi geçici olarak w×h boyutuna alır, yardımcıları (ızgara, seçim kutusu, gizmo, tel kafes)
   * gizler, fn'i çalıştırır ve her şeyi geri koyar.
   */
  async function withRenderSize(w, h, fn) {
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevRatio = renderer.getPixelRatio();
    stopTurnLoop();
    const helpers = [grid, selectionBox, gizmoHelper, ...helperMeshes()];
    const helperVis = helpers.map((o) => o.visible);
    const prevOverride = scene.overrideMaterial;
    helpers.forEach((o) => (o.visible = false));
    scene.overrideMaterial = null;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    // Ekranda gerilmiş görünmesin: kayıt boyunca tuvali oranını koruyarak sığdır.
    renderer.domElement.style.objectFit = "contain";
    renderer.domElement.style.background = "#000";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // A framed preset (orbit/close/hero) was fitted at the viewport aspect: when the output is narrower
    // (e.g. a 9:16 spin) move the camera back so the scene is not cropped; restored afterwards.
    const prevCamPos = camera.position.clone();
    if (presetFit && fitKey(camera.position, orbit.target) === presetFit.key) {
      const half = fitHalfFov(w / h);
      if (half > 0 && half < presetFit.halfFov) {
        const k = Math.sin(presetFit.halfFov) / Math.sin(half);
        camera.position.sub(orbit.target).multiplyScalar(k).add(orbit.target);
        camera.updateMatrixWorld();
      }
    }
    try {
      return await fn();
    } finally {
      camera.position.copy(prevCamPos);
      camera.updateMatrixWorld();
      helpers.forEach((o, i) => (o.visible = helperVis[i]));
      startTurnLoop();
      scene.overrideMaterial = prevOverride;
      renderer.setPixelRatio(prevRatio);
      renderer.domElement.style.objectFit = "";
      renderer.domElement.style.background = "";
      const vw = viewport.clientWidth || prevSize.x;
      const vh = viewport.clientHeight || prevSize.y;
      if (vw && vh) {
        renderer.setSize(vw, vh);
        camera.aspect = vw / vh;
        camera.updateProjectionMatrix();
      }
      requestRender();
    }
  }

  /** Çizimden hemen sonra çağrılmalı (preserveDrawingBuffer kapalı). */
  function canvasToBlob(type = 'image/png') {
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        if (blob) return resolve(blob);
        resolve(await (await fetch(canvas.toDataURL(type))).blob());
      }, type);
    });
  }

  async function renderPNG(w = 1920, h = 1080) {
    await waitForLoads();
    return exclusive(() =>
      withRenderSize(w, h, () => {
        renderer.render(scene, camera);
        return canvasToBlob('image/png'); // kopya toBlob çağrısı anında alınır
      }),
    );
  }

  /**
   * Kamerayı hedef etrafında döndürerek video kaydeder. İptal edilirse ya da kayıt
   * desteklenmiyorsa null döner. Kare ilerlemesi gerçek zamana bağlıdır (performance.now).
   */
  async function recordSpin({ seconds = 6, width = 1280, height = 720, fps = 30, turns = 1, onProgress } = {}) {
    const mime = pickMime(RECORD_MIMES);
    if (mime == null || typeof canvas.captureStream !== 'function') {
      toast(t('three.rec.unsupported', 'This browser does not support video recording'));
      return null;
    }
    await waitForLoads();
    width = Math.max(2, Math.round(width / 2) * 2);
    height = Math.max(2, Math.round(height / 2) * 2);
    fps = Math.max(1, Math.min(60, fps));
    const durationMs = Math.max(0.1, seconds) * 1000;

    return exclusive(() =>
      withRenderSize(width, height, () => new Promise((resolve) => {
        if (frameRequest) {
          cancelAnimationFrame(frameRequest);
          frameRequest = 0;
        }
        recording = true;

        // Mümkünse kareleri elle it (requestFrame): yalnız çizdiğimiz kareler kaydedilir.
        let stream = canvas.captureStream(0);
        let track = stream.getVideoTracks()[0];
        const manualFrames = track && typeof track.requestFrame === 'function';
        if (!manualFrames) {
          stream.getTracks().forEach((t) => t.stop());
          stream = canvas.captureStream(fps);
          track = stream.getVideoTracks()[0];
        }

        const bitrate = Math.round(Math.min(12e6, Math.max(3e6, 5e6 * ((width * height) / (1280 * 720)))));
        let recorder;
        try {
          recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : {});
        } catch (e) {
          console.error(e);
          stream.getTracks().forEach((t) => t.stop());
          recording = false;
          toast(t('three.rec.startFail', 'Could not start video recording'));
          resolve(null);
          return;
        }

        const chunks = [];
        let cancelled = false;
        let finished = false;
        const target = orbit.target.clone();
        const offset = camera.position.clone().sub(target);
        const startPos = camera.position.clone();

        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          recording = false;
          busy.hide();
          resolve(cancelled || !chunks.length ? null : new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' }));
        };
        recorder.onerror = (e) => {
          console.error(e);
          cancelled = true;
          finish();
        };

        busy.show(t('three.rec.busy', 'Recording turntable video'), () => {
          cancelled = true;
        });

        const frameMs = 1000 / fps;
        let startTime = 0;
        let nextFrameAt = 0;
        let rafId = 0;
        let timerId = 0;

        // rAF (görünür pencerede vsync'e hizalı) + zamanlayıcı yedeği; hangisi önce gelirse.
        const schedule = () => {
          const wait = Math.max(1, nextFrameAt - performance.now());
          rafId = requestAnimationFrame(tick);
          timerId = setTimeout(tick, wait);
        };

        function finish() {
          if (finished) return;
          finished = true;
          cancelAnimationFrame(rafId);
          clearTimeout(timerId);
          camera.position.copy(startPos);
          camera.lookAt(target);
          orbit.update();
          setTimeout(() => {
            if (recorder.state !== 'inactive') recorder.stop();
            else recorder.onstop();
          }, 120);
        }

        function tick() {
          cancelAnimationFrame(rafId);
          clearTimeout(timerId);
          if (finished) return;
          const now = performance.now();
          if (cancelled) return finish();
          if (now + 1 < nextFrameAt) return schedule(); // fps sınırı: henüz erken
          const p = Math.min(1, (now - startTime) / durationMs);
          const angle = p * turns * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          camera.position.set(
            target.x + offset.x * cos - offset.z * sin,
            target.y + offset.y,
            target.z + offset.x * sin + offset.z * cos,
          );
          camera.lookAt(target);
          renderer.render(scene, camera);
          if (manualFrames) track.requestFrame();

          busy.progress(p, t('three.rec.remaining', '{s} s left', { s: Math.ceil(seconds - p * seconds) }));
          try {
            onProgress?.(p);
          } catch {}

          nextFrameAt += frameMs;
          if (nextFrameAt < now) nextFrameAt = now + frameMs; // geride kaldıysa yetişmeye çalışma
          if (p >= 1) finish();
          else schedule();
        }

        recorder.start(1000);
        startTime = nextFrameAt = performance.now();
        tick();
      })),
    );
  }

  q('#d-png').onclick = async () => {
    await saveWithToast(await renderPNG(), 'render.png', (n) => t('three.png.saved', '{name} saved (1920×1080)', { name: n }));
  };

  qa('[data-send]').forEach(
    (b) =>
      (b.onclick = async () => {
        b.closest('details').open = false;
        if (!world.children.length) return toast(t('three.addSomethingFirst', 'Add something to the scene first'));
        const [w, h] = String(store.get('vproj', { res: '1080x1920' }).res || '1080x1920')
          .split('x')
          .map(Number);
        if (b.dataset.send === 'still') {
          const blob = await renderPNG(w, h);
          bus.dispatchEvent(new CustomEvent('to-video', { detail: { blob, name: '3D görüntü.png', type: 'image' } }));
        } else {
          // Kayıt hafif kalsın: uzun kenar en fazla 1280.
          const k = 1280 / Math.max(w, h);
          const blob = await recordSpin({
            seconds: 6,
            width: Math.round((w * k) / 2) * 2,
            height: Math.round((h * k) / 2) * 2,
          });
          if (blob) {
            const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
            bus.dispatchEvent(new CustomEvent('to-video', { detail: { blob, name: `3D döner.${ext}`, type: 'video' } }));
          }
        }
      }),
  );

  // ---------- kısayollar

  addEventListener('keydown', (e) => {
    if (!active || isTyping(e) || !$('#help').hidden) return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      return undo();
    }
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      return redo();
    }
    if (ctrl) return;
    if (key === 'g') setGizmoMode('translate');
    else if (key === 'r') setGizmoMode('rotate');
    else if (key === 's') setGizmoMode('scale');
    else if (key === 'x' || key === 'delete') removeObject();
    else if (key === 'd' && e.shiftKey) duplicateObject();
    else if (key === 'f') focusSelected();
    else if (key === 'h' && selected) toggleVisible(selected);
    else if (key === 'escape') selectObject(null);
    else if (key === '1') setView('front');
    else if (key === '3') setView('right');
    else if (key === '7') setView('top');
    else return;
    e.preventDefault();
  });

  // ---------- açılır menüler (details.menu): konumlandır, dışarı tıklayınca kapat

  document.addEventListener('click', (e) => {
    $$('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.open = false;
    });
  });
  // "toggle" kabarcıklanmaz; yakalama aşamasında dinleyince sonradan eklenen menüler de çalışır.
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('menu') || !d.open) return;
      const summary = d.querySelector('summary');
      const pop = d.querySelector('.pop');
      if (!summary || !pop) return;
      const r = summary.getBoundingClientRect();
      pop.style.left = Math.min(r.left, innerWidth - 230) + 'px';
      pop.style.top = r.bottom + 4 + 'px';
    },
    true,
  );

  // ---------- API yardımcıları

  /** addShape/update seçeneklerini nesneye uygular. */
  function applyOptions(obj, opts = {}) {
    if (opts.name != null) obj.name = String(opts.name);
    if (opts.position) obj.position.fromArray(opts.position);
    if (opts.rotation) obj.rotation.set(opts.rotation[0] * DEG, opts.rotation[1] * DEG, opts.rotation[2] * DEG);
    if (opts.scale != null) obj.scale.fromArray(toVec3(opts.scale));
    if (opts.visible != null) obj.visible = !!opts.visible;
    if (obj.userData.hl) {
      const L = obj.userData.light;
      if (opts.color != null) L.color = hex6(opts.color);
      for (const k of ['intensity', 'distance', 'angle', 'penumbra']) {
        if (opts[k] != null && Number.isFinite(+opts[k]) && k in L) L[k] = +opts[k];
      }
      syncLight(obj);
    }
    if (obj.userData.hs) {
      const m = obj.material;
      const isText = obj.userData.kind === 'text';
      if (isText) {
        // For text, "color" is the text colour; text/font/background/size rebuild the texture once.
        const patch = {};
        if (opts.color != null) patch.color = hex6(opts.color);
        if (opts.text != null) patch.text = String(opts.text);
        if (opts.font != null) patch.font = String(opts.font);
        if (opts.background !== undefined) patch.background = opts.background ? hex6(opts.background) : '';
        if (opts.size != null && Number.isFinite(+opts.size)) patch.size = +opts.size;
        if (Object.keys(patch).length) setText(obj, patch);
      } else if (opts.color != null) m.color.set(opts.color);
      if (opts.metalness != null) m.metalness = +opts.metalness;
      if (opts.roughness != null) m.roughness = +opts.roughness;
      if (opts.emissive != null) m.emissive.set(opts.emissive);
      if (opts.emissiveIntensity != null) m.emissiveIntensity = +opts.emissiveIntensity;
      if (opts.opacity != null) setOpacity(m, +opts.opacity);
      if (opts.wireframe != null) m.wireframe = !!opts.wireframe;
      if (opts.detail != null && SHAPES[obj.userData.kind].curved) {
        const seg = Math.max(3, Math.min(64, Math.round(opts.detail)));
        if (seg !== obj.userData.seg) setSegments(obj, seg);
      }
      if (opts.texture !== undefined && !isText) return applyTexture(obj, opts.texture);
    }
    return null;
  }

  /** API çağrısından sonra arayüzü tazeler. */
  function refreshUI(obj) {
    renderOutliner();
    if (!obj || obj === selected) renderProps();
    updateStatus();
    requestRender();
  }

  const api = {
    clear() {
      world.clear();
      selectObject(null);
      commit({ silent: true });
    },

    /** Nesneyi sahneden kaldırır (geri alma adımı için ardından commit() çağrılmalı). */
    remove(obj) {
      if (!obj || obj.parent !== world) return;
      world.remove(obj);
      if (selected === obj) selectObject(null);
      refreshUI();
    },

    /** Kalıcı canlı proje kimliğiyle (userData.lid) nesne bulur. */
    byId: (lid) => world.children.find((o) => o.userData.lid === lid) || null,

    addShape(kind, opts = {}) {
      const isText = kind === 'text';
      const mesh = makeShape(kind, {
        seg: opts.detail ? Math.max(3, Math.min(64, Math.round(opts.detail))) : undefined,
        // Doku verilip renk verilmediyse doku renkleri bozulmasın diye beyaz.
        color: opts.color || (opts.texture && !isText ? '#ffffff' : undefined),
        metalness: opts.metalness,
        roughness: opts.roughness,
        name: opts.name,
      });
      if (kind !== 'plane') mesh.position.y = isText ? 1 : 0.5;
      // For text, "color" (text colour) is applied by applyOptions together with text/font/background/size.
      applyOptions(mesh, { ...opts, name: undefined, color: isText ? opts.color : undefined, detail: undefined });
      world.add(mesh);
      refreshUI(mesh);
      return mesh;
    },

    /** Adds a point/spot light object: opts {name, position, rotation, color, intensity, distance, angle, penumbra, visible}. */
    addLight(kind, opts = {}) {
      if (lightCount() >= MAX_LIGHTS) throw new Error(t('three.light.max', 'At most {n} lights per scene (keeps the app fast)', { n: MAX_LIGHTS }));
      const l = makeLight(kind, opts, opts.name);
      l.position.set(0, 3, 0);
      applyOptions(l, { ...opts, name: undefined });
      world.add(l);
      refreshUI(l);
      return l;
    },

    /** Array tool: adds \`count\` copies of obj along axis (caller commits; one undo step). */
    array(obj, opts = {}) {
      const made = arrayObject(obj, opts);
      refreshUI();
      return made;
    },

    applyPreset(obj, key) {
      applyPreset(obj, key);
      refreshUI(obj);
    },
    presets: () => Object.keys(MATERIAL_PRESETS),

    /** Camera pose {position, target} for a named view (front/right/top/persp/orbit/close/hero); whole scene, no selection. */
    cameraPose: (view) => viewPose(view, null),
    setTurntable: (on) => setTurntable(on, { silent: true }),

    async importModel(file, opts = {}) {
      const name = file.name || opts.name || 'model';
      const group = addImported(await loadModelFile(file, name), name, opts.fit);
      if (opts.name) group.name = opts.name;
      if (opts.position) group.position.fromArray(opts.position);
      if (opts.rotation) group.rotation.set(opts.rotation[0] * DEG, opts.rotation[1] * DEG, opts.rotation[2] * DEG);
      if (opts.scale != null) {
        const s = toVec3(opts.scale);
        group.scale.multiply(new THREE.Vector3(s[0], s[1], s[2]));
      }
      if (opts.visible != null) group.visible = !!opts.visible;
      refreshUI(group);
      return group;
    },

    /** Returns the texture job (resolves true/false: applied / could not decode) when opts.texture is given, else null. */
    update(obj, opts = {}) {
      if (!obj) return null;
      // addShape ile tutarlı: doku verilip renk verilmediyse doku renkleri bozulmasın diye beyaz.
      const whiten = obj.userData.hs && opts.texture && opts.color == null;
      const job = applyOptions(obj, whiten ? { ...opts, color: '#ffffff' } : opts);
      refreshUI(obj);
      return job;
    },

    select: (obj) => selectObject(obj || null),
    selected: () => selected,
    objects: () => [...world.children],

    setScene(opts = {}) {
      if (opts.background != null) {
        sceneSettings.bg = '#' + new THREE.Color(opts.background).getHexString();
      }
      // background2: second gradient colour; null / '' / false clears the gradient.
      if (opts.background2 !== undefined) sceneSettings.bg2 = opts.background2 ? '#' + new THREE.Color(opts.background2).getHexString() : null;
      if (opts.background != null || opts.background2 !== undefined) applyBackground();
      if (opts.turntable != null) setTurntable(!!opts.turntable, { silent: true });
      if (opts.grid != null) grid.visible = sceneSettings.grid = !!opts.grid;
      if (opts.light != null) sunLight.intensity = sceneSettings.light = +opts.light;
      if (opts.ambient != null) hemiLight.intensity = sceneSettings.ambient = +opts.ambient;
      if (opts.shadows != null) {
        sceneSettings.shadows = !!opts.shadows;
        applyQuality();
      }
      // Canlı projenin sahne ayarları kalıcı genel tercihe yazılmaz (persist:false; live-3d.js).
      if (opts.persist !== false) store.set('scene3d', sceneSettings);
      if (!selected) renderProps();
      requestRender();
    },

    setCamera(opts = {}) {
      if (opts.fov != null) {
        camera.fov = +opts.fov;
        camera.updateProjectionMatrix();
      }
      if (opts.target) orbit.target.fromArray(opts.target);
      if (opts.position) camera.position.fromArray(opts.position);
      camera.lookAt(orbit.target);
      orbit.update();
      requestRender();
    },

    /** setScene ile simetrik: {background, light, ambient, grid, shadows}. */
    scene: () => ({
      background: sceneSettings.bg,
      background2: sceneSettings.bg2 || null,
      turntable,
      light: sceneSettings.light,
      ambient: sceneSettings.ambient,
      grid: !!sceneSettings.grid,
      shadows: !!sceneSettings.shadows,
    }),

    /** Varsayılan sahne ({background, background2, turntable, light, ambient, grid, shadows}) ve kamera ({position, target, fov}). */
    defaults: () => ({
      scene: { background: SCENE_DEFAULTS.bg, background2: null, turntable: false, light: SCENE_DEFAULTS.light, ambient: SCENE_DEFAULTS.ambient, grid: SCENE_DEFAULTS.grid, shadows: SCENE_DEFAULTS.shadows },
      camera: { position: [...CAMERA_DEFAULTS.position], target: [...CAMERA_DEFAULTS.target], fov: CAMERA_DEFAULTS.fov },
    }),

    /** setCamera ile simetrik: {position, target, fov}. */
    camera: () => ({
      position: camera.position.toArray(),
      target: orbit.target.toArray(),
      fov: camera.fov,
    }),

    renderPNG,
    recordSpin,

    async exportModel(format = 'glb') {
      const blob = await exportBlob(format);
      if (!blob) throw new Error(t('three.export.none', 'No visible objects to export'));
      return blob;
    },

    saveProject: saveProjectBlob,
    // API'den açma/commit kullanıcı değişikliği sayılmaz ('mode-change' yayınlamaz).
    openProject: (blob) => openProjectBlob(blob, true),
    commit: () => commit({ silent: true }),

    el: {
      addButton: (kind) => q(`[data-add="${kind}"]`),
      viewport: () => viewport,
      props: () => propsPanel,
    },

    /** Nesnenin ekrandaki sınır kutusu (client CSS px) ya da görünmüyorsa null. */
    screenOf(obj) {
      if (!obj) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const box = objectBox(obj);
      if (box.isEmpty()) return null;
      camera.updateMatrixWorld();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const p = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        p.project(camera);
        if (p.z > 1) continue; // kameranın arkasında
        const x = rect.left + ((p.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - p.y) / 2) * rect.height;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (minX === Infinity) return null;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    },
  };

  // ---------- varsayılan sahne

  const cube = makeShape('cube');
  cube.position.set(0, 0.5, 0);
  const sphere = makeShape('sphere');
  sphere.position.set(1.6, 0.5, 0);
  const wedge = makeShape('wedge');
  wedge.position.set(-1.6, 0.5, 0);
  world.add(cube, sphere, wedge);

  history = [snapshot()];
  historyIndex = 0;
  renderOutliner();
  renderProps();
  applyQuality();
  updateStatus();

  return {
    activate() {
      active = true;
      resize();
      updateStatus();
      requestRender();
      startTurnLoop();
    },
    deactivate() {
      active = false;
      stopTurnLoop();
      if (frameRequest) {
        cancelAnimationFrame(frameRequest);
        frameRequest = 0;
      }
    },
    eco() {
      applyQuality();
      renderProps();
      updateStatus();
    },
    api,
  };
}
