# Hafif Stüdyo 2 — Mimari ve modül sözleşmeleri

Tek sayfalık uygulama. Kaynak `src/`, `node build.mjs` ile esbuild tek dosyaya paketler:
`resources/index.html` (Neutralino masaüstü) ve `dist-web/HafifStudyo.html` (tarayıcı).
Build, `src/*.css` dosyalarını alfabetik sırayla birleştirip `<!--CSS-->` yerine, JS paketini `<!--JS-->` yerine koyar.

**Performans kuralı (zayıf PC: GTX 1050 Ti):** Boşta CPU/GPU ≈ 0. Sürekli `requestAnimationFrame` döngüsü yok;
çizim sadece bir şey değişince (render-on-demand). Animasyon döngüleri iş bitince kendini durdurur.

## Dosyalar ve sahipler

| Dosya | İçerik |
|---|---|
| `src/util.js` | `$ $$ bus store settings toast busy fmtTime clamp uid sleep esc waitEvent pickMime isTyping extOf baseName stripExt` (hazır, değiştirme) |
| `src/platform.js` | Neutralino köprüsü: `isNative paths args init openFiles saveAs saveOutput saveVideoFile saveVideoAs readBlob readText writeBlob writeText exists mkdirp listDir join resolvePath dirOf findFfmpeg ffmpeg toMp4 startScreenRecord clientOrigin win mount watchDir exit reveal` (hazır) |
| `src/three-mode.js` + `src/three.css` | 3D modu |
| `src/video-mode.js` + `src/video.css` | Video modu |
| `src/agents.js` + `src/agents.css` | Ajan katmanı (imleçler, seçim kutusu, HUD, kod paneli) |
| `src/web-mode.js` + `src/web.css` | Web yapılış modu |
| `src/recipe.js`, `src/jobs.js`, `src/main.js`, `build.mjs` | Tarif çalıştırıcı, iş klasörü, giriş noktası, build |
| `src/style.css` | Orijinal ortak stil (değiştirme; yeni stil kendi css dosyana) |

DOM: `src/index.html` (orijinal işaretleme + `<section id="mweb" class="mode"></section>` boş bölüm + üstte `data-tab="mweb"` sekmesi).
Ortak: `#toast`, `#busy` (busy.show/progress/hide), `#help`, `#st-left`, `#st-right`, `#eco`.

## Mod nesnesi (her mod fabrikası bunu döner)

```js
{ activate(), deactivate(), eco(), api: {...} }
```
`main.js` sekme değişince `deactivate/activate` çağırır. Pasif moddaki her şey durur.

## three-mode.js

`export function createThreeMode()` → mod nesnesi. `import * as THREE from 'three'` ve
`three/examples/jsm/...` (OrbitControls, TransformControls, GLTFLoader, GLTFExporter, OBJLoader, OBJExporter, STLLoader, STLExporter).
`api`:
```js
clear()                                   // sahneyi boşalt (undo geçmişine işler)
addShape(kind, opts) -> Mesh              // kind: cube sphere cylinder cone wedge torus capsule plane
   // opts: {name, position:[x,y,z], rotation:[derece x,y,z], scale:[x,y,z]|sayı, color:'#hex',
   //        metalness, roughness, wireframe, detail(segment), visible, texture: Blob|File (resim, malzemeye map)}
importModel(file, opts) -> Object3D       // file: File (adıyla .glb/.gltf/.obj/.stl); opts: position/rotation/scale + fit:sayı (en büyük boyutu bu birime ölçekle)
update(obj, opts)                         // addShape opts'unun aynısı, var olan nesneye uygular
select(obj|null); selected(); objects()   // objects(): World altındaki nesneler
setScene({background:'#hex', grid:bool, shadows:bool, light:sayı, ambient:sayı})
setCamera({position:[..], target:[..], fov})
renderPNG(w=1920,h=1080) -> Promise<Blob>
recordSpin({seconds=6,width=1280,height=720,fps=30,turns=1,onProgress}) -> Promise<Blob|null>  // MediaRecorder; önce 'video/mp4;codecs=avc1', sonra webm
exportModel('obj'|'stl'|'glb') -> Promise<Blob>
saveProject() -> Promise<Blob>; openProject(blob)
commit()                                   // undo geçmişine anlık durum
el.addButton(kind) -> Element              // [data-add=kind]
el.viewport() -> Element                   // #d-vp
el.props() -> Element                      // #d-props
screenOf(obj) -> {x,y,w,h}|null            // nesnenin ekrandaki sınır kutusu (client CSS px) — ajan seçim kutusu için
```
UI düğmeleri eskisi gibi çalışır; **indirme yerine** `platform.saveAs(blob, ad)` kullanılır
(Kaydet: proje.glb, Dışa aktar: model.obj/stl/glb, PNG: render.png). "Videoya gönder" `bus` üzerinden `to-video` olayı yollar (detail: {blob,name,type}).

