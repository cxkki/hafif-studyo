// İş klasörü (Belgeler\HafifStudyo\isler) izleyicisi ve komut satırı çalıştırıcısı.
// Klasöre *.json tarif bırakılınca uygulama işi yapar, yanına <ad>.done.json ya da <ad>.error.json yazar.
import { $, sleep, toast, stripExt, baseName } from './util.js';
import * as platform from './platform.js';
import { runRecipe, parseRecipeText } from './recipe.js';
import { t } from './i18n.js';

let running = 0; // şu an çalışan tarif sayısı (0 ya da 1)
let pending = 0; // sıradaki + çalışan tarif sayısı
let chain = Promise.resolve();
const listeners = new Set();
export const jobsRunning = () => running > 0;
/** Çalışan ya da sırada bekleyen tarif var mı? */
export const jobsBusy = () => pending > 0;
/** Kuyruk durumu değişince fn(busy) çağrılır. */
export const onJobsChange = (fn) => listeners.add(fn);
function notify() {
  for (const fn of listeners) {
    try {
      fn(pending > 0);
    } catch (e) {
      console.error(e);
    }
  }
}

/**
 * Tüm tarif çalıştırmaları (iş klasörü, komut satırı, arayüz) tek sıradan geçer:
 * aynı anda yalnızca biri modları sürer. Bir işin hatası sırayı bozmaz.
 */
export function exclusive(fn) {
  pending++;
  notify();
  const p = chain.then(async () => {
    running++;
    try {
      return await fn();
    } finally {
      running--;
      pending--;
      notify();
    }
  });
  chain = p.catch(() => {});
  return p;
}

const STATUS_RE = /\.(done|error|running)\.json$/i;

export function parseCli(args) {
  const o = { run: null, headless: false, recordBuild: false, speed: null, out: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : args[++i]);
    if (a === '--run' || a.startsWith('--run=')) o.run = val();
    else if (a === '--headless') o.headless = true;
    else if (a === '--record-build') o.recordBuild = true;
    else if (a === '--speed' || a.startsWith('--speed=')) o.speed = val();
    else if (a === '--out' || a.startsWith('--out=')) o.out = val();
  }
  return o;
}

function setState(text, busy = false) {
  const el = $('#jobState');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('busy', busy);
}

/** Tek bir tarif dosyasını çalıştırır ve durum dosyasını yazar. */
export function runRecipeFile(path, ctx, opts = {}) {
  return exclusive(() => runRecipeFileNow(path, ctx, opts));
}

async function runRecipeFileNow(path, ctx, opts) {
  const base = path.replace(/\.json$/i, '');
  const started = new Date();
  // pid: hs-run.ps1 ve sonraki açılış, işi süren örneğin hâlâ çalışıp çalışmadığını buna bakarak anlar.
  const status = { recipe: path, started: started.toISOString(), ...(window.NL_PID ? { pid: +window.NL_PID } : {}) };
  try {
    await platform.writeText(base + '.running.json', JSON.stringify(status, null, 2));
    const recipe = parseRecipeText(await platform.readText(path));
    const res = await runRecipe(recipe, {
      ...ctx,
      ...opts,
      baseDir: platform.dirOf(path),
      name: recipe.name || stripExt(baseName(path)),
    });
    const done = { ok: true, ...status, finished: new Date().toISOString(), seconds: res.seconds, outputs: res.outputs, log: res.log, ...(res.project ? { project: res.project } : {}) };
    await platform.writeText(base + '.done.json', JSON.stringify(done, null, 2));
    return done;
  } catch (e) {
    console.error(e);
    const err = { ok: false, ...status, finished: new Date().toISOString(), error: String(e?.message || e), stack: String(e?.stack || '') };
    await platform.writeText(base + '.error.json', JSON.stringify(err, null, 2)).catch((we) => console.error('.error.json yazılamadı', we));
    return err;
  } finally {
    await platform.removeFile(base + '.running.json').catch(() => {});
  }
}

