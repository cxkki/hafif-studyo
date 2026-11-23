// AI assistant drawer: chat with Claude (official SDK) or an OpenAI-compatible model that edits the live project
// through tools (ai-tools.js) while the agents animate the changes.
//
// Wiring (main.js, after initLive):   import { initAI } from './ai.js';   initAI(ctx);   // ctx = { modes, switchTab, live }
// Idle cost: nothing runs while the drawer is closed or no request is in flight (no timers, no rAF loops; text
// rendering uses one requestAnimationFrame per incoming chunk batch, only while streaming).
import { $, bus, esc, toast } from './util.js';
import { live as liveMgr } from './live.js';
import { t } from './i18n.js';
import { bindTools, runTool, chipLabel, systemPrompt } from './ai-tools.js';
import { createClaudeProvider, CLAUDE_MODELS, EFFORTS } from './ai-claude.js';
import { PRESETS, presetOf, presetHint, loadSettings, saveSettings, activeConfig, speakerName, createCompatProvider } from './ai-providers.js';

const ICON = {
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="m19.4 13.5.9.7-1.8 3.1-1.1-.4a7 7 0 0 1-1.6.9l-.2 1.2h-3.6l-.2-1.2a7 7 0 0 1-1.6-.9l-1.1.4-1.8-3.1.9-.7a7 7 0 0 1 0-1.9l-.9-.7 1.8-3.1 1.1.4a7 7 0 0 1 1.6-.9l.2-1.2h3.6l.2 1.2a7 7 0 0 1 1.6.9l1.1-.4 1.8 3.1-.9.7a7 7 0 0 1 0 1.9Z"/></svg>',
  clear: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 7h16M9 7V4.8h6V7m-8.5 0 .8 12.2h9.4L17.5 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m6 6 12 12M18 6 6 18"/></svg>',
};

const PUSH_MIN_WIDTH = 1100; // wider windows: the drawer pushes the editor instead of covering it

let ctx = null;
const providers = { anthropic: null, compat: null };
const S = {
  open: false,
  running: false,
  abort: null,
  history: [], // provider-native API history (append-only)
  historyKind: '', // 'anthropic' | 'compat': history format
  items: 0, // rendered chat items
};
let el = {};

const providerFor = (kind) =>
  kind === 'anthropic' ? (providers.anthropic ||= createClaudeProvider()) : (providers.compat ||= createCompatProvider());

// ---------------------------------------------------------------- DOM

function h(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  if (html) e.innerHTML = html;
  return e;
}

