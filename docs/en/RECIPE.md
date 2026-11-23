Türkçe: ../TARIF.md

# Hafif Stüdyo recipe format (v1)

A recipe is a JSON file that tells Hafif Stüdyo what to produce. Types: `3d`, `video`, `web` (a video of a finished site being built),
`web-live` (watch live while Claude writes the site; aliases `canli`, `web-canli`) and `proje` (live project session, see `docs/en/LIVE.md`).
The app runs the recipe itself and writes the results to the **Belgeler\HafifStudyo\çıktılar** folder.

## Ways to run

| Method | How | Status file |
|---|---|---|
| Jobs folder | With the app open, drop `Belgeler\HafifStudyo\isler\<name>.json` | `<name>.done.json` or `<name>.error.json` in the same folder (`<name>.running.json` while running) |
| Command line | `HafifStudyo.exe --run tarif.json [--headless] [--record-build] [--speed 5x] [--out klasör]` | `<name>.done.json` / `.error.json` next to the recipe; exit code 0 = success |
| UI | In the top bar, click **Tarif çalıştır** and pick a .json file | notification on screen |

- `--headless`: the window never appears, the agent animation is skipped, and only the result is produced (the `web` type needs a window and ignores this flag).
- `--record-build`: the whole build process is also screen-recorded as `<name>-yapilis.mp4` (requires ffmpeg; the window is kept on top during recording).
- `hs-run.ps1 -TimeoutSec <sec>` (default 1800): when this time runs out, waiting ends with exit code 2. With `-Queue`, `-Headless`, `-RecordBuild` and `-Speed` have no effect (the running app executes the recipe with its own settings).
- `--speed`: agent speed `1x`, `2x`, `5x`, `instant`. Overrides `agents.speed` in the recipe.
- `.done.json` contents: `{ ok, recipe, started, finished, seconds, outputs: [full paths], log: [...] }`.
- `.error.json` contents: `{ ok:false, error, stack }`. To run again under the same name, delete the status file.
- File paths (media, model, site) can be **absolute** or **relative to the recipe file's folder**. Both `/` and `\` are valid.

## Common fields

```jsonc
{
  "type": "video",            // required: "3d" | "video" | "web" | "web-live" | "proje"
  "name": "oyun-tanitim",     // root of the output names (default: the recipe file's name)
  "outputDir": "projeX",      // optional: absolute path, or a subfolder under the outputs folder
  "baseDir": "C:/projeler/x", // optional: root for relative file paths (defaults to the recipe file's folder).
                              // hs-run.ps1 -Queue adds this itself when it copies the recipe into the jobs folder.
  "agents": {                 // agent mode (build animation)
    "show": true,             // false: no animation (fast)
    "count": 12,              // 1-20 agents (default 20 for web)
    "speed": "2x"             // "1x" | "2x" | "5x" | "instant"; defaults to 1x when --record-build is used
  },
  "recordBuild": false        // true or {"file": "x-yapilis.mp4"}: same as --record-build on the command line
}
```

## `3d` — scene, render, turntable video, model

