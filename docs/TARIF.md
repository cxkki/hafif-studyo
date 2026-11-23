# Hafif Stüdyo tarif formatı (v1)

Tarif, Hafif Stüdyo'ya ne üreteceğini söyleyen bir JSON dosyasıdır. Türler: `3d`, `video`, `web` (bitmiş sitenin yapılış videosu),
`web-live` (Claude siteyi yazarken canlı izle; takma adlar `canli`, `web-canli`) ve `proje` (canlı proje oturumu, bkz. `docs/CANLI.md`).
Uygulama tarifi kendisi çalıştırır, sonuçları **Belgeler\HafifStudyo\çıktılar** klasörüne yazar.

## Çalıştırma yolları

| Yol | Nasıl | Durum dosyası |
|---|---|---|
| İş klasörü | Uygulama açıkken `Belgeler\HafifStudyo\isler\<ad>.json` bırak | aynı klasörde `<ad>.done.json` ya da `<ad>.error.json` (çalışırken `<ad>.running.json`) |
| Komut satırı | `HafifStudyo.exe --run tarif.json [--headless] [--record-build] [--speed 5x] [--out klasör]` | tarifin yanına `<ad>.done.json` / `.error.json`; çıkış kodu 0 = başarılı |
| Arayüz | Üst çubukta **Tarif çalıştır** → .json seç | ekranda bildirim |

