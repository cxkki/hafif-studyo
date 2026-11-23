// AI provider registry + settings, and the "OpenAI-compatible" provider (fetch to {baseUrl}/chat/completions,
// function calling, SSE streaming). Claude lives in ai-claude.js and never goes through this path.
//
// Settings are stored only in this browser profile (localStorage, key "hs_ai"); API keys are kept per preset,
// never logged and only sent to the chosen provider's endpoint (in a header, never in a URL).
import { store } from './util.js';
import { TOOL_DEFS, validateInput } from './ai-tools.js';
import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from './ai-claude.js';
import { t } from './i18n.js';

/** Presets. kind: 'anthropic' (official SDK) | 'compat' (OpenAI-compatible HTTP). */
export const PRESETS = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic Claude', models: CLAUDE_MODELS, model: CLAUDE_DEFAULT_MODEL, needsKey: true, host: 'api.anthropic.com' },
  { id: 'openai', kind: 'compat', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], model: 'gpt-5-mini', needsKey: true },
  { id: 'openrouter', kind: 'compat', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5-mini', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'], model: 'openai/gpt-5-mini', needsKey: true },
  { id: 'groq', kind: 'compat', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], model: 'openai/gpt-oss-120b', needsKey: true },
  { id: 'gemini', kind: 'compat', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-pro'], model: 'gemini-2.5-flash', needsKey: true },
  { id: 'ollama', kind: 'compat', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5-coder:7b', 'llama3.1:8b'], model: 'qwen2.5-coder:7b', needsKey: false, local: true },
  { id: 'lmstudio', kind: 'compat', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', models: ['local-model'], model: 'local-model', needsKey: false, local: true },
];
export const presetOf = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

/** Hint shown in settings for local servers (browser CORS). */
export function presetHint(id) {
  if (id === 'ollama') return t('ai.hint.ollama', 'Start Ollama with the environment variable OLLAMA_ORIGINS=* so the app may connect, and pull a model that supports tools.');
  if (id === 'lmstudio') return t('ai.hint.lmstudio', 'In LM Studio start the local server with CORS enabled, and load a model that supports tools.');
  if (id === 'anthropic') return t('ai.hint.anthropic', 'Create a key at console.anthropic.com.');
  return '';
}

// ---------------------------------------------------------------- settings

const KEY = 'ai';
const defaults = () => ({ preset: '', effort: 'medium', models: {}, baseUrls: {}, keys: {} });

export function loadSettings() {
  const s = { ...defaults(), ...(store.get(KEY, null) || {}) };
  for (const k of ['models', 'baseUrls', 'keys']) if (!s[k] || typeof s[k] !== 'object') s[k] = {};
  return s;
}
export function saveSettings(s) {
  store.set(KEY, s);
}

/** Effective settings for the active preset: { preset, kind, label, apiKey, model, baseUrl, effort, ready }. */
export function activeConfig(s = loadSettings()) {
  const p = presetOf(s.preset);
  const apiKey = s.keys[p.id] || '';
  const cfg = {
    preset: p.id,
    kind: p.kind,
    label: p.label,
    apiKey,
    model: (s.models[p.id] || p.model || '').trim(),
    baseUrl: (s.baseUrls[p.id] || p.baseUrl || '').trim().replace(/\/+$/, ''),
    effort: s.effort || 'medium',
  };
  cfg.ready = !!s.preset && !!cfg.model && (!p.needsKey || !!apiKey) && (p.kind === 'anthropic' || !!cfg.baseUrl);
  return cfg;
}

/** Display name used in note bubbles ("Claude:", "Gemini:" …). */
export function speakerName(cfg) {
  if (cfg.kind === 'anthropic') return 'Claude';
  const m = cfg.model.split('/').pop();
  if (/gemini/i.test(m)) return 'Gemini';
  if (/^gpt|^o\d/i.test(m)) return 'GPT';
  if (/llama/i.test(m)) return 'Llama';
  if (/qwen/i.test(m)) return 'Qwen';
  if (/deepseek/i.test(m)) return 'DeepSeek';
  if (/mistral|mixtral/i.test(m)) return 'Mistral';
  return presetOf(cfg.preset).label;
}

// ---------------------------------------------------------------- OpenAI-compatible provider

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class NetError extends Error {}

// additionalProperties is dropped: some OpenAI-compatible servers (e.g. older Gemini endpoints) reject it.
const compatTools = () =>
  TOOL_DEFS.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: { ...d.parameters, additionalProperties: undefined } } }));

function compatErrorText(e, cfg) {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return t('ai.err.auth', 'The API key was rejected. Check it in settings.');
    if (e.status === 404) return t('ai.err.model', 'Model not found. Check the model name in settings.') + (e.message ? ' — ' + e.message : '');
    if (e.status === 429) return t('ai.err.rate', 'Rate limit reached. Wait a moment and try again.');
    return t('ai.err.api', 'AI service error ({status}): {msg}', { status: e.status, msg: e.message });
  }
  if (e instanceof NetError) {
    const local = presetOf(cfg?.preset).local;
    return local
      ? t('ai.err.local', 'Could not reach {url}. Is the local server running and allowed to accept requests from the app (CORS)?', { url: cfg.baseUrl })
      : t('ai.err.network', 'Could not reach the AI service. Check your internet connection.');
  }
  return String(e?.message || e);
}

