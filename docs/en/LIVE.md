Türkçe: ../CANLI.md

# Live project (working together with Claude)

Goal: the user tells Claude in chat "make that text bigger", "put a logo at the end of the video", "add a pricing section to the site";
Claude edits the project and Hafif Stüdyo shows the change **immediately, through agents**. If the user changes something in the UI,
that is written back to the project as well; on its next step Claude reads the latest state.

## Project folder

`Belgeler\HafifStudyo\projeler\<ad>\` (default; it can be any folder)
```
proje.json        ← single source of truth (the recipe format from RECIPE.md + identifiers)
medya/            ← the project's media (relative paths are relative to the project folder)
site/             ← the site's files in web projects
cikti/            ← exports (default; can be changed with output/outputs in the recipe)
```

### proje.json
Same as the `3d`, `video` and `web` formats in RECIPE.md; the differences are:
- Every item has a persistent `id`: `clips[].id` (`c1`, `c2`…), `texts[].id` (`t1`…), `objects[].id` (`o1`…).
  If missing, the app assigns one and writes it back to the file. When Claude modifies an item it **keeps the same id**; a new item gets a new id.
- `media` is always in object form: `{ "oyun": "medya/oyun.mp4" }`.
- `music` in a video project is `{ "media": "<id>", ... }`.
- Web project: `{ "type": "web", "name": "...", "site": "site", "entry": "index.html", "orientation": "vertical" }`;
  liveness comes from the site's files (the live mode of web-mode).
- Optional `"rev": n` — the app increments it on every write (Claude may neither read nor write it).

## Flow

1. **Open:** The app opens the project → switches to the relevant tab → the project is built from scratch with agents (as in the
   recipe runner, but without exporting). After that, `proje.json` (in web projects, the site folder) is watched.
2. **Claude edits:** `proje.json` changes → 300 ms debounce → the JSON is read (if it is invalid, the last valid state is kept and a
   "proje.json okunamadı: …" warning appears at the top) → a **diff** against the previous state is computed → the operations are applied by agents in sequence:
   - added item → the agent adds it (video: drag from the library onto a track; text: Add text + letter by letter; 3D: toolbar + panel)
   - removed item → the agent selects it, draws a reddish box, deletes it
   - changed field → the agent selects the item, goes to the relevant field in the panel, types/slides the value or picks the color, then the exact value is set through the API
   - project settings (resolution, fps, background, scene, camera) → the relevant control
   - media added → add-to-library animation
   If a new change arrives while an animation is running, the latest state is queued (intermediate states are merged).
3. **User edits:** The mode API reports a change (commit) → after 600 ms the current state is written to proje.json
   (the app's own write does not echo in the watcher: a content digest is compared).
4. **Export:** only on request (a command or the button in the UI) → `outputs`/`output` → `cikti/` (or the
   specified path) → result file.
5. **Close:** a command, the HUD X, or another project being opened.

## Commands (work folder `Belgeler\HafifStudyo\isler\`)

| File | Content | Effect |
|---|---|---|
| `canli.json` | `{"type":"proje","path":"C:/…/projeler/ad"}` or `{"type":"proje","template":"tiktok-oyun","name":"ad"}` | Opens the project live (creating it from a template if needed); lasts until the session ends. When finished, `canli.done.json` |
| `canli.say` | plain text | A note in a "Claude:" bubble at the top |
| `canli.export` (not supported in web projects; a web video is produced when a session opened with `"record": true` closes) | empty or `{"file":"x.mp4"}` | Exports the open project; the result is `canli.export.done.json` / `.error.json` |
| `canli.stop` | empty (or `tursuz`: in web, the final lap is skipped) | Closes the session |
| `canli.proje` | (written by the app) | Full path of the opened project; `hs-run -New/-Open` prints this as a `PROJE: …` line |

`hs-run.ps1` wraps these: `-New <template> -Name <name>`, `-Open <project folder>`, `-Say "…"`, `-Export`, `-Close`
(the old `-Live <site folder>` = live watching of a web project, `-LiveStop` = `-Close`).

## Templates

`sablonlar/<id>/` (in the source) → copied by the build into `resources/sablonlar/` (embedded in the app).
Each template: `sablon.json` (`{ "id", "ad", "aciklama", "tur": "video"|"3d"|"web", "kapak": "kapak.png" }`),
`proje.json`, and `medya/`, `site/` if present. `sablonlar/index.json` provides the list.
A new project = a copy of the template folder (`name` in `proje.json` is set to the new name).
The bundled templates are English by default (captions, site copy, `sablon.json` `ad`/`aciklama`), matching the app's default language; ids, folder and file names and JSON field names are unchanged.

- Large shared media (oyun.mp4, muzik.mp3, logo.png) is kept as a single copy: `sablonlar/_ortak/medya/`. A template requests it in `sablon.json`
  with `"ortak": ["medya/oyun.mp4", …]`; when the project is created, `_ortak/<path>` → `<project>/<path>` is copied.
- `index.json` is **generated by the build** (do not write it by hand): each entry is `{ id, ad, aciklama, tur, kapak, boyut?, dosyalar, ortak? }`;
  `dosyalar` = the files in the template folder (excluding `sablon.json` and the cover). Order: type (video, 3d, web) + `sira` from `sablon.json`.
- New template: `sablonlar/<id>/` + `sablon.json` + `proje.json` (+ cover 320×180, or 180×320 for vertical) → `node build.mjs`.
- `src/templates.js`: `listTemplates()`, `createFromTemplate(id, ad, ustKlasor?)` → the full path of the project folder
  (the name is converted to ASCII, with `-2`, `-3` appended if it already exists; the template-name prefix of output file names is changed as well; `cikti/` is created),
  `openGallery()` → a path or `null`. The browser cannot write to disk: it returns `'/sablonlar/<id>'` (the development server
  serves the shared media at this path too).

## Applier interface (contract for parallel development)

`src/live-video.js` and `src/live-3d.js` expose the same interface; `src/live.js` (the manager) calls them:
```js
export async function apply(prev, next, env)   // if prev is null, build from scratch (= diff from empty). With agents, real UI operations.
export async function exportNow(proj, env, opts = {}) // -> { outputs: [full path] } ; opts.file is optional
export function snapshot(env)                  // -> current state in proje.json format (ids and media ids preserved)
export function normalize(proj)                // -> a copy with ids assigned to items that lack them (c1/t1/o1…), media in object form
```
`env` (provided by the manager):
```js
{ modes, switchTab, dir /* project folder, forward slashes */, resolve(rel) /* -> absolute path */,
  loadFile(rel) /* -> Promise<File> (from disk on desktop, fetch in the browser) */, agents /* src/agents.js */,
  show /* bool: is the agent animation on */, speed /* '1x'|'2x'|'5x'|'instant' */,
  note(text) /* short notification */, outDir /* <project>/cikti */ }
