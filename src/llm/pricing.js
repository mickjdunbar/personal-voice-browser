// 2026-11-05 (mick-agentic-browser): indicative LLM cost estimation for the "This turn" panel.
// Prices are USD per 1,000,000 tokens and are ILLUSTRATIVE defaults — override the whole table with
// the LLM_PRICES env var (JSON: { "model-substring": { "in": n, "cached": n, "out": n } }). Matching is
// by substring so "gpt-5.6-terra" matches a key "gpt-5.6-terra". Cached input tokens are billed at the
// cheaper `cached` rate. S2S (Realtime audio) is NOT included here — jambonz does not surface its token
// usage to us; this covers the text models that do the browsing/reasoning (the bulk of the spend).
const json = (v, f) => { if (!v) return f; try { return JSON.parse(v); } catch { return f; } };

const DEFAULTS = {
  'gpt-5.6-terra': { in: 1.25, cached: 0.125, out: 10 },
  'gpt-6-sol': { in: 1.25, cached: 0.125, out: 10 },
  'gpt-6-luna': { in: 1.25, cached: 0.125, out: 10 },
  'gpt-5.6-luna': { in: 1.0, cached: 0.1, out: 8 },
  'gpt-5.5': { in: 1.25, cached: 0.125, out: 10 },
  'gpt-5.4-mini': { in: 0.25, cached: 0.025, out: 2 },
  'gemini-3.6-flash': { in: 0.3, cached: 0.075, out: 2.5 },
  'gemini-3.5-flash-lite': { in: 0.1, cached: 0.025, out: 0.4 }
};
const FALLBACK = { in: 1, cached: 0.1, out: 5 };

const PRICES = { ...DEFAULTS, ...json(process.env.LLM_PRICES, {}) };

/** Price row for a model id, by longest matching substring key (else a generic fallback). */
export function priceFor(model = '') {
  const m = String(model);
  let best = null, bestLen = -1;
  for (const key of Object.keys(PRICES)) {
    if (m.includes(key) && key.length > bestLen) { best = PRICES[key]; bestLen = key.length; }
  }
  return best || FALLBACK;
}

// Realtime (speech-to-speech) pricing, USD per 1M tokens, split text/audio — OpenAI's
// response.done carries the matching usage breakdown. Illustrative defaults like the table
// above; override via LLM_PRICES with the same keys (e.g. {"gpt-realtime": {...}}).
const REALTIME_DEFAULTS = {
  'gpt-realtime': { text_in: 4, text_cached: 0.4, text_out: 16, audio_in: 32, audio_cached: 0.4, audio_out: 64 },
  'gpt-4o-realtime': { text_in: 5, text_cached: 2.5, text_out: 20, audio_in: 40, audio_cached: 2.5, audio_out: 80 }
};
const REALTIME_PRICES = { ...REALTIME_DEFAULTS, ...json(process.env.LLM_PRICES, {}) };

/** USD cost of ONE OpenAI Realtime response, from response.done's `usage` object. */
export function costOfRealtimeUsage(model = '', usage = {}) {
  const m = String(model);
  let p = null, bestLen = -1;
  for (const key of Object.keys(REALTIME_PRICES)) {
    const row = REALTIME_PRICES[key];
    if (row && typeof row.audio_in === 'number' && m.includes(key) && key.length > bestLen) { p = row; bestLen = key.length; }
  }
  if (!p) p = REALTIME_DEFAULTS['gpt-realtime'];
  const ind = usage.input_token_details || {};
  const outd = usage.output_token_details || {};
  const cachedD = ind.cached_tokens_details || {};
  const cachedText = cachedD.text_tokens || 0;
  const cachedAudio = cachedD.audio_tokens || 0;
  const cachedFlat = Math.max(0, (ind.cached_tokens || 0) - cachedText - cachedAudio); // no breakdown given
  const textIn = Math.max(0, (ind.text_tokens || 0) - cachedText);
  const audioIn = Math.max(0, (ind.audio_tokens || 0) - cachedAudio);
  return (
    textIn * p.text_in + audioIn * p.audio_in +
    cachedText * p.text_cached + cachedAudio * p.audio_cached + cachedFlat * p.text_cached +
    (outd.text_tokens || 0) * p.text_out + (outd.audio_tokens || 0) * p.audio_out
  ) / 1e6;
}

/** USD cost of a list of model calls (each {model, input_tokens, cached_tokens, output_tokens}). */
export function costOfCalls(calls = []) {
  let c = 0;
  for (const m of calls || []) {
    const p = priceFor(m.model);
    const cached = m.cached_tokens || 0;
    const billedIn = Math.max(0, (m.input_tokens || 0) - cached);
    c += (billedIn * p.in + cached * p.cached + (m.output_tokens || 0) * p.out) / 1e6;
  }
  return c;
}
