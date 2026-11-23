// AI assistant tools: provider-neutral definitions, input validation, executors and the system prompt.
// Executors call the real app modules (live.js, templates.js, platform.js, web-mode live engine).
// Nothing here runs unless the assistant is actively handling a user message.
import { sleep, store } from './util.js';
import * as platform from './platform.js';
import { live } from './live.js';
import { listTemplates, createFromTemplate, slugify } from './templates.js';
import { jobsBusy } from './jobs.js';
import { t, currentLanguage, LANGUAGES } from './i18n.js';
import { DRAW_HELP, STICK_EXAMPLE } from './draw-clip.js';
import { MUSIC_STYLES } from './music-gen.js';

const MAX_READ = 200_000; // characters returned by read_site_file / get_project
const MAX_LIST = 400; // entries returned by list_site_files
const APPLY_TIMEOUT = 60_000;

let ctx = null; // { modes, switchTab, live? }
let noteFn = null; // (text) => void, provided by ai.js (shows "<provider>: text")

export function bindTools(c, { note } = {}) {
  ctx = c;
  noteFn = note || null;
}

const L = () => ctx?.live || live;

// ---------------------------------------------------------------- tool definitions (JSON Schema)

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

export const TOOL_DEFS = [
  {
    name: 'list_templates',
    description:
      'List the built-in project templates (id, name, description, type video|3d|web, size). Use before new_project. Only pick a template whose type matches the output the user wants.',
    parameters: obj({}),
  },
  {
    name: 'new_project',
    description:
      'Create a new project from a template and open it live in the app (agents build it on screen). Returns the project folder and its proje.json. Closes any open live project first. The template type must match the requested output (a video request never uses a web template); afterwards replace or remove template content that does not fit the request. If no template fits, use new_blank_project.',
    parameters: obj(
      {
        template: str('Template id from list_templates'),
        name: str('Project name, e.g. "Summer sale TikTok"'),
        type: { type: 'string', enum: ['video', '3d', 'web'], description: 'Optional: the output type you intend; the call fails if the template has another type' },
      },
      ['template', 'name'],
    ),
  },
  {
    name: 'new_blank_project',
    description:
      'Create an EMPTY project and open it live: video (no clips yet: add text, shape, draw and music items with update_project), 3d (empty scene) or web (same as start_web_live). Use it when no template matches the request, e.g. a custom animation or stick-figure video drawn with draw clips.',
    parameters: obj(
      {
        type: { type: 'string', enum: ['video', '3d', 'web'], description: 'video = MP4 edit/animation, 3d = 3D scene, web = website' },
        name: str('Project name, e.g. "Stick figure dance"'),
        orientation: { type: 'string', enum: ['vertical', 'horizontal'], description: 'vertical = 1080x1920 (TikTok/Reels/Shorts, default), horizontal = 1920x1080' },
        resolution: str('Optional exact size "WxH", e.g. "1080x1080" (overrides orientation; video and 3d only)'),
      },
      ['type', 'name'],
    ),
  },
  {
    name: 'open_project',
    description: 'Open an existing project folder (containing proje.json) live in the app.',
    parameters: obj({ path: str('Absolute project folder path (desktop) or URL path (browser build)') }, ['path']),
  },
  {
    name: 'close_project',
    description: 'Close the open live project (web projects finish their session; a recorded web session produces its video).',
    parameters: obj({}),
  },
  {
    name: 'get_project',
    description: 'Return the current proje.json of the open live project (always read it before editing: the user may have changed things in the UI).',
    parameters: obj({}),
  },
  {
    name: 'update_project',
    description:
      'Replace the whole proje.json of the open live project. The app diffs it against the current state and animates each change with agents; returns when the change is applied on screen. Keep every existing id; give new items new ids; do not change "type". Send small, related changes per call.',
    parameters: obj({ project_json: str('The complete new proje.json as a JSON string') }, ['project_json']),
  },
  {
    name: 'start_web_live',
    description:
      'Only for websites / landing pages (never for a video request, even one that mentions HTML: use a video project with draw clips). Start a live website project: creates Documents/HafifStudyo/projeler/<name>/site (reused if it exists) and opens it so every file you write is built on screen by agents. Then write files with write_site_file.',
    parameters: obj(
      {
        name: str('Project / site name'),
        orientation: { type: 'string', enum: ['vertical', 'horizontal'], description: 'vertical = phone 1080x1920 (TikTok), horizontal = desktop 1920x1080' },
      },
      ['name'],
    ),
  },
  {
    name: 'list_site_files',
    description: 'List the files of the live website folder (relative paths with sizes).',
    parameters: obj({}),
  },
  {
    name: 'read_site_file',
    description: 'Read a text file of the live website, by path relative to the site folder (e.g. "index.html", "css/style.css").',
    parameters: obj({ path: str('Relative path inside the site folder') }, ['path']),
  },
  {
    name: 'write_site_file',
    description:
      'Create or overwrite a text file in the live website folder (relative path only). The app animates the change. Build the site in steps: skeleton index.html, then style.css, then one section at a time.',
    parameters: obj({ path: str('Relative path inside the site folder'), content: str('Full file content') }, ['path', 'content']),
  },
  {
    name: 'stop_web_live',
    description: 'Finish the live website session.',
    parameters: obj({}),
  },
  {
    name: 'export_project',
    description: 'Export the open video/3D project (MP4 / PNG / GLB… as set in proje.json). Real-time: a 10 s video takes about 10 s. Only when the user asks.',
    parameters: obj({ file: str('Optional output file name, e.g. "final.mp4"') }),
  },
  {
    name: 'note',
    description: 'Show a short narration bubble on screen (what you are doing now). Keep it under ~80 characters.',
    parameters: obj({ text: str('Short message') }, ['text']),
  },
  {
    name: 'get_schema',
    description: 'Return the proje.json formats (video, 3d, web) and editing rules. Call once before your first edit.',
    parameters: obj({}),
  },
];

