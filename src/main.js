// Giriş noktası: modları kurar, sekmeleri bağlar, masaüstünde iş klasörünü / komut satırını başlatır.
import { $, $$, bus, store, settings, toast, stripExt, baseName } from './util.js';
import * as platform from './platform.js';
import { t, initI18n, setLanguageGuard } from './i18n.js';
import { createThreeMode } from './three-mode.js';
import { createVideoMode } from './video-mode.js';
import { createWebMode } from './web-mode.js';
import { agents } from './agents.js';
import { runRecipe, parseRecipeText } from './recipe.js';
import { startJobs, runCli, parseCli, jobsBusy, exclusive, onJobsChange } from './jobs.js';
import { live, initLive } from './live.js';
import { openGallery } from './templates.js';
import { initPalette } from './palette.js';
import { initWelcome, openTour, closeTour } from './welcome.js';
import { initAI } from './ai.js';

/** Üst çubuk: "Proje aç", canlı rozet, "Dışa aktar", "Kapat" (+ varsa #templatesBtn → galeri). */
function mountLiveBar() {
  const anchor = $('#runRecipeBtn');
  const mk = (cls, text, title) => {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = text;
    if (title) b.title = title;
    return b;
  };
  const openBtn = mk('', t('live.open', 'Open project'), t('live.open.title', 'Open a project folder (proje.json) live: AI edits appear with agents'));
  const badge = mk('lv-badge', '', t('live.badge.title', 'Show project folder'));
  const label = document.createElement('span');
  badge.appendChild(label);
  const expBtn = mk('', t('live.export', 'Export'), t('live.export.title', 'Export the live project now (to its cikti/ folder)'));
  const closeBtn = mk('', t('live.close', 'Close'), t('live.close.title', 'Close the live project'));
  anchor.before(openBtn, badge, expBtn, closeBtn);

  const sync = () => {
    const on = live.active;
    badge.hidden = closeBtn.hidden = !on;
    // Web projesinde video oturum kapanırken üretilir ("record": true); ayrı dışa aktarma yok.
    expBtn.hidden = !on || live.type === 'web';
    label.textContent = on ? t('live.badge', 'Live: {name}', { name: live.name }) : '';
    badge.title = on ? `${live.dir}\n` + t('live.badge.click', 'Click to show the folder') : '';
  };
  bus.addEventListener('live-change', sync);
  sync();

  const openDir = async (dir) => {
    if (!dir) return;
    if (jobsBusy()) return toast(t('jobs.busy', 'A recipe is running; try again when it finishes'));
    openBtn.disabled = true;
    try {
      await live.open(dir);
    } catch (e) {
      console.error(e);
      toast(t('live.openError', 'Could not open project: {msg}', { msg: e.message }), 6000);
    } finally {
      openBtn.disabled = false;
    }
  };

  openBtn.onclick = async () => {
    if (!platform.isNative()) {
      const p = prompt(t('live.urlPrompt', 'URL path of the project folder'), '/ornekler/canli-test');
      return openDir(p && p.trim());
    }
    openDir(await platform.pickFolder(t('live.pickFolder', 'Choose a project folder (containing proje.json)')));
  };
  badge.onclick = () => live.active && platform.reveal(live.dir + '/proje.json');
  expBtn.onclick = async () => {
    expBtn.disabled = true;
    badge.classList.add('lv-busy');
    try {
      const { outputs } = await live.exportNow();
      toast(outputs.length ? t('live.exported', 'Exported: {file}', { file: baseName(outputs[0]) }) : t('live.nothingToExport', 'Nothing to export'), 5000);
    } catch (e) {
      console.error(e);
      toast(t('live.exportError', 'Export error: {msg}', { msg: e.message }), 6000);
    } finally {
      expBtn.disabled = false;
      badge.classList.remove('lv-busy');
    }
  };
  closeBtn.onclick = () => live.close().catch((e) => toast(t('live.closeError', 'Close error: {msg}', { msg: e.message })));
  const toggle = () => (live.active ? closeBtn.click() : openBtn.click());

  const tb = $('#templatesBtn');
  if (tb)
    tb.onclick = async () => {
      try {
        openDir(await openGallery());
      } catch (e) {
        console.error(e);
        toast(t('templates.error', 'Template error: {msg}', { msg: e.message }), 6000);
      }
    };
  return { toggle };
}

