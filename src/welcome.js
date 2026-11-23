// First-run tour: 4 steps, shown once (store key "welcomeDone"). Call initWelcome(ctx) at startup.
import { t } from './i18n.js';
import { store } from './util.js';

let ovl = null;

function steps() {
  return [
    { ic: '🧊', h: t('welcome.s1.h', 'Welcome to Hafif Stüdyo'), p: t('welcome.s1.p', 'Three lightweight modes in one app: 3D modelling, video editing and web building. Switch between them with the tabs at the top.') },
    { ic: '🧩', h: t('welcome.s2.h', 'Templates'), p: t('welcome.s2.p', 'Start from a ready-made template: pick one in the gallery, name your project and go. Open it any time from the Templates button.') },
    { ic: '🤖', h: t('welcome.s3.h', 'AI assistant'), p: t('welcome.s3.p', 'Describe what you want and the assistant builds or edits it for you, with coloured cursors showing every change as it happens.') },
    { ic: '⚡', h: t('welcome.s4.h', 'Live projects and agents'), p: t('welcome.s4.p', 'Open a live project and an AI can edit it while you watch; your own edits are written back. Press Ctrl+K any time for the command palette.') },
  ];
}

export function closeTour() { if (ovl) { ovl.remove(); ovl = null; } }

/** Show the tour (also used by the palette "Show tour" command). */
export function openTour() {
  closeTour();
  const S = steps();
  let i = 0;
  ovl = document.createElement('div');
  ovl.className = 'ovl';
  ovl.style.zIndex = 100;
  ovl.innerHTML = '<div class="card wl-card" role="dialog" aria-modal="true"><div class="wl-ic"></div><h2></h2><p></p><div class="wl-foot"><div class="wl-dots"></div><button class="wl-skip"></button><button class="pri wl-next"></button></div></div>';
  const $q = (s) => ovl.querySelector(s);
  const finish = () => { store.set('welcomeDone', true); closeTour(); };
  const render = () => {
    const s = S[i];
    $q('.wl-ic').textContent = s.ic; $q('h2').textContent = s.h; $q('p').textContent = s.p;
    $q('.wl-dots').innerHTML = S.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('');
    $q('.wl-skip').textContent = t('welcome.skip', 'Skip');
    $q('.wl-skip').hidden = i === S.length - 1;
    $q('.wl-next').textContent = i === S.length - 1 ? t('welcome.done', 'Get started') : t('welcome.next', 'Next');
  };
  $q('.wl-skip').onclick = finish;
  $q('.wl-next').onclick = () => (i === S.length - 1 ? finish() : (i++, render()));
  ovl.addEventListener('keydown', (e) => {
    // Keep plain keys away from the mode shortcuts (Space, arrows, Delete...) while the tour is open.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight') $q('.wl-next').click();
    else if (e.key === 'ArrowLeft' && i > 0) { i--; render(); }
  });
  document.body.appendChild(ovl);
  render();
  $q('.wl-next').focus();
}

export function initWelcome() {
  if (!store.get('welcomeDone', false)) openTour();
}
