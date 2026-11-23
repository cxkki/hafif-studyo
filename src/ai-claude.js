// Anthropic Claude provider (official @anthropic-ai/sdk, in the browser).
// Manual streaming tool loop: client.beta.messages.stream + finalMessage(), eager input streaming on every client tool
// (inputs validated locally before running), adaptive thinking (thinking param omitted), output_config.effort,
// server-side refusal fallbacks (beta server-side-fallback-2026-07-01, fallbacks: "default") where the model supports them.
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFS, validateInput } from './ai-tools.js';
import { t } from './i18n.js';

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_ROUNDS = 40; // model turns per user message
const MAX_JSON_RETRIES = 2;

// Models with server-side fallbacks (Claude Haiku 5.5 has none: a fallbacks list there returns a 400).
const supportsFallback = (m) => /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5|mythos-5)/.test(m);
// output_config.effort: Opus 4.5+, the 4.6+ family and every 5.x / Fable / Mythos model.
const supportsEffort = (m) => /^claude-(fable|mythos)|^claude-[a-z]+-5|^claude-opus-4-[5-9]|^claude-[a-z]+-4-[6-9]/.test(m);
// Current models accept 64K+ output when streaming; anything unknown/older gets a conservative cap.
const maxTokensFor = (m) => (/^claude-(fable|mythos)|^claude-[a-z]+-5|^claude-[a-z]+-4-[6-9]/.test(m) ? 64000 : 8192);

const claudeTools = () =>
  TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters, eager_input_streaming: true }));

/**
 * After a mid-output fallback, blocks before the last `fallback` block that the fallback model cannot take
 * (thinking, redacted_thinking, tool_use, unpaired server_tool_use) are omitted when echoing; the fallback block stays.
 */
function echoContent(content) {
  let last = -1;
  content.forEach((b, i) => b.type === 'fallback' && (last = i));
  if (last <= 0) return content;
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return content.filter((b, i) => i >= last || !drop.has(b.type));
}

/** User-facing message for an SDK error (most specific first). Never includes the key. */
export function claudeErrorText(e) {
  if (e instanceof Anthropic.AuthenticationError) return t('ai.err.auth', 'The API key was rejected. Check it in settings.');
  if (e instanceof Anthropic.PermissionDeniedError) return t('ai.err.permission', 'This key has no access to that model or feature.');
  if (e instanceof Anthropic.NotFoundError) return t('ai.err.model', 'Model not found. Check the model name in settings.');
  if (e instanceof Anthropic.RateLimitError) return t('ai.err.rate', 'Rate limit reached. Wait a moment and try again.');
  if (e instanceof Anthropic.OverloadedError) return t('ai.err.overloaded', 'The service is overloaded. Try again shortly.');
  if (e instanceof Anthropic.BadRequestError) return t('ai.err.bad', 'Request rejected: {msg}', { msg: apiMsg(e) });
  if (e instanceof Anthropic.APIConnectionError) return t('ai.err.network', 'Could not reach the AI service. Check your internet connection.');
  if (e instanceof Anthropic.APIError) return t('ai.err.api', 'AI service error ({status}): {msg}', { status: e.status ?? '?', msg: apiMsg(e) });
  return String(e?.message || e);
}
const apiMsg = (e) => e?.error?.error?.message || e?.message || '';

