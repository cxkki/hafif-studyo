# Canlı proje (Claude ile birlikte çalışma)

Amaç: Kullanıcı Claude'a sohbette "şu yazıyı büyüt", "videonun sonuna logo koy", "siteye fiyat bölümü ekle" der;
Claude projeyi düzenler ve Hafif Stüdyo değişikliği **anında, ajanlarla** gösterir. Kullanıcı arayüzde bir şey değiştirirse
o da projeye geri yazılır; Claude bir sonraki adımda son hâli okur.

## Proje klasörü

`Belgeler\HafifStudyo\projeler\<ad>\` (varsayılan; herhangi bir klasör olabilir)
```
proje.json        ← tek doğruluk kaynağı (TARIF.md'deki tarif biçimi + kimlikler)
medya/            ← projenin medyası (göreli yollar proje klasörüne göre)
site/             ← web projelerinde sitenin dosyaları
cikti/            ← dışa aktarmalar (varsayılan; tarifte output/outputs ile değiştirilebilir)
```

### proje.json
TARIF.md'deki `3d`, `video`, `web` biçimleriyle aynı; farkları:
- Her öğenin kalıcı bir `id`'si vardır: `clips[].id` (`c1`, `c2`…), `texts[].id` (`t1`…), `objects[].id` (`o1`…).
  Eksikse uygulama atar ve dosyaya geri yazar. Claude bir öğeyi değiştirirken **aynı id'yi korur**; yeni öğeye yeni id verir.
- `media` her zaman nesne biçimindedir: `{ "oyun": "medya/oyun.mp4" }`.
- `music` video projesinde `{ "media": "<kimlik>", ... }`.
- Web projesi: `{ "type": "web", "name": "...", "site": "site", "entry": "index.html", "orientation": "vertical" }`;
  canlılık sitenin dosyalarından gelir (web-mode canlı modu).
- İsteğe bağlı `"rev": n` — uygulama her yazışta artırır (Claude okumaz/yazmaz da olur).

## Akış

1. **Açma:** Uygulama projeyi açar → ilgili sekmeye geçer → proje sıfırdan, ajanlarla kurulur (tarif çalıştırıcıdaki
   gibi, ama dışa aktarma yapılmaz). Sonra `proje.json` (web'de site klasörü) izlenir.
2. **Claude düzenler:** `proje.json` değişir → 300 ms debounce → JSON okunur (geçersizse son geçerli hâl kalır, üstte
   "proje.json okunamadı: …" uyarısı) → önceki hâlle **fark** çıkarılır → işlemler ajanlarla sırayla uygulanır:
   - eklenen öğe → ajan ekler (video: kütüphaneden kanala sürükleme; yazı: Yazı ekle + harf harf; 3D: araç çubuğu + panel)
   - silinen öğe → ajan seçer, kırmızımsı kutu, siler
   - değişen alan → ajan öğeyi seçer, panelde ilgili alana gider, değeri yazar/kaydırır/renk seçer, sonra kesin değer API ile
   - proje ayarları (çözünürlük, fps, arka plan, sahne, kamera) → ilgili kontrol
   - medya eklendi → kütüphaneye ekleme animasyonu
   Animasyon sürerken yeni değişiklik gelirse son hâl kuyruğa alınır (ara hâller birleşir).
3. **Kullanıcı düzenler:** Mod API'si değişiklik bildirir (commit) → 600 ms sonra güncel durum proje.json'a yazılır
   (uygulamanın kendi yazışı izleyicide yankı yapmaz: içerik özeti karşılaştırılır).
4. **Dışa aktarma:** sadece istenince (komut ya da arayüzdeki düğme) → `outputs`/`output` → `cikti/` (ya da
   belirtilen yol) → sonuç dosyası.
5. **Kapatma:** komut, HUD X ya da başka proje açılınca.

## Komutlar (iş klasörü `Belgeler\HafifStudyo\isler\`)

| Dosya | İçerik | Etki |
|---|---|---|
| `canli.json` | `{"type":"proje","path":"C:/…/projeler/ad"}` ya da `{"type":"proje","template":"tiktok-oyun","name":"ad"}` | Projeyi (gerekirse şablondan oluşturup) canlı açar; oturum bitene kadar sürer. Bitince `canli.done.json` |
| `canli.say` | düz metin | Üstte "Claude:" balonunda not |
| `canli.export` (web projesinde desteklenmez; web videosu `"record": true` ile açılan oturumun kapanışında üretilir) | boş ya da `{"file":"x.mp4"}` | Açık projeyi dışa aktarır; sonuç `canli.export.done.json` / `.error.json` |
| `canli.stop` | boş (ya da `tursuz`: web'de son tur atlanır) | Oturumu kapatır |
| `canli.proje` | (uygulama yazar) | Açılan projenin tam yolu; `hs-run -New/-Open` bunu `PROJE: …` satırı olarak yazdırır |

`hs-run.ps1` bunları sarar: `-New <şablon> -Name <ad>`, `-Open <proje klasörü>`, `-Say "…"`, `-Export`, `-Close`
(eski `-Live <site klasörü>` = web projesi canlı izleme, `-LiveStop` = `-Close`).

## Şablonlar

`sablonlar/<kimlik>/` (kaynakta) → build ile `resources/sablonlar/` altına kopyalanır (uygulamaya gömülü).
Her şablon: `sablon.json` (`{ "id", "ad", "aciklama", "tur": "video"|"3d"|"web", "kapak": "kapak.png" }`),
`proje.json`, varsa `medya/`, `site/`. `sablonlar/index.json` listeyi verir.
Yeni proje = şablon klasörünün kopyası (`proje.json` içindeki `name` yeni adla).
Paketlenmiş şablonlar uygulamanın varsayılan dili olan İngilizcedir (altyazılar, site metinleri, `sablon.json` `ad`/`aciklama`); kimlikler, klasör/dosya adları ve JSON alan adları aynıdır.

- Büyük ortak medya (oyun.mp4, muzik.mp3, logo.png) tek kopya: `sablonlar/_ortak/medya/`. Şablon bunu `sablon.json`'da
  `"ortak": ["medya/oyun.mp4", …]` ile ister; proje oluşturulurken `_ortak/<yol>` → `<proje>/<yol>` kopyalanır.
- `index.json` **build tarafından üretilir** (elle yazma): her girdi `{ id, ad, aciklama, tur, kapak, boyut?, dosyalar, ortak? }`;
  `dosyalar` = şablon klasöründeki dosyalar (`sablon.json` ve kapak hariç). Sıra: tür (video, 3d, web) + `sablon.json` `sira`.
- Yeni şablon: `sablonlar/<id>/` + `sablon.json` + `proje.json` (+ kapak 320×180 / dikeyde 180×320) → `node build.mjs`.
- `src/templates.js`: `listTemplates()`, `createFromTemplate(id, ad, ustKlasor?)` → proje klasörünün tam yolu
  (ad ASCII'ye çevrilir, varsa `-2`, `-3`; çıktı dosya adlarının şablon adı öneki de değişir; `cikti/` açılır),
  `openGallery()` → yol ya da `null`. Tarayıcıda diske yazılamaz: `'/sablonlar/<id>'` döner (geliştirme sunucusu
  ortak medyayı bu yolda da sunar).

## Uygulayıcı arayüzü (paralel geliştirme sözleşmesi)

`src/live-video.js` ve `src/live-3d.js` aynı arayüzü dışa açar; `src/live.js` (yönetici) bunları çağırır:
```js
export async function apply(prev, next, env)   // prev null ise sıfırdan kurulum (= boştan fark). Ajanlı, gerçek arayüz işlemleri.
export async function exportNow(proj, env, opts = {}) // -> { outputs: [tam yol] } ; opts.file isteğe bağlı
export function snapshot(env)                  // -> mevcut durum, proje.json biçiminde (id'ler ve medya kimlikleri korunur)
export function normalize(proj)                // -> id'leri eksik öğelere atanmış kopya (c1/t1/o1…), media nesne biçiminde
```
`env` (yönetici sağlar):
```js
{ modes, switchTab, dir /* proje klasörü, ileri eğik çizgi */, resolve(rel) /* -> mutlak yol */,
  loadFile(rel) /* -> Promise<File> (masaüstünde diskten, tarayıcıda fetch) */, agents /* src/agents.js */,
  show /* bool: ajan animasyonu açık mı */, speed /* '1x'|'2x'|'5x'|'instant' */,
  note(text) /* kısa bildirim */, outDir /* <proje>/cikti */ }
```
Kural: `apply` sırasında mod API'lerinin `commit()` çağrıları kullanıcı değişikliği sayılmaz (yönetici bu sürede ve
sonraki 400 ms'de 'mode-change' olaylarını yok sayar). Modlar, kullanıcı commit'lerinde
`bus.dispatchEvent(new CustomEvent('mode-change', { detail: { mode: 'mvid' | 'm3d' } }))` yayınlar.
Ajan gösterimi için ortak küçük yardımcılar her uygulayıcının içinde olabilir (recipe.js'e dokunmadan, ondan kopyalanarak).

## Modül sınırları

- `src/live.js` — canlı proje yöneticisi (aç, izle, fark, uygula, geri yaz, dışa aktar, kapat). 3D ve video farklarını
  kendisi uygular (mod API'leri + agents); web projesinde `modes.mweb.api.live` (web-mode.js) motorunu kullanır.
- `src/templates.js` — şablon listesi, şablondan proje oluşturma, galeri penceresi (arayüz).
- `src/jobs.js` / `tools/hs-run.ps1` — komutlar.

## Yeni alanlar (canlı projede)

Aşağıdaki alanlar `docs/TARIF.md`'deki ile aynıdır; `proje.json`'da şöyle davranırlar. Alan silinirse varsayılana döner.

**Video** (`live-video.js`)
- Klip: `speed` (0.25–4), `rotation` (−360..360), `crop` (`{l,t,r,b}`, 0..0.45), `effects` (nesne ya da bakış adı), `transition`, `motion`.
  Ajanlar paneldeki bölümleri açar, bakış düğmesine tıklar, geçiş türünü seçip süreyi kaydırır, efekt/kırpma/hareket değerlerini tek tek kaydırır ya da yazar; kesin değer sonra API ile verilir.
- Şekil klibi: `{"id":"c5","kind":"shape","shape":"rect|rounded|circle|bar","track":"v2","start":0,"duration":3,"color":"#4f8cff","w":0.6,"h":0.1,"radius":0.3}`.
  Eklenince ajan "Şekil" düğmesine tıklar; `kind` değişirse klip değiştirilir. Şekil klibi medyasızdır.
- Çizim klibi (JavaScript ile çizilen katman, bkz. `docs/TARIF.md`): `{"id":"c7","kind":"draw","track":"v2","start":0,"duration":10,"code":"<JS>"}` ve `x`, `y`, `scale`, `rotation`, `opacity`, `fadeIn`, `fadeOut`, `transition`, `effects`, `motion`.
  Medyasız ve şekilsiz, `code`'lu klibe `kind: "draw"` verilir; `code` satır dizisi de olabilir (dosyada dizi olarak kalır). `kind` ya da `track` değişirse klip değiştirilir; dosyadan silinen alan varsayılana döner (süre 5, boş kod, x 0, y 0, scale 1, opacity 1, geçişler 0).
  Eklenince "Kod" ajanı **Drawing** düğmesine tıklar, paneldeki kod kutusunu temizler, ilk birkaç satırı yazar, kalanını bir anda doldurur ve Apply'ı gösterir; kesin kod sonra API ile verilir, böylece "Not applied yet" taslağı kalmaz.
  Kod, kare başına süre sınırı olan kum havuzlu bir Worker'da çalışır; hatalar klipte rozet ve panelde metin olarak görünür. Snapshot, kullanıcının eklediği çizim kliplerini medyasız `{id, kind:"draw", track, code, ...}` olarak yazar.
- Üretilen müzik: `"music": {"generate": {"style":"upbeat","bpm":120,"seed":1,"key":"A minor"}, "volume":0.7, "fadeIn":0.3, "fadeOut":1.5, "duration":"auto"}`
  (stiller `upbeat chill epic lofi chiptune cinematic`; `media`/`file` yok). Parça `in` + süre x hız kadarını kapsamalı (`"auto"` = diğer kliplerin sonuna kadar, boş zaman çizelgesinde 30 sn); 0,5 sn'ye yukarı yuvarlanır, 3-180 sn'ye sıkıştırılır.
  Masaüstünde WAV `<proje>/medya/muzik-<stil>-<bpm>-<seed>-<özet>.wav`'dır: varsa yeniden kullanılır, yoksa üretilip oraya kaydedilir (tarayıcıda bellekte kalır). `proje.json` `generate` nesnesini korur, dosya `media` içinde görünmez
  (geri almada da), böylece gidiş-dönüş eşgüçlü kalır. `generate` değişirse ya da dosya ↔ üretilen müzik geçilirse müzik değiştirilir; klip başlangıcını, `in`'i, hızı, sesi ve geçişlerini korur.
  Kullanıcı `"auto"` altında video uzunluğunu değiştirirse tek bir arka plan yenilemesi (tek 500 ms zamanlayıcı) parçayı geçmiş kaydı oluşturmadan yeniden üretir. Bu oturumun yazdığı WAV, yenisi onun yerine geçince `medya/`'dan silinir; önceki oturumların dosyalarına dokunulmaz.
- Yazı: `font`, `weight`, `italic`, `align`, `letterSpacing`, `lineHeight`, `rotation`, `strokeColor`, `strokeWidth`, `shadow*`, `boxPad`, `boxRadius`, `boxOpacity`; `anim` artık `bounce | fade-up | zoom-in | wave` da olur.
- Proje: `markers` (`[1.5, 4]`), `tracks` (`{"v1":{"mute":true,"lock":true}}`), `output.quality` (`low|medium|high`, canlı dışa aktarmada kullanılır).
- Geri yazım: kullanıcının arayüzde değiştirdiği alanlar yazılır. Dosyada bakış adı ya da geçiş dizgesi olarak yazılmış değer, kullanıcı değiştirene kadar olduğu gibi kalır.
  Kullanıcının eklediği öğelere yalnız varsayılandan farklı alanlar yazılır; şekil klibi `kind: "shape"` ile, medyasız yazılır.

**3D** (`live-3d.js`)
- `scene.background2` (degrade; `null`/`""` siler), `scene.turntable` (yalnız true iken geri yazılır), `camera.preset` (`front right side top persp orbit close hero`).
  `camera.preset` tek seferliktir: tüm nesneler kurulduktan sonra, yeni ya da öncekinden farklıysa uygulanır; geri yazımda silinir.
- Malzeme: `emissive` (`#000000`), `emissiveIntensity` (1), `opacity` (0–1, 1), `preset` (`matte plastic metal gold glass glow`; yalnız nesnenin yazmadığı alanları doldurur ve sonra düşer, dosyada açılmış değerler görünür).
- 3B yazı: `{"shape":"text","text":"Merhaba","font":"Segoe UI","color":"#ffffff","background":"","size":1}`; varsayılan konum `[0,1,0]`.
- Işık: `{"light":"point"|"spot","color","intensity" (30/60),"distance" (0),"angle" (5–89),"penumbra" (0–1),"position","rotation"}`. Nokta ↔ spot değişince nesne yeniden kurulur.
- `array`: `{"count":N,"axis":"x|y|z","spacing":1.5}` N kopya ekler (`<id>.2`, `<id>.3`…); `normalize` açar, geri yazımda kopyalar ayrı nesne olarak yazılır.
- Not: arayüzden elle yapılan değişiklik dosyaya yalnız geri yazımla ulaşır; `preset` ve `array` açılımı AI'nın dosyası uygulanırken olur.

## Uygulama içi AI asistanı

Üst çubuktaki **AI** düğmesi (ya da Ctrl+K paletinden AI assistant) sağda bir çekmece açar; kullanıcı doğrudan uygulamanın içinden
canlı projeyi AI'a düzenletebilir. Çekmece açıkken ana alan, pencere ≥ 1100 px ise daralır (üstüne binmez).

- **Sağlayıcılar:** Claude (`src/ai-claude.js`, resmî `@anthropic-ai/sdk`; modeller `claude-opus-5-5` varsayılan, `claude-sonnet-5-5`, `claude-haiku-5-5` ya da yazılan herhangi bir ad; çaba `low|medium|high|xhigh|max`, varsayılan medium)
  ve OpenAI uyumlu sağlayıcılar (`src/ai-providers.js`, `{baseUrl}/chat/completions`): OpenAI, OpenRouter, Groq, Google Gemini, Ollama (`http://localhost:11434/v1`, `OLLAMA_ORIGINS=*` gerekir), LM Studio (`http://localhost:1234/v1`, CORS açık olmalı).
- **Araçlar** (`src/ai-tools.js`): `list_templates`, `new_project(template, name, type?)`, `new_blank_project(type, name, orientation?, resolution?)`, `open_project(path)`, `close_project`, `get_project`, `update_project(project_json)`,
  `start_web_live(name, orientation)`, `list_site_files`, `read_site_file(path)`, `write_site_file(path, content)`, `stop_web_live`, `export_project(file?)`, `note(text)`, `get_schema`.
  Masaüstünde `update_project` `proje.json`'u yazar; izleyici ajan animasyonlarıyla uygular, araç `live.busy` bitene kadar bekler (en çok 60 sn) ve uygulanan projeyi döner. Tarayıcıda `live.applyText` kullanılır.
  Site dosyası yolları göreli olmalıdır (mutlak yol ve `..` reddedilir); site dosyası araçları yalnız masaüstünde çalışır. `start_web_live`, `Belgeler\HafifStudyo\projeler\<ad>\` altında web projesi açar.
  `new_blank_project`, `Belgeler\HafifStudyo\projeler\<slug>\` klasörünü (ad doluysa `-2`, `-3`; `medya/` ve `cikti/` ile) asgari bir `proje.json` ile oluşturur ve canlı açar: `video` = `{"type":"video","name","resolution":"1080x1920","fps":30,"background":"#000000","clips":[],"texts":[],"music":null}` (`horizontal` = 1920x1080; `resolution` `"WxH"`, kenar başına 64-7680 px, üstüne yazar), `3d` = boş sahne, `web` = `start_web_live` ile aynı. Tarayıcı sürümünde aynı türde bir şablon açılır ve `live.applyText` ile değiştirilir.
  `new_project` isteğe bağlı `type` alır; şablonun türü farklıysa çağrı hata verir ve `new_blank_project`'i gösterir.
- **Yönlendirme (sistem istemi):** video istekleri (kurgu, klip, TikTok/Reels/Shorts, animasyon, "10 saniyelik ... yap") => video projesi (boş ya da video şablonu). Videonun içinde özel çizim, karakter, çöp adam, hareketli grafik, diyagram ya da "HTML/canvas ile" => **çizim klipleri** (`kind:"draw"`), asla web modu değil. "Müzik"/"havalı müzik" => kullanıcı dosya vermediyse `music.generate`. Web modu yalnız site ya da açılış sayfası istenirse. İstenen çıktıdan farklı türdeki şablon kullanılmaz; isteğe uymayan şablon içeriği değiştirilir ya da silinir. AI sonucun canlı oynadığını söyler, yalnız istenince dışa aktarır.
  `get_schema` çizim kliplerini (alanlar, `DRAW_HELP`'teki `H` yardımcıları, `STICK_EXAMPLE` klibi) ve `music.generate`'i diğer biçimle birlikte anlatır.
- **Anahtar nerede:** API anahtarı yalnızca tarayıcının `localStorage`'ında (`hs_ai`, `util.store` ile) tutulur; **hiçbir proje dosyasına (proje.json, tarif, site) yazılmaz**.
  Yalnızca seçilen sağlayıcıya başlık olarak gider (Claude: `x-api-key`; diğerleri: `Authorization: Bearer`), URL'ye konmaz. Ayarlardaki "Forget key" anahtarı siler.
  `hs_ai` biçimi: `{preset, effort, models, baseUrls, keys}`.
- Sohbet geçmişi bellektedir; sayfa yenilenince silinir. Boştayken hiçbir döngü çalışmaz.

## Claude Code ile sürmeye devam

Uygulama içi asistan zorunlu değildir: Claude Code (terminal) yine `hs-run.ps1` ile uygulamayı sürer
(`-New`, `-Open`, `-Say`, `-Export`, `-Close`) ve doğrudan `proje.json`'u düzenler; uygulama ikisini de aynı izleyiciyle uygular.
İkisi aynı anda kullanılabilir: son yazılan hâl kazanır ve ara hâller birleşir.
