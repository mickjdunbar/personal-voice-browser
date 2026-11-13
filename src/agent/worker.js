// 2026-11-05 (mick-agentic-browser): a WORKER runs ONE task from the Lead's
// plan and returns a STRUCTURED result — it never speaks to the caller (only
// Aria does that, via the Lead). Workers run concurrently; there can be several
// of the same kind at once (two phone calls, two browse tasks), each isolated:
//   phone   — a real outbound call (placeAskCall); naturally parallel (own leg).
//   browse  — a throwaway Navigator on its OWN session key (its own browser tab
//             + history), driven by the task goal; its reply is CAPTURED as text
//             (textWriter) instead of being spoken. Reuses the whole proven tool
//             loop, SOPs and knowledge — nothing to reimplement.
//   chatbot — one message to a named external assistant.
import { Navigator, textWriter } from './navigator.js';
import { placeAskCall, checkAskTarget } from '../phone/ask.js';
import { askChatBot } from '../chat/bots.js';
import { completeText } from '../llm/client.js';
import { config } from '../config.js';
import { getBrowser } from '../browser/browser.js';
import { createLogger } from '../logger.js';

const log = createLogger('Worker');
const DIGITS = /[+()\d][\d()\s-]{5,}\d/;

/** Pull a phone number for `name` out of the caller's free-text context. Returns '' if none. */
async function resolveNumber(name, contextText) {
  if (!contextText) return '';
  // Fast path: a single number in the context and one obvious name.
  try {
    const out = await completeText({
      model: config.llm.summaryModel,
      messages: [
        { role: 'system', content: `From the notes, return ONLY the phone number for "${name}" in full (digits and +), or the single word NONE if the notes do not contain a number for them. No other words.` },
        { role: 'user', content: contextText }
      ],
      params: { max_tokens: 24, temperature: 0 }
    });
    const m = String(out).match(DIGITS);
    return m ? m[0].replace(/[()\s-]/g, '') : '';
  } catch { return ''; }
}

/**
 * @param {object} task   a task from the planner, with inputs resolved by the Lead
 * @param {object} o
 * @param {string} o.sessionId     the main session (for shared outbound-call context)
 * @param {string} o.contextText   what is known about the caller (for number resolution)
 * @param {string} [o.upstream]    a note of results this task depends on
 * @param {AbortSignal} [o.signal] abort to cancel the task mid-flight
 * @returns {Promise<{ok:boolean, result:string, error?:string, raw?:any}>}
 */
export async function runTask(task, { sessionId = 'main', contextText = '', upstream = '', signal } = {}) {
  const goal = [task.goal, upstream && `Use these results from earlier steps: ${upstream}`].filter(Boolean).join('\n\n');
  try {
    if (task.kind === 'phone') return await runPhone(task, { sessionId, contextText, signal });
    if (task.kind === 'chatbot') return await runChatbot(task, { sessionId });
    return await runBrowse(task, { sessionId, goal, signal });
  } catch (err) {
    if (signal?.aborted) return { ok: false, result: '', error: 'cancelled' };
    log.warn(`task ${task.id} (${task.kind}) threw: ${err.message}`);
    return { ok: false, result: '', error: err.message };
  }
}

async function runPhone(task, { sessionId, contextText, signal }) {
  const name = task.name || 'them';
  let to = (task.to || '').replace(/[^\d+]/g, '');
  if (!to || to.replace(/\D/g, '').length < 5) to = await resolveNumber(name, contextText);
  const question = task.question || task.goal;
  const bad = checkAskTarget({ to, question });
  if (bad) return { ok: false, result: `couldn't call ${name}: ${bad}`, error: bad };
  const r = await placeAskCall({ to, name, question, onBehalfOf: config.agentName, sessionId });
  if (signal?.aborted) return { ok: false, result: '', error: 'cancelled' };
  if (r?.error) return { ok: false, result: `couldn't reach ${name}${r.timed_out ? " — they didn't pick up" : ''}`, error: r.error, raw: r };
  return { ok: true, result: `${name} said: ${r.answer}`, raw: r };
}

async function runChatbot(task, { sessionId }) {
  const r = await askChatBot(task.bot, sessionId, task.message || task.goal);
  if (r?.error) return { ok: false, result: `the ${r.name || task.bot || 'assistant'} couldn't help`, error: r.error, raw: r };
  return { ok: true, result: `${r.name || 'the assistant'} said: ${r.reply}`, raw: r };
}

async function runBrowse(task, { sessionId, goal, signal }) {
  const workerId = `${sessionId}#w-${task.id}`;
  let nav = null;
  try {
    nav = new Navigator({ sessionId: workerId, channel: 'specialist', metadata: { worker: true } });
    await nav.start({ mode: 'worker', task: task.title });
    const writer = textWriter();
    await nav.turn(goal, writer, { signal, kind: 'speech' });
    const result = (writer.text || '').trim();
    return { ok: Boolean(result), result: result || 'nothing came back', raw: { url: nav.tab?.url } };
  } finally {
    try { await nav?.end('worker_done'); } catch { /* ignore */ }
    try { await getBrowser().closeTab?.(workerId); } catch { /* ignore */ }
  }
}