async function readError(res) {
  let msg = '';
  try {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      msg = (typeof e === 'string' ? e : e?.message) || j.message || '';
    } catch {
      msg = txt.slice(0, 300);
    }
  } catch {}
  return new HttpError(res.status, msg || res.statusText || 'error');
}

/** Streams one chat completion. Returns { content, toolCalls:[{id,name,arguments}], finish }. */
async function streamCompletion(cfg, body, signal, onText) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  let res;
  try {
    res = await fetch(cfg.baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') throw e;
    throw new NetError('network');
  }
  if (!res.ok) throw await readError(res);

  let content = '';
  let finish = '';
  const calls = []; // by index
  // Tool-call deltas are keyed by index; some servers omit it (match by id, else continue the last call).
  const callAt = (tc, i) => {
    let idx;
    if (Number.isInteger(tc.index)) idx = tc.index;
    else if (tc.id) {
      idx = calls.findIndex((c) => c && c.id === tc.id);
      if (idx < 0) idx = calls.length;
    } else idx = calls.length ? calls.length - 1 : i;
    return (calls[idx] ||= { id: '', name: '', arguments: '' });
  };
  const handle = (data) => {
    if (data.error) throw new HttpError(500, data.error.message || String(data.error));
    const ch = data.choices?.[0];
    if (!ch) return;
    const d = ch.delta || ch.message || {};
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      onText(d.content);
    }
    (d.tool_calls || []).forEach((tc, i) => {
      const c = callAt(tc, i);
      if (tc.id) c.id = tc.id;
      if (tc.function?.name && !c.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    });
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  const type = res.headers.get('content-type') || '';
  if (!/event-stream/.test(type)) {
    // Server ignored stream:true: plain JSON response.
    handle(await res.json());
  } else {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        handle(data);
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  return { content, toolCalls, finish };
}

export function createCompatProvider() {
  let lastCfg = null;
  return {
    id: 'compat',
    errorText: (e) => compatErrorText(e, lastCfg),
    isAbort: (e) => e?.name === 'AbortError',

    /** history: OpenAI chat messages (system message excluded; added per request). Mutated append-only. */
    async run({ history, userText, settings, system, signal, cb }) {
      lastCfg = settings;
      history.push({ role: 'user', content: userText });
      const tools = compatTools();
      for (let round = 0; round < 40; round++) {
        if (signal.aborted) return;
        const body = { model: settings.model, messages: [{ role: 'system', content: system }, ...history], tools, tool_choice: 'auto', stream: true };
        if (settings.preset === 'openai' && /^(o\d|gpt-5)/.test(settings.model)) body.reasoning_effort = { xhigh: 'high', max: 'high' }[settings.effort] || settings.effort;
        const out = await streamCompletion(settings, body, signal, cb.onText);
        if (out.finish === 'length' && out.toolCalls.length) {
          cb.onNotice(t('ai.notice.truncated_tool', 'The reply was cut off before a tool call finished. Ask for smaller steps.'));
          return;
        }
        if (out.finish === 'content_filter') {
          // Tool calls of a filtered reply are never run, so they must not enter the history either: an assistant
          // tool_calls message without matching tool replies makes every later request fail. Keep only its text.
          if (out.content) history.push({ role: 'assistant', content: out.content });
          cb.onNotice(t('ai.notice.refusal', 'The model declined this request. Try rephrasing it.'));
          return;
        }
        const msg = { role: 'assistant', content: out.content || (out.toolCalls.length ? null : '') };
        if (out.toolCalls.length)
          msg.tool_calls = out.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
        history.push(msg);
        if (!out.toolCalls.length) {
          if (out.finish === 'length') cb.onNotice(t('ai.notice.truncated', 'The reply hit the length limit.'));
          return;
        }
        for (const c of out.toolCalls) {
          cb.onToolStart(c.id, c.name);
          let input;
          try {
            input = JSON.parse(c.arguments || '{}');
          } catch {
            input = undefined;
          }
          cb.onToolInput(c.id, input);
          let r;
          if (input === undefined) r = { ok: false, content: JSON.stringify({ INVALID_JSON: c.arguments || '' }) };
          else if (validateInput(c.name, input)) r = { ok: false, content: JSON.stringify({ INVALID_INPUT: validateInput(c.name, input) }) };
          else if (signal.aborted) r = { ok: false, content: 'Cancelled by the user.' };
          else r = await cb.runTool(c.name, input);
          history.push({ role: 'tool', tool_call_id: c.id, content: r.content });
          cb.onToolEnd(c.id, r.ok);
        }
        if (signal.aborted) return;
      }
      cb.onNotice(t('ai.notice.rounds', 'Stopped after many steps. Say "continue" to go on.'));
    },
  };
}