function build() {
  const btn = h('button', { class: 'ai-toggle', title: t('ai.toggle.title', 'AI assistant: edit projects by chatting'), 'aria-expanded': 'false' });
  btn.textContent = t('ai.toggle', 'AI');
  const top = $('.top');
  (top || document.body).appendChild(btn);

  const drawer = h('aside', { class: 'ai-drawer', hidden: true, 'aria-label': t('ai.title', 'AI Assistant') });
  drawer.innerHTML = `
    <header class="ai-head">
      <div class="ai-title"><b>${esc(t('ai.title', 'AI Assistant'))}</b><span class="ai-sub"></span></div>
      <button class="ai-ib" data-a="clear" title="${esc(t('ai.clear', 'Clear chat'))}" aria-label="${esc(t('ai.clear', 'Clear chat'))}">${ICON.clear}</button>
      <button class="ai-ib" data-a="settings" title="${esc(t('ai.settings', 'Settings'))}" aria-label="${esc(t('ai.settings', 'Settings'))}">${ICON.gear}</button>
      <button class="ai-ib" data-a="close" title="${esc(t('ai.close', 'Close'))}" aria-label="${esc(t('ai.close', 'Close'))}">${ICON.close}</button>
    </header>
    <div class="ai-live"></div>
    <div class="ai-list" role="log" aria-live="polite"></div>
    <div class="ai-ctx" hidden><span class="ai-ctx-l"></span><button type="button" class="ai-ib ai-ctx-x">${ICON.close}</button></div>
    <form class="ai-form">
      <textarea class="ai-text" rows="2" placeholder="${esc(t('ai.placeholder', 'Ask for a change… (Enter to send)'))}"></textarea>
      <button type="submit" class="pri ai-send">${esc(t('ai.send', 'Send'))}</button>
    </form>
    <div class="ai-settings" hidden></div>`;
  document.body.appendChild(drawer);

  el = {
    btn,
    drawer,
    sub: $('.ai-sub', drawer),
    liveLine: $('.ai-live', drawer),
    list: $('.ai-list', drawer),
    form: $('.ai-form', drawer),
    text: $('.ai-text', drawer),
    send: $('.ai-send', drawer),
    settings: $('.ai-settings', drawer),
    ctx: $('.ai-ctx', drawer),
  };
  // Selected element from the web inspector ("Ask AI about this"): shown as a chip, sent with the next message.
  const ctxX = el.ctx.querySelector('.ai-ctx-x');
  ctxX.title = ctxX.ariaLabel = t('ai.ctx.remove', 'Remove selection');
  ctxX.onclick = () => setContext(null);
  bus.addEventListener('ai-context', (e) => setContext(e.detail || null));
  bus.addEventListener('ai-open', () => {
    toggle(true);
    el.text.focus();
  });

  btn.onclick = () => toggle();
  drawer.querySelector('[data-a=close]').onclick = () => toggle(false);
  drawer.querySelector('[data-a=settings]').onclick = () => openSettings();
  drawer.querySelector('[data-a=clear]').onclick = () => clearChat();
  el.form.onsubmit = (e) => {
    e.preventDefault();
    if (S.running) stop();
    else submit();
  };
  el.text.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!S.running) submit();
    }
    if (e.key === 'Escape') {
      if (S.running) stop();
      else toggle(false);
    }
    e.stopPropagation(); // app shortcuts must not fire while typing here
  };
  el.text.onkeyup = (e) => e.stopPropagation();
  bus.addEventListener('live-change', () => S.open && syncHeader());
}

