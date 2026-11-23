// Geliştirme için basit statik sunucu: proje kökünü http://localhost:5180 adresinde sunar (Range destekli, yalnız yerel).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', glb: 'model/gltf-binary', jpg: 'image/jpeg' };
// Kökün içinde mi? ('..' ile çıkan ya da kardeş 'proje2-xyz' klasörüne giden yollar dışarıda sayılır.)
const inRoot = (f) => {
  const rel = path.relative(root, f);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const fail = (res, code, text) => {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
};
// Okuma hatası (dosya silindi/kilitli: Windows'ta EBUSY/EPERM) sunucuyu çökertmesin.
const send = (res, f, opts) => {
  const st = fs.createReadStream(f, opts);
  st.on('error', () => res.destroy());
  st.pipe(res);
};
http.createServer((req, res) => {
  try {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return fail(res, 400, 'bozuk adres');
    }
    if (p === '/') p = '/dist-web/HafifStudyo.html';
    let f = path.join(root, p);
    // Şablonların ortak medyası (sablonlar/_ortak/) tarayıcıda şablon klasöründeymiş gibi sunulur:
    // /sablonlar/<id>/medya/x.mp4 yoksa /sablonlar/_ortak/medya/x.mp4 (masaüstünde proje oluşturulurken kopyalanır).
    const m0 = /^\/sablonlar\/[^/_][^/]*\/(.+)$/.exec(p);
    if (m0 && !fs.existsSync(f)) f = path.join(root, 'sablonlar', '_ortak', m0[1]);
    if (!inRoot(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return fail(res, 404, 'yok');
    const size = fs.statSync(f).size, type = T[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let s, e;
      if (!m[1]) {
        // sonek aralığı: bytes=-N → son N bayt
        s = Math.max(0, size - +m[2]);
        e = size - 1;
      } else {
        s = +m[1];
        e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      }
      if (!size || s > e || s >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Cache-Control': 'no-store' });
      return send(res, f, { start: s, end: e });
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    send(res, f);
  } catch (err) {
    console.error('istek hatası:', req.url, err?.message || err);
    fail(res, 500, 'sunucu hatası');
  }
}).listen(5180, '127.0.0.1', () => console.log('http://localhost:5180'));
