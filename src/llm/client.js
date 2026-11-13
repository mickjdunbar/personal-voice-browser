// 2026-11-03 (mick-agentic-browser): streaming client for any OpenAI-compatible
// chat-completions endpoint (Gemini's /v1beta/openai by default). Hand-rolled
// fetch, no vendor SDK. streamChat() reports content deltas as they arrive and
// resolves with the assembled tool calls + usage, so a turn can start speaking
// the first sentence while the model is still generating and still act on a
// function call from the same response.
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('LLM');

export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} req {model, messages, tools?, params?, signal?, baseURL?, apiKey?}
 * @param {(delta: string) => void} [onText]
 * @returns {Promise<{text, toolCalls, usage, model, ttftMs, totalMs, finishReason}>}
 */
// OpenAI's own /chat/completions differs from the Gemini OpenAI-compatible endpoint we used before:
// reasoning models (gpt-5.x / gpt-6.x / o-series — anything that isn't a plain chat model like a
// "mini") reject `temperature` other than 1 and require `max_completion_tokens` instead of
// `max_tokens`. We fix the request up here so the SAME lane params work on either backend; a no-op
// for non-OpenAI bases. (gpt-*-mini and 4o-class models keep temperature + max_tokens.)
function normalizeForEndpoint(body, baseURL) {
  if (!/\bapi\.openai\.com\b/.test(baseURL || '')) return;
  if (body.max_tokens != null && body.max_completion_tokens == null) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  const reasoning = /^(o[0-9]|gpt-[0-9])/i.test(body.model || '') && !/mini|nano|4o|chat/i.test(body.model || '');
  if (reasoning && body.temperature != null && body.temperature !== 1) delete body.temperature;
}