```
Rule: `commit()` calls on the mode APIs during `apply` do not count as user changes (during that time and for the following 400 ms the manager
ignores 'mode-change' events). On user commits, modes emit
`bus.dispatchEvent(new CustomEvent('mode-change', { detail: { mode: 'mvid' | 'm3d' } }))`.
Small shared helpers for the agent display may live inside each applier (copied from recipe.js, without touching recipe.js).

## Module boundaries

- `src/live.js` — the live project manager (open, watch, diff, apply, write back, export, close). It applies 3D and video diffs
  itself (mode APIs + agents); for web projects it uses the `modes.mweb.api.live` engine (web-mode.js).
- `src/templates.js` — template list, creating a project from a template, the gallery window (UI).
- `src/jobs.js` / `tools/hs-run.ps1` — commands.

## New fields (in the live project)

The fields below are the same as in `docs/en/RECIPE.md`; this is how they behave in `proje.json`. If a field is removed it reverts to its default.

**Video** (`live-video.js`)
- Clip: `speed` (0.25–4), `rotation` (−360..360), `crop` (`{l,t,r,b}`, 0..0.45), `effects` (an object or a look name), `transition`, `motion`.
  The agents open the sections in the panel, click the look button, choose the transition type and slide the duration, and slide or type the effect/crop/motion values one by one; the exact value is then set through the API.
- Shape clip: `{"id":"c5","kind":"shape","shape":"rect|rounded|circle|bar","track":"v2","start":0,"duration":3,"color":"#4f8cff","w":0.6,"h":0.1,"radius":0.3}`.
  When one is added, the agent clicks the "Şekil" button; if `kind` changes, the clip is replaced. A shape clip has no media.
- Draw clip (a layer drawn by JavaScript, see `docs/en/RECIPE.md`): `{"id":"c7","kind":"draw","track":"v2","start":0,"duration":10,"code":"<JS>"}` plus `x`, `y`, `scale`, `rotation`, `opacity`, `fadeIn`, `fadeOut`, `transition`, `effects`, `motion`.
  A clip with `code` and no media or shape gets `kind: "draw"`; `code` may also be an array of lines (the file keeps it as an array). A changed `kind` or `track` replaces the clip; a field removed from the file returns to its default (duration 5, empty code, x 0, y 0, scale 1, opacity 1, fades 0).
  When one is added, a "Kod" agent clicks the **Drawing** button, clears the code box in the panel, types the first few lines, fills in the rest and points at Apply; the exact code is then set through the API, so no "Not applied yet" draft is left.
  The code runs in a sandboxed Worker with a per-frame time limit; errors show as a badge on the clip and in the panel. Snapshot writes user-added draw clips as `{id, kind:"draw", track, code, ...}` without media.
- Generated music: `"music": {"generate": {"style":"upbeat","bpm":120,"seed":1,"key":"A minor"}, "volume":0.7, "fadeIn":0.3, "fadeOut":1.5, "duration":"auto"}`
  (styles `upbeat chill epic lofi chiptune cinematic`; no `media`/`file`). The piece must cover `in` + duration x speed (`"auto"` = up to the end of the other clips, 30 s on an empty timeline), rounded up to 0.5 s and clamped to 3-180 s.
  On desktop the WAV is `<project>/medya/muzik-<style>-<bpm>-<seed>-<hash>.wav`: an existing file is reused, otherwise it is generated and saved there (in the browser it stays in memory). `proje.json` keeps the `generate` object and the file never appears in `media`
  (also after undo), so the round trip stays idempotent. Changing `generate`, or switching between a file and generated music, replaces the music; the clip keeps its start, `in`, speed, volume and fades.
  If the user changes the video length under `"auto"`, one background refresh (a single 500 ms timer) regenerates the piece without a history entry. A WAV written by this session is deleted from `medya/` once a newer piece replaces it; files from earlier sessions are never deleted.
- Text: `font`, `weight`, `italic`, `align`, `letterSpacing`, `lineHeight`, `rotation`, `strokeColor`, `strokeWidth`, `shadow*`, `boxPad`, `boxRadius`, `boxOpacity`; `anim` can now also be `bounce | fade-up | zoom-in | wave`.
- Project: `markers` (`[1.5, 4]`), `tracks` (`{"v1":{"mute":true,"lock":true}}`), `output.quality` (`low|medium|high`, used in live export).
- Write-back: fields the user changed in the UI are written. A value written in the file as a look name or a transition string stays as it is until the user changes it.
  For items the user adds, only fields that differ from the default are written; a shape clip is written with `kind: "shape"`, without media.

**3D** (`live-3d.js`)
- `scene.background2` (gradient; `null`/`""` removes it), `scene.turntable` (written back only when true), `camera.preset` (`front right side top persp orbit close hero`).
  `camera.preset` is one-shot: it is applied after all objects have been built, if it is new or different from the previous one; it is removed on write-back.
- Material: `emissive` (`#000000`), `emissiveIntensity` (1), `opacity` (0–1, 1), `preset` (`matte plastic metal gold glass glow`; it fills in only the fields the object does not specify and is then dropped, so the expanded values are visible in the file).
- 3D text: `{"shape":"text","text":"Merhaba","font":"Segoe UI","color":"#ffffff","background":"","size":1}`; default position `[0,1,0]`.
- Light: `{"light":"point"|"spot","color","intensity" (30/60),"distance" (0),"angle" (5–89),"penumbra" (0–1),"position","rotation"}`. When switching between point and spot, the object is rebuilt.
- `array`: `{"count":N,"axis":"x|y|z","spacing":1.5}` adds N copies (`<id>.2`, `<id>.3`…); `normalize` expands it, and on write-back the copies are written as separate objects.
- Note: a change made by hand in the UI reaches the file only through write-back; the expansion of `preset` and `array` happens when the AI's file is applied.

