// 2026-11-09 (mick-agentic-browser): LLM mood refiner. The lexicon scorer
// (sentiment.js) gives an instant, free score — but almost everything said to a
// task assistant is neutral wording ("create an appointment", "do a dtmf
// test"), so the mood pill sat pinned on "neutral 0". This module re-reads the
// last few lines of the conversation with the fast model, asynchronously and
// debounced, and emits a `sentiment.update` that corrects the pill/chart with
// a judgement of TONE (warmth, frustration, energy), not just trigger words.
// Fire-and-forget: a model failure changes nothing (the lexicon score stands).
import { config } from './config.js';
import { completeText } from './llm/client.js';
import { emitEvent } from './events.js';
import { createLogger } from './logger.js';

const logger = createLogger('MOOD');
const DEBOUNCE_MS = Number(process.env.MOOD_DEBOUNCE_MS || 1500);
const sessions = new Map(); // sessionId -> { timer, pending, busy }

const labelOf = (score) => (score > 0.25 ? 'positive' : score < -0.25 ? 'negative' : 'neutral');

/**
 * Schedule an LLM mood read for a caller line. Debounced per session (voice
 * transcripts arrive in pieces); only the newest request runs.
 * @param {object} o
 * @param {string} o.sessionId  console session to emit to
 * @param {number} o.turn       caller turn the score belongs to
 * @param {Array<{role:string,text:string}>} o.lines  recent transcript, oldest first
 * @param {(score:number) => {slope:number,trend:string}} o.apply  write the score into the
 *        caller-history slot captured by the caller; returns the refreshed trend
 */
export function refineMood({ sessionId, turn, lines, apply }) {
  if (!config.llm.apiKey || process.env.MOOD_LLM === '0') return;
  const st = sessions.get(sessionId) || {};
  st.pending = { turn, lines, apply };
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.timer = null; run(sessionId); }, DEBOUNCE_MS);
  sessions.set(sessionId, st);
}

async function run(sessionId) {
  const st = sessions.get(sessionId);
  if (!st || st.busy || !st.pending) return;
  const { turn, lines, apply } = st.pending;
  st.pending = null;
  st.busy = true;
  try {
    const convo = (lines || [])
      .filter((l) => l && l.text)
      .slice(-6)
      .map((l) => `${l.role === 'user' ? 'CALLER' : 'ASSISTANT'}: ${String(l.text).slice(0, 220)}`)
      .join('\n');
    if (!convo) return;
    const raw = await completeText({
      model: config.llm.fastModel,
      messages: [
        { role: 'system', content: 'You rate the CALLER\'s current mood on a phone call with an assistant. Scale: -1 (very upset or frustrated) to 1 (very happy or warm); 0 is neutral or purely businesslike. Judge tone and context — politeness, enthusiasm, impatience, sarcasm — not the topic. Use the full range: an ordinary friendly exchange is around 0.3, mild irritation around -0.3; reserve values beyond ±0.8 for genuinely extreme moods. Reply with ONLY the number.' },
        { role: 'user', content: convo }
      ],
      params: { max_tokens: 16 }
    });
    const score = Math.max(-1, Math.min(1, Number((raw.match(/-?\d*\.?\d+/) || [])[0])));
    if (!Number.isFinite(score)) return;
    const rounded = Math.round(score * 100) / 100;
    const trend = apply(rounded);
    emitEvent('sentiment.update', sessionId, { turn, sentiment: { score: rounded, label: labelOf(rounded), hits: ['model'] }, trend });
  } catch (err) {
    logger.warn(`mood refine failed (${err.message}) — lexicon score stands`);
  } finally {
    st.busy = false;
    if (st.pending) { clearTimeout(st.timer); st.timer = setTimeout(() => { st.timer = null; run(sessionId); }, 200); }
    else if (!st.timer) sessions.delete(sessionId);
  }
}
