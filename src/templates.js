// Şablonlar: liste, şablondan proje oluşturma, galeri penceresi.
// Şablonlar uygulamanın kendi sunucusundan okunur: build sablonlar/ klasörünü resources/sablonlar/ altına kopyalar
// (tarayıcıda tools/serve.mjs proje kökünü sunduğu için /sablonlar/ yine çalışır).
// index.json: [{ id, ad, aciklama, tur: 'video'|'3d'|'web', kapak, boyut?, dosyalar: [...], ortak?: [...] }]
//   dosyalar → /sablonlar/<id>/<yol>  → <proje>/<yol>
//   ortak    → /sablonlar/_ortak/<yol> → <proje>/<yol>   (büyük medya şablonlar arasında paylaşılır)
import * as platform from './platform.js';
import { esc } from './util.js';
import { jobsBusy, onJobsChange } from './jobs.js';
import { t } from './i18n.js';

export const TEMPLATE_BASE = '/sablonlar/';
/** Tür adı (galeri filtresi ve rozet). Fonksiyon: t() her çağrıda okunur, modül yüklenirken değil. */
const turAd = (tur) => ({ video: t('tpl.type.video', 'Video'), '3d': t('tpl.type.3d', '3D'), web: t('tpl.type.web', 'Web') })[tur];
const seg = (p) => String(p).split('/').map(encodeURIComponent).join('/');
/** Şablondaki bir dosyanın URL'si (ör. kapak): templateUrl('tiktok-oyun', 'kapak.png'). */
export const templateUrl = (id, file = '') => TEMPLATE_BASE + seg(id) + (file ? '/' + seg(file) : '');