## In-app AI assistant

The **AI** button in the top bar (or AI assistant from the Ctrl+K palette) opens a drawer on the right; the user can have the AI edit the
live project directly from inside the app. While the drawer is open, the main area narrows (it does not overlap) if the window is ≥ 1100 px.

- **Providers:** Claude (`src/ai-claude.js`, the official `@anthropic-ai/sdk`; models `claude-opus-5-5` by default, `claude-sonnet-5-5`, `claude-haiku-5-5`, or any typed name; effort `low|medium|high|xhigh|max`, default medium)
  and OpenAI-compatible providers (`src/ai-providers.js`, `{baseUrl}/chat/completions`): OpenAI, OpenRouter, Groq, Google Gemini, Ollama (`http://localhost:11434/v1`, requires `OLLAMA_ORIGINS=*`), LM Studio (`http://localhost:1234/v1`, CORS must be enabled).
- **Tools** (`src/ai-tools.js`): `list_templates`, `new_project(template, name, type?)`, `new_blank_project(type, name, orientation?, resolution?)`, `open_project(path)`, `close_project`, `get_project`, `update_project(project_json)`,
  `start_web_live(name, orientation)`, `list_site_files`, `read_site_file(path)`, `write_site_file(path, content)`, `stop_web_live`, `export_project(file?)`, `note(text)`, `get_schema`.
  On desktop, `update_project` writes `proje.json`; the watcher applies it with agent animations, and the tool waits until `live.busy` finishes (at most 60 s) and returns the applied project. In the browser, `live.applyText` is used.
  Site file paths must be relative (absolute paths and `..` are rejected); the site file tools work on desktop only. `start_web_live` opens a web project under `Belgeler\HafifStudyo\projeler\<ad>\`.
  `new_blank_project` creates `Belgeler\HafifStudyo\projeler\<slug>\` (`-2`, `-3` if the name is taken; with `medya/` and `cikti/`) holding a minimal `proje.json`, and opens it live: `video` = `{"type":"video","name","resolution":"1080x1920","fps":30,"background":"#000000","clips":[],"texts":[],"music":null}` (`horizontal` = 1920x1080; `resolution` `"WxH"`, 64-7680 px per side, overrides), `3d` = an empty scene, `web` = the same as `start_web_live`. In the browser build it opens a template of that type and replaces it through `live.applyText`.
  `new_project` takes an optional `type`; if the template has another type the call fails and points to `new_blank_project`.
- **Routing (system prompt):** video requests (edit, clip, TikTok/Reels/Shorts, animation, "make a 10-second ...") => a video project (blank or a video template). Custom drawings, characters, stick figures, motion graphics, diagrams or "with HTML/canvas" inside a video => **draw clips** (`kind:"draw"`), never web mode. "Music"/"cool music" => `music.generate` unless the user gave a file. Web mode only when the user wants a website or landing page. A template whose type differs from the requested output is never used, and template content that does not match the request is replaced or removed. The AI tells the user the result plays live and exports only when asked.
  `get_schema` documents draw clips (fields, the `H` helpers from `DRAW_HELP`, the `STICK_EXAMPLE` clip) and `music.generate` next to the rest of the format.
- **Where the key lives:** the API key is kept only in the browser's `localStorage` (`hs_ai`, via `util.store`); it is **never written to any project file (proje.json, recipe, site)**.
  It is sent only to the selected provider, as a header (Claude: `x-api-key`; others: `Authorization: Bearer`), and is never put in the URL. "Forget key" in the settings deletes the key.
  The `hs_ai` format is `{preset, effort, models, baseUrls, keys}`.
- Chat history is held in memory; it is erased when the page is refreshed. When idle, no loop runs.

## Continuing to drive with Claude Code

The in-app assistant is optional: Claude Code (terminal) can still drive the app with `hs-run.ps1`
(`-New`, `-Open`, `-Say`, `-Export`, `-Close`) and edit `proje.json` directly; the app applies both through the same watcher.
Both can be used at the same time: the last written state wins and intermediate states are merged.
