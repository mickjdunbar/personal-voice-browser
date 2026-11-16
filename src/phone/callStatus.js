// 16 Nov 2026 (mick-agentic-browser): what happened to an OUTBOUND dial that never connected.
//
// A REST-created call only reaches our WebSocket once it is answered. When the carrier refuses
// the number (16 Nov: HCF's 13 number → SIP 403 on this trunk) nothing arrives at all, and the
// IVR mapper sat out a three-minute timeout before saying "no leg answered" — the real reason was
// invisible. jambonz will POST call-status webhooks for a call to `call_status_hook`, so every
// dial we place now asks for them at https://<PUBLIC_HOST>/api/jambonz/status and the waiting
// code (ask legs, map legs) is told the moment a dial fails, with the SIP cause in plain words.
import { config } from '../config.js';
import { emitEvent } from '../events.js';
import { jambonz } from '../jambonzApi.js';
import { createLogger } from '../logger.js';

const logger = createLogger('CallStatus');
const watchers = new Map(); // callSid -> { fn, at }
const FINAL = new Set(['completed', 'failed', 'busy', 'no-answer']);
const MAX_AGE_MS = 15 * 60 * 1000;

/** The webhook URL jambonz should post status to, or null when there is no public host (localhost dev). */
export function statusHookUrl() {
  const host = config.publicHost;
  if (!host || /^(localhost|127\.0\.0\.1)/.test(host)) return null;
  return `https://${host}/api/jambonz/status${config.wsSecret ? `?token=${encodeURIComponent(config.wsSecret)}` : ''}`;
}
/** Spread into a Create Call payload. */
export function callOptions() { const url = statusHookUrl(); return url ? { call_status_hook: url } : {}; }

/** Be told about status changes for one call sid. Returns the unwatch function. */
export function watchCallStatus(callSid, fn) {
  if (!callSid || typeof fn !== 'function') return () => {};
  const now = Date.now();
  for (const [k, w] of watchers) if (now - w.at > MAX_AGE_MS) watchers.delete(k);
  watchers.set(callSid, { fn, at: now });
  return () => watchers.delete(callSid);
}

/** A jambonz call-status webhook body → normalised status; dispatches to the watcher. */
export function onStatusWebhook(body = {}) {
  const st = {
    callSid: String(body.call_sid || ''),
    status: String(body.call_status || ''),
    sip: Number(body.sip_status) || 0,
    reason: String(body.sip_reason || ''),
    to: body.to != null ? String(body.to) : '',
    direction: body.direction || '',
    duration: body.duration != null ? Number(body.duration) : undefined
  };
  if (!st.callSid) return st;
  emitEvent('call.dial_status', null, { callSid: st.callSid, status: st.status, sip: st.sip || undefined, reason: st.reason || undefined, to: st.to ? st.to.replace(/\d(?=\d{3})/g, '•') : undefined });
  const w = watchers.get(st.callSid);
  if (w) {
    if (FINAL.has(st.status)) watchers.delete(st.callSid);
    try { w.fn(st); } catch (err) { logger.warn(`status watcher threw: ${err.message}`); }
  }
  return st;
}

/**
 * The belt to the webhook's braces: jambonz writes a refused dial to its call record (RecentCalls)
 * within a second — `answered:false, sip_status:403, termination_reason:'failed'` (measured 16 Nov:
 * 150 ms after the attempt) — while the webhook may never arrive. Poll that record for a short while
 * after every dial; the first FINAL verdict (webhook or record) wins, and an answered call stops
 * the polling (its leg reaches our WebSocket normally).
 */
const sipToStatus = (sip) => ([486, 600].includes(sip) ? 'busy' : [480, 408, 487].includes(sip) ? 'no-answer' : 'failed');
export async function pollDialOutcome(callSid, { everyMs = 3000, timeoutMs = 60000, firstMs = 1500, signal = null } = {}) {
  if (!callSid || !config.jambonz.accountSid) return null;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, firstMs));
  while (Date.now() - t0 < timeoutMs && !signal?.aborted) {
    try {
      const r = await jambonz('GET', `/Accounts/${config.jambonz.accountSid}/RecentCalls?page=1&count=30`);
      const list = r?.data || r?.calls || (Array.isArray(r) ? r : []);
      const c = list.find((x) => x.call_sid === callSid);
      if (c) {
        if (c.answered) return { callSid, status: 'in-progress', sip: Number(c.sip_status) || 200, answered: true };
        const sip = Number(c.sip_status) || 0;
        if (c.termination_reason || sip >= 400) return { callSid, status: sipToStatus(sip), sip, reason: c.termination_reason || '', from: 'record' };
      }
    } catch (err) { logger.warn(`recent-calls poll failed: ${err.message}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/**
 * Track one outbound dial: webhook watcher + record polling; `fn(st)` is called ONCE with the first
 * final verdict (failed / busy / no-answer). Returns a stop function.
 */
export function trackDial(callSid, fn, opts = {}) {
  if (!callSid) return () => {};
  let done = false;
  const ctl = { aborted: false };
  const finish = (st) => { if (done) return; done = true; ctl.aborted = true; unwatch(); try { fn(st); } catch (err) { logger.warn(`dial tracker threw: ${err.message}`); } };
  const unwatch = watchCallStatus(callSid, (st) => { if (FINAL.has(st.status) && st.status !== 'completed') finish(st); else if (st.status === 'in-progress' || st.status === 'completed') { ctl.aborted = true; } });
  pollDialOutcome(callSid, { ...opts, signal: ctl }).then((st) => { if (st && !st.answered) finish(st); }).catch(() => {});
  return () => { done = true; ctl.aborted = true; unwatch(); };
}

/** True for Australian 13 / 1300 / 1800 numbers — this trunk's carrier refuses them (SIP 403). */
export function isAuShortNumber(number) {
  const d = String(number || '').replace(/\D/g, '');
  return /^(61)?(13\d{4}|1300\d{6}|1800\d{6})$/.test(d) || /^0?(13\d{4}|1300\d{6}|1800\d{6})$/.test(d);
}
const SHORT_HINT = ' — this trunk cannot dial Australian 13 / 1300 / 1800 numbers; use the business\'s local landline instead';

/** A failed dial in plain words for the owner and the model. */
export function describeDialFailure(st = {}, number = '') {
  const short = isAuShortNumber(number);
  const sip = Number(st.sip) || 0;
  if (st.status === 'busy' || sip === 486 || sip === 600) return 'the line was busy';
  if (st.status === 'no-answer' || sip === 480 || sip === 408) return `nobody answered${short ? SHORT_HINT : ''}`;
  if (sip === 403) return `the carrier refused the call (SIP 403 Forbidden)${short ? SHORT_HINT : ' — the number may be barred on this trunk'}`;
  if ([404, 484, 604].includes(sip)) return `the number is not valid or not routable (SIP ${sip})${short ? SHORT_HINT : ''}`;
  if (sip === 503 || sip === 500) return `the carrier could not route the call (SIP ${sip})${short ? SHORT_HINT : ''}`;
  return `the call failed${st.status ? ` (${st.status}${sip ? `, SIP ${sip}${st.reason ? ' ' + st.reason : ''}` : ''})` : ''}${short ? SHORT_HINT : ''}`;
}

/** What to add to a blind timeout when no status ever arrived. */
export function timeoutHint(number) {
  return isAuShortNumber(number) ? ' — Australian 13 / 1300 / 1800 numbers are refused by this trunk\'s carrier; try the business\'s local landline' : '';
}
