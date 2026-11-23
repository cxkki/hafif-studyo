Türkçe: ../MIMARI.md

# Hafif Stüdyo 2 — Architecture and module contracts

A single-page application. The source lives in `src/`, and `node build.mjs` bundles it into a single file with esbuild:
`resources/index.html` (Neutralino desktop) and `dist-web/HafifStudyo.html` (browser).
The build concatenates the `src/*.css` files in alphabetical order and substitutes them for `<!--CSS-->`, and substitutes the JS bundle for `<!--JS-->`.

**Performance rule (weak PC: GTX 1050 Ti):** Idle CPU/GPU ≈ 0. There is no continuous `requestAnimationFrame` loop;
drawing happens only when something changes (render-on-demand). Animation loops stop themselves when their work is done.

## Files and owners

| File | Contents |
|---|---|
| `src/util.js` | `$ $$ bus store settings toast busy fmtTime clamp uid sleep esc waitEvent pickMime isTyping extOf baseName stripExt` (ready, do not change) |
| `src/platform.js` | Neutralino bridge: `isNative paths args init openFiles saveAs saveOutput saveVideoFile saveVideoAs readBlob readText writeBlob writeText exists mkdirp listDir join resolvePath dirOf findFfmpeg ffmpeg toMp4 startScreenRecord clientOrigin win mount watchDir exit reveal` (ready) |
| `src/three-mode.js` + `src/three.css` | 3D mode |
| `src/video-mode.js` + `src/video.css` | Video mode |
| `src/agents.js` + `src/agents.css` | Agent layer (cursors, selection box, HUD, code panel) |
| `src/web-mode.js` + `src/web.css` | Web build mode |
| `src/recipe.js`, `src/jobs.js`, `src/main.js`, `build.mjs` | Recipe runner, job folder, entry point, build |
| `src/style.css` | Original shared stylesheet (do not change; put new styles in your own css file) |

DOM: `src/index.html` (the original markup + an empty `<section id="mweb" class="mode"></section>` section + a `data-tab="mweb"` tab at the top).
Shared: `#toast`, `#busy` (busy.show/progress/hide), `#help`, `#st-left`, `#st-right`, `#eco`.

## Mode object (every mode factory returns this)

```js
{ activate(), deactivate(), eco(), api: {...} }
```
`main.js` calls `deactivate/activate` when the tab changes. Everything in an inactive mode stops.

## three-mode.js

`export function createThreeMode()` → mode object. Uses `import * as THREE from 'three'` and
`three/examples/jsm/...` (OrbitControls, TransformControls, GLTFLoader, GLTFExporter, OBJLoader, OBJExporter, STLLoader, STLExporter).
`api`:
```js
clear()                                   // empty the scene (recorded in the undo history)
addShape(kind, opts) -> Mesh              // kind: cube sphere cylinder cone wedge torus capsule plane
   // opts: {name, position:[x,y,z], rotation:[degrees x,y,z], scale:[x,y,z]|number, color:'#hex',
   //        metalness, roughness, wireframe, detail(segments), visible, texture: Blob|File (image, applied as the material map)}
importModel(file, opts) -> Object3D       // file: File (by name .glb/.gltf/.obj/.stl); opts: position/rotation/scale + fit:number (scale the largest dimension to this unit)
update(obj, opts)                         // same as addShape opts, applied to an existing object
select(obj|null); selected(); objects()   // objects(): the objects under World
setScene({background:'#hex', grid:bool, shadows:bool, light:number, ambient:number})
setCamera({position:[..], target:[..], fov})
renderPNG(w=1920,h=1080) -> Promise<Blob>
recordSpin({seconds=6,width=1280,height=720,fps=30,turns=1,onProgress}) -> Promise<Blob|null>  // MediaRecorder; 'video/mp4;codecs=avc1' first, then webm
exportModel('obj'|'stl'|'glb') -> Promise<Blob>
saveProject() -> Promise<Blob>; openProject(blob)
commit()                                   // snapshot the current state into the undo history
el.addButton(kind) -> Element              // [data-add=kind]
el.viewport() -> Element                   // #d-vp
el.props() -> Element                      // #d-props
screenOf(obj) -> {x,y,w,h}|null            // the object's bounding box on screen (client CSS px) — for the agent selection box
```
The UI buttons work as before; **instead of downloading**, `platform.saveAs(blob, name)` is used
(Save: proje.glb, Export: model.obj/stl/glb, PNG: render.png). "Send to video" posts a `to-video` event over `bus` (detail: {blob,name,type}).

