// 2026-11-04 (mick-agentic-browser): "phone a person for the answer". The agent
// can place a short OUTBOUND call to someone (a number from the caller context),
// ask them one question, capture their spoken answer, hang up, and bring the
// answer back into the live conversation — e.g. "call my wife and ask what she'd
// like for dinner". One quick question per call, never bulk; emergency numbers
// are refused; the agent must get the caller's OK before dialling (tool rule).
import { config } from '../config.js';
import { jambonz } from '../jambonzApi.js';
import { bus, topic } from '../bus.js';
import { createLogger } from '../logger.js';
import { effectiveDial } from './testTarget.js';
import { dialAllowed, recordDial } from './dialCap.js'; // 16 Nov: sliding-window cap on real dials
import { callOptions, trackDial, describeDialFailure } from './callStatus.js'; // 16 Nov: refused dials fail fast

const logger = createLogger('PhoneAsk');
const pending = new Map(); // askId -> { question, name, onBehalfOf, to, startedAt }
const EMERGENCY = new Set(['000', '911', '112', '999', '111', '108', '119', '110', '101', '102']);

export function getAsk(askId) { return pending.get(askId) || null; }
export function resolveAsk(askId, payload) { bus.emit(topic(askId, 'answer'), payload); }
/** Calls still in flight for a session (dialling, ringing or talking) — for dedupe and resume notes. */
export function pendingAsksFor(sessionId = 'main') { return [...pending.entries()].filter(([, a]) => a.sessionId === sessionId).map(([askId, a]) => ({ askId, ...a })); }

/**
 * Normalize ANY phone-number spelling into E.164 (+<country><number>) before dialing.
 * "0400 123 456" → +61400123456 · "61400123456" → +61… · "0061…" → +61… · "+1 555…" → +1555….
 * Default country code comes from DEFAULT_COUNTRY_CODE (61 = Australia).
 */
export function normalizeE164(raw, cc = process.env.DEFAULT_COUNTRY_CODE || '61') {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (plus) return `+${digits}`;                                       // already E.164, just tidy
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;           // 0061… international prefix
  if (digits.startsWith('0')) return `+${cc}${digits.slice(1)}`;       // national format (04xx…)
  if (digits.startsWith(cc) && digits.length >= 10) return `+${digits}`; // country code, missing +
  if (digits.length === 9) return `+${cc}${digits}`;                   // AU number missing the leading 0
  return `+${digits}`;                                                 // assume it carries a country code
}

/** Synchronous pre-flight: returns an error string if we cannot make this call, else null. */
export function checkAskTarget({ to, question } = {}) {
  const digits = String(to || '').replace(/[^\d]/g, '');
  if (!String(question || '').trim()) return 'there is no question to ask';
  if (digits.length < 5) return `"${to || ''}" is not a phone number I can call`;
  if (EMERGENCY.has(digits)) return 'I will not place a call to an emergency number';
  if (!config.phoneAsk.enabled) return 'phoning people is turned off (set PHONE_ASK_ENABLED=1)';
  if (!config.jambonz.apiKey || !config.jambonz.accountSid || !config.jambonz.applicationSid) return 'outbound calling is not configured';
  if (!(config.phoneAsk.fromNumber || config.jambonz.fromNumber)) return 'no caller ID is set for outbound calls';
  return null;
}

/**
 * Place the outbound ask call and resolve with the person's answer.
 * @returns {Promise<{answer?,transcript?,error?,timed_out?,name?}>}
 */