// ---------------------------------------------------------------- validation (eager input streaming: inputs are not validated server-side)

/** Minimal JSON-Schema check for the flat schemas above. Returns an error string or ''. */
export function validateInput(name, input) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) return `Unknown tool: ${name}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be a JSON object';
  const { properties, required } = def.parameters;
  for (const k of required) if (input[k] == null) return `Missing required field "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = properties[k];
    if (!p) return `Unexpected field "${k}"`;
    if (v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') return `Field "${k}" must be a string`;
    if (p.enum && !p.enum.includes(v)) return `Field "${k}" must be one of ${p.enum.join(', ')}`;
  }
  return '';
}

// ---------------------------------------------------------------- helpers

const errOf = (e) => String((e && e.message) || e || 'unknown error');
const json = (v) => JSON.stringify(v);

function assertNoJob() {
  if (jobsBusy()) throw new Error('A recipe job is running in the app; try again when it finishes.');
}

function requireLive() {
  if (!L().active) throw new Error('No live project is open. Use new_blank_project, new_project or open_project first (start_web_live only for websites).');
}

/** Absolute path with forward slashes and "."/".." collapsed; '' when ".." climbs above the root. */
function canonPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  let head = '';
  let rest = s;
  if (s.startsWith('//')) (head = '//'), (rest = s.slice(2));
  else if (s.startsWith('/')) (head = '/'), (rest = s.slice(1));
  const out = [];
  for (const x of rest.split('/')) {
    if (!x || x === '.') continue;
    if (x === '..') {
      if (!out.length || (out.length === 1 && /^[a-zA-Z]:$/.test(out[0]))) return '';
      out.pop();
    } else out.push(x);
  }
  return out.length ? head + out.join('/') : '';
}

/** True when `child` is `parent` itself or lies inside it (case-insensitive on Windows-style paths). */
function isInside(child, parent) {
  let c = canonPath(child);
  let p = canonPath(parent);
  if (!c || !p) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('//')) (c = c.toLowerCase()), (p = p.toLowerCase());
  return c === p || c.startsWith(p + '/');
}

/**
 * Resolves a web project's site folder and confines it to the project folder (proje.json "site" is model-editable:
 * an absolute path or ".." must never let the site-file tools write elsewhere on disk).
 */
function confinedSite(site, projectDir) {
  const raw = String(site || 'site');
  const full = canonPath(platform.resolvePath(raw, projectDir));
  if (!full || !isInside(full, projectDir)) throw new Error(`The site folder "${raw}" must be inside the project folder (${projectDir}).`);
  return full;
}

/** Site folder of the current web project (absolute, forward slashes). */
function siteDir() {
  const lv = L();
  const W = ctx?.modes?.mweb?.api?.live;
  // The folder the web engine is actually watching: web-mode stores it when a live session starts and it cannot
  // change while the session runs (the live proje.json "site" only applies on reopen).
  const watched = W?.active ? String(store.get('web_site', null)?.dir || '').replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (lv.active && lv.type === 'web') {
    const d = watched || platform.resolvePath(String(lv.project?.site || 'site'), lv.dir);
    return confinedSite(d, lv.dir);
  }
  // Live website started by hand in the Web tab ("Live watch"): the folder the user chose.
  if (watched) return canonPath(watched) || watched;
  throw new Error('No live website is open. Call start_web_live first (or open a web project).');
}