- `--headless`: pencere hiç görünmez, ajan animasyonu atlanır, sadece sonuç üretilir (`web` türü pencere ister, bu bayrağı yok sayar).
- `--record-build`: tüm yapılış süreci ayrıca `<ad>-yapilis.mp4` olarak ekrandan kaydedilir (ffmpeg gerekir; pencere kayıt boyunca en üstte tutulur).
- `hs-run.ps1 -TimeoutSec <sn>` (varsayılan 1800): bu süre dolunca bekleme biter, çıkış kodu 2. `-Queue` ile `-Headless`, `-RecordBuild`, `-Speed` etkisizdir (açık uygulama tarifi kendi ayarıyla çalıştırır).
- `--speed`: ajan hızı `1x`, `2x`, `5x`, `instant` (anında). Tarifteki `agents.speed` değerini ezer.
- `.done.json` içeriği: `{ ok, recipe, started, finished, seconds, outputs: [tam yollar], log: [...] }`.
- `.error.json` içeriği: `{ ok:false, error, stack }`. Aynı adla tekrar çalıştırmak için durum dosyasını sil.
- Dosya yolları (medya, model, site) **mutlak** ya da **tarif dosyasının klasörüne göre göreli** olabilir. `/` ve `\` ikisi de geçerli.

## Ortak alanlar

```jsonc
{
  "type": "video",            // zorunlu: "3d" | "video" | "web" | "web-live" | "proje"
  "name": "oyun-tanitim",     // çıktı adlarının kökü (varsayılan: tarif dosyasının adı)
  "outputDir": "projeX",      // isteğe bağlı: mutlak yol ya da çıktılar klasörünün altında alt klasör
  "baseDir": "C:/projeler/x", // isteğe bağlı: göreli dosya yollarının kökü (yoksa tarif dosyasının klasörü).
                              // hs-run.ps1 -Queue tarifi iş klasörüne kopyalarken bunu kendisi ekler.
  "agents": {                 // ajan modu (yapılış animasyonu)
    "show": true,             // false: animasyonsuz (hızlı)
    "count": 12,              // 1-20 ajan (web için varsayılan 20)
    "speed": "2x"             // "1x" | "2x" | "5x" | "instant"; --record-build varken varsayılan 1x
  },
  "recordBuild": false        // true ya da {"file": "x-yapilis.mp4"}: komut satırındaki --record-build ile aynı
}
```

## `3d` — sahne, render, döner video, model

```jsonc
{
  "type": "3d",
  "name": "logo",
  "clear": true,                                  // önce sahneyi boşalt (varsayılan true)
  "scene": { "background": "#101418", "background2": "#2a3550", "turntable": false,
             "grid": false, "shadows": true, "light": 2.0, "ambient": 1.1 },
                                  // background2: ikinci renk = degrade arka plan (null / "" / anahtarı silmek temizler); turntable: kamera yavaşça döner
  "camera": { "position": [6, 4, 8], "target": [0, 1, 0], "fov": 50, "preset": "orbit" },
                                  // preset: front right side top persp orbit close hero (hazır açı; tek seferlik komut: geri yazımda silinir)
  "objects": [
    {
      "shape": "cube",            // cube sphere cylinder cone wedge torus capsule plane
                                  // (Türkçe de olur: küp küre silindir koni rampa simit kapsül zemin)
      "name": "Kutu",
      "position": [0, 0.5, 0],
      "rotation": [0, 45, 0],     // derece
      "scale": [1, 1, 1],         // ya da tek sayı: 2
      "color": "#4f8cff",
      "metalness": 0.2, "roughness": 0.5,
      "emissive": "#000000", "emissiveIntensity": 1,   // kendi ışığı (parlama); varsayılan siyah / 1
      "opacity": 1,                                    // 0-1 saydamlık
      "preset": "plastic",        // matte plastic metal gold glass glow: yalnız nesnenin kendisi yazmadığı malzeme alanlarını doldurur
      "array": { "count": 5, "axis": "x", "spacing": 1.5 },  // N kopya daha: kimlikler <id>.2, <id>.3…, adlar "<ad> 2"; spacing yoksa nesnenin o eksendeki boyu
      "wireframe": false,
      "detail": 32,               // eğri şekillerde segment sayısı (3-64)
      "texture": "logo.png",      // isteğe bağlı resim dokusu
      "visible": true
    },
    { "shape": "text", "text": "Merhaba", "font": "Segoe UI", "color": "#ffffff", "background": "", "size": 1, "position": [0, 1, 0] },
                                  // 3B yazı: color = yazı rengi, background = dolgu (boş = saydam), size = em yüksekliği (dünya birimi);
                                  // "yazı" / "metin" de olur; malzeme alanları (emissive, opacity, preset…) geçerli
    { "light": "point", "color": "#ffffff", "intensity": 30, "distance": 0, "position": [0, 3, 0] },
    { "light": "spot", "color": "#ffddaa", "intensity": 60, "angle": 40, "penumbra": 0.3, "position": [0, 4, 0], "rotation": [0, 0, 0] },
                                  // ışık: light "point" | "spot" (shape: "pointlight" / "spotlight" de olur). intensity fiziksel birim (varsayılan 30 nokta, 60 spot);
                                  // distance 0 = sınırsız; angle 5-89° ve penumbra 0-1 yalnız spot; spot yerel −Y yönüne bakar, rotation ile yönlendirilir. Sahnede en çok 8 ışık
    { "model": "modeller/araba.glb", "name": "Araba", "position": [2, 0, 0], "rotation": [0, 90, 0], "scale": 1, "fit": 2 }
                                  // model: .glb .gltf .obj .stl; fit: en büyük boyutu bu kadar birime ölçekle
  ],
  "outputs": [
    { "kind": "png", "file": "logo.png", "width": 1920, "height": 1080 },
    { "kind": "spin", "file": "logo-donen.mp4", "seconds": 6, "width": 1080, "height": 1920, "fps": 30, "turns": 1 },
    { "kind": "obj", "file": "logo.obj" },          // obj | stl | glb
    { "kind": "project", "file": "logo-proje.glb" } // Hafif Stüdyo'da "Aç" ile düzenlenebilir proje
  ]
}
```
`preset` uygulanınca alanın kendisi düşer (geri yazılan proje.json'da açılmış değerler görünür); cam ön ayarı gerçek kırılma değil düz saydamlıktır.
Işık gölgeleri yalnız `scene.shadows` açıkken görünür. `outputs` yoksa sadece 1920×1080 PNG üretilir. Uzaklık birimi metre gibi düşün: küp 1×1×1, zemin 4×4.

## `video` — dikey/yatay video kurgusu

```jsonc
{
  "type": "video",
  "name": "tanitim",
  "resolution": "1080x1920",     // "1920x1080" "1280x720" "1080x1080" ya da "vertical" / "horizontal" / "square"
  "fps": 30,                     // 30 ya da 60
  "background": "#000000",
  "media": {                     // kimlik → dosya yolu
    "oyun": "medya/oyun.mp4",
    "logo": "medya/logo.png",
    "muzik": "medya/muzik.mp3"
  },
  "clips": [
    {
      "media": "oyun",           // media kimliği ya da doğrudan dosya yolu
      "track": "v1",             // v1 = Ana video, v2 = Üst katman, a = Ses (yazılar "texts" ile)
      "start": 0,                // zaman çizelgesinde başlangıç (sn)
      "duration": 8,             // süre (sn); yoksa medyanın kalan süresi, resimde 3
      "in": 2.0,                 // kaynak içinde başlangıç (kırpma)
      "x": 0, "y": 0,            // -0.5..0.5 (ekran oranı, 0 = orta)
      "scale": 1,                // 1 = tam sığdır
      "opacity": 1,
      "fit": "cover",            // "contain" (tamamı görünsün) | "cover" (ekranı doldur)
      "volume": 1,               // 0-2
      "fadeIn": 0.3, "fadeOut": 0.5,
      "speed": 1,                // 0.25-4 (yalnız video/ses); duration zaman çizelgesi sn'si, kaynak süresi = duration × speed
      "rotation": 0,             // derece, -360..360
      "crop": { "l": 0, "t": 0, "r": 0, "b": 0 },   // kaynağın oranı, her biri 0..0.45; null siler
      "effects": "cinematic",    // bakış adı ya da ayar nesnesi (aşağıda); null siler
      "transition": { "type": "crossfade", "duration": 0.5 },   // klip başında; kısa yazım "fade"; null / "none" siler
      "motion": "zoom-in"        // Ken Burns: ön ayar ya da {from,to,ease} (aşağıda); null siler
    },
    { "id": "c5", "kind": "shape", "shape": "rounded", "track": "v2", "start": 0, "duration": 3,
      "color": "#4f8cff", "w": 0.6, "h": 0.1, "radius": 0.3, "x": 0, "y": 0.35 }   // şekil klibi (aşağıda)
  ],
  "texts": [
    {
      "text": "BU OYUN ÇOK ZOR!\nikinci satır",
      "start": 0, "duration": 2.5,
      "size": 9,                 // ekranın kısa kenarının %'si (2-25)
      "color": "#ffffff",
      "stroke": true,            // siyah kontür
      "box": false, "boxColor": "#000000",
      "anim": "pop",             // none | pop (büyüyerek) | slide (kayarak) | type (harf harf) | bounce (zıplayarak) | fade-up (yukarı süzülerek) | zoom-in (yakınlaşarak) | wave (harf harf dalga)
      "x": 0, "y": -0.3,         // -0.5..0.5
      "scale": 1, "opacity": 1, "fadeIn": 0, "fadeOut": 0.2,
      "font": "Segoe UI", "weight": 800, "italic": false,   // weight 100-900; yüklü her yazı tipi adı kabul edilir
      "align": "center",         // left | center | right
      "letterSpacing": 0, "lineHeight": 1.15, "rotation": 0, // letterSpacing em (-0.2..1); lineHeight 0.6-3; rotation derece
      "strokeColor": "#000000", "strokeWidth": 0.14,         // kontür rengi / kalınlığı (0-0.5 × yazı boyu); stroke: true ister
      "shadow": false, "shadowColor": "#000000", "shadowBlur": 0.3, "shadowDist": 0.08,   // blur 0-2, dist 0-1 (× yazı boyu)
      "boxPad": 0.35, "boxRadius": 0.25, "boxOpacity": 0.8   // em, em, 0-1; box: true ister
    }
  ],
  "music": { "media": "muzik", "volume": 0.7, "start": 0, "in": 0, "duration": "auto", "fadeIn": 0.3, "fadeOut": 1.5 },
                                 // "music": "medya/muzik.mp3" kısa yazımı da olur; duration "auto" = video süresi
  "markers": [1.5, 4],           // zaman çizelgesi işaretleri (sn); {"time": n} de olur
  "tracks": {                    // kanal durumu; yalnız true bayraklar saklanır (muted/hidden/locked takma adları da olur)
    "t": { "hide": true, "lock": true },
    "v2": { "mute": false, "hide": false, "lock": false },
    "v1": { "mute": false, "hide": false, "lock": false },
    "a": { "mute": false, "lock": false }
  },
  "output": { "file": "tanitim.mp4", "quality": "high" }   // ya da "output": "tanitim.mp4"; quality: low | medium | high (bit hızı boyut × fps'ten)
}
```

### Klip efektleri, geçişler, hareket

- **`effects`** nesnesi: `brightness` 0..2 [1], `contrast` 0..2 [1], `saturation` 0..3 [1], `hue` −180..180° [0], `blur` 0..40 (1080 kısa kenarda px) [0],
  `grayscale` 0..1 [0], `sepia` 0..1 [0], `vignette` 0..1 [0]. Ya da hazır bakış adı: `"cinematic" | "warm" | "cool" | "bw" | "vintage" | "vivid"`. `null` siler.
- **`transition`**: `type` = `fade` (siyahtan) | `crossfade` | `slide-left` | `slide-up` | `zoom` | `wipe` | `blur`; `duration` 0.05..5 sn [0.5]. Kısa yazım: yalnız tür dizgesi.
  `fade` dışındakiler aynı kanaldaki önceki klibi (aralık ≤ 0.1 sn) altta çizer; kaynağı bittiyse son kare tutulur, sesi geçiş boyunca kısılır.
  Gerçekten üst üste binen klipler ayrıca çapraz geçer. Geçiş yalnız video, resim, şekil ve çizim kliplerinde; yazılar `anim` kullanır.
- **`motion`**: `{ "from": {x,y,scale,rotation}, "to": {...}, "ease": "linear" | "ease-in" | "ease-out" | "ease-in-out" }`. `x`/`y` klibin x/y'sine eklenen ekran oranıdır,
  `scale` çarpar, `rotation` ekler. Ön ayar dizgeleri: `"zoom-in" | "zoom-out" | "pan-left" | "pan-right"`.
- `crop` ve `vignette` şekil kliplerinde uygulanmaz; `crop` çizim kliplerinde de uygulanmaz.

### Şekil klibi (`kind: "shape"`)

`clips[]` içinde medyasız klip: `shape` = `rect | rounded | circle | bar` (bar: klip boyunca dolan ilerleme çubuğu). `track` varsayılanı `v2` (`v1` de olur).
`color` dolgu rengi; `w` ekran genişliğinin, `h` ekran yüksekliğinin oranı (0.005–2); `radius` 0..1 (`rounded` ve `bar` için).
`x`, `y`, `scale`, `rotation`, `opacity`, `fadeIn`, `fadeOut`, `transition`, `effects`, `motion` normal kliplerdeki gibidir.
`media` yoksa ve `shape` varsa `kind` yazılmayabilir.
Dışa aktarma gerçek zamanlıdır (10 sn video ≈ 10 sn sürer). Önce `video/mp4;codecs=avc1` denenir; ffmpeg varsa sonuç her zaman
oynatıcı dostu MP4'e çevrilir/yeniden paketlenir, yoksa tarayıcının verdiği biçim (MP4 ya da WebM) kalır.

### Çizim klibi (`kind: "draw"`)

Kareleri **JavaScript ile çizilen** video katmanı (çöp adam, karakter, hareketli grafik, diyagram, animasyonlu arka plan). Medya gerekmez.
`track` varsayılanı `v2` (`v1` de olur). `media` ve `shape` yoksa ve `code` varsa `kind` yazılmayabilir.

```jsonc
{ "id": "c7", "kind": "draw", "track": "v2", "start": 0, "duration": 10,
  "code": "<JS fonksiyon gövdesi>",    // dizge (ya da satır dizisi; \n ile birleştirilir)
  "x": 0, "y": 0, "scale": 1, "opacity": 1, "rotation": 0, "fadeIn": 0, "fadeOut": 0,
  "transition": null, "effects": null, "motion": null }
