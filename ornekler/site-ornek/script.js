// Kıvılcım örnek sitesi: tek küçük betik (zamanlayıcı ya da sürekli döngü yok).
(function () {
  var yil = document.getElementById('yil');
  if (yil) yil.textContent = String(new Date().getFullYear());

  var form = document.getElementById('form');
  var not = document.getElementById('not');
  if (!form || !not) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var ad = form.ad.value.trim();
    var eposta = form.eposta.value.trim();
    if (!ad || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(eposta)) {
      not.style.color = '#e8461f';
      not.textContent = 'Lütfen adını ve geçerli bir e-posta adresi yaz.';
      return;
    }
    not.style.color = '';
    not.textContent = 'Teşekkürler ' + ad.split(' ')[0] + '! Kurulum bağlantısı birkaç dakika içinde e-postanda.';
    form.reset();
  });
})();