/** Relative path inside the site folder; rejects absolute paths and "..". */
function safeRel(p) {
  const s = String(p || '').replace(/\\/g, '/').trim();
  if (!s || s.includes('\0')) throw new Error('Empty path');
  if (platform.isAbs(s) || /^[a-zA-Z]:/.test(s) || s.startsWith('/') || /^[a-z]+:\/\//i.test(s)) throw new Error('Path must be relative to the site folder');
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) throw new Error('Path must stay inside the site folder ("..": not allowed)');
  return parts.join('/');
}

async function readProjectText() {
  const lv = L();
  if (platform.isNative()) {
    try {
      return await platform.readText(platform.join(lv.dir, 'proje.json'));
    } catch {}
  }
  return JSON.stringify(lv.project || {}, null, 2);
}

const compactProject = () => {
  const p = L().project;
  return p ? JSON.stringify(p) : null;
};

/** Waits until the live manager has applied the latest proje.json (polls every 300 ms, max 60 s). */
async function waitApplied(signal) {
  const lv = L();
  const t0 = performance.now();
  let sawBusy = false;
  while (performance.now() - t0 < APPLY_TIMEOUT) {
    await sleep(300);
    if (!lv.active) return 'closed';
    if (lv.busy) sawBusy = true;
    // Watcher debounce is 300 ms; if nothing started after ~2.5 s the file produced no visible change.
    else if (sawBusy || performance.now() - t0 > 2500) return 'ok';
    if (signal?.aborted) return 'aborted';
  }
  return 'timeout';
}

async function openLive(dir) {
  assertNoJob();
  const res = await L().open(dir);
  if (!res) throw new Error('The project was replaced by another one while opening');
  return res;
}

/** "1080x1920" (also "1080×1920", "1080 x 1920") → normalized "WxH"; throws on a bad or absurd size. */
function normResolution(r) {
  const m = /^\s*(\d{2,5})\s*[x×X*]\s*(\d{2,5})\s*$/.exec(String(r || ''));
  if (!m) throw new Error(`resolution must look like "1080x1920" (got "${r}")`);
  const w = +m[1];
  const h = +m[2];
  if (w < 64 || h < 64 || w > 7680 || h > 7680) throw new Error('resolution must be between 64 and 7680 pixels per side');
  // Video encoders need even sizes.
  return `${w - (w % 2)}x${h - (h % 2)}`;
}

/** Minimal proje.json for a blank video / 3d project. */
function blankProject(type, name, res) {
  if (type === 'video') return { type: 'video', name, resolution: res, fps: 30, background: '#000000', clips: [], texts: [], music: null };
  const [w, h] = res.split('x').map(Number);
  return {
    type: '3d',
    name,
    scene: { background: '#14161c', grid: true, shadows: true, light: 2, ambient: 1 },
    camera: { position: [4, 3, 6], target: [0, 0.5, 0], fov: 45 },
    objects: [],
    outputs: [
      { kind: 'png', file: `${name}.png`, width: w, height: h },
      { kind: 'spin', file: `${name}-spin.mp4`, seconds: 6, width: w, height: h, fps: 30, turns: 1 },
    ],
  };
}

/** Free folder under Documents/HafifStudyo/projeler for a new project ("-2", "-3"… when the name is taken). */
async function freeProjectDir(name) {
  if (!platform.paths.root) throw new Error('Project folder is unknown (was the platform started?)');
  const parent = platform.join(platform.paths.root, 'projeler');
  await platform.mkdirp(parent);
  const base = slugify(name);
  let dir = platform.join(parent, base);
  for (let n = 2; await platform.exists(dir); n++) dir = platform.join(parent, `${base}-${n}`);
  return dir;
}

// ---------------------------------------------------------------- executors