```jsonc
{
  "type": "3d",
  "name": "logo",
  "clear": true,                                  // empty the scene first (default true)
  "scene": { "background": "#101418", "background2": "#2a3550", "turntable": false,
             "grid": false, "shadows": true, "light": 2.0, "ambient": 1.1 },
                                  // background2: second color = gradient background (null / "" / deleting the key clears it); turntable: camera slowly orbits
  "camera": { "position": [6, 4, 8], "target": [0, 1, 0], "fov": 50, "preset": "orbit" },
                                  // preset: front right side top persp orbit close hero (ready-made angle; one-shot command: removed on write-back)
  "objects": [
    {
      "shape": "cube",            // cube sphere cylinder cone wedge torus capsule plane
                                  // (Turkish names also work: küp küre silindir koni rampa simit kapsül zemin)
      "name": "Kutu",
      "position": [0, 0.5, 0],
      "rotation": [0, 45, 0],     // degrees
      "scale": [1, 1, 1],         // or a single number: 2
      "color": "#4f8cff",
      "metalness": 0.2, "roughness": 0.5,
      "emissive": "#000000", "emissiveIntensity": 1,   // self-illumination (glow); defaults to black / 1
      "opacity": 1,                                    // 0-1 transparency
      "preset": "plastic",        // matte plastic metal gold glass glow: fills in only the material fields the object itself does not specify
      "array": { "count": 5, "axis": "x", "spacing": 1.5 },  // N more copies: ids <id>.2, <id>.3…, names "<name> 2"; if spacing is omitted, the object's size along that axis
      "wireframe": false,
      "detail": 32,               // segment count for curved shapes (3-64)
      "texture": "logo.png",      // optional image texture
      "visible": true
    },
    { "shape": "text", "text": "Merhaba", "font": "Segoe UI", "color": "#ffffff", "background": "", "size": 1, "position": [0, 1, 0] },
                                  // 3D text: color = text color, background = fill (empty = transparent), size = em height (world units);
                                  // "yazı" / "metin" also work; material fields (emissive, opacity, preset…) apply
    { "light": "point", "color": "#ffffff", "intensity": 30, "distance": 0, "position": [0, 3, 0] },
    { "light": "spot", "color": "#ffddaa", "intensity": 60, "angle": 40, "penumbra": 0.3, "position": [0, 4, 0], "rotation": [0, 0, 0] },
                                  // light: light "point" | "spot" (shape: "pointlight" / "spotlight" also work). intensity is in physical units (default 30 for point, 60 for spot);
                                  // distance 0 = unlimited; angle 5-89° and penumbra 0-1 apply to spot only; a spot faces its local −Y direction and is aimed with rotation. At most 8 lights per scene
    { "model": "modeller/araba.glb", "name": "Araba", "position": [2, 0, 0], "rotation": [0, 90, 0], "scale": 1, "fit": 2 }
                                  // model: .glb .gltf .obj .stl; fit: scale the largest dimension to this many units
  ],
  "outputs": [
    { "kind": "png", "file": "logo.png", "width": 1920, "height": 1080 },
    { "kind": "spin", "file": "logo-donen.mp4", "seconds": 6, "width": 1080, "height": 1920, "fps": 30, "turns": 1 },
    { "kind": "obj", "file": "logo.obj" },          // obj | stl | glb
    { "kind": "project", "file": "logo-proje.glb" } // a project you can edit in Hafif Stüdyo via "Aç" (Open)
  ]
}
```
Once a `preset` is applied, the field itself is dropped (the expanded values appear in the written-back proje.json); the glass preset is plain transparency, not real refraction.
Light shadows are visible only when `scene.shadows` is on. If `outputs` is missing, only a 1920×1080 PNG is produced. Think of distance units as meters: a cube is 1×1×1, a plane is 4×4.

## `video` — vertical/horizontal video editing