```

`code`, `function (ctx, t, w, h, p, H) { ... }` fonksiyonunun **gövdesidir**; her kare için çağrılır:
`ctx` = proje boyutunda (`w` x `h`, örn. 1080x1920) bir OffscreenCanvas'ın 2D bağlamı, her karede şeffaf temizlenir;
`t` = klip başından beri saniye (0..süre); `p` = `t / duration` (0..1). Katman tam kare bir resim klibi gibi birleştirilir:
`x`, `y`, `scale`, `opacity`, `rotation`, `fadeIn`, `fadeOut`, `transition`, `effects`, `motion` tüm çizime uygulanır. `crop` ve `fit` uygulanmaz.
İlk satır `// Başlık` ise zaman çizelgesinde klibin adı olur.

**Kurallar.** Kod deterministik olmalı (aynı `t` aynı kareyi verir): `Date` yok; `Math.random` her kare için tohumludur, `H.rand` tercih edilir.
Eşzamanlı ve hızlı olmalı: kare başına yaklaşık 250 ms süre sınırı vardır (tam boyutlu dışa aktarmada biraz fazla); sonsuz döngü kesilir ve hata olarak bildirilir.

**Kum havuzu (sandbox).** Kod yalnızca ayrı bir Web Worker'da (Blob URL'den) OffscreenCanvas ile çalışır. Derlemeden önce worker `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`, `Worker`, zamanlayıcılar, `eval`/`Function` kurucuları ve fazlasını kaldırır ya da engeller;
içinde `import` geçen kod reddedilir; worker hiçbir Neutralino nesnesini ya da belirteci görmez. Söz dizimi ve çalışma hataları (satır numarasıyla) klipte gösterilir
(zaman çizelgesinde rozet, özellikler panelinde metin, önizlemede kırmızı not) ve uygulamaya asla fırlatılmaz; dışa aktarmaya not girmez.