const EXEC = {
  async list_templates() {
    const list = await listTemplates();
    return json(list.map((x) => ({ id: x.id, name: x.ad, description: x.aciklama, type: x.tur, size: x.boyut || undefined })));
  },

  async new_project({ template, name, type }) {
    assertNoJob();
    if (type) {
      const tp = (await listTemplates()).find((x) => x.id === template);
      if (!tp) throw new Error(`Unknown template "${template}"; call list_templates.`);
      if (tp.tur && tp.tur !== type)
        throw new Error(`Template "${template}" is a ${tp.tur} template, not ${type}. Pick a ${type} template or use new_blank_project with type "${type}".`);
    }
    const dir = await createFromTemplate(template, name);
    const res = await openLive(dir);
    return json({ ok: true, dir: res.dir, type: res.type, name: res.name, project: JSON.parse(await readProjectText()) });
  },

  async new_blank_project({ type, name, orientation, resolution }, opts) {
    const kind = String(type || '').toLowerCase();
    if (kind === 'web') {
      // A blank site gets its own free folder (start_web_live alone would reopen an existing site of the same name).
      const free = platform.isNative() ? (await freeProjectDir(name)).split('/').pop() : name;
      return EXEC.start_web_live({ name: free, orientation: orientation || 'vertical' }, opts);
    }
    if (kind !== 'video' && kind !== '3d') throw new Error('type must be video, 3d or web');
    assertNoJob();
    const res = resolution ? normResolution(resolution) : orientation === 'horizontal' ? '1920x1080' : '1080x1920';
    if (!platform.isNative()) {
      // The browser build cannot write project folders: open a built-in template of the same type and replace
      // its content with the blank project through the live manager (like update_project does in the browser).
      const tp = (await listTemplates()).find((x) => x.tur === kind);
      if (!tp) throw new Error(`No ${kind} template is available to start from in the browser build.`);
      const opened = await openLive(await createFromTemplate(tp.id, name));
      const proj = blankProject(kind, slugify(name), res);
      await L().applyText(proj);
      return json({ ok: true, dir: opened.dir, type: kind, name: proj.name, project: compactProject() });
    }
    const dir = await freeProjectDir(name);
    const proj = blankProject(kind, dir.split('/').pop(), res);
    await platform.mkdirp(platform.join(dir, 'medya'));
    await platform.mkdirp(platform.join(dir, 'cikti'));
    await platform.writeText(platform.join(dir, 'proje.json'), JSON.stringify(proj, null, 2) + '\n');
    const opened = await openLive(dir);
    return json({ ok: true, dir: opened.dir, type: opened.type, name: opened.name, project: JSON.parse(await readProjectText()) });
  },

  async open_project({ path }) {
    const res = await openLive(path);
    return json({ ok: true, dir: res.dir, type: res.type, name: res.name });
  },

  async close_project() {
    if (!L().active) return json({ ok: true, note: 'no project was open' });
    const res = await L().close();
    return json({ ok: true, outputs: res?.outputs || [], changes: res?.changes ?? 0 });
  },

  async get_project() {
    requireLive();
    const text = await readProjectText();
    const lv = L();
    return json({ dir: lv.dir, type: lv.type, busy: lv.busy, project_json: text.slice(0, MAX_READ) });
  },

  async update_project({ project_json }, { signal }) {
    requireLive();
    const lv = L();
    let parsed;
    try {
      parsed = JSON.parse(project_json);
    } catch (e) {
      throw new Error('project_json is not valid JSON: ' + errOf(e));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('project_json must be a JSON object');
    if (parsed.type && String(parsed.type).toLowerCase() !== lv.type) throw new Error(`The project type cannot change (it is "${lv.type}")`);
    if (!parsed.type) parsed.type = lv.type;
    if (!platform.isNative()) {
      const r = await lv.applyText(parsed);
      return json({ ok: true, applied: !!r?.applied, project: compactProject() });
    }
    await platform.writeText(platform.join(lv.dir, 'proje.json'), JSON.stringify(parsed, null, 2) + '\n');
    const state = await waitApplied(signal);
    if (state === 'timeout') return json({ ok: true, warning: 'Still applying after 60 s; check again with get_project.' });
    if (state === 'closed') throw new Error('The live project was closed');
    return json({ ok: true, project: lv.type === 'web' ? undefined : compactProject() });
  },

  async start_web_live({ name, orientation }) {
    if (!platform.isNative()) throw new Error('Live websites need the desktop app.');
    assertNoJob();
    const slug = slugify(name);
    const dir = platform.join(platform.paths.root, 'projeler', slug);
    const projPath = platform.join(dir, 'proje.json');
    let proj = null;
    if (await platform.exists(projPath)) {
      try {
        proj = JSON.parse(await platform.readText(projPath));
      } catch {}
      if (proj && proj.type !== 'web') throw new Error(`A ${proj.type || 'non-web'} project named "${slug}" already exists; choose another name.`);
    }
    if (!proj) {
      proj = { type: 'web', name: slug, site: 'site', entry: 'index.html', orientation: orientation || 'vertical' };
      await platform.mkdirp(platform.join(dir, 'site'));
      await platform.writeText(projPath, JSON.stringify(proj, null, 2) + '\n');
    } else if (orientation && proj.orientation !== orientation) {
      proj.orientation = orientation;
      await platform.writeText(projPath, JSON.stringify(proj, null, 2) + '\n');
    }
    const site = confinedSite(proj.site, dir);
    await platform.mkdirp(site);
    // A web live session started by hand (Web tab) would block the manager's own session: finish it first.
    const W = ctx?.modes?.mweb?.api?.live;
    if (W?.active && !(L().active && L().type === 'web')) await W.stop({ tour: false });
    await openLive(dir);
    return json({ ok: true, dir, site, entry: proj.entry || 'index.html', files: await listFiles(site) });
  },

  async list_site_files() {
    const dir = siteDir();
    return json({ site: dir, files: await listFiles(dir) });
  },

  async read_site_file({ path }) {
    const dir = siteDir();
    const rel = safeRel(path);
    const full = platform.join(dir, rel);
    if (!platform.isNative()) throw new Error('Reading site files needs the desktop app.');
    if (!(await platform.exists(full))) throw new Error('File not found: ' + rel);
    const text = await platform.readText(full);
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n…(truncated)' : text;
  },

  async write_site_file({ path, content }) {
    if (!platform.isNative()) throw new Error('Writing site files needs the desktop app.');
    const dir = siteDir();
    const rel = safeRel(path);
    await platform.writeText(platform.join(dir, rel), content);
    return json({ ok: true, path: rel, bytes: content.length });
  },

  async stop_web_live() {
    const lv = L();
    if (lv.active && lv.type === 'web') {
      const res = await lv.close();
      return json({ ok: true, outputs: res?.outputs || [] });
    }
    const W = ctx?.modes?.mweb?.api?.live;
    if (W?.active) {
      const res = await W.stop({ tour: true });
      return json({ ok: true, outputs: res?.video ? [res.video] : [] });
    }
    return json({ ok: true, note: 'no live website was running' });
  },

  async export_project({ file }) {
    requireLive();
    const res = await L().exportNow(file ? { file } : {});
    return json({ ok: true, outputs: res.outputs });
  },

  async note({ text }) {
    noteFn ? noteFn(text) : L().note(text);
    return 'shown';
  },

  async get_schema() {
    return schemaText();
  },
};

async function listFiles(root) {
  if (!platform.isNative()) return [];
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (out.length >= MAX_LIST || depth > 6) return;
    let entries = [];
    try {
      entries = await platform.listDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const n = e.entry;
      if (!n || n === '.' || n === '..' || n === 'node_modules' || n.startsWith('.git')) continue;
      const r = rel ? rel + '/' + n : n;
      if (e.type === 'DIRECTORY') await walk(platform.join(dir, n), r, depth + 1);
      else out.push(r);
      if (out.length >= MAX_LIST) return;
    }
  };
  await walk(root, '', 0);
  return out;
}