## video-mode.js

`export function createVideoMode()` → mode object. `api`:
```js
clear()                                    // all clips + media
setResolution('1080x1920'|'1920x1080'|'1280x720'|'1080x1080'|'WxH'); setFps(30|60); setBackground('#000')
addMedia(file, name?, type?) -> Promise<media>   // media: {id,name,type:'video'|'audio'|'image',dur,w,h,...}
addClip(media, opts) -> clip               // opts: {track:'v1'|'v2'|'a', start, duration, in, x, y, scale, opacity, fit:'contain'|'cover', volume, fadeIn, fadeOut}
addText(opts) -> clip                      // {text,start,duration,size,color,stroke,box,boxColor,anim:'none'|'pop'|'slide'|'type',x,y,scale,opacity,fadeIn,fadeOut}
updateClip(id, opts); select(id|null); seek(t); duration(); clips(); media()
commit()                                    // undo history
exportVideo({onProgress}) -> Promise<Blob|null>  // real-time MediaRecorder; mime order: mp4 avc1 → mp4 → webm vp9 → vp8 → webm
el.mediaCard(mediaId) -> Element; el.clip(clipId) -> Element; el.track('t'|'v2'|'v1'|'a') -> Element
el.props() -> Element                       // #v-props
el.timeToX(t) -> clientX                    // the on-screen x of second t on the timeline
```
The "Export video" UI → `platform.saveVideoAs(blob, 'video.mp4')` (converts to MP4 if ffmpeg is available).
A new text animation `type` (typed out letter by letter) is added.

## agents.js — agent layer

`export const agents` (singleton). All coordinates are **client CSS pixels** of the main document.
A target (`target`) can be one of: `Element`, a `{x,y,w,h}` rectangle, or a `{x,y}` point.
```js
start({count=12, mode:'3d'|'video'|'web', title, total, speed:'1x'|'2x'|'5x'|'instant', code?:string})
   // opens the layer: a single <canvas> (pointer-events:none) for cursors; HUD; "N agents active" + avatar dots at the top;
   // if code is given, a code panel on the right (the recipe JSON)
stop({keep=false})          // agents step aside, the loop stops; if keep=false the HUD closes too
progress(done, total?, label?)   // HUD: "20 agents · 168 / 351 layers", progress line
pick(role?) -> agent        // the next agent (if a role matches a name, that one). agent: {id,name,color,x,y}
moveTo(agent, target, {dur}?)            -> Promise   // smooth movement to the target's center
click(agent, el, {real=true}?)           -> Promise   // goes there, click ring, calls el.click() if real
select(agent, target, {label?, hold?})   -> handle {update(target), done(), remove()} // blue box + corner handles + "640 × 360" badge
typeInto(agent, inputEl, text)           -> Promise   // letter by letter; an input event on each letter, change at the end
slide(agent, rangeEl, value)             -> Promise   // drags the slider; input events, change at the end
drag(agent, fromTarget, toTarget, {label, onDrop})  -> Promise // carries a ghost card, calls onDrop() when dropped
codeLine(i, {type=true})    // highlights / types line i in the code panel
busy(agent, ms)             // a small "working" motion for the agent around its target
setSpeed(s); speed; instant // instant: no animation (durations are 0)
dur(ms) -> ms               // duration scaled by the speed
onTour = fn; onClose = fn   // HUD buttons
active                      // bool
```
Many agents at once: calls return Promises, and different agents can run in parallel with `await Promise.all`.
Idle/passive agents wander lightly (ambient), but no loop runs while the layer is closed.

## web-mode.js