## video-mode.js

`export function createVideoMode()` → mod nesnesi. `api`:
```js
clear()                                    // tüm klipler + medya
setResolution('1080x1920'|'1920x1080'|'1280x720'|'1080x1080'|'WxH'); setFps(30|60); setBackground('#000')
addMedia(file, name?, type?) -> Promise<media>   // media: {id,name,type:'video'|'audio'|'image',dur,w,h,...}
addClip(media, opts) -> clip               // opts: {track:'v1'|'v2'|'a', start, duration, in, x, y, scale, opacity, fit:'contain'|'cover', volume, fadeIn, fadeOut}
addText(opts) -> clip                      // {text,start,duration,size,color,stroke,box,boxColor,anim:'none'|'pop'|'slide'|'type',x,y,scale,opacity,fadeIn,fadeOut}
updateClip(id, opts); select(id|null); seek(t); duration(); clips(); media()
commit()                                    // undo geçmişi
exportVideo({onProgress}) -> Promise<Blob|null>  // gerçek zamanlı MediaRecorder; mime sırası: mp4 avc1 → mp4 → webm vp9 → vp8 → webm
el.mediaCard(mediaId) -> Element; el.clip(clipId) -> Element; el.track('t'|'v2'|'v1'|'a') -> Element
el.props() -> Element                       // #v-props
el.timeToX(t) -> clientX                    // zaman çizelgesinde t saniyesinin ekran x'i
```
UI "Videoyu dışa aktar" → `platform.saveVideoAs(blob, 'video.mp4')` (ffmpeg varsa MP4'e çevirir).
Yeni yazı animasyonu `type` (harf harf yazılır) eklenir.

## agents.js — ajan katmanı

`export const agents` (tekil). Tüm koordinatlar ana belgenin **client CSS pikseli**.
Hedef (`target`) şunlardan biri olabilir: `Element`, `{x,y,w,h}` dikdörtgen, `{x,y}` nokta.
```js
start({count=12, mode:'3d'|'video'|'web', title, total, speed:'1x'|'2x'|'5x'|'instant', code?:string})
   // katmanı açar: tek <canvas> (pointer-events:none) imleçler için; HUD; üstte "N ajan aktif" + avatar noktaları;
   // code verilirse sağda kod paneli (tarif JSON'u)
stop({keep=false})          // ajanlar kenara çekilir, döngü durur; keep=false ise HUD da kapanır
progress(done, total?, label?)   // HUD: "20 ajan · 168 / 351 katman", ilerleme çizgisi
pick(role?) -> agent        // sıradaki ajan (role isim eşleşirse onu). agent: {id,name,color,x,y}
moveTo(agent, target, {dur}?)            -> Promise   // hedefin merkezine yumuşak hareket
click(agent, el, {real=true}?)           -> Promise   // gider, tıklama halkası, real ise el.click()
select(agent, target, {label?, hold?})   -> handle {update(target), done(), remove()} // mavi kutu + köşe tutamaçları + "640 × 360" rozeti
typeInto(agent, inputEl, text)           -> Promise   // harf harf; her harfte input olayı, sonda change
slide(agent, rangeEl, value)             -> Promise   // kaydırıcıyı sürükler; input olayları, sonda change
drag(agent, fromTarget, toTarget, {label, onDrop})  -> Promise // hayalet kart taşır, bırakınca onDrop()
codeLine(i, {type=true})    // kod panelinde i. satırı vurgular / yazar
busy(agent, ms)             // ajanı hedefinin çevresinde küçük "çalışıyor" hareketi
setSpeed(s); speed; instant // instant: animasyonsuz (süreler 0)
dur(ms) -> ms               // hıza göre ölçeklenmiş süre
onTour = fn; onClose = fn   // HUD düğmeleri
active                      // bool
```
Çok ajan aynı anda: çağrılar Promise döner, farklı ajanlar paralel `await Promise.all` ile yürüyebilir.
Boşta/pasif ajanlar hafif dolaşır (ambient), ama katman kapalıyken hiçbir döngü dönmez.

## web-mode.js

`export function createWebMode()` → mod nesnesi; `#mweb` içini kendisi doldurur. `api`:
```js
loadSite(dir, entry='index.html')   // Neutralino: platform.mount('/__site', dir) ile aynı origin'de iframe
build({orientation:'vertical'|'horizontal', count=20, speed='1x', hold=2, tour=true, intro='Sayfa taranıyor...'}) -> Promise
record({orientation, file, ...buildOpts}) -> Promise<path>  // build'i ffmpeg ekran kaydıyla videoya çevirir (platform.startScreenRecord)
```
Sitenin dosyalarına dokunulmaz; tüm efekt çalışma anında iframe DOM'u üzerinde (geçici sınıf/stil) yapılır.

## recipe.js / jobs.js

Tarif formatı: `docs/TARIF.md`. `runRecipe(recipe, {baseDir, headless, recordBuild, speed})` → `{outputs:[yol], log:[...]}`.

## Yeni modüller

| Dosya | İçerik |
|---|---|
| `src/video-fx.js` | Saf (içe aktarmasız) video yardımcıları: bakışlar, efektlerden `ctx.filter`, vinyet, easing, geçişler, hareket (Ken Burns), kırpma, yazı varsayılanları ve yazı tipleri, `drawShape`, dışa aktarma ön ayarları ve bit hızı. `video-mode.js` ve `live-video.js` kullanır |
| `src/video.css` | Video modunun yeni arayüzü (efekt, geçiş, dışa aktarma penceresi…); build `src/*.css`'i otomatik alır |
| `src/ai.js` + `src/ai.css` | Uygulama içi AI çekmecesi. `initAI(ctx)` → `{ open(), close(), toggle() }` (iki kez çağrılabilir); üst çubuğa "AI" düğmesi ekler. `main.js` önyüklemede çağırır |
| `src/ai-claude.js` | Claude döngüsü (resmî SDK, akış, araç çağrısı, `refusal`/`max_tokens`/`pause_turn` işleme, şema denetimi) |
| `src/ai-providers.js` | OpenAI uyumlu sağlayıcı (ön ayarlar: OpenAI, OpenRouter, Groq, Gemini, Ollama, LM Studio), ayar saklama, `activeConfig()`, `speakerName()` |
| `src/ai-tools.js` | AI araçları ve yürütücüleri (`live.js`, `templates.js`, `platform.js`, web canlı motoru), girdi denetimi, sistem istemi, `get_schema` metni |
| `src/palette.js` + `palette.css` | Ctrl+K / Ctrl+Shift+P komut paleti (bulanık arama, son 8 komut `store` anahtarı `palRecent`), üst çubukta dil seçici. `initPalette({openTour, openLive?, openAssistant?, actions})`; `registerAction({id,title,keywords,group?,run})`, `openPalette()`, `closePalette()` |
| `src/welcome.js` + `welcome.css` | İlk açılış turu (4 adım). `initWelcome()`, `openTour()`; bitince `store` anahtarı `welcomeDone`. `--run` sırasında gösterilmez |
| `src/i18n.js` | Çeviri altyapısı: `t(key, English, params?)`, `initI18n()`, `applyDom()`, `setLanguage(code)`, `currentLanguage()`, `isRtl()`, `LANGUAGES` (20 dil) |
| `src/locales/` | Sözlükler: `<kod>.json` (düz `{anahtar: metin}`); `en.json` çıkarıcı üretir, `tr.json` Türkçe |
| `tools/i18n-extract.mjs` | Kaynaktaki `t()` çağrılarından ve `data-i18n*` özniteliklerinden `en.json`'u yazar, dil başına eksik/fazla anahtar raporu verir (`--missing tr` eksikleri JSON olarak basar) |

Not: AI, palet ve tur "mod" sözleşmesine girmez; `main.js` önyüklemede (`initI18n()`'den sonra) çağırır. 3D modun küçük CSS'i `three.css` yerine JS ile eklenir (`hs-three-css`).

## i18n kuralları

- Her kullanıcıya görünen metin `t('alan.anahtar', 'İngilizce metin')` ile yazılır; İngilizce metin satır içi yedektir (`en` için sözlük şart değil). `{ad}` yer tutucuları üçüncü parametreyle doldurulur.
- `t()` **arayüz kurulurken** (tembel) çağrılır, modül yüklenirken değil: sözlük `initI18n()` ile yüklenir ve dil değişince sayfa yeniden yüklenir (`setLanguage`).
  Modül düzeyinde sabit olarak `t()` çağırma; fabrika ya da `init` içinde çağır.
- Statik HTML için `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` öznitelikleri (metin İngilizce yedek olur).
- Dinamik anahtarlar (`t('pal.add.' + id)`) çıkarıcıda yalnız önek verir; bunları ayrıca açıkça listele.
- `build.mjs` `src/locales/<kod>.json` dosyalarını `resources/locales/` altına kopyalar (geçersiz JSON build'i düşürür); çalışma anında `fetch('locales/<kod>.json')` ile yüklenir. Tek dosyalık tarayıcı build'inde sözlük yoktur, İngilizce yedek kullanılır.
- Çeviri hazırlık dosyaları `src/locales/_tr/*.json` (agents, lead, live, recipe, three…) `tr.json` içine birleştirilir; `_tr/` yalnız ara kayıttır, build ve çalışma anında okunmaz.
- Yeni metin ekleyince `node tools/i18n-extract.mjs` çalıştırıp `en.json`'u güncelle ve eksikleri kontrol et.

## API eklemeleri

`video-mode.js` (`modes.mvid.api`):
```js
addShape(opts)                        // şekil klibi; addClip(null, {kind:'shape', ...}) de olur
exportVideo({onProgress, scale, quality:'low'|'medium'|'high', bitrate})  // yeni seçenekler yoksa eskisi gibi
exportFrame({scale}) -> Promise<Blob PNG>; openExportDialog()
shuttle(-1|0|1); play(rate); rippleDelete()      // J/K/L; Shift+Delete
tracks(); setTracks({v1:{mute:true}, ...}); markers(); setMarkers([...])   // ayarlayıcılar commit etmez; çağıran commit eder
el.shapeButton(); el.trackHead(k); el.trackFlag(k, flag); el.ruler()
updateClip(id, {'effects.brightness': 1.2, 'motion.to.scale': 1.3, 'transition.type': 'wipe', 'crop.l': 0.1})  // noktalı anahtar; nesne alanı bütünüyle değiştirir, null siler
```
`three-mode.js` (`modes.m3d.api`): `addLight(kind, opts)` (`'point'|'spot'`), `array(obj, {count, axis, spacing})`, `applyPreset(obj, key)`, `presets()`,
`cameraPose(name)`, `setTurntable(bool)`. Genişleyenler: `addShape('text', …)`, `update`/`addShape` yeni alanları alır, `setScene`/`scene()`/`defaults()` `background2` ve `turntable` taşır,
`el.addButton('text'|'pointlight'|'spotlight')`. Işık ve yazı nesneleri geri al, GLB kaydet/aç ve çoğaltmada desteklenir (`emissive`/`opacity` GLB'de `userData.mx` altında).

Canlı uygulayıcılar (`live-video.js`, `live-3d.js`) yeni alanların hepsini farka katar; `defaultOf` yeni alanları kapsar, dosyadan silinen alan varsayılana döner.
`recipe.js` şekil klibini `kind:"shape"` ile destekler (`api.addShape`); diğer yeni video alanları `addClip`/`addText` üzerinden geçer.