export function createClaudeProvider() {
  let client = null;
  let clientKey = '';
  const getClient = (apiKey) => {
    if (!client || clientKey !== apiKey) {
      client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
      clientKey = apiKey;
    }
    return client;
  };

  return {
    id: 'anthropic',
    errorText: claudeErrorText,
    isAbort: (e) => e instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError',

    /**
     * Runs one user turn. history: Anthropic MessageParam[] (mutated: append-only).
     * cb: { onText(delta), onToolStart(id, name), onToolInput(id, input), onToolEnd(id, ok), onNotice(text), runTool(name, input),
     *       onRoundStart?(), onRoundDiscard?() }
     */
    async run({ history, userText, settings, system, signal, cb }) {
      const c = getClient(settings.apiKey);
      const model = settings.model || CLAUDE_DEFAULT_MODEL;
      const fallback = supportsFallback(model);
      const params = {
        model,
        max_tokens: maxTokensFor(model),
        system,
        tools: claudeTools(),
        tool_choice: { type: 'auto' },
        cache_control: { type: 'ephemeral' }, // automatic prompt caching of system + tools + history
        ...(supportsEffort(model) ? { output_config: { effort: settings.effort || 'medium' } } : {}),
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      };
      history.push({ role: 'user', content: userText });

      let jsonRetries = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal.aborted) return;
        cb.onRoundStart?.();
        const stream =c.beta.messages.stream({ ...params, messages: history }, { signal });
        let message;
        try {
          for await (const ev of stream) {
            if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') cb.onText(ev.delta.text);
            else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use')
              cb.onToolStart(ev.content_block.id, ev.content_block.name);
            else if (ev.type === 'content_block_start' && ev.content_block.type === 'fallback') cb.onText('\n');
          }
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Only a tool input that could not be parsed at all is retried; API errors and aborts propagate.
          if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
          cb.onRoundDiscard?.(); // drop this attempt's streamed text and tool chips: the retry streams them again
          cb.onNotice(t('ai.notice.retry', 'The reply was malformed; retrying…'));
          continue;
        }

        const stop = message.stop_reason;
        const toolUses = message.content.filter((b) => b.type === 'tool_use');

        if (stop === 'refusal') {
          // A refusal can cut a tool_use off mid-input: never run that turn's tools; the partial is discarded.
          const cat = message.stop_details?.category;
          cb.onNotice(
            cat
              ? t('ai.notice.refusal_cat', 'The model declined this request ({cat}). Try rephrasing it.', { cat })
              : t('ai.notice.refusal', 'The model declined this request. Try rephrasing it.'),
          );
          return;
        }
        if (stop === 'max_tokens' && toolUses.length) {
          // A truncated tool input can still look valid: do not run it.
          cb.onNotice(t('ai.notice.truncated_tool', 'The reply was cut off before a tool call finished. Ask for smaller steps.'));
          return;
        }

        let content = echoContent(message.content);
        // Client tool_use blocks are kept only when their results follow (stop_reason tool_use): any other stop
        // (e.g. model_context_window_exceeded) may have cut one off, and an unanswered tool_use breaks the history.
        if (stop !== 'tool_use' && stop !== 'pause_turn') content = content.filter((b) => b.type !== 'tool_use');
        // The API rejects an empty assistant message before a later user turn: push nothing instead
        // (the next user message is then merged with the previous user turn).
        if (content.length) history.push({ role: 'assistant', content });

        if (stop === 'pause_turn') {
          if (content.length) continue;
          cb.onNotice(t('ai.notice.empty', 'The model returned an empty reply. Try again or rephrase.'));
          return;
        }
        if (stop === 'max_tokens') {
          cb.onNotice(t('ai.notice.truncated', 'The reply hit the length limit.'));
          return;
        }
        if (stop === 'model_context_window_exceeded') {
          cb.onNotice(t('ai.notice.context', 'The conversation is too long. Clear the chat to continue.'));
          return;
        }
        if (stop !== 'tool_use' && stop !== 'end_turn' && stop !== 'stop_sequence') {
          cb.onNotice(t('ai.notice.stopped_reason', 'The reply stopped unexpectedly ({reason}).', { reason: String(stop || '?') }));
          return;
        }
        if (!content.length) {
          // An empty end after tool results just means "done"; an empty first reply is worth a word.
          if (round === 0) cb.onNotice(t('ai.notice.empty', 'The model returned an empty reply. Try again or rephrase.'));
          return;
        }
        const calls = content.filter((b) => b.type === 'tool_use');
        if (stop !== 'tool_use' || !calls.length) return; // end_turn / stop_sequence

        const results = [];
        for (const tu of calls) {
          cb.onToolInput(tu.id, tu.input);
          const bad = validateInput(tu.name, tu.input);
          if (bad) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input ?? null), error: bad }) });
            cb.onToolEnd(tu.id, false);
            continue;
          }
          if (signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Cancelled by the user.' });
            cb.onToolEnd(tu.id, false);
            continue;
          }
          const r = await cb.runTool(tu.name, tu.input);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
          cb.onToolEnd(tu.id, r.ok);
        }
        // All results of one turn go back in a single user message (keeps history valid even after a stop).
        history.push({ role: 'user', content: results });
        if (signal.aborted) return;
      }
      cb.onNotice(t('ai.notice.rounds', 'Stopped after many steps. Say "continue" to go on.'));
    },
  };
}