**Yardımcılar `H`** (AI'a `get_schema` ile `src/draw-clip.js` içindeki `DRAW_HELP`'ten anlatılır):

| Yardımcı | Anlamı |
|---|---|
| `H.lerp(a,b,k)`, `H.clamp(v,a,b)` | aradeğer / sınırlama |
| `H.ease(k, ad)` | `linear`, `ease-in`, `ease-out`, `ease-in-out` (varsayılan), `bounce`, `elastic` |
| `H.wave(t, freq=1, amp=1, phase=0)` | `amp * sin(2π·freq·t + phase)` |
| `H.rand(i, seed=0)` | deterministik rastgele 0..1 |
| `H.seg(t, start, end)` | `t`'nin `[start, end]` içindeki ilerlemesi 0..1 (sınırlı); zamanlı vuruşlar için `H.ease` ile birleştirilir |
| `H.hsl(h,s,l,a=1)` | renk dizgesi |
| `H.stick(ctx, {x, y, h=300, color, width, head, fill, flip, face, pose})` | en alçak ayağı `(x,y)`'de, toplam boyu `h` olan çöp adam. `pose` = `{armL, armR, legL, legR, body, neck}` derece (0 = düz aşağı, pozitif = figürün sağına; uzuv `[üst, bükülme]` olabilir); `face` = `happy` `sad` `surprised` `angry` ya da `null`; `flip` aynalar. Eklemleri döner (`head{x,y,r}`, `handL`, `handR`, `footL`, ...) |
| `H.text(ctx, str, x, y, {size, color, font, weight, align, stroke, strokeWidth})` | ortalı yazı (`\n` = yeni satır) |
| `H.circle(ctx,x,y,r,fill,stroke,lw)`, `H.line(ctx,x1,y1,x2,y2,color,lw)`, `H.rect(ctx,x,y,w,h,fill,radius)`, `H.poly(ctx,pts,fill,stroke,lw)` | şekiller |
| `H.glow(ctx, color, blur)` | sonrakiler için neon parıltı (`H.glow(ctx, null)` = kapalı) |
| `H.bg(ctx, w, h, c1, c2=null, angle=90)` | arka plan rengi ya da degrade |