/** True when the app was opened for Claude/hs-run: a live session or recipe job is waiting in the jobs folder. */
async function jobsFolderActive() {
  try {
    for (const e of await platform.listDir(platform.paths.jobs)) {
      if (e.type !== 'FILE') continue;
      const n = String(e.entry);
      if (/^canli\.(json|proje|running\.json)$/i.test(n)) return true;
      if (/\.json$/i.test(n) && !/\.(done|error|running)\.json$/i.test(n) && !/^canli\./i.test(n)) return true;
    }
  } catch {}
  return false;
}

/** Masaüstünde hataları ve önemli günlük satırlarını Belgeler\HafifStudyo\hata.log'a ekler (Claude teşhis için okur). */
function installErrorLog() {
  if (!platform.isNative()) return;
  const file = platform.join(platform.paths.root, 'hata.log');
  let chain = Promise.resolve();
  const write = (kind, args) => {
    const text = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
    const line = `${new Date().toISOString()} [${kind}] ${text}\n`;
    chain = chain.then(() => window.Neutralino.filesystem.appendFile(file, line).catch(() => window.Neutralino.filesystem.writeFile(file, line))).catch(() => {});
  };
  const origErr = console.error.bind(console);
  console.error = (...a) => {
    origErr(...a);
    write('hata', a);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...a) => {
    origWarn(...a);
    write('uyarı', a);
  };
  addEventListener('error', (e) => write('hata', [e.error || e.message]));
  addEventListener('unhandledrejection', (e) => write('söz', [e.reason]));
  write('açılış', ['Hafif Stüdyo başladı', (window.NL_ARGS || []).slice(1).join(' ')]);
}