`export function createWebMode()` → mode object; it fills `#mweb` itself. `api`:
```js
loadSite(dir, entry='index.html')   // Neutralino: an iframe on the same origin as platform.mount('/__site', dir)
build({orientation:'vertical'|'horizontal', count=20, speed='1x', hold=2, tour=true, intro='Sayfa taranıyor...'}) -> Promise
record({orientation, file, ...buildOpts}) -> Promise<path>  // turns build into a video with an ffmpeg screen recording (platform.startScreenRecord)
```
The site's files are never touched; all effects are applied at runtime on the iframe DOM (temporary classes/styles).

## recipe.js / jobs.js

Recipe format: [`docs/en/RECIPE.md`](RECIPE.md). `runRecipe(recipe, {baseDir, headless, recordBuild, speed})` → `{outputs:[path], log:[...]}`.

## New modules

| File | Contents |
|---|---|
| `src/video-fx.js` | Pure (import-free) video helpers: looks, `ctx.filter` from effects, vignette, easing, transitions, motion (Ken Burns), cropping, text defaults and fonts, `drawShape`, export presets and bitrate. Used by `video-mode.js` and `live-video.js` |
| `src/draw-clip.js` | Draw clips (`kind:"draw"`, frames drawn by JavaScript). `makeHelpers` (the `H` library), `workerMain` / `workerSource()` (sandboxed Web Worker from a Blob URL with an OffscreenCanvas: network, timers, `eval`, `import` and Neutralino are removed or stubbed before the code is compiled), `createDrawRenderer()` -> `{ frame(clipId, code, t, w, h, scale) -> Promise<ImageBitmap>, cached(clipId), error(clipId), dispose(clipId), disposeAll() }` (cache per clip, merged requests, ~250 ms frame timeout, then the worker is terminated and recreated lazily; errors as text with the line number), `DRAW_HELP` (helper docs for the AI schema), `STICK_EXAMPLE` |
| `src/music-gen.js` | Procedural music. `MUSIC_STYLES`, `generateMusic({style, bpm, seed, key, duration}) -> Promise<Blob>` (WAV 44.1 kHz stereo 16-bit, rendered with OfflineAudioContext, 3-180 s, deterministic), `musicFileName(params, duration)` (cache name `muzik-<style>-<bpm>-<seed>-<hash>.wav`) |
| `src/video.css` | The new UI of video mode (effects, transitions, export dialog…); the build picks up `src/*.css` automatically |
| `src/ai.js` + `src/ai.css` | In-app AI drawer. `initAI(ctx)` → `{ open(), close(), toggle() }` (can be called twice); adds an "AI" button to the top bar. `main.js` calls it at boot |
| `src/ai-claude.js` | Claude loop (official SDK, streaming, tool calls, `refusal`/`max_tokens`/`pause_turn` handling, schema validation) |
| `src/ai-providers.js` | OpenAI-compatible provider (presets: OpenAI, OpenRouter, Groq, Gemini, Ollama, LM Studio), settings storage, `activeConfig()`, `speakerName()` |
| `src/ai-tools.js` | AI tools and their executors (`live.js`, `templates.js`, `platform.js`, the web live engine), input validation, system prompt, `get_schema` text |
| `src/palette.js` + `palette.css` | Ctrl+K / Ctrl+Shift+P command palette (fuzzy search, last 8 commands under the `store` key `palRecent`), language selector in the top bar. `initPalette({openTour, openLive?, openAssistant?, actions})`; `registerAction({id,title,keywords,group?,run})`, `openPalette()`, `closePalette()` |
| `src/welcome.js` + `welcome.css` | First-run tour (4 steps). `initWelcome()`, `openTour()`; when finished, the `store` key `welcomeDone` is set. Not shown during `--run` |
| `src/i18n.js` | Translation infrastructure: `t(key, English, params?)`, `initI18n()`, `applyDom()`, `setLanguage(code)`, `currentLanguage()`, `isRtl()`, `LANGUAGES` (20 languages) |
| `src/locales/` | Dictionaries: `<code>.json` (flat `{key: text}`); the extractor generates `en.json`, `tr.json` is Turkish |
| `tools/i18n-extract.mjs` | Writes `en.json` from the `t()` calls and `data-i18n*` attributes in the source, and reports missing/extra keys per language (`--missing tr` prints the missing ones as JSON) |

