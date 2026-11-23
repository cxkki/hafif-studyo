// Hafif Stüdyo build: src/ → resources/index.html (masaüstü) + dist-web/HafifStudyo.html (tarayıcı)
// Kullanım: node build.mjs            (bir kez)
//           node build.mjs --watch    (değişiklikte yeniden)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

function css() {
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.css')).sort();
  // Ortak stil önce, modüllerinkiler sonra.
  files.sort((a, b) => (a === 'style.css' ? -1 : b === 'style.css' ? 1 : a.localeCompare(b)));
  return files.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
}

async function bundle() {
  const r = await esbuild.build({
    entryPoints: [path.join(src, 'main.js')],
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

// ---------------------------------------------------------------- şablonlar
// sablonlar/<id>/sablon.json okunur → sablonlar/index.json üretilir (kaynakta da güncellenir; geliştirme sunucusu
// tools/serve.mjs onu okur) → tüm klasör resources/sablonlar/ altına kopyalanır (uygulama fetch('/sablonlar/...') ile okur).
// index.json girdisi: { id, ad, aciklama, tur, kapak, boyut?, dosyalar: [şablon klasörüne göre], ortak: [_ortak/ altına göre] }
// "dosyalar" = şablon klasöründeki tüm dosyalar (sablon.json ve kapak hariç); "ortak" = _ortak/<yol> → projede <yol>.
const sablonDir = path.join(root, 'sablonlar');
const TUR_SIRA = { video: 0, '3d': 1, web: 2 };

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function templateIndex() {
  const list = [];
  for (const e of fs.readdirSync(sablonDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(sablonDir, e.name);
    const metaPath = path.join(dir, 'sablon.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.id !== e.name) throw new Error(`sablon.json id (${meta.id}) klasör adıyla (${e.name}) aynı olmalı`);
    if (!fs.existsSync(path.join(dir, 'proje.json'))) throw new Error(`proje.json yok: sablonlar/${e.name}`);
    JSON.parse(fs.readFileSync(path.join(dir, 'proje.json'), 'utf8')); // geçerli JSON mu
    const kapak = meta.kapak || 'kapak.png';
    const dosyalar = listFiles(dir)
      .filter((f) => f !== 'sablon.json' && f !== kapak)
      .sort((a, b) => (a === 'proje.json' ? -1 : b === 'proje.json' ? 1 : a.localeCompare(b)));
    const ortak = meta.ortak || [];
    for (const f of ortak)
      if (!fs.existsSync(path.join(sablonDir, '_ortak', f))) throw new Error(`ortak dosya yok: sablonlar/_ortak/${f} (${e.name})`);
    const item = { id: meta.id, ad: meta.ad, aciklama: meta.aciklama, tur: meta.tur, kapak };
    if (meta.boyut) item.boyut = meta.boyut;
    item.dosyalar = dosyalar;
    if (ortak.length) item.ortak = ortak;
    item._sira = [TUR_SIRA[meta.tur] ?? 9, meta.sira ?? 99, meta.id];
    list.push(item);
  }
  list.sort((a, b) => a._sira[0] - b._sira[0] || a._sira[1] - b._sira[1] || a._sira[2].localeCompare(b._sira[2]));
  return list.map(({ _sira, ...rest }) => rest);
}

function copyTemplates() {
  if (!fs.existsSync(sablonDir)) return 0;
  const json = JSON.stringify(templateIndex(), null, 2) + '\n';
  const idx = path.join(sablonDir, 'index.json');
  if (!fs.existsSync(idx) || fs.readFileSync(idx, 'utf8') !== json) fs.writeFileSync(idx, json);
  const dst = path.join(root, 'resources', 'sablonlar');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(sablonDir, dst, { recursive: true });
  return JSON.parse(json).length;
}

// The single-file browser build has no locales/ folder next to it, so its dictionaries are embedded.
function embeddedLocales() {
  const dir = path.join(src, 'locales');
  if (!fs.existsSync(dir)) return '';
  const all = {};
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z]{2}\.json$/.test(x) && x !== 'en.json'))
    all[f.slice(0, 2)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return `<script>window.__HS_LOCALES=${JSON.stringify(all).replace(/<\//g, '<\\/')}</script>\n`;
}

function page(js, styles, native) {
  const tpl = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  return tpl
    .replace('<!--CSS-->', () => `<style>\n${styles}\n</style>`)
    .replace('<!--NEUTRALINO-->', () => (native ? '<script src="/js/neutralino.js"></script>' : ''))
    .replace('<!--JS-->', () => (native ? '' : embeddedLocales()) + `<script>\n${js}\n</script>`);
}

async function build() {
  const t0 = Date.now();
  try {
    const [js, styles] = [await bundle(), css()];
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist-web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources', 'index.html'), page(js, styles, true));
    fs.writeFileSync(path.join(root, 'dist-web', 'HafifStudyo.html'), page(js, styles, false));
    const kb = Math.round(fs.statSync(path.join(root, 'resources', 'index.html')).size / 1024);
    console.log(`build ok (${kb} KB, ${Date.now() - t0} ms)`);
    return true;
  } catch (e) {
    console.error('build HATA:', e.message);
    return false;
  }
}

// Language dictionaries: src/locales/<code>.json → resources/locales/ (fetched at runtime by src/i18n.js).
// Invalid JSON fails the build so a broken translation never ships.
function copyLocales() {
  const from = path.join(src, 'locales');
  const to = path.join(root, 'resources', 'locales');
  fs.rmSync(to, { recursive: true, force: true });
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from).filter((x) => /^[a-z]{2}\.json$/.test(x))) {
    const text = fs.readFileSync(path.join(from, f), 'utf8');
    JSON.parse(text);
    fs.writeFileSync(path.join(to, f), text);
    n++;
  }
  return n;
}
try {
  console.log(`locales ok (${copyLocales()} languages → resources/locales)`);
} catch (e) {
  console.error('locale ERROR:', e.message);
  if (!watch) process.exit(1);
}

// Şablonlar JS paketinden bağımsız: paket hata verse de kopyalanır (izleme modunda sadece sablonlar/ değişince).
let tplOk = true;
try {
  console.log(`şablonlar ok (${copyTemplates()} şablon → resources/sablonlar)`);
} catch (e) {
  tplOk = false;
  console.error('şablon HATA:', e.message);
}
const ok = await build();
if (watch) {
  let timer;
  fs.watch(src, { recursive: true }, (_ev, filename) => {
    if (filename && /(^|[\\/])locales[\\/]/.test(String(filename))) {
      try {
        console.log(`locales ok (${copyLocales()} languages)`);
      } catch (e) {
        console.error('locale ERROR:', e.message);
      }
      // fall through: rebuild too, so the single-file web build re-embeds the dictionaries
    }
    clearTimeout(timer);
    timer = setTimeout(build, 150);
  });
  if (fs.existsSync(sablonDir)) {
    let t2;
    fs.watch(sablonDir, { recursive: true }, () => {
      clearTimeout(t2);
      t2 = setTimeout(() => {
        try {
          console.log(`şablonlar kopyalandı (${copyTemplates()})`);
        } catch (e) {
          console.error('şablon HATA:', e.message);
        }
      }, 300);
    });
  }
  console.log('izleniyor: src/, sablonlar/');
} else if (!ok || !tplOk) process.exit(1);
