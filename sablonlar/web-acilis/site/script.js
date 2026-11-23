// Spark sample site: one small script (no timers or continuous loops).
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
      not.textContent = 'Please enter your name and a valid email address.';
      return;
    }
    not.style.color = '';
    not.textContent = 'Thanks ' + ad.split(' ')[0] + '! The setup link will reach your inbox in a few minutes.';
    form.reset();
  });
})();