Örnek klip (iki neon çöp adam: biri el sallar, öbürü zıplar), `proje.json`'da şöyle görünür:

```jsonc
{ "id": "c1", "kind": "draw", "track": "v2", "start": 0, "duration": 10, "code": "// Two neon stick figures: one waves, the other jumps.\nH.bg(ctx, w, h, '#0b0620', '#1d0b45', 180);\nconst gy = h * 0.72, s = Math.min(w, h) * 0.42;\nH.glow(ctx, '#00e5ff', 24);\nH.line(ctx, w * 0.06, gy, w * 0.94, gy, '#00e5ff', 6);\nH.glow(ctx, '#ff3df2', 28);\nconst a = H.stick(ctx, { x: w * 0.3, y: gy, h: s, color: '#ff3df2', face: 'happy',\n  pose: { armL: -20, armR: [110, 50 + H.wave(t, 2, 30)], body: H.wave(t, 0.5, 4) } });\nconst air = Math.sin(((t * 0.9) % 1) * Math.PI);\nH.glow(ctx, '#39ff88', 28);\nH.stick(ctx, { x: w * 0.7, y: gy - air * s * 0.45, h: s, color: '#39ff88', flip: true,\n  face: air > 0.6 ? 'surprised' : 'happy',\n  pose: { armL: -30 - 130 * air, armR: 30 + 130 * air } });\nconst pop = H.ease(H.seg(t, 0.4, 0.8), 'elastic');   // speech bubble pops in\nif (pop > 0) {\n  ctx.save(); ctx.translate(a.head.x + s * 0.2, a.head.y - s * 0.3); ctx.scale(pop, pop);\n  H.glow(ctx, '#ffffff', 16);\n  H.rect(ctx, -s * 0.28, -s * 0.1, s * 0.56, s * 0.2, '#ffffff', s * 0.06);\n  H.glow(ctx, null);\n  H.text(ctx, 'Hi!', 0, 0, { size: s * 0.12, color: '#1d0b45' });\n  ctx.restore();\n}" }
```