Note: the AI, palette and tour are not part of the "mode" contract; `main.js` calls them at boot (after `initI18n()`). The small CSS of the 3D mode is added via JS (`hs-three-css`) instead of `three.css`.

## i18n rules

- Every user-visible string is written as `t('field.key', 'English text')`; the English text is the inline fallback (no dictionary is required for `en`). `{name}` placeholders are filled with the third parameter.
- `t()` is called **while the UI is being built** (lazily), not while the module is loading: the dictionary is loaded by `initI18n()` and the page reloads when the language changes (`setLanguage`).
  Do not call `t()` in a module-level constant; call it inside a factory or `init`.
- For static HTML use the `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` attributes (the text becomes the English fallback).
- For dynamic keys (`t('pal.add.' + id)`) the extractor only emits the prefix; list these explicitly as well.
- `build.mjs` copies the `src/locales/<code>.json` files under `resources/locales/` (invalid JSON fails the build); at runtime they are loaded with `fetch('locales/<code>.json')`. The single-file browser build has no dictionary and uses the English fallback.
- The translation staging files `src/locales/_tr/*.json` (agents, lead, live, recipe, three…) are merged into `tr.json`; `_tr/` is only an intermediate record and is not read by the build or at runtime.
- When you add new text, run `node tools/i18n-extract.mjs` to update `en.json` and check for missing keys.

## API additions

`video-mode.js` (`modes.mvid.api`):
```js
addShape(opts)                        // a shape clip; addClip(null, {kind:'shape', ...}) works too
exportVideo({onProgress, scale, quality:'low'|'medium'|'high', bitrate})  // behaves as before if the new options are absent
exportFrame({scale}) -> Promise<Blob PNG>; openExportDialog()
shuttle(-1|0|1); play(rate); rippleDelete()      // J/K/L; Shift+Delete
tracks(); setTracks({v1:{mute:true}, ...}); markers(); setMarkers([...])   // setters do not commit; the caller commits
el.shapeButton(); el.trackHead(k); el.trackFlag(k, flag); el.ruler()
updateClip(id, {'effects.brightness': 1.2, 'motion.to.scale': 1.3, 'transition.type': 'wipe', 'crop.l': 0.1})  // dotted key; an object field is replaced as a whole, null deletes
```
`three-mode.js` (`modes.m3d.api`): `addLight(kind, opts)` (`'point'|'spot'`), `array(obj, {count, axis, spacing})`, `applyPreset(obj, key)`, `presets()`,
`cameraPose(name)`, `setTurntable(bool)`. Extended: `addShape('text', …)`, `update`/`addShape` accept the new fields, `setScene`/`scene()`/`defaults()` carry `background2` and `turntable`,
`el.addButton('text'|'pointlight'|'spotlight')`. Light and text objects are supported in undo, GLB save/open and duplication (`emissive`/`opacity` live under `userData.mx` in the GLB).

The live appliers (`live-video.js`, `live-3d.js`) include all of the new fields in the diff; `defaultOf` covers the new fields, and a field deleted from the file reverts to its default.
`addDraw(opts)` (also `addClip(null, {kind:'draw', ...})`; `updateClip(id, {code})` works), `drawError(id)`, `el.drawButton()` / `el.drawCode()` / `el.drawApply()`. `publicClip` carries `kind:'draw'` and `code`. The properties panel of a draw clip has a monospace code box (Apply, Ctrl+Enter, Example) and the error text; the toolbar has a **Drawing** button that adds a draw clip with `STICK_EXAMPLE`.
Preview frames are rendered at the preview-quality scale, one frame ahead, with no idle loop (a returned frame triggers a single `requestDraw`); export waits for the exact frame of every visible draw clip. Draw workers are terminated when the clip leaves the timeline, on `clear()` and on deactivate (unless an export is running).
`music.generate` is handled in `live-video.js` and `recipe.js` (`generateMusic` + `musicFileName`; in live projects the WAV is cached under `<project>/medya/`). The in-app AI has the `new_blank_project` tool (`ai-tools.js`) and routing rules in its system prompt (see `docs/en/LIVE.md`). Templates in `sablonlar/` are English by default.
`recipe.js` supports the shape clip via `kind:"shape"` (`api.addShape`); the other new video fields go through `addClip`/`addText`.