```jsonc
{
  "type": "video",
  "name": "tanitim",
  "resolution": "1080x1920",     // "1920x1080" "1280x720" "1080x1080" or "vertical" / "horizontal" / "square"
  "fps": 30,                     // 30 or 60
  "background": "#000000",
  "media": {                     // id → file path
    "oyun": "medya/oyun.mp4",
    "logo": "medya/logo.png",
    "muzik": "medya/muzik.mp3"
  },
  "clips": [
    {
      "media": "oyun",           // a media id or a direct file path
      "track": "v1",             // v1 = Main video, v2 = Overlay, a = Audio (text goes in "texts")
      "start": 0,                // start on the timeline (sec)
      "duration": 8,             // duration (sec); if omitted, the rest of the media's length, 3 for images
      "in": 2.0,                 // start within the source (trim)
      "x": 0, "y": 0,            // -0.5..0.5 (screen fraction, 0 = center)
      "scale": 1,                // 1 = fit fully
      "opacity": 1,
      "fit": "cover",            // "contain" (show everything) | "cover" (fill the screen)
      "volume": 1,               // 0-2
      "fadeIn": 0.3, "fadeOut": 0.5,
      "speed": 1,                // 0.25-4 (video/audio only); duration is in timeline seconds, source length = duration × speed
      "rotation": 0,             // degrees, -360..360
      "crop": { "l": 0, "t": 0, "r": 0, "b": 0 },   // fraction of the source, each 0..0.45; null removes
      "effects": "cinematic",    // a look name or a settings object (below); null removes
      "transition": { "type": "crossfade", "duration": 0.5 },   // at the start of the clip; short form "fade"; null / "none" removes
      "motion": "zoom-in"        // Ken Burns: a preset or {from,to,ease} (below); null removes
    },
    { "id": "c5", "kind": "shape", "shape": "rounded", "track": "v2", "start": 0, "duration": 3,
      "color": "#4f8cff", "w": 0.6, "h": 0.1, "radius": 0.3, "x": 0, "y": 0.35 }   // shape clip (below)
  ],
  "texts": [
    {
      "text": "BU OYUN ÇOK ZOR!\nikinci satır",
      "start": 0, "duration": 2.5,
      "size": 9,                 // % of the screen's short side (2-25)
      "color": "#ffffff",
      "stroke": true,            // black outline
      "box": false, "boxColor": "#000000",
      "anim": "pop",             // none | pop (grows in) | slide (slides in) | type (letter by letter) | bounce | fade-up (floats up) | zoom-in (zooms in) | wave (letter-by-letter wave)
      "x": 0, "y": -0.3,         // -0.5..0.5
      "scale": 1, "opacity": 1, "fadeIn": 0, "fadeOut": 0.2,
      "font": "Segoe UI", "weight": 800, "italic": false,   // weight 100-900; any installed font name is accepted
      "align": "center",         // left | center | right
      "letterSpacing": 0, "lineHeight": 1.15, "rotation": 0, // letterSpacing in em (-0.2..1); lineHeight 0.6-3; rotation in degrees
      "strokeColor": "#000000", "strokeWidth": 0.14,         // outline color / thickness (0-0.5 × text size); requires stroke: true
      "shadow": false, "shadowColor": "#000000", "shadowBlur": 0.3, "shadowDist": 0.08,   // blur 0-2, dist 0-1 (× text size)
      "boxPad": 0.35, "boxRadius": 0.25, "boxOpacity": 0.8   // em, em, 0-1; requires box: true
    }
  ],
  "music": { "media": "muzik", "volume": 0.7, "start": 0, "in": 0, "duration": "auto", "fadeIn": 0.3, "fadeOut": 1.5 },
                                 // the short form "music": "medya/muzik.mp3" also works; duration "auto" = the video's length
                                 // instead of a file: "music": { "generate": {"style":"upbeat"}, ... } (see Generated music)
  "markers": [1.5, 4],           // timeline markers (sec); {"time": n} also works
  "tracks": {                    // track state; only true flags are stored (aliases muted/hidden/locked also work)
    "t": { "hide": true, "lock": true },
    "v2": { "mute": false, "hide": false, "lock": false },
    "v1": { "mute": false, "hide": false, "lock": false },
    "a": { "mute": false, "lock": false }
  },
  "output": { "file": "tanitim.mp4", "quality": "high" }   // or "output": "tanitim.mp4"; quality: low | medium | high (bitrate from size × fps)
}
```

### Clip effects, transitions, motion

- **`effects`** object: `brightness` 0..2 [1], `contrast` 0..2 [1], `saturation` 0..3 [1], `hue` −180..180° [0], `blur` 0..40 (px at a 1080 short side) [0],
  `grayscale` 0..1 [0], `sepia` 0..1 [0], `vignette` 0..1 [0]. Or a ready-made look name: `"cinematic" | "warm" | "cool" | "bw" | "vintage" | "vivid"`. `null` removes.
- **`transition`**: `type` = `fade` (from black) | `crossfade` | `slide-left` | `slide-up` | `zoom` | `wipe` | `blur`; `duration` 0.05..5 sec [0.5]. Short form: just the type string.
  Types other than `fade` draw the previous clip on the same track (gap ≤ 0.1 sec) underneath; if its source has ended, its last frame is held, and its audio is ducked during the transition.
  Clips that genuinely overlap also crossfade. Transitions apply only to video, image, shape and draw clips; texts use `anim`.
- **`motion`**: `{ "from": {x,y,scale,rotation}, "to": {...}, "ease": "linear" | "ease-in" | "ease-out" | "ease-in-out" }`. `x`/`y` are screen fractions added to the clip's x/y,
  `scale` multiplies, `rotation` adds. Preset strings: `"zoom-in" | "zoom-out" | "pan-left" | "pan-right"`.
- `crop` and `vignette` do not apply to shape clips; `crop` does not apply to draw clips.

### Shape clip (`kind: "shape"`)