/** Runs one tool call. Returns { ok, content } — content is the text sent back to the model. */
export async function runTool(name, input, { signal } = {}) {
  const bad = validateInput(name, input);
  if (bad) return { ok: false, content: json({ INVALID_INPUT: bad, received: input ?? null }) };
  try {
    const content = await EXEC[name](input, { signal });
    return { ok: true, content: String(content ?? 'ok') };
  } catch (e) {
    return { ok: false, content: 'Error: ' + errOf(e) };
  }
}

/** Short human label for a tool chip, e.g. "updated proje.json". */
export function chipLabel(name, input, done) {
  const p = input?.path ? ' ' + input.path : '';
  const L1 = {
    list_templates: [t('ai.chip.list_templates_run', 'reading templates'), t('ai.chip.list_templates', 'read templates')],
    new_project: [t('ai.chip.new_project_run', 'creating project'), t('ai.chip.new_project', 'created project')],
    new_blank_project: [t('ai.chip.new_blank_project_run', 'creating blank project'), t('ai.chip.new_blank_project', 'created blank project')],
    open_project: [t('ai.chip.open_project_run', 'opening project'), t('ai.chip.open_project', 'opened project')],
    close_project: [t('ai.chip.close_project_run', 'closing project'), t('ai.chip.close_project', 'closed project')],
    get_project: [t('ai.chip.get_project_run', 'reading proje.json'), t('ai.chip.get_project', 'read proje.json')],
    update_project: [t('ai.chip.update_project_run', 'updating proje.json'), t('ai.chip.update_project', 'updated proje.json')],
    start_web_live: [t('ai.chip.start_web_live_run', 'starting live website'), t('ai.chip.start_web_live', 'started live website')],
    list_site_files: [t('ai.chip.list_site_files_run', 'listing site files'), t('ai.chip.list_site_files', 'listed site files')],
    read_site_file: [t('ai.chip.read_site_file_run', 'reading') + p, t('ai.chip.read_site_file', 'read') + p],
    write_site_file: [t('ai.chip.write_site_file_run', 'writing') + p, t('ai.chip.write_site_file', 'wrote') + p],
    stop_web_live: [t('ai.chip.stop_web_live_run', 'finishing live website'), t('ai.chip.stop_web_live', 'finished live website')],
    export_project: [t('ai.chip.export_project_run', 'exporting'), t('ai.chip.export_project', 'exported')],
    note: [t('ai.chip.note_run', 'note'), t('ai.chip.note', 'note')],
    get_schema: [t('ai.chip.get_schema_run', 'reading formats'), t('ai.chip.get_schema', 'read formats')],
  }[name];
  return L1 ? L1[done ? 1 : 0] : name;
}