function setContext(c) {
  S.context = c && c.kind === 'web-element' ? c : null;
  el.ctx.hidden = !S.context;
  if (!S.context) return;
  const txt = String(S.context.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  el.ctx.querySelector('.ai-ctx-l').textContent = t('ai.ctx.label', 'Selected: <{tag}> {text}', { tag: S.context.tag || '?', text: txt ? `"${txt}"` : '' });
  el.ctx.title = `${S.context.file || ''}  ${S.context.selector || ''}`;
}

/** Text sent to the model: the user's words, prefixed with the selected element (if any). */
function withContext(text) {
  const c = S.context;
  if (!c) return text;
  const info = `[The user selected this element in the live website preview. File: ${c.file || 'index.html'}; CSS selector: ${c.selector || '?'}; tag: <${c.tag || '?'}>; text: "${String(c.text || '').slice(0, 200)}".\nHTML: ${String(c.html || '').slice(0, 800)}]`;
  return `${info}\n\n${text}`;
}

function toggle(force) {
  const open = force ?? !S.open;
  if (open === S.open) return;
  S.open = open;
  el.drawer.hidden = !open;
  el.btn.classList.toggle('on', open);
  el.btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('ai-push', open && innerWidth >= PUSH_MIN_WIDTH);
  dispatchEvent(new Event('resize')); // viewports re-fit once (no loop)
  if (open) {
    syncHeader();
    if (!S.items) renderEmpty();
    setTimeout(() => el.text.focus(), 0);
  }
}

function syncHeader() {
  const cfg = activeConfig();
  el.sub.textContent = cfg.ready ? `${cfg.label} · ${cfg.model}` : t('ai.not_connected', 'Not connected');
  const lv = ctx?.live || liveMgr;
  el.liveLine.textContent = lv.active
    ? t('ai.live_on', 'Live project: {name}', { name: lv.name })
    : t('ai.live_off_blank', 'No project open — the AI can start a blank video, 3D or web project, or use a template.');
  el.liveLine.classList.toggle('on', !!lv.active);
}

// ---------------------------------------------------------------- chat rendering

const nearBottom = () => el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;
const scrollEnd = (force) => {
  if (force || nearBottom()) el.list.scrollTop = el.list.scrollHeight;
};

/** Tiny safe markdown: escapes HTML, then **bold**, `code`; newlines kept by CSS. */
function md(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

function addItem(node) {
  const empty = $('.ai-empty', el.list);
  if (empty) empty.remove();
  el.list.appendChild(node);
  S.items++;
  scrollEnd(true);
  return node;
}

function addUser(text) {
  const d = h('div', { class: 'ai-msg ai-user' });
  d.textContent = text;
  return addItem(d);
}

function addNotice(text, kind = '') {
  const d = h('div', { class: 'ai-notice' + (kind ? ' ai-' + kind : '') });
  d.textContent = text;
  return addItem(d);
}

/** Assistant turn container: text segments and tool chips in order. */
function botTurn() {
  const box = addItem(h('div', { class: 'ai-msg ai-bot' }));
  let seg = null; // current text segment {el, raw}
  let buf = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!buf) return;
    const stick = nearBottom();
    if (!seg) {
      seg = { el: h('div', { class: 'ai-tx' }), raw: '' };
      box.appendChild(seg.el);
    }
    seg.raw += buf;
    buf = '';
    seg.el.innerHTML = md(seg.raw.replace(/^\n+/, ''));
    if (stick) scrollEnd(true);
  };
  const chips = new Map();
  let mark = null; // state at the start of the current model round (for discardRound)
  /** Chips still "running" when the turn ends were never executed (stop, error, refusal, cut-off reply). */
  const settleChips = () => {
    for (const x of chips.values()) {
      if (!x.c.classList.contains('run')) continue;
      x.c.classList.remove('run');
      x.c.classList.add('skip');
      x.c.firstChild.textContent = '–';
      x.c.lastChild.textContent = chipLabel(x.name, x.input, false) + ' — ' + t('ai.chip.not_run', 'not run');
    }
  };
  return {
    /** Remembers the current output so a discarded round (malformed reply, retried) can be removed. */
    roundStart() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      mark = { n: box.childNodes.length, seg, raw: seg?.raw ?? '' };
    },
    /** Removes the text and chips streamed since roundStart. */
    discardRound() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      buf = '';
      if (!mark) return;
      while (box.childNodes.length > mark.n) box.lastChild.remove();
      for (const [id, x] of chips) if (!x.c.isConnected) chips.delete(id);
      seg = mark.seg;
      if (seg && seg.raw !== mark.raw) {
        seg.raw = mark.raw;
        seg.el.innerHTML = md(seg.raw.replace(/^\n+/, ''));
      }
    },
    text(delta) {
      buf += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    chip(id, name) {
      flush();
      seg = null;
      const c = h('div', { class: 'ai-chip run' });
      c.innerHTML = `<i aria-hidden="true"></i><span></span>`;
      c.lastChild.textContent = chipLabel(name, null, false);
      box.appendChild(c);
      chips.set(id, { c, name, input: null });
      scrollEnd();
    },
    chipInput(id, input) {
      const x = chips.get(id);
      if (!x) return;
      x.input = input;
      x.c.lastChild.textContent = chipLabel(x.name, input, false);
      if (x.name === 'note' && input?.text) x.c.title = input.text;
    },
    chipEnd(id, ok) {
      const x = chips.get(id);
      if (!x) return;
      x.c.classList.remove('run');
      x.c.classList.add(ok ? 'ok' : 'err');
      x.c.firstChild.textContent = ok ? '✓' : '✕';
      x.c.lastChild.textContent = chipLabel(x.name, x.input, true) + (ok ? '' : ' — ' + t('ai.chip.failed', 'failed'));
    },
    /** Flush pending text; the next text starts a new segment (used before a notice). */
    pause() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      seg = null;
    },
    end() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      settleChips(); // no pulsing chip (CSS animation) may outlive the turn
      if (!box.childNodes.length) box.remove();
    },
  };
}