let cache = null;
/** Şablon listesi (index.json). Hata olursa fırlatır. */
export async function listTemplates(force = false) {
  if (cache && !force) return cache;
  const r = await fetch(TEMPLATE_BASE + 'index.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(t('tpl.listError', 'Could not read the template list ({status})', { status: r.status }));
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error(t('tpl.listNotArray', 'sablonlar/index.json is not a list'));
  cache = list;
  return list;
}

const TR = { ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u' };
/** Proje adını klasör adına çevirir: "Benim Oyunum!" → "benim-oyunum". Türkçe harfler ASCII'ye. */
export function slugify(name) {
  let s = String(name || '')
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/.test(s)) s = 'proje' + (s ? '-' + s : '');
  return s;
}

/** Varsayılan proje adı: şablon adı + bugünün tarihi. */
export function defaultName(tp) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${tp?.ad || tp?.id || t('tpl.defaultProject', 'Project')} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Çıktı dosya adlarının başındaki eski proje adını yenisiyle değiştirir (logo-3d-donen.mp4 → benim-donen.mp4). */
function renameOutputs(proj, oldName, newName) {
  if (!oldName || oldName === newName) return;
  const fix = (f) => (typeof f === 'string' && (f === oldName || f.startsWith(oldName + '.') || f.startsWith(oldName + '-')) ? newName + f.slice(oldName.length) : f);
  if (typeof proj.output === 'string') proj.output = fix(proj.output);
  else if (proj.output && typeof proj.output === 'object') proj.output.file = fix(proj.output.file);
  if (Array.isArray(proj.outputs)) for (const o of proj.outputs) if (o && typeof o === 'object') o.file = fix(o.file);
}

async function fetchBlob(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw Object.assign(new Error(t('tpl.fileError', 'Could not fetch template file: {url} ({status})', { url, status: r.status })), { status: r.status });
  return r.blob();
}

/** Şablonu listede bulur; yoksa listeyi bir kez yeniden okur (build --watch yeni şablon eklemiş olabilir). */
async function findTemplate(id, force = false) {
  let list = await listTemplates(force);
  let tp = list.find((x) => x.id === id);
  if (!tp && !force) {
    list = await listTemplates(true);
    tp = list.find((x) => x.id === id);
  }
  if (!tp) throw new Error(t('tpl.notFound', 'Template not found: {id} (available: {list})', { id, list: list.map((x) => x.id).join(', ') }));
  return tp;
}

/**
 * Şablondan yeni proje klasörü oluşturur: <parentDir>/<ad> (ad dosya adına uygun hâle getirilir; klasör varsa -2, -3…).
 * Tüm dosyalar kopyalanır, proje.json'daki "name" klasör adıyla değiştirilir (çıktı adları da). Tam yolu döndürür.
 * Tarayıcıda diske yazılamaz: şablonun URL yolu ('/sablonlar/<id>') döner (geliştirme testi için).
 * opts.onProgress(done, total, file) isteğe bağlı.
 */
export async function createFromTemplate(id, name, parentDir = platform.paths.root + '/projeler', opts = {}) {
  let tp = await findTemplate(id);
  if (!platform.isNative()) return TEMPLATE_BASE + id;

  parentDir = String(parentDir).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!parentDir || parentDir === '/projeler') throw new Error(t('tpl.noParent', 'Project folder is unknown (was the platform started?)'));
  await platform.mkdirp(parentDir);
  const base = slugify(name || tp.ad || tp.id);
  let dir = platform.join(parentDir, base);
  for (let n = 2; await platform.exists(dir); n++) dir = platform.join(parentDir, `${base}-${n}`);
  await platform.mkdirp(dir);

  const filesOf = (x) => [
    ...(x.dosyalar || []).filter((f) => f !== 'proje.json').map((f) => ({ url: templateUrl(id, f), to: f })),
    ...(x.ortak || []).map((f) => ({ url: TEMPLATE_BASE + '_ortak/' + seg(f), to: f })),
  ];
  let total = 1;
  let i = 0;
  const prog = (i, f) => opts.onProgress?.(i, total, f);
  const copyAll = async () => {
    const files = filesOf(tp);
    total = files.length + 1;
    i = 0;
    for (const f of files) {
      prog(i, f.to);
      await platform.writeBlob(platform.join(dir, f.to), await fetchBlob(f.url));
      i++;
    }
  };
  try {
    try {
      await copyAll();
    } catch (e) {
      // Liste eskimiş olabilir (build --watch dosya ekledi/sildi/adını değiştirdi): taze listeyle bir kez yeniden dene.
      if (e?.status !== 404) throw e;
      tp = await findTemplate(id, true);
      await copyAll();
    }
    // proje.json en son yazılır: izleyen biri yarım projeyi görmesin.
    prog(i, 'proje.json');
    const proj = JSON.parse(await (await fetchBlob(templateUrl(id, 'proje.json'))).text());
    const newName = dir.split('/').pop();
    renameOutputs(proj, proj.name, newName);
    proj.name = newName;
    await platform.mkdirp(platform.join(dir, 'cikti'));
    await platform.writeText(platform.join(dir, 'proje.json'), JSON.stringify(proj, null, 2) + '\n');
    prog(total, null);
  } catch (e) {
    // Yarım kalan klasörü temizle (proje.json yoksa kimse kullanmıyordur).
    await platform.removeFile(dir).catch(() => {});
    throw e;
  }
  return dir;
}

// ------------------------------------------------------------------ galeri

let openPromise = null;
let jobsHook = null; // açık galerinin iş durumu dinleyicisi (tek kayıt: onJobsChange'in silme yolu yok)
onJobsChange((busy) => jobsHook?.(busy));

/**
 * Şablon galerisi: kapaklı ızgara, tür filtresi, ad sorusu. "Oluştur" → createFromTemplate → klasör yolu.
 * İptal → null. Zaten açıksa aynı Promise döner.
 */