// ---------------------------------------------------------------- system prompt + schema

export function languageName(code = currentLanguage()) {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? `${l.name} (${code})` : 'English (en)';
}

/** Stable for a given language (kept byte-identical between requests so prompt caching works). */
export function systemPrompt(lang = currentLanguage()) {
  return `You are the AI assistant built into Hafif Stüdyo, a lightweight desktop studio for 3D scenes, short videos (TikTok / Shorts / Reels / YouTube) and websites. You control the app through tools. The user watches the screen: every change you make is animated by on-screen agents and shown live.

Pick the right output first (most important):
- VIDEO: any edit, clip, TikTok / Reels / Shorts, animation, intro, meme, slideshow, "make a 10-second ...", anything meant to be watched or exported as MP4 => a video project: new_blank_project {type:"video"} or new_project with a template whose type is "video".
- DRAWINGS IN A VIDEO: custom drawings, characters, stick figures, people interacting, scenes, motion graphics, charts/diagrams, animated backgrounds, or "with HTML / canvas / JavaScript / code" inside a video => draw clips (clips with "kind":"draw" and JavaScript canvas "code") in a video project. Never switch to web mode for this; a website is not a video.
- MUSIC: "music", "cool music", "a beat", "soundtrack" => "music": {"generate": {...}} in the video project (procedural music, no file needed), unless the user supplied a music file. Pick a style that fits the mood.
- WEBSITE: only when the user wants a website, landing page or web page => web mode (start_web_live or new_blank_project {type:"web"}).
- 3D: 3D models, product renders, spinning logos, 3D scenes => a 3d project.
- Never use a template whose type differs from the requested output (pass "type" to new_project so a mismatch fails). If you start from a template, replace or remove all template content that does not match the request (template captions, clips, media, site copy); never leave unrelated template text or footage in the result. If no template fits, use new_blank_project.

How to work:
- Check the state first. If nothing suitable is open, create a project (new_blank_project, or list_templates + new_project). If a project is open, call get_project before editing: the user may have changed it in the UI. If the open project has a different type than the request, create a new one instead of bending it.
- Call get_schema once before your first edit so you know the proje.json format (including draw clips and generated music).
- Work in small visible steps: a few related changes per update_project / write_site_file call, so the user can follow. Before a larger step, narrate it with note() in a few words.
- update_project always takes the complete proje.json. Keep every existing id (c1, t1, o1...), give new items new ids, never change "type", keep media paths that exist.
- Draw clips: write clean, deterministic canvas code sized by w/h; give it style (gradient or dark background, glow, bold colours, easing, small camera moves) and make the action read clearly in a short time. Combine with text (a hook in the first 2 s) and generated music for a finished video.
- Websites: write a skeleton index.html first, then style.css, then add sections one at a time. Plain HTML/CSS/JS, no build step, no external CDNs unless asked.
- Export only when the user asks for it.
- If a tool returns an error, fix the input and retry once; if it still fails, explain briefly.
- When done, answer in 1-3 short sentences: what you made, that it is playing live in the app (video: press play in the Video tab), and what the user could ask next (changes, or "export" for an MP4). No code dumps unless asked.
- Reply in ${languageName(lang)}, the user's interface language, unless the user writes in another language; then use theirs. Text inside the project (captions, site copy) follows the user's request language.`;
}