// timeoutMs is a safety net, not the call length: the ask call can now hold a real back-and-forth
// (callee questions relayed to the owner and answered), so 90 s was cutting live calls' promises
// short — the console then reported "no answer" while the call was still going. 10 Nov: the promise
// now resolves at report_outcome (goal reached, call still open for follow-ups), so this only guards
// calls that never get that far — but an unhurried natural chat can take a while to get there.
// 13 Nov: 420 s let a silent leg hold the owner for seven minutes; the ask leg now reports the
// outcome the moment it has it, so three minutes is plenty for a real back-and-forth.
export async function placeAskCall({ to, name, question, onBehalfOf, kind = 'person', sessionId = 'main', timeoutMs = Number(process.env.PHONE_ASK_TIMEOUT_MS) || 180000 }) {
  // TEST redirect: when the console's "redirect calls to a test number" switch is on, dial the test
  // number instead of the real one — keep the name/question so the exercise is realistic, but no real
  // person or business is rung. We validate against the number we will ACTUALLY dial.
  const dial = effectiveDial(sessionId, to);
  const num = normalizeE164(dial.to); // ALWAYS dial E.164 (+<country code>…)
  const q = String(question || '').trim();
  const pre = checkAskTarget({ to: num, question });
  if (pre) return { error: pre, to: num };
  const from = config.phoneAsk.fromNumber || config.jambonz.fromNumber;
  if (dial.redirected) logger.info(`TEST redirect: ${String(dial.real).replace(/\d(?=\d{2})/g, '•')} -> test number`);

  // 13 Nov (take after the hero): the host's leg restarted mid-request and the resumed model fired
  // the same "ring the venue" again — TWO calls to the restaurant, two bookings. A second call to the
  // same number for the same session while the first is still in flight is never what anyone wants.
  const cap = dialAllowed(sessionId);
  if (!cap.ok) { logger.warn(`dial cap: ${sessionId} refused (${cap.count} this session / ${cap.total} total in window)`); return { error: cap.error, to: num }; }
  const dupe = pendingAsksFor(sessionId).find((a) => a.to === num && Date.now() - a.startedAt < 5 * 60 * 1000);
  if (dupe) {
    logger.warn(`ask call to ${num} already in flight for ${sessionId} (${dupe.askId}) — not dialling again`);
    return { in_progress: true, name: dupe.name, answer: '', note: `A call to ${name || 'them'} is ALREADY in progress — do not ring again. The outcome will arrive as a message; say nothing new to the caller about it.` };
  }

  const askId = `ask-${Math.random().toString(36).slice(2, 10)}`;
  pending.set(askId, { question: q, name: name || 'there', onBehalfOf: onBehalfOf || config.agentName, kind, redirected: dial.redirected, to: num, startedAt: Date.now(), sessionId });

  const answer = new Promise((resolve) => {
    // 13 Nov: the timeout is EMITTED on the topic (not just resolved here) so the conductor hears it
    // and hangs the leg up — a silently removed listener left a 7-minute zombie leg to the venue.
    const timer = setTimeout(() => { if (pending.has(askId)) resolveAsk(askId, { error: 'no answer within the time limit', timed_out: true }); }, timeoutMs);
    bus.once(topic(askId, 'answer'), (payload) => { clearTimeout(timer); pending.delete(askId); resolve({ name, to: num, redirected: dial.redirected, real: dial.redirected ? dial.real : undefined, ...payload }); }); // 17 Nov: the console shows the number
  });

  try {
    recordDial(sessionId);
    const created = await jambonz('POST', `/Accounts/${config.jambonz.accountSid}/Calls`, {
      application_sid: config.jambonz.applicationSid,
      from,
      to: { type: 'phone', number: num.replace(/^\+/, '') },
      tag: { mode: 'ask', askId, session: sessionId },
      timeout: 40,
      ...callOptions(),
      // 14 Nov: answering-machine detection — the first who-answered signal, at pickup
      // (amd_human_detected / amd_machine_detected / amd_tone_detected → /amd hook). PHONE_ASK_AMD=0 disables.
      ...(/^(0|false|off)$/i.test(process.env.PHONE_ASK_AMD || '') ? {} : { amd: { actionHook: '/amd', thresholdWordCount: 9, timers: { noSpeechTimeoutMs: 5000, decisionTimeoutMs: 15000, toneTimeoutMs: 20000, greetingCompletionTimeoutMs: 2000 } } })
    });
    const sid = created?.sid || created?.call_sid || '';
    if (sid) trackDial(sid, (st) => { if (pending.has(askId)) resolveAsk(askId, { error: describeDialFailure(st, num), rejected: true, sip: st.sip }); });
    logger.info(`ask call -> ${num} (askId ${askId}): "${q.slice(0, 70)}"${sid ? ` sid ${sid.slice(0, 8)}…` : ''}`);
  } catch (err) {
    bus.removeAllListeners(topic(askId, 'answer')); pending.delete(askId);
    return { error: `could not place the call: ${err.message}` };
  }
  return answer;
}