export function openGallery(parentDir) {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const ovl = document.createElement('div');
    ovl.className = 'ovl tpl-ovl';
    ovl.innerHTML = `
<div class="card tpl-card" role="dialog" aria-modal="true" aria-labelledby="tplTitle">
  <div class="tpl-head">
    <h2 id="tplTitle">${t('tpl.title', 'New project from template')}</h2>
    <div class="tpl-filter" role="group" aria-label="${t('tpl.filter.aria', 'Type')}">
      <button data-f="" aria-pressed="true" class="on">${t('tpl.filter.all', 'All')}</button>
      <button data-f="video" aria-pressed="false">${t('tpl.type.video', 'Video')}</button>
      <button data-f="3d" aria-pressed="false">${t('tpl.type.3d', '3D')}</button>
      <button data-f="web" aria-pressed="false">${t('tpl.type.web', 'Web')}</button>
    </div>
    <div class="spacer"></div>
    <button class="tpl-x" data-act="cancel" aria-label="${t('tpl.close', 'Close')}" title="${t('tpl.close.title', 'Close (Esc)')}">✕</button>
  </div>
  <div class="tpl-grid" role="listbox" aria-label="${t('tpl.list.aria', 'Templates')}"><div class="empty tpl-info">${t('tpl.loading', 'Loading templates…')}</div></div>
  <div class="tpl-foot">
    <label class="tpl-name"><span>${t('tpl.name', 'Project name')}</span><input type="text" id="tplName" maxlength="80" spellcheck="false" disabled placeholder="${t('tpl.name.ph', 'Choose a template first')}"></label>
    <div class="tpl-path" id="tplPath"></div>
    <div class="tpl-actions">
      <span class="tpl-msg" id="tplMsg" role="status"></span>
      <button data-act="cancel">${t('common.cancel', 'Cancel')}</button>
      <button data-act="create" class="pri" disabled>${t('tpl.create', 'Create')}</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(ovl);

    const q = (s) => ovl.querySelector(s);
    const grid = q('.tpl-grid');
    const nameIn = q('#tplName');
    const pathEl = q('#tplPath');
    const msg = q('#tplMsg');
    const createBtn = q('[data-act=create]');
    const root = () => String(parentDir || platform.paths.root + '/projeler').replace(/\\/g, '/');
    let list = [];
    let filter = '';
    let sel = null;
    let nameTouched = false;
    let busyNow = false;
    let jobsNote = false; // iş uyarısı gösteriliyor mu (mesaj metnine bakılmaz: metin dile göre değişir)

    const setMsg = (text, err = false) => {
      msg.textContent = text || '';
      msg.classList.toggle('err', !!err);
    };
    // Oluşturulacak ad: create() ile önizleme aynı kuralı kullanır (boşsa şablon adı + tarih).
    const effName = () => nameIn.value.trim() || defaultName(sel);
    let pathSeq = 0;
    const updatePath = async () => {
      const seq = ++pathSeq;
      if (!sel) return (pathEl.textContent = '');
      if (!platform.isNative()) return (pathEl.textContent = t('tpl.browserPath', 'The browser cannot write to disk; the template path is returned: {path}', { path: TEMPLATE_BASE + sel.id }));
      // createFromTemplate'teki gibi: klasör varsa -2, -3… (eski yanıt yenisini ezmesin)
      const base = slugify(effName());
      const show = (d) => seq === pathSeq && (pathEl.textContent = t('tpl.folder', 'Folder: {path}', { path: d.replace(/\//g, '\\') }));
      let dir = platform.join(root(), base);
      show(dir);
      try {
        for (let n = 2; n < 1000 && (await platform.exists(dir)); n++) {
          if (seq !== pathSeq) return;
          dir = platform.join(root(), `${base}-${n}`);
        }
        show(dir);
      } catch {}
    };
    const render = () => {
      const shown = list.filter((tp) => !filter || tp.tur === filter);
      if (!shown.length) {
        grid.innerHTML = `<div class="empty tpl-info">${list.length ? t('tpl.noneType', 'No templates of this type.') : t('tpl.none', 'No templates.')}</div>`;
        return;
      }
      grid.innerHTML = shown
        .map((tp) => {
          const img = templateUrl(tp.id, tp.kapak || 'kapak.png');
          return `<button class="tpl-item${sel?.id === tp.id ? ' sel' : ''}" role="option" aria-selected="${sel?.id === tp.id}" data-id="${esc(tp.id)}" title="${esc(tp.aciklama || '')}">
  <div class="tpl-th"><div class="tpl-bg" style="background-image:url('${esc(img)}')"></div><img src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></div>
  <div class="tpl-meta"><b>${esc(tp.ad || tp.id)}</b><span class="tpl-tur t-${esc(tp.tur)}">${esc(turAd(tp.tur) || tp.tur)}</span></div>
  <p>${esc(tp.aciklama || '')}</p>
  ${tp.boyut ? `<span class="tpl-size">${esc(tp.boyut.replace('x', '×'))}</span>` : ''}
</button>`;
        })
        .join('');
    };
    const select = (id) => {
      sel = list.find((tp) => tp.id === id) || null;
      for (const b of grid.querySelectorAll('.tpl-item')) {
        const on = b.dataset.id === id;
        b.classList.toggle('sel', on);
        b.setAttribute('aria-selected', on);
      }
      nameIn.disabled = !sel || busyNow;
      createBtn.disabled = !sel || busyNow;
      if (sel && !nameTouched) nameIn.value = defaultName(sel);
      setMsg('');
      updatePath();
    };
    const lock = (on) => {
      busyNow = on;
      for (const b of ovl.querySelectorAll('button')) b.disabled = on || (b === createBtn && !sel);
      nameIn.disabled = on || !sel;
      ovl.classList.toggle('busy', on);
    };
    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      if (jobsHook === onJobs) jobsHook = null;
      ovl.remove();
      openPromise = null;
      try {
        prevFocus?.focus?.();
      } catch {}
      resolve(val);
    };
    const create = async () => {
      if (!sel || busyNow) return;
      // Tarif/iş çalışırken proje açılamaz: klasörü boşuna oluşturup yetim bırakma.
      if (jobsBusy()) {
        jobsNote = true;
        return setMsg(t('jobs.busy', 'A recipe is running; try again when it finishes'), true);
      }
      const name = effName();
      lock(true);
      setMsg(t('tpl.creating', 'Creating…'));
      try {
        const dir = await createFromTemplate(sel.id, name, parentDir || undefined, {
          onProgress: (i, n) => setMsg(t('tpl.copying', 'Copying files… {i}/{n}', { i: Math.min(i, n), n })),
        });
        close(dir);
      } catch (e) {
        lock(false);
        setMsg(t('tpl.createError', 'Could not create: {msg}', { msg: e?.message || e }), true);
      }
    };
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busyNow) close(null);
      } else if (e.key === 'Enter' && e.target === nameIn) {
        e.preventDefault();
        e.stopPropagation();
        create();
      } else {
        // Galeri açıkken tuşlar arkadaki 3D/video kısayollarına (Delete, Space, s, Ctrl+Z…) gitmesin.
        // preventDefault yok: girdi kutusuna yazma ve düğme etkinleştirme çalışmaya devam eder.
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onKey, true);
    // Galeri açıkken bir iş başlarsa (ör. Claude hs-run çalıştırdı) kullanıcıya göster.
    function onJobs(busy) {
      if (busyNow) return;
      if (busy) {
        jobsNote = true;
        setMsg(t('tpl.jobBusyCreate', 'A recipe is running; you can create once it finishes'), true);
      } else if (jobsNote) {
        jobsNote = false;
        setMsg('');
      }
    }
    jobsHook = onJobs;
    if (jobsBusy()) onJobs(true);

    let downOnOvl = false; // dışına tıklama: basış da bırakış da kartın dışında olmalı (sürükleyip bırakma kapatmasın)
    ovl.addEventListener('mousedown', (e) => (downOnOvl = e.target === ovl));
    ovl.addEventListener('click', (e) => {
      if (busyNow) return;
      const b = e.target.closest('button');
      if (e.target === ovl) return downOnOvl && close(null);
      if (!b) return;
      if (b.dataset.act === 'cancel') return close(null);
      if (b.dataset.act === 'create') return create();
      if (b.dataset.f != null) {
        filter = b.dataset.f;
        for (const f of ovl.querySelectorAll('[data-f]')) {
          f.classList.toggle('on', f === b);
          f.setAttribute('aria-pressed', f === b);
        }
        if (sel && filter && sel.tur !== filter) select(null);
        render();
        return;
      }
      if (b.dataset.id) select(b.dataset.id);
    });
    grid.addEventListener('dblclick', (e) => {
      const b = e.target.closest('.tpl-item');
      if (b && !busyNow) {
        select(b.dataset.id);
        create();
      }
    });
    nameIn.addEventListener('input', () => {
      nameTouched = nameIn.value.trim() !== '';
      updatePath();
    });

    q('[data-f=""]').focus();
    listTemplates(true) // her açılışta taze liste (index.json küçük; build --watch değiştirmiş olabilir)
      .then((l) => {
        list = l;
        render();
        grid.querySelector('.tpl-item')?.focus();
      })
      .catch((e) => {
        grid.innerHTML = `<div class="empty tpl-info err">${esc(t('tpl.loadError', 'Could not read templates: {msg}', { msg: e?.message || e }))}</div>`;
      });
  });
  return openPromise;
}