/** Style names from music-gen.js (an array of names / {id} objects, or an object keyed by name). */
function musicStyleNames() {
  const s = MUSIC_STYLES;
  const names = Array.isArray(s) ? s.map((x) => (typeof x === 'string' ? x : x?.id || x?.name)) : s && typeof s === 'object' ? Object.keys(s) : [];
  const list = names.filter((x) => typeof x === 'string' && x);
  return list.length ? list : ['upbeat', 'chill', 'epic', 'lofi', 'chiptune', 'cinematic'];
}

let schemaCache = '';
/** Built on first use (after draw-clip.js / music-gen.js have loaded); the same text on every call. */
function schemaText() {
  if (schemaCache) return schemaCache;
  const styles = musicStyleNames()
    .map((x) => `"${x}"`)
    .join(' | ');
  const stickClip = JSON.stringify({ id: 'c1', kind: 'draw', track: 'v1', start: 0, duration: 10, code: String(STICK_EXAMPLE || '') });
  schemaCache = `proje.json formats (Hafif Stüdyo live projects). Paths are relative to the project folder.

COMMON: "type" ("video" | "3d" | "web", never change it), "name", optional "agents": {"show": true, "count": 12, "speed": "1x"|"2x"|"5x"|"instant"}, optional "rev" (the app increments it; you may omit it).
RULES: every item has a persistent id: clips[].id "c1".., texts[].id "t1".., objects[].id "o1"... Keep ids when changing an item; new item = new id (next free number). "media" is always an object {"key": "medya/file.ext"}. Send the whole file each time.
NEW PROJECTS: new_blank_project {type, name, orientation} creates an empty project (video: no clips; 3d: empty scene; web: empty site). new_project starts from a template, which must have the SAME type as the request.

VIDEO:
{"type":"video","name":"promo","resolution":"1080x1920" ("1920x1080","1280x720","1080x1080"),"fps":30,"background":"#000000",
 "media":{"game":"medya/oyun.mp4","logo":"medya/logo.png"},
 "clips":[{"id":"c1","media":"game","track":"v1" (v1 main video, v2 overlay, a audio),"start":0,"duration":8,"in":0 (trim start in source),
   "x":0,"y":0 (-0.5..0.5, 0 = centre),"scale":1,"opacity":1,"rotation":0,"fit":"cover"|"contain","volume":1 (0-2),"fadeIn":0.3,"fadeOut":0.5,
   "effects":null (or a look "cinematic"|"warm"|"cool"|"bw"|"vintage"|"vivid", or {brightness,contrast,saturation,hue,blur,grayscale,sepia,vignette}),
   "transition":null (or "fade"|"crossfade"|"slide-left"|"slide-up"|"zoom"|"wipe"|"blur", or {"type":"crossfade","duration":0.5}),
   "motion":null (or {"from":{"x":0,"y":0,"scale":1,"rotation":0},"to":{"scale":1.2},"ease":"ease-in-out"})}],
 "texts":[{"id":"t1","text":"LINE ONE\\nline two","start":0,"duration":2.5,"size":9 (% of the short screen edge, 2-25),"color":"#ffffff",
   "stroke":true,"box":false,"boxColor":"#000000","anim":"none"|"pop"|"slide"|"type"|"bounce"|"fade-up"|"zoom-in"|"wave","font":"Segoe UI","weight":800,
   "x":0,"y":-0.28,"scale":1,"opacity":1,"fadeIn":0,"fadeOut":0.2}],
 "music":{"media":"music","volume":0.7,"start":0,"in":0,"duration":"auto","fadeIn":0.3,"fadeOut":1.5} (a music file in "media"; or the generated form below),
 "output":{"file":"promo.mp4"}}
SHAPE CLIP (no media): {"id":"c5","kind":"shape","shape":"rect"|"rounded"|"circle"|"bar","track":"v2","start":0,"duration":3,"color":"#4f8cff","w":0.6,"h":0.1,"radius":0.3,"x":0,"y":0}

DRAW CLIP (custom JavaScript canvas drawing; use it for everything that is not existing media: characters, stick figures, people interacting, scenes, motion graphics, diagrams, animated backgrounds):
{"id":"c2","kind":"draw","track":"v2" (overlay; "v1" for a full-frame background layer),"start":0,"duration":10,"code":"<JS function body>",
 "x":0,"y":0,"scale":1,"opacity":1,"rotation":0,"fadeIn":0,"fadeOut":0,"transition":null,"effects":null,"motion":null}
- "code" is the BODY of function (ctx, t, w, h, p, H) { ... }. ctx = CanvasRenderingContext2D of a transparent w x h canvas (the project resolution, e.g. 1080x1920), cleared before every frame; t = seconds since the clip start (0..duration); p = t/duration (0..1); H = the helper library below.
- It is called once per frame: draw the WHOLE frame for time t (keep no state between calls). Must be deterministic: no Math.random / Date (use H.rand(i, seed)). It runs in a sandboxed worker: no DOM, no fetch/network, no images.
- Keep each frame fast (well under 250 ms: small loops, no huge particle counts). Size everything from w and h (e.g. w*0.5, h*0.62) so it works at any resolution.
- The layer is composited like a full-frame image clip: x/y/scale/opacity/rotation/effects/motion/transition apply to the whole drawing. Text items are drawn above it.
- One draw clip can hold a whole short scene (use H.seg(t, a, b) for beats inside it); for longer stories put several draw clips one after another (transitions work between them).
- Syntax/runtime errors are shown on the clip in the app; if the user reports one, fix the code and resend.
- In proje.json "code" is a JSON string: escape newlines as \\n and double quotes as \\" (or use single quotes in the JS).
${String(DRAW_HELP || '').trim()}
Example draw clip (two neon stick figures: one waves, the other jumps):
${stickClip}

GENERATED MUSIC (procedural, no file needed; use it whenever the user wants music and gave no file):
"music":{"generate":{"style":"upbeat" (${styles}),"bpm":120 (optional, 60-180, default per style),"seed":1 (integer: another seed = another tune),"key":"A minor" (optional, e.g. "C major", "E minor")},"volume":0.7,"fadeIn":0.3,"fadeOut":1.5,"duration":"auto"}
The app renders the track for the project length and stores it under medya/; keep the "generate" object as it is in proje.json (never replace it with a file path). To change the tune, change style / bpm / seed / key.

Good vertical video: 1080x1920, 30 fps, 8-20 s, something moving from frame 1. Hook text in the first 2 s: size 8-10, stroke true, anim "pop", y about -0.28.
Text must fit: on vertical video use size <= 9 for 2 lines of ~17 characters; max 2 lines, 2-4 words per line. Keep text out of the bottom 15% and the right edge (platform UI).
A new text or cut every 2-3 s; a call to action in the last 2 s if it is a promo. Music volume 0.6-0.8, fadeOut 1.5; mute game audio (clip volume 0-0.3) under music. Clip fades 0.2-0.4 s.
Media: only reference media files that exist in the project (templates ship files such as medya/oyun.mp4 and medya/logo.png; blank projects have none). You cannot create image or video files: draw visuals with draw clips (or text/shape clips) and make music with "music.generate".

3D:
{"type":"3d","name":"logo","scene":{"background":"#101418","grid":false,"shadows":true,"light":2.0,"ambient":1.1},
 "camera":{"position":[6,4,8],"target":[0,1,0],"fov":50},
 "objects":[{"id":"o1","shape":"cube"|"sphere"|"cylinder"|"cone"|"wedge"|"torus"|"capsule"|"plane","name":"Box","position":[0,0.5,0],
   "rotation":[0,45,0] (degrees),"scale":[1,1,1] or 2,"color":"#4f8cff","metalness":0.2,"roughness":0.5,"wireframe":false,"detail":32 (3-64),
   "texture":"medya/logo.png","visible":true},
  {"id":"o2","model":"modeller/car.glb","name":"Car","position":[2,0,0],"scale":1,"fit":2}],
 "outputs":[{"kind":"png","file":"logo.png","width":1920,"height":1080},
  {"kind":"spin","file":"logo-spin.mp4","seconds":6,"width":1080,"height":1920,"fps":30,"turns":1},{"kind":"glb","file":"logo.glb"}]}
Units are metres: a cube is 1x1x1, a plane 4x4. Build products from several shapes; aim the camera target at the object centre; for vertical video keep the camera a bit further away.

WEB (only for websites / landing pages; never use it to make a video):
{"type":"web","name":"site","site":"site","entry":"index.html","orientation":"vertical"|"horizontal","record":false}
Edit the website files with write_site_file (not proje.json); the app animates every file change (new elements get a selection box, text is typed, CSS changes recolour elements).
Settings in proje.json (site, entry, orientation, record) only take effect when the project is reopened. "site" must be a folder inside the project folder.

EXPORT: only when the user asks. export_project writes into <project>/cikti/ (video: "output", 3d: "outputs"). Web videos are only produced when a session opened with "record": true is closed.`;
  return schemaCache;
}