A clip without media inside `clips[]`: `shape` = `rect | rounded | circle | bar` (bar: a progress bar that fills over the clip's duration). `track` defaults to `v2` (`v1` also works).
`color` is the fill color; `w` is a fraction of the screen width and `h` a fraction of the screen height (0.005–2); `radius` 0..1 (for `rounded` and `bar`).
`x`, `y`, `scale`, `rotation`, `opacity`, `fadeIn`, `fadeOut`, `transition`, `effects` and `motion` work as on regular clips.
If `media` is absent and `shape` is present, `kind` may be omitted.
Export runs in real time (a 10 sec video takes about 10 sec). `video/mp4;codecs=avc1` is tried first; if ffmpeg is available, the result is always
converted/remuxed to a player-friendly MP4, otherwise the format the browser provides (MP4 or WebM) is kept.

### Draw clip (`kind: "draw"`)

A video layer whose frames are **drawn by JavaScript** (stick figures, characters, motion graphics, diagrams, animated backgrounds). No media needed.
`track` defaults to `v2` (`v1` also works). If `media` and `shape` are absent and `code` is present, `kind` may be omitted.

```jsonc
{ "id": "c7", "kind": "draw", "track": "v2", "start": 0, "duration": 10,
  "code": "<JS function body>",        // a string (or an array of lines, joined with \n)
  "x": 0, "y": 0, "scale": 1, "opacity": 1, "rotation": 0, "fadeIn": 0, "fadeOut": 0,
  "transition": null, "effects": null, "motion": null }
```

`code` is the **body** of `function (ctx, t, w, h, p, H) { ... }`, called for every frame:
`ctx` = 2D context of an OffscreenCanvas of the project size (`w` x `h`, e.g. 1080x1920), cleared to transparent before each frame;
`t` = seconds since the clip start (0..duration); `p` = `t / duration` (0..1). The layer is composited like a full-frame image clip, so
`x`, `y`, `scale`, `opacity`, `rotation`, `fadeIn`, `fadeOut`, `transition`, `effects` and `motion` apply to the whole drawing. `crop` and `fit` do not apply.
A first line `// Title` becomes the clip's label on the timeline.

**Rules.** The code must be deterministic (the same `t` gives the same frame): no `Date`; `Math.random` is seeded per frame, prefer `H.rand`.
It must be synchronous and fast: each frame has a time budget of about 250 ms (a bit more at full-size export); an endless loop is cut off and reported as an error.

**Sandbox.** The code runs only inside a dedicated Web Worker (created from a Blob URL) with an OffscreenCanvas. Before the code is compiled the worker removes or
stubs `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`, `Worker`, timers, `eval`/`Function` constructors and more;
code containing `import` is rejected, and the worker never sees any Neutralino object or token. Syntax and runtime errors (with the line number) are shown on the clip
(a badge on the timeline, the text in the properties panel, a red note in the preview) and never thrown into the app; exports never include the note.

**Helpers `H`** (documented to the AI by `get_schema`, from `DRAW_HELP` in `src/draw-clip.js`):

| Helper | Meaning |
|---|---|
| `H.lerp(a,b,k)`, `H.clamp(v,a,b)` | interpolate / clamp |
| `H.ease(k, name)` | `linear`, `ease-in`, `ease-out`, `ease-in-out` (default), `bounce`, `elastic` |
| `H.wave(t, freq=1, amp=1, phase=0)` | `amp * sin(2π·freq·t + phase)` |
| `H.rand(i, seed=0)` | deterministic random 0..1 |
| `H.seg(t, start, end)` | progress 0..1 of `t` inside `[start, end]` (clamped); combine with `H.ease` for timed beats |
| `H.hsl(h,s,l,a=1)` | colour string |
| `H.stick(ctx, {x, y, h=300, color, width, head, fill, flip, face, pose})` | stick figure with its lowest foot at `(x,y)` and total height `h`. `pose` = `{armL, armR, legL, legR, body, neck}` in degrees (0 = straight down, positive = towards the figure's right; a limb may be `[upper, bend]`); `face` = `happy` `sad` `surprised` `angry` or `null`; `flip` mirrors. Returns the joints (`head{x,y,r}`, `handL`, `handR`, `footL`, ...) |
| `H.text(ctx, str, x, y, {size, color, font, weight, align, stroke, strokeWidth})` | centred text (`\n` = new line) |
| `H.circle(ctx,x,y,r,fill,stroke,lw)`, `H.line(ctx,x1,y1,x2,y2,color,lw)`, `H.rect(ctx,x,y,w,h,fill,radius)`, `H.poly(ctx,pts,fill,stroke,lw)` | shapes |
| `H.glow(ctx, color, blur)` | neon glow for what follows (`H.glow(ctx, null)` = off) |
| `H.bg(ctx, w, h, c1, c2=null, angle=90)` | background colour or gradient |

Example clip (two neon stick figures: one waves, the other jumps), as it appears in `proje.json`:

```jsonc
{ "id": "c1", "kind": "draw", "track": "v2", "start": 0, "duration": 10, "code": "// Two neon stick figures: one waves, the other jumps.\nH.bg(ctx, w, h, '#0b0620', '#1d0b45', 180);\nconst gy = h * 0.72, s = Math.min(w, h) * 0.42;\nH.glow(ctx, '#00e5ff', 24);\nH.line(ctx, w * 0.06, gy, w * 0.94, gy, '#00e5ff', 6);\nH.glow(ctx, '#ff3df2', 28);\nconst a = H.stick(ctx, { x: w * 0.3, y: gy, h: s, color: '#ff3df2', face: 'happy',\n  pose: { armL: -20, armR: [110, 50 + H.wave(t, 2, 30)], body: H.wave(t, 0.5, 4) } });\nconst air = Math.sin(((t * 0.9) % 1) * Math.PI);\nH.glow(ctx, '#39ff88', 28);\nH.stick(ctx, { x: w * 0.7, y: gy - air * s * 0.45, h: s, color: '#39ff88', flip: true,\n  face: air > 0.6 ? 'surprised' : 'happy',\n  pose: { armL: -30 - 130 * air, armR: 30 + 130 * air } });\nconst pop = H.ease(H.seg(t, 0.4, 0.8), 'elastic');   // speech bubble pops in\nif (pop > 0) {\n  ctx.save(); ctx.translate(a.head.x + s * 0.2, a.head.y - s * 0.3); ctx.scale(pop, pop);\n  H.glow(ctx, '#ffffff', 16);\n  H.rect(ctx, -s * 0.28, -s * 0.1, s * 0.56, s * 0.2, '#ffffff', s * 0.06);\n  H.glow(ctx, null);\n  H.text(ctx, 'Hi!', 0, 0, { size: s * 0.12, color: '#1d0b45' });\n  ctx.restore();\n}" }
```

The same code, readable:

```js
// Two neon stick figures: one waves, the other jumps.
H.bg(ctx, w, h, '#0b0620', '#1d0b45', 180);
const gy = h * 0.72, s = Math.min(w, h) * 0.42;
H.glow(ctx, '#00e5ff', 24);
H.line(ctx, w * 0.06, gy, w * 0.94, gy, '#00e5ff', 6);
H.glow(ctx, '#ff3df2', 28);
const a = H.stick(ctx, { x: w * 0.3, y: gy, h: s, color: '#ff3df2', face: 'happy',
  pose: { armL: -20, armR: [110, 50 + H.wave(t, 2, 30)], body: H.wave(t, 0.5, 4) } });
const air = Math.sin(((t * 0.9) % 1) * Math.PI);
H.glow(ctx, '#39ff88', 28);
H.stick(ctx, { x: w * 0.7, y: gy - air * s * 0.45, h: s, color: '#39ff88', flip: true,
  face: air > 0.6 ? 'surprised' : 'happy',
  pose: { armL: -30 - 130 * air, armR: 30 + 130 * air } });
const pop = H.ease(H.seg(t, 0.4, 0.8), 'elastic');   // speech bubble pops in
if (pop > 0) {
  ctx.save(); ctx.translate(a.head.x + s * 0.2, a.head.y - s * 0.3); ctx.scale(pop, pop);
  H.glow(ctx, '#ffffff', 16);
  H.rect(ctx, -s * 0.28, -s * 0.1, s * 0.56, s * 0.2, '#ffffff', s * 0.06);
  H.glow(ctx, null);
  H.text(ctx, 'Hi!', 0, 0, { size: s * 0.12, color: '#1d0b45' });
  ctx.restore();
}
```

In the app, the **Drawing** button in the video toolbar adds a draw clip with an example like this one; selecting a draw clip shows a code box in the properties panel
(Apply or Ctrl+Enter applies it; the error text appears below).

### Generated music (`music.generate`)

Procedural background music, no file needed. `generate` replaces `media`/`file`; the other music fields work as usual:

```jsonc
"music": { "generate": { "style": "upbeat", "bpm": 120, "seed": 1, "key": "A minor" },
           "volume": 0.7, "fadeIn": 0.3, "fadeOut": 1.5, "duration": "auto" }
```
- `style`: `upbeat` | `chill` | `epic` | `lofi` | `chiptune` | `cinematic` (default `upbeat`). `bpm` is optional (style default; clamped 60-180). `seed` is an integer (default 1; another seed gives a variation).
  `key` is optional (`"C major"`, `"A minor"`, ...; style default).
- Drums, bass, chord pad and a lead/arp follow a 4- or 8-bar progression; the first bar is lighter and the last bar resolves, so any length (3-180 s) ends cleanly. The same parameters give the same result.
- `duration: "auto"` = the length of the project (the piece covers the other clips; 30 s on an empty timeline). It is rendered in well under a second or two (OfflineAudioContext, 44.1 kHz stereo 16-bit WAV).
- Live projects (desktop): the WAV is saved as `<project>/medya/muzik-<style>-<bpm>-<seed>-<hash>.wav` and reused if it already exists (the name changes with any parameter or the needed length).
  `proje.json` keeps the `generate` object; the file never appears in `media`. In recipes, the piece is rendered in memory.
- Web recordings (`web` / `web-live`) accept `"music": { "generate": {...}, "duration": 90 }` too.

## `web` — "built by agents" video of a website

```jsonc
{
  "type": "web",
  "name": "site-yapilis",
  "site": "C:/projeler/my-site",   // folder containing index.html (the site's files are not touched)
  "entry": "index.html",
  "orientation": "vertical",             // "vertical" (1080×1920, default) | "horizontal" (1920×1080)
  "agents": { "count": 20, "speed": "1x" },
  "intro": "Sayfa taranıyor...",
  "hold": 2,                              // how many sec the finished site stays on screen at the end
  "tour": true,                           // scroll the page from top to bottom at the end
  "music": { "file": "muzik.mp3", "volume": 0.6 },   // optional, added afterwards with ffmpeg
  "output": { "file": "site-yapilis.mp4" }           // false: just play, do not record
}
```
Flow: dark screen + "Sayfa taranıyor..." → agents gather in the middle → the DOM is built layer by layer (blue selection box,
size badge, letter-by-letter text, color/font application) → site in its final form → agents withdraw to the edges → tour.
The recording is taken from the screen (ffmpeg gdigrab): **the window must be visible and not covered**.

## `web-live` — watch live while Claude writes the site

Instead of playing back a finished site, as Claude writes files into a site folder, Hafif Stüdyo shows it **live**:
new elements are added with a blue box plus size badge, text is typed letter by letter, when CSS changes the color/font agents go to the changed elements,
and the code panel types out the new lines of the changed file. Claude's notes appear at the top in a "Claude:" bubble.

The easiest way is `hs-run.ps1` (it launches the app if it is closed):
```powershell
hs-run.ps1 -Live C:\projeler\sitem [-Record] [-Orientation vertical|horizontal] [-Name sitem] [-Music muzik.mp3]
hs-run.ps1 -Say "Hero bölümünü yazıyorum"
hs-run.ps1 -LiveStop        # ends the session; prints canli.done.json (with -Record, outputs includes <name>-canli.mp4)
```
Or drop a `canli.json` into the jobs folder:
```jsonc
{ "type": "web-live", "name": "sitem", "site": "C:/projeler/sitem", "entry": "index.html",
  "record": true, "orientation": "vertical", "agents": { "count": 12, "speed": "1x" }, "music": "muzik.mp3" }
```
Control files (in the jobs folder; they are not recipes): `canli.say` (its text is shown as a note), `canli.stop` (ends the session; if the content is `tursuz`, the final tour is skipped).
The default orientation for `web-live` is `horizontal` (`vertical` for the `web` type); pass `-Orientation vertical` for TikTok.
The session also ends via the X in the HUD, or if there are no changes at all for 20 minutes; until then, other recipes wait in the queue.
With `record: true`, only the moments of change are recorded and stitched together (long idle stretches do not end up in the video).

## Examples

The bundled templates (`sablonlar/`) are in English (captions, site copy, names and descriptions).

In the `ornekler/` folder: `tiktok-oyun-tanitim.json`, `3d-logo-donen.json`, `web-site-yapilis.json` (+ `medya/`, `site-ornek/`).