/** Süreç hâlâ çalışıyor mu? Emin olunamazsa true (başka örneğin işine dokunulmasın). */
async function pidAlive(pid) {
  pid = Math.floor(+pid);
  if (!pid || pid === +window.NL_PID) return false; // bu örnek yeni açıldı: kayıt önceki bir süreçten
  try {
    const r = await window.Neutralino.os.execCommand(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`);
    return new RegExp(`"${pid}"`).test(String(r?.stdOut || ''));
  } catch {
    return true;
  }
}

/**
 * Pencere canlı oturum sürerken kapatıldıysa (exitProcessOnClose) canli.json / canli.running.json diskte kalır.
 * Sahibi süreç artık yoksa: oturum yeniden açılmaz (canli.error.json), kalıntılar silinir.
 * running.json'daki pid hâlâ yaşıyorsa (ikinci bir örneğin açık oturumu) dokunulmaz.
 */
async function clearStaleLive(dir) {
  const base = platform.join(dir, 'canli');
  if (!(await platform.exists(base + '.running.json'))) return;
  let pid = 0;
  try {
    pid = +JSON.parse(String(await platform.readText(base + '.running.json')).replace(/^﻿/, '')).pid || 0;
  } catch {}
  if (pid && (await pidAlive(pid))) return;
  if (!(await platform.exists(base + '.done.json')) && !(await platform.exists(base + '.error.json'))) {
    const err = { ok: false, finished: new Date().toISOString(), error: 'app closed: live session was interrupted (use -Open/-New to reopen)' };
    await platform.writeText(base + '.error.json', JSON.stringify(err, null, 2)).catch(() => {});
  }
  for (const f of ['canli.json', 'canli.running.json', 'canli.proje']) await platform.removeFile(platform.join(dir, f)).catch(() => {});
}

/** Uygulama açıkken iş klasörünü izler; işleri sırayla çalıştırır. */
export async function startJobs(ctx) {
  const dir = platform.paths.jobs;
  const queue = [];
  const seen = new Set();
  let busyLoop = false;

  async function isPending(name) {
    if (!/\.json$/i.test(name) || STATUS_RE.test(name)) return false;
    const base = platform.join(dir, name.replace(/\.json$/i, ''));
    return !(await platform.exists(base + '.done.json')) && !(await platform.exists(base + '.error.json'));
  }

  async function enqueue(name) {
    // seen, await'ten ÖNCE işaretlenir: art arda gelen add/modified olayları aynı işi iki kez sıraya koymasın.
    if (seen.has(name)) return;
    seen.add(name);
    let ok = false;
    try {
      ok = await isPending(name);
    } catch (e) {
      console.warn('iş kontrolü', name, e);
    }
    if (!ok) {
      seen.delete(name);
      return;
    }
    queue.push(name);
    pump();
  }

  async function pump() {
    if (busyLoop) return;
    busyLoop = true;
    try {
      while (queue.length) {
        const name = queue.shift();
        try {
          // Dosya yazımı bitsin. Rastgele ek bekleme: uygulama iki kez açıksa iki örnek aynı anda uyanmasın.
          await sleep(600 + Math.random() * 600);
          if (!(await isPending(name))) continue; // bu arada silindi ya da durum dosyası oluştu
          // Başka bir Hafif Stüdyo örneği bu işi sahiplendiyse (.running.json) atla.
          const runFile = platform.join(dir, name.replace(/\.json$/i, '') + '.running.json');
          if (await platform.exists(runFile)) {
            // Çökmüş bir örnekten kalan eski sahiplik 30 dk sonra yok sayılır.
            let started = 0;
            try {
              started = Date.parse(JSON.parse(await platform.readText(runFile)).started) || 0;
            } catch {}
            if (Date.now() - started < 30 * 60 * 1000) continue;
          }
          const path = platform.join(dir, name);
          setState(t('jobs.state', 'Job: {name}', { name }), true);
          toast(t('jobs.started', 'Job started: {name}', { name }));
          const r = await runRecipeFile(path, ctx);
          toast(r.ok ? t('jobs.done', 'Job finished: {name} ({n} outputs)', { name, n: r.outputs.length }) : t('jobs.failed', 'Job error: {error}', { error: r.error }), 5000);
        } catch (e) {
          console.error('iş', name, e);
        } finally {
          seen.delete(name);
        }
      }
    } finally {
      busyLoop = false;
      setState(t('jobs.watching', 'Watching job folder'));
    }
  }

  // Canlı oturum kontrol dosyaları (tarif değil):
  //   canli.say    = Claude'un notu, canli.stop = oturumu kapat,
  //   canli.export = açık projeyi dışa aktar (içerik boş ya da {"file": "..."}) → canli.export.done.json / .error.json
  const CONTROL = ['canli.say', 'canli.stop', 'canli.export'];
  async function liveTargets() {
    let proj = null;
    try {
      proj = (await import('./live.js')).live;
    } catch {}
    const web = ctx.modes?.mweb?.api?.live;
    return { proj: proj?.active ? proj : null, web: web?.active ? web : null };
  }
  // Yeni dosya add+modified iki olay üretir: aynı komut iki kez işlenmesin. İşlenirken gelen olay yutulmaz,
  // bitince bir kez daha bakılır (controlNow dosya yoksa hiçbir şey yapmaz; yeni yazılmışsa onu işler).
  const inFlight = new Set();
  const rerun = new Set();
  async function control(name) {
    if (inFlight.has(name)) return void rerun.add(name);
    inFlight.add(name);
    try {
      await controlNow(name);
    } catch (e) {
      console.error('canlı komut', name, e);
    } finally {
      inFlight.delete(name);
      if (rerun.delete(name)) control(name);
    }
  }
  async function controlNow(name) {
    const path = platform.join(dir, name);
    if (!(await platform.exists(path))) return;
    let text = '';
    try {
      text = String(await platform.readText(path)).replace(/^﻿/, '').trim();
    } catch {}
    await platform.removeFile(path).catch(() => {});
    const { proj, web } = await liveTargets();
    if (name === 'canli.say' && text) (proj || web)?.note(text);
    if (name === 'canli.stop') {
      if (proj) proj.close().catch((e) => console.error('canlı kapatma', e));
      else if (web) web.stop({ tour: !/^(notour|tursuz)$/i.test(text) }).catch((e) => console.error('canlı durdurma', e));
    }
    if (name === 'canli.export') {
      const base = platform.join(dir, 'canli.export');
      let opts = {};
      try {
        opts = text ? JSON.parse(text) : {};
      } catch {}
      // id: hs-run -Export kendi isteğinin sonucunu (önceki bir -Export'unkinden) ayırt eder.
      const id = opts && typeof opts.id === 'string' ? { id: opts.id } : {};
      try {
        if (!proj) throw new Error(t('jobs.noLive', 'No live project is open'));
        const r = await proj.exportNow(opts);
        await platform.writeText(base + '.done.json', JSON.stringify({ ok: true, ...id, finished: new Date().toISOString(), outputs: r?.outputs || [] }, null, 2));
      } catch (e) {
        console.error('canli.export', e);
        await platform.writeText(base + '.error.json', JSON.stringify({ ok: false, ...id, error: String(e?.message || e) }, null, 2)).catch(() => {});
      }
    }
  }

  // Açılışta: eski kontrol dosyalarını temizle, yarıda kalmış canlı oturumu kapat, bekleyen işleri sıraya al.
  for (const f of CONTROL) await platform.removeFile(platform.join(dir, f)).catch(() => {});
  await clearStaleLive(dir).catch((e) => console.warn('eski canlı oturum', e));
  try {
    for (const e of await platform.listDir(dir)) if (e.type === 'FILE') await enqueue(e.entry);
  } catch (e) {
    console.warn('iş klasörü okunamadı', e);
  }
  await platform.watchDir(dir, (filename, action) => {
    if (action === 'delete') return;
    const name = baseName(filename);
    if (CONTROL.includes(name)) return void setTimeout(() => control(name), 150);
    enqueue(name);
  });
  setState(busyLoop ? t('jobs.running', 'Job running') : t('jobs.watching', 'Watching job folder'));
  $('#jobState').title = t('jobs.hint', 'Drop a .json recipe into {dir}', { dir: dir.replace(/\//g, '\\') });
  $('#jobState').onclick = () => platform.reveal(dir + '/.');
}

/** --run tarif.json [--headless] [--record-build] [--speed 5x] */
export async function runCli(cli, ctx) {
  let path = cli.run;
  if (!platform.isAbs(path)) path = platform.join(window.NL_CWD || platform.paths.app, path);
  setState(t('jobs.cli', 'Command-line job'), true);
  const r = await runRecipeFile(path, ctx, { headless: cli.headless, recordBuild: cli.recordBuild, speed: cli.speed, outDir: cli.out });
  await sleep(300);
  platform.exit(r.ok ? 0 : 1);
}