function renderEmpty() {
  el.list.textContent = '';
  S.items = 0;
  const cfg = activeConfig();
  const d = h('div', { class: 'ai-empty' });
  if (!cfg.ready) {
    d.innerHTML = `<p class="ai-lead">${esc(t('ai.empty.connect', 'Connect an AI with your own API key. It edits your project while the agents show every change.'))}</p>
      <div class="ai-prov"></div>
      <p class="ai-small">${esc(t('ai.empty.privacy', 'Your key stays on this computer and is sent only to the provider you choose.'))}</p>`;
    const box = $('.ai-prov', d);
    for (const p of PRESETS) {
      const b = h('button', { type: 'button' });
      b.textContent = p.label;
      b.onclick = () => openSettings(p.id);
      box.appendChild(b);
    }
  } else {
    d.innerHTML = `<p class="ai-lead">${esc(t('ai.empty.ready', 'What should we make? Try:'))}</p><div class="ai-sugg"></div>`;
    const ideas = [
      t('ai.sugg.draw', 'Make a 10-second video: two neon stick figures meet and high-five, with upbeat music'),
      t('ai.sugg.tiktok', 'Make a TikTok video about my game'),
      t('ai.sugg.hook', 'Make the hook text yellow and bigger'),
      t('ai.sugg.site', 'Build a landing page for a coffee shop'),
      t('ai.sugg.3d', 'Build a 3D product scene with a spinning box'),
    ];
    for (const s of ideas) {
      const b = h('button', { type: 'button' });
      b.textContent = s;
      b.onclick = () => {
        el.text.value = s;
        el.text.focus();
      };
      $('.ai-sugg', d).appendChild(b);
    }
  }
  el.list.appendChild(d);
}

function clearChat() {
  if (S.running) stop();
  S.history = [];
  S.historyKind = '';
  renderEmpty();
}

function setRunning(on) {
  S.running = on;
  el.send.textContent = on ? t('ai.stop', 'Stop') : t('ai.send', 'Send');
  el.send.classList.toggle('pri', !on);
  el.send.classList.toggle('ai-stop', on);
  el.drawer.classList.toggle('busy', on);
}

function stop() {
  S.abort?.abort();
}

// ---------------------------------------------------------------- notes ("<provider>: text")

let noteEl = null;
let noteT = 0;
function showNote(text) {
  const cfg = activeConfig();
  const who = speakerName(cfg);
  const lv = ctx?.live || liveMgr;
  if (who === 'Claude') return lv.note(text); // live.js bubble is labelled "Claude:"
  const s = String(text ?? '').trim();
  if (!s) return;
  if (!noteEl) {
    noteEl = h('div', { class: 'lv-note ai-note', role: 'status', 'aria-live': 'polite' }, '<b></b><span></span>');
    document.body.appendChild(noteEl);
  }
  noteEl.firstChild.textContent = who + ':';
  noteEl.lastChild.textContent = s;
  noteEl.classList.add('show');
  clearTimeout(noteT);
  noteT = setTimeout(() => noteEl.classList.remove('show'), 6000);
}

// ---------------------------------------------------------------- run

async function submit() {
  const text = el.text.value.trim();
  if (!text) return;
  const cfg = activeConfig();
  if (!cfg.ready) {
    openSettings();
    return;
  }
  if (S.historyKind && S.historyKind !== cfg.kind) {
    // Histories are provider-specific; a new provider starts a new conversation.
    S.history = [];
    addNotice(t('ai.notice.newconv', 'Provider changed: starting a new conversation.'));
  }
  S.historyKind = cfg.kind;
  el.text.value = '';
  addUser(text);
  const userText = withContext(text);
  setContext(null);

  const provider = providerFor(cfg.kind);
  const ac = new AbortController();
  S.abort = ac;
  setRunning(true);
  const turn = botTurn();
  const hist = S.history; // clearChat may replace S.history while this runs
  const base = hist.length;
  try {
    await provider.run({
      history: hist,
      userText,
      settings: cfg,
      system: systemPrompt(),
      signal: ac.signal,
      cb: {
        onText: (d) => turn.text(d),
        onRoundStart: () => turn.roundStart(),
        onRoundDiscard: () => turn.discardRound(),
        onToolStart: (id, name) => turn.chip(id, name),
        onToolInput: (id, input) => turn.chipInput(id, input),
        onToolEnd: (id, ok) => {
          turn.chipEnd(id, ok);
          syncHeader();
        },
        onNotice: (msg) => {
          turn.pause();
          addNotice(msg, 'warn');
        },
        runTool: (name, input) => runTool(name, input, { signal: ac.signal }),
      },
    });
  } catch (e) {
    turn.end();
    if (provider.isAbort(e) || ac.signal.aborted) addNotice(t('ai.notice.stopped', 'Stopped.'));
    else {
      console.warn('AI request failed:', e?.status ?? '', e?.name || 'Error'); // no message body: never risk logging secrets
      addNotice(provider.errorText(e), 'err');
    }
  } finally {
    turn.end();
    // Nothing came back for this message: drop it from the API history so a retry does not send it twice.
    if (hist.length === base + 1) hist.pop();
    S.abort = null;
    setRunning(false);
    syncHeader();
  }
}