async function boot() {
  // Language first: every module builds its UI text with t().
  await initI18n().catch((e) => console.warn('i18n', e));
  const native = await platform.init().catch((e) => {
    console.error('platform', e);
    return false;
  });
  installErrorLog();
  const cli = parseCli(platform.args);

  const modes = { m3d: createThreeMode(), mvid: createVideoMode(), mweb: createWebMode() };
  let current = 'm3d';

  function switchTab(id) {
    if (!modes[id]) id = 'm3d';
    // _on gerçek etkinliği tutar (görünürlük değişimleri de günceller); pasif aynı mod yeniden etkinleşir.
    if (id === current && modes[id]._on) return;
    if (modes[current]._on) modes[current].deactivate();
    modes[current]._on = false;
    current = id;
    $$('.mode').forEach((m) => m.classList.toggle('on', m.id === id));
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    modes[id].activate();
    modes[id]._on = true;
    store.set('tab', id);
  }
  $$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  // Eko mod
  const eco = $('#eco');
  eco.checked = settings.eco;
  eco.onchange = () => {
    settings.eco = eco.checked;
    store.set('eco', settings.eco);
    Object.values(modes).forEach((m) => m.eco());
    toast(settings.eco ? t('eco.on', 'Eco mode on: lighter rendering') : t('eco.off', 'Eco mode off: full quality'));
  };

  // Kısayollar penceresi
  const help = $('#help');
  $('#helpBtn').onclick = () => (help.hidden = false);
  $('#helpClose').onclick = () => (help.hidden = true);
  help.onclick = (e) => {
    if (e.target === help) help.hidden = true;
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') help.hidden = true;
  });

  // 3D → video
  bus.addEventListener('to-video', async (e) => {
    if (await modes.mvid.fromBlob(e.detail)) {
      switchTab('mvid');
      toast(t('3d.sentToVideo', '3D output added to the video'));
    }
  });

  // Etkin modu pencere görünürlüğüyle eşitler (_on bayrağını da günceller).
  function syncVisibility() {
    const m = modes[current];
    if (document.hidden) {
      if (m._on) {
        m.deactivate();
        m._on = false;
      }
    } else if (!m._on) {
      m.activate();
      m._on = true;
    }
  }

  // Pencere küçültülünce boşta kal (iş çalışırken değil: dışa aktarma sürmeli)
  document.addEventListener('visibilitychange', () => {
    if (jobsBusy()) return;
    syncVisibility();
  });

  // Tarif çalıştırma bağlamı (recipe.js kullanır)
  const ctx = { modes, switchTab, current: () => current, syncVisibility };
  // Canlı proje yöneticisi (docs/CANLI.md); jobs.js ctx.live ile erişebilir.
  ctx.live = initLive(ctx);
  const liveBar = mountLiveBar();
  const busyNow = () => jobsBusy() || !!(modes.mvid.api && modes.mvid.api.exporting && modes.mvid.api.exporting());
  // Language change reloads the page: never during a job/export/--run, confirm when a live session or work may be lost.
  setLanguageGuard(async () => {
    if (cli.run || busyNow()) {
      toast(t('lang.busy', 'A job or export is running; change the language when it finishes'));
      return false;
    }
    if (!confirm(live.active
      ? t('lang.confirmLive', 'Changing the language reloads the app and closes the live project. Unsaved work will be lost. Continue?')
      : t('lang.confirm', 'Changing the language reloads the app. Unsaved scene or timeline work will be lost. Continue?'))) return false;
    if (live.active) await live.close().catch((e) => console.error(e));
    return true;
  });
  // AI assistant drawer (Claude or an OpenAI-compatible provider) and the Ctrl+K command palette.
  const ai = initAI(ctx);
  initPalette({ openTour, openLive: () => liveBar.toggle(), openAssistant: () => ai && ai.open(), isBusy: busyNow });

  // Tüm tarifler (iş klasörü, komut satırı, arayüz) jobs.js'teki tek sıradan geçer.
  const runBtn = $('#runRecipeBtn');
  onJobsChange((busy) => {
    runBtn.disabled = busy;
    runBtn.title = busy ? t('jobs.busy', 'A recipe is running; try again when it finishes') : '';
    if (busy) closeTour();
    if (!busy) syncVisibility(); // iş sırasında görünürlük değiştiyse modu eşitle
  });

  runBtn.onclick = async () => {
    if (jobsBusy()) return toast(t('jobs.alreadyRunning', 'A recipe is already running'));
    if (live.active) return toast(t('live.closeFirst', 'Close the live project first'));
    const [file] = await platform.openFiles('.json', false, t('recipe.pick', 'Choose a recipe (.json)'));
    if (!file) return;
    try {
      const recipe = parseRecipeText(await file.text());
      const baseDir = file.path ? platform.dirOf(file.path) : platform.paths.root;
      const name = recipe.name || stripExt(baseName(file.name || file.path || 'is'));
      // Seçim penceresi açıkken bir iş başlamış olabilir: exclusive sıraya alır.
      const res = await exclusive(() => runRecipe(recipe, { ...ctx, baseDir, name }));
      toast(t('recipe.done', 'Done: {n} outputs → {dir}', { n: res.outputs.length, dir: platform.paths.out || t('common.downloads', 'Downloads') }), 5000);
    } catch (e) {
      console.error(e);
      toast(t('recipe.error', 'Recipe error: {msg}', { msg: e.message }), 6000);
    }
  };
  $('#outDirBtn').onclick = () => (native ? platform.reveal(platform.paths.out + '/.') : toast(t('common.desktopOnly', 'Works in the desktop app')));
  $('#outDirBtn').hidden = !native;

  window.__hs = { modes, agents, platform, ai, runRecipe: (r, o = {}) => exclusive(() => runRecipe(r, { ...ctx, ...o })), switchTab, live };

  modes.m3d.deactivate();
  modes.mvid.deactivate();
  modes.mweb.deactivate();
  current = 'm3d';
  switchTab(cli.run ? 'm3d' : store.get('tab', 'm3d'));

  if (cli.run) {
    // Komut satırı: --run tarif.json [--headless] [--record-build]
    if (!cli.headless) platform.win.show();
    await runCli(cli, ctx);
    return;
  }
  platform.win.show();
  // First-run tour: never during --run, a running job/live session or an hs-run launch (still available from the palette).
  bus.addEventListener('live-change', () => live.active && closeTour());
  const quiet = native && (await jobsFolderActive());
  if (!quiet && !jobsBusy() && !live.active) initWelcome();
  if (native) startJobs(ctx);
}

boot().catch((e) => {
  console.error(e);
  platform.win.show();
});