Aynı kod, okunur hâlde:

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

Uygulamada video araç çubuğundaki **Drawing** düğmesi buna benzer örnekli bir çizim klibi ekler; çizim klibi seçilince özellikler panelinde kod kutusu çıkar
(Apply ya da Ctrl+Enter uygular; hata metni altında görünür).

### Üretilen müzik (`music.generate`)

Dosyasız, yordamsal arka plan müziği. `generate`, `media`/`file` yerine geçer; diğer müzik alanları her zamanki gibidir:

```jsonc
"music": { "generate": { "style": "upbeat", "bpm": 120, "seed": 1, "key": "A minor" },
           "volume": 0.7, "fadeIn": 0.3, "fadeOut": 1.5, "duration": "auto" }
```
- `style`: `upbeat` | `chill` | `epic` | `lofi` | `chiptune` | `cinematic` (varsayılan `upbeat`). `bpm` isteğe bağlı (stil varsayılanı; 60-180'e sıkıştırılır). `seed` tamsayı (varsayılan 1; başka tohum başka varyasyon).
  `key` isteğe bağlı (`"C major"`, `"A minor"`, ...; stil varsayılanı).
- Davul, bas, akor pedi ve ana ezgi/arpej 4 ya da 8 ölçülük bir ilerlemeyi izler; ilk ölçü daha hafiftir, son ölçü çözülür; böylece her uzunluk (3-180 sn) düzgün biter. Aynı parametre aynı sonucu verir.
- `duration: "auto"` = projenin uzunluğu (parça diğer kliplerin sonuna kadar yeter; boş zaman çizelgesinde 30 sn). Hızlı üretilir (OfflineAudioContext, 44,1 kHz stereo 16 bit WAV).
- Canlı projeler (masaüstü): WAV `<proje>/medya/muzik-<stil>-<bpm>-<seed>-<özet>.wav` olarak kaydedilir, varsa yeniden kullanılır (ad, her parametreyle ve gereken uzunlukla değişir).
  `proje.json` `generate` nesnesini korur; dosya `media` içinde görünmez. Tariflerde parça bellekte üretilir.
- Web kayıtları (`web` / `web-live`) da `"music": { "generate": {...}, "duration": 90 }` kabul eder.

## `web` — web sitesinin "ajanlarla yapılışı" videosu

```jsonc
{
  "type": "web",
  "name": "site-yapilis",
  "site": "C:/projeler/my-site",   // index.html'in olduğu klasör (sitenin dosyalarına dokunulmaz)
  "entry": "index.html",
  "orientation": "vertical",             // "vertical" (1080×1920, varsayılan) | "horizontal" (1920×1080)
  "agents": { "count": 20, "speed": "1x" },
  "intro": "Sayfa taranıyor...",
  "hold": 2,                              // bitince site tam hâliyle kaç sn beklesin
  "tour": true,                           // sonunda sayfayı baştan sona kaydır
  "music": { "file": "muzik.mp3", "volume": 0.6 },   // isteğe bağlı, sonradan ffmpeg ile eklenir
  "output": { "file": "site-yapilis.mp4" }           // false: sadece oynat, kaydetme
}
```
Akış: koyu ekran + "Sayfa taranıyor..." → ajanlar ortada toplanır → DOM katman katman kurulur (mavi seçim kutusu,
boyut rozeti, harf harf metin, renk/font uygulama) → site tam hâli → ajanlar kenara çekilir → tur.
Kayıt ekrandan alınır (ffmpeg gdigrab): **pencere görünür ve üstü kapalı olmamalı**.

## `web-live` — Claude siteyi yazarken canlı izle

Bitmiş bir siteyi oynatmak yerine, Claude bir site klasörüne dosyaları yazdıkça Hafif Stüdyo bunu **canlı** gösterir:
yeni öğeler mavi kutu + boyut rozetiyle eklenir, metinler harf harf yazılır, CSS değişince değişen öğelere renk/font ajanları gider,
kod panelinde değişen dosyanın yeni satırları yazılır. Claude'un notları üstte "Claude:" balonunda görünür.

En kolay yol `hs-run.ps1` (uygulama kapalıysa açar):
```powershell
hs-run.ps1 -Live C:\projeler\sitem [-Record] [-Orientation vertical|horizontal] [-Name sitem] [-Music muzik.mp3]
hs-run.ps1 -Say "Hero bölümünü yazıyorum"
hs-run.ps1 -LiveStop        # oturumu bitirir; canli.done.json'u yazdırır (-Record ise outputs içinde <ad>-canli.mp4)
```
Ya da iş klasörüne `canli.json` bırak:
```jsonc
{ "type": "web-live", "name": "sitem", "site": "C:/projeler/sitem", "entry": "index.html",
  "record": true, "orientation": "vertical", "agents": { "count": 12, "speed": "1x" }, "music": "muzik.mp3" }
```
Kontrol dosyaları (iş klasöründe, tarif değildir): `canli.say` (içindeki metin not olarak gösterilir), `canli.stop` (oturumu bitirir; içerik `tursuz` ise son tur atlanır).
`web-live` için varsayılan yön `horizontal`dır (`web` türünde `vertical`); TikTok için `-Orientation vertical` ver.
Oturum ayrıca HUD'daki X ile ya da 20 dk hiç değişiklik olmazsa biter; o ana kadar başka tarifler sırada bekler.
`record: true` ise yalnızca değişiklik anları kaydedilir ve birleştirilir (uzun beklemeler videoya girmez).

## Örnekler

Paketlenmiş şablonlar (`sablonlar/`) artık varsayılan olarak İngilizcedir (altyazılar, site metinleri, adlar ve açıklamalar).

`ornekler/` klasöründe: `tiktok-oyun-tanitim.json`, `3d-logo-donen.json`, `web-site-yapilis.json` (+ `medya/`, `site-ornek/`).