// ---------------------------------------------------------------- settings dialog

function openSettings(presetId) {
  const s = loadSettings();
  let cur = presetOf(presetId || s.preset || 'anthropic');
  const p = el.settings;
  p.hidden = false;
  p.innerHTML = `
    <form class="ai-set" autocomplete="off">
      <h3>${esc(t('ai.set.title', 'AI settings'))}</h3>
      <label><span>${esc(t('ai.set.provider', 'Provider'))}</span><select name="preset"></select></label>
      <label class="ai-key"><span>${esc(t('ai.set.key', 'API key'))}</span>
        <span class="ai-keyrow"><input name="key" type="password" spellcheck="false" autocomplete="off" />
        <button type="button" data-a="show">${esc(t('ai.set.show', 'Show'))}</button></span></label>
      <label><span>${esc(t('ai.set.model', 'Model'))}</span><input name="model" list="ai-models" spellcheck="false" /><datalist id="ai-models"></datalist></label>
      <label class="ai-base"><span>${esc(t('ai.set.base', 'Base URL'))}</span><input name="base" spellcheck="false" /></label>
      <label class="ai-eff"><span>${esc(t('ai.set.effort', 'Effort'))}</span><select name="effort"></select></label>
      <p class="ai-hint"></p>
      <p class="ai-small ai-priv"></p>
      <div class="ai-set-btns">
        <button type="button" data-a="forget">${esc(t('ai.set.forget', 'Forget key'))}</button>
        <span class="spacer"></span>
        <button type="button" data-a="cancel">${esc(t('ai.set.cancel', 'Cancel'))}</button>
        <button type="submit" class="pri">${esc(t('ai.set.save', 'Save'))}</button>
      </div>
    </form>`;
  const f = $('form', p);
  const sel = f.elements.preset;
  for (const x of PRESETS) sel.appendChild(new Option(x.kind === 'compat' ? `${x.label} (${t('ai.set.compat', 'OpenAI-compatible')})` : x.label, x.id));
  // Static keys so tools/i18n-extract.mjs can see them.
  const effortLabel = {
    low: t('ai.effort.low', 'Low'),
    medium: t('ai.effort.medium', 'Medium'),
    high: t('ai.effort.high', 'High'),
    xhigh: t('ai.effort.xhigh', 'Extra high'),
    max: t('ai.effort.max', 'Max'),
  };
  for (const e of EFFORTS) f.elements.effort.appendChild(new Option(effortLabel[e] || e, e));
  f.elements.effort.value = s.effort || 'medium';

  // Pending edits per preset (so switching the select does not lose what was typed).
  const draft = { keys: { ...s.keys }, models: { ...s.models }, baseUrls: { ...s.baseUrls } };
  const keep = () => {
    draft.keys[cur.id] = f.elements.key.value.trim();
    draft.models[cur.id] = f.elements.model.value.trim();
    if (cur.kind === 'compat') draft.baseUrls[cur.id] = f.elements.base.value.trim();
  };
  const fill = () => {
    sel.value = cur.id;
    f.elements.key.value = draft.keys[cur.id] || '';
    f.elements.key.type = 'password';
    $('[data-a=show]', f).textContent = t('ai.set.show', 'Show');
    f.elements.key.placeholder = cur.needsKey ? t('ai.set.key_ph', 'Paste your API key') : t('ai.set.key_opt', 'Optional for local servers');
    f.elements.model.value = draft.models[cur.id] || cur.model;
    const dl = $('#ai-models', f);
    dl.textContent = '';
    for (const m of cur.kind === 'anthropic' ? CLAUDE_MODELS : cur.models) dl.appendChild(new Option(m, m));
    f.elements.base.value = draft.baseUrls[cur.id] || cur.baseUrl || '';
    $('.ai-base', f).hidden = cur.kind !== 'compat';
    $('.ai-eff', f).hidden = cur.kind !== 'anthropic' && cur.id !== 'openai';
    $('.ai-hint', f).textContent = presetHint(cur.id);
    let host = cur.host || '';
    try {
      host = host || new URL(f.elements.base.value).host;
    } catch {}
    $('.ai-priv', f).textContent = t('ai.set.privacy', 'The key is stored only on this computer and sent only to {host}.', { host: host || '—' });
  };
  fill();
  sel.onchange = () => {
    keep();
    cur = presetOf(sel.value);
    fill();
  };
  f.elements.base.oninput = () => {
    let host = '';
    try {
      host = new URL(f.elements.base.value).host;
    } catch {}
    $('.ai-priv', f).textContent = t('ai.set.privacy', 'The key is stored only on this computer and sent only to {host}.', { host: host || '—' });
  };
  $('[data-a=show]', f).onclick = (e) => {
    const k = f.elements.key;
    k.type = k.type === 'password' ? 'text' : 'password';
    e.target.textContent = k.type === 'password' ? t('ai.set.show', 'Show') : t('ai.set.hide', 'Hide');
  };
  $('[data-a=forget]', f).onclick = () => {
    f.elements.key.value = '';
    draft.keys[cur.id] = '';
    const s2 = loadSettings();
    delete s2.keys[cur.id];
    saveSettings(s2);
    toast(t('ai.set.forgotten', 'Key removed from this computer'));
    syncHeader();
  };
  $('[data-a=cancel]', f).onclick = () => closeSettings();
  f.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeSettings();
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    keep();
    if (cur.kind === 'compat') {
      try {
        const u = new URL(draft.baseUrls[cur.id] || cur.baseUrl);
        if (!/^https?:$/.test(u.protocol)) throw 0;
      } catch {
        toast(t('ai.set.bad_url', 'Base URL must start with http:// or https://'));
        return;
      }
    }
    const next = { ...loadSettings(), preset: cur.id, effort: f.elements.effort.value, keys: {}, models: {}, baseUrls: {} };
    for (const [k, v] of Object.entries(draft.keys)) if (v) next.keys[k] = v;
    for (const [k, v] of Object.entries(draft.models)) if (v && v !== presetOf(k).model) next.models[k] = v;
    for (const [k, v] of Object.entries(draft.baseUrls)) if (v && v !== presetOf(k).baseUrl) next.baseUrls[k] = v;
    saveSettings(next);
    closeSettings();
    syncHeader();
    if (!S.historyKind) renderEmpty();
  };
  setTimeout(() => (cur.needsKey && !f.elements.key.value ? f.elements.key : f.elements.model).focus(), 0);
  if (!S.open) toggle(true);
}

function closeSettings() {
  el.settings.hidden = true;
  el.settings.textContent = ''; // drop the key from the DOM
  el.text.focus();
}

// ---------------------------------------------------------------- public

/**
 * Creates the "AI" header button and the assistant drawer. Call once after initLive.
 * ctx: { modes, switchTab, live? } — live defaults to the live.js manager.
 * Returns { open(), close(), toggle() }.
 */
export function initAI(c) {
  if (ctx) return api;
  ctx = { ...c, live: c?.live || liveMgr };
  bindTools(ctx, { note: showNote });
  build();
  return api;
}

const api = {
  open: () => toggle(true),
  close: () => toggle(false),
  toggle: () => toggle(),
};