// Transient-failure armour: on a flaky network (rural links, wifi blips) the first symptom is a
// fetch that dies with "fetch failed"/ECONNRESET before any byte arrives — retrying quietly saves
// the whole turn. We only retry BEFORE the stream starts (idempotent), never mid-stream, and only
// for network-class errors or gateway/overload statuses.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
function isNetErr(err) {
  const s = `${err?.message || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket hang up|other side closed|network/i.test(s);
}
async function fetchWithRetry(url, opts, { tries = 3, label = 'model' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (RETRYABLE_STATUS.has(res.status) && i < tries - 1) {
        logger.warn(`${label} HTTP ${res.status} — retrying (attempt ${i + 2}/${tries})`);
        await new Promise((r) => setTimeout(r, 350 * (i + 1) + Math.random() * 250));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (opts?.signal?.aborted || !isNetErr(err) || i === tries - 1) throw err;
      logger.warn(`${label} network error (${err?.cause?.code || err.message}) — retrying (attempt ${i + 2}/${tries})`);
      await new Promise((r) => setTimeout(r, 350 * (i + 1) + Math.random() * 250));
    }
  }
  throw lastErr;
}

// 13 Nov (Dinner-sorted take 3): three deep-lane requests hung for 3.5-5 MINUTES each with no bytes
// arriving — the fetch simply sat there until the far end gave up, and the caller held the line.
// A stall is now bounded: no first byte within LLM_TTFB_TIMEOUT_MS (default 75 s) or no further
// byte within LLM_IDLE_TIMEOUT_MS (default 60 s) aborts the request; a stall BEFORE any byte is
// retried once on a fresh connection. A caller-supplied signal still aborts everything.
const TTFB_TIMEOUT_MS = Number(process.env.LLM_TTFB_TIMEOUT_MS) || 75000;
const IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS) || 60000;

export async function streamChat(req, onText) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamChatOnce(req, onText);
    } catch (err) {
      if (err?.stall === 'ttfb' && attempt === 0 && !req.signal?.aborted) {
        logger.warn(`${req.model}: no response within ${TTFB_TIMEOUT_MS} ms — retrying once on a fresh connection`);
        continue;
      }
      throw err;
    }
  }
}

async function streamChatOnce(req, onText) {
  const { model, messages, tools, params = {}, signal } = req;
  const baseURL = req.baseURL || config.llm.baseURL;
  const apiKey = req.apiKey || config.llm.apiKey;
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, ...params };
  if (tools?.length) body.tools = tools;
  normalizeForEndpoint(body, baseURL);

  // Stall watchdog: aborts the fetch/stream when nothing arrives for too long.
  const ac = new AbortController();
  let stall = null;
  let timer = null;
  const arm = (ms, kind) => { clearTimeout(timer); timer = setTimeout(() => { stall = kind; ac.abort(); }, ms); };
  const onOuterAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
  const stallError = () => { const e = new ModelError(`model request stalled (${stall === 'ttfb' ? `no response in ${TTFB_TIMEOUT_MS} ms` : `no data for ${IDLE_TIMEOUT_MS} ms`})`, 0); e.stall = stall; return e; };

  const started = Date.now();
  let res;
  try {
    arm(TTFB_TIMEOUT_MS, 'ttfb');
    res = await fetchWithRetry(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: ac.signal
    }, { label: model });
  } catch (err) {
    clearTimeout(timer); signal?.removeEventListener?.('abort', onOuterAbort);
    if (stall) throw stallError();
    throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer); signal?.removeEventListener?.('abort', onOuterAbort);
    const errText = await res.text().catch(() => '');
    logger.error(`${model} HTTP ${res.status}: ${errText.slice(0, 400)}`);
    throw new ModelError(`model request failed: HTTP ${res.status}`, res.status);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let ttftMs = null;
  let usage = null;
  let finishReason = null;
  const toolAcc = new Map();

  try {
  for await (const bytes of res.body) {
    arm(IDLE_TIMEOUT_MS, 'idle');
    buffer += decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new ModelError(`model stream error: ${chunk.error.message || JSON.stringify(chunk.error)}`);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        if (ttftMs === null) ttftMs = Date.now() - started;
        text += delta.content;
        if (onText) onText(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        if (ttftMs === null) ttftMs = Date.now() - started;
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) || { id: tc.id || `call_${idx}`, name: '', args: '', extra: null };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        // Gemini attaches a thought_signature here and rejects the tool round unless it is echoed back.
        if (tc.extra_content) acc.extra = tc.extra_content;
        toolAcc.set(idx, acc);
      }
      if (delta.extra_content && toolAcc.size) {
        const last = [...toolAcc.values()].at(-1);
        if (!last.extra) last.extra = delta.extra_content;
      }
    }
  }
  } catch (err) {
    if (stall) { logger.warn(`${model}: stream stalled after ${text.length} chars (${Date.now() - started} ms)`); throw stallError(); }
    throw err;
  } finally {
    clearTimeout(timer); signal?.removeEventListener?.('abort', onOuterAbort);
  }

  const toolCalls = [...toolAcc.values()].map((c) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
    return { id: c.id, name: c.name, args, rawArguments: c.args || '{}', extraContent: c.extra };
  });

  return {
    text,
    toolCalls,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          totalTokens: usage.total_tokens ?? null
        }
      : null,
    model,
    ttftMs,
    totalMs: Date.now() - started,
    finishReason
  };
}

/** The assistant message that records a batch of tool calls, for the next request. */
export function assistantToolCallMessage(text, calls) {
  return {
    role: 'assistant',
    content: text || null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.rawArguments || JSON.stringify(c.args || {}) },
      ...(c.extraContent ? { extra_content: c.extraContent } : {})
    }))
  };
}

/** Non-streaming convenience for summaries and classifiers. */
export async function completeText(req) {
  const r = await streamChat({ ...req }, null);
  return r.text.trim();
}

/** Embeddings via their OWN endpoint (Gemini by default), independent of the chat lane's base/key so
 * the KB keeps working when chat/S2S move to OpenAI (see config.kb.embeddingBaseURL). */
export async function embed(texts, { model = config.kb.embeddingModel, dimensions } = {}) {
  const res = await fetchWithRetry(`${config.kb.embeddingBaseURL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.kb.embeddingApiKey}` },
    body: JSON.stringify({ model, input: texts, ...(dimensions ? { dimensions } : {}) })
  }, { label: 'embeddings' });
  if (!res.ok) throw new ModelError(`embeddings failed: HTTP ${res.status}`, res.status);
  const j = await res.json();
  return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
