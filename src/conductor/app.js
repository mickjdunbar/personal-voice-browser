// 2026-11-03 (mick-agentic-browser): the CONDUCTOR — a jambonz WebSocket
// application (ws.jambonz.org) mounted at /ws that blends two agents on one
// call:
//
//   config -> speech-to-speech (Gemini Live): greeting + small talk
//     -- the model calls browse_for_caller(request) -->
//   say(bridge line, same voice family) + agent(harness navigator, specialist
//     mode, handoff={request, summary, transcript})
//     -- the navigator emits `handback` on the in-process bus once the chat
//        turns light again (after its last reply has been SPOKEN) -->
//   speech-to-speech again, resumed with a summary of what was done.
//
// Lane swaps are `redirect` commands. Both halves run in this process, so the
// hand-off carries full context both ways and the caller hears one person.
//
// Call tag options: {mode:'cascaded'} skips S2S (harness only, like Studio);
// {session:'x'} binds the call to a console session other than 'main'.
import http from 'node:http';
import fs from 'node:fs';
import { createEndpoint } from '@jambonz/sdk/websocket';
import { config, audioUrl } from '../config.js';
import { bus, topic } from '../bus.js';
import { renderContext } from '../context.js';
import { emitEvent } from '../events.js';
import { configVerb, sayVerb, hangupVerb, s2sVerb, agentVerb, askS2sVerb, recognizer, BROWSE_TOOL_NAME, TASK_TOOL_NAME, ASK_FINISH_TOOL, ASK_OWNER_TOOL, ASK_REPORT_TOOL, RELAY_TOOL } from './verbs.js';
import { runIvrMapCall, ivrMapLegEnded } from '../phone/ivrmap.js'; // 14 Nov: IVR mapper legs (mode 'ivrmap')
import { getAsk, resolveAsk, pendingAsksFor } from '../phone/ask.js';
import { createDetector, postureFor, inboundPostureFor, priorFor, rememberVerdict, renderMenuTree } from '../phone/whoAnswered.js'; // 14 Nov: human / agent / IVR / voicemail read on ask legs + inbound callers
import { listIvrMaps, getIvrMap } from '../phone/ivrmap.js';
import { costOfRealtimeUsage } from '../llm/pricing.js';
import { completeText } from '../llm/client.js';
import { getSession } from '../agent/sessions.js';
import { textWriter } from '../agent/navigator.js';
import { HOST, pickSpecialist } from '../agent/team.js';
import { scoreSentiment, trendOf } from '../sentiment.js';
import { isChitChat } from '../llm/lanes.js';
import { foldTranscript, closeLine, noteSpeechStart, noteCommitted, noteTurnComplete } from './transcript.js'; // 16 Nov: pure + tested
import { ambience as ambienceSettings, changesSince, lastCallAt, markCallStart } from '../settings.js';
import { refineMood } from '../mood.js';
import { authorizeUpgrade, rejectUpgrade } from '../wsAuth.js';
import { getObservability } from '../observability/store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Conductor');
const BRIDGE_LINES = ['Sure, let me have a look at that.', 'Okay, let me pull that up.', 'Right, give me a sec and I will do that.'];
// Spoken (same TTS voice) the instant the specialist hands back, so Aria's return is never dead air
// while the speech-to-speech session re-establishes.
const RESUME_LINES = ['Okay, I\'m back with you. Anything else you\'d like to do?', 'Right, got that for you. What else can I help with?', 'There you go. Anything else on the web?'];

const calls = new Map();
const recent = [];

// 12 Nov: in-flight call transcripts are CHECKPOINTED to disk every few seconds and restored at
// boot as "socket closed" entries. When `node --watch` (or a crash) restarts the harness mid-call,
// jambonz re-dials the control socket under the same callSid and the resumed call then carries its
// real transcript instead of amnesia (take 3: a mid-take edit restarted the server and Aria came
// back with "ready to help… text or email?" while the caller heard silence).
const LIVE_FILE = process.env.LIVE_CALLS_FILE || '.live-calls.json';
try {
  const saved = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  const now = Date.now();
  for (const r of (saved.calls || [])) if (now - (r.saved_at || 0) < 120000 && r.transcript?.length) recent.unshift({ ...r, end_reason: 'socket closed', ended_at: now });
  if (recent.length) logger.info(`restored ${recent.length} in-flight call transcript(s) from ${LIVE_FILE} — a reconnect within 90 s resumes with context`);
} catch { /* nothing checkpointed */ }
function checkpointLive() {
  try {
    const live = [...calls.values()].filter((c) => c.mode !== 'ask' && c.transcript?.length)
      .map((c) => ({ call_sid: c.callSid, mode: c.mode, lane: c.lane, session: c.sessionId, from: c.from, to: c.to, direction: c.direction, started_at: c.startedAt, swaps: c.swaps, transcript: c.transcript.slice(-24), saved_at: Date.now() }));
    fs.writeFileSync(LIVE_FILE, JSON.stringify({ calls: live }));
  } catch (err) { logger.debug(`live checkpoint failed: ${err.message}`); }
}
const checkpointTimer = setInterval(checkpointLive, 4000);
if (checkpointTimer.unref) checkpointTimer.unref();

// Typed-input bridge: the console text box can drive a live voice call as if the caller spoke the
// line. The reply is spoken; the typed words are not. `registerHarnessInjector` wires in the
// harness server's injectText (set once at boot by app.js).
let harnessInject = null;
export function registerHarnessInjector(fn) { harnessInject = fn; }

// Which console session owns the NEXT call. A WebRTC call from the softphone carries no session tag
// of its own, so the console that starts the call "claims" the next one (over /ui) just before it
// dials; onSession consumes the claim so the call (and all its events) bind to THAT device's session
// — not every open console. Last writer wins; a stale claim (>60 s) is ignored.
let claimedCall = null; // { session, at }
export function claimNextCall(sessionId) { if (sessionId) claimedCall = { session: sessionId, at: Date.now() }; }
function takeClaimedSession() {
  const c = claimedCall; claimedCall = null;
  if (!c) return null;
  return Date.now() - c.at > 60000 ? null : c.session;
}

// Force-end the live call for a console session (the "Hang up" button / orb). Any console can end
// its own call authoritatively, even if the WebRTC leg is held by another device or the client-side
// hangup didn't take. cleanup() is idempotent, so a following socket-close is harmless.
export function hangupSession(sessionId = 'main') {
  const ctl = [...calls.values()].find((c) => c.sessionId === sessionId);
  if (!ctl) return { ok: false, reason: 'no live call for this session' };
  try { ctl.session.hangup().reply(); } catch { try { ctl.session.hangup(); } catch {} }
  cleanup(ctl, 'console hangup');
  return { ok: true, callSid: ctl.callSid };
}

// When a call is STARTED by a typed message (console: send-while-idle), that message is the caller's
// opening request. It's stashed here by session id before the call connects, then consumed in
// onSession so the greeting addresses it instead of a generic "what can I help with?".
const pendingIntents = new Map(); // sessionId -> { text, at }
export function setPendingIntent(sessionId = 'main', text = '') {
  const t = String(text || '').trim();
  if (t) pendingIntents.set(sessionId, { text: t, at: Date.now() });
}
function takePendingIntent(sessionId = 'main') {
  const p = pendingIntents.get(sessionId);
  if (!p) return '';
  pendingIntents.delete(sessionId);
  return Date.now() - p.at > 30000 ? '' : p.text; // ignore a stale intent (call never connected)
}
export async function injectCallerText(sessionId, text) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: 'empty' };
  // 1) Any live harness leg (a Studio custom-harness call, the cascaded lane, or the specialist half
  //    of a hybrid call): feed it there, so the pipeline answers and speaks just like a spoken turn.
  if (harnessInject) { const r = await harnessInject(sessionId, clean); if (r?.ok) return { ok: true, routed: 'specialist' }; }
  // 2) Hybrid call on the speech-to-speech host (Aria): record the typed line as a caller turn and
  //    hand to the specialist with it as the request — the browse_for_caller path, no spoken ask.
  const ctl = [...calls.values()].find((c) => c.sessionId === sessionId);
  if (!ctl) return { ok: false, error: 'no live call' };
  if (ctl.swapping) return { ok: false, error: 'busy' };
  ctl.transcript.push({ role: 'user', text: clean, closed: true, at: Date.now() });
  const s = scoreSentiment(clean);
  ctl.callerTurns = (ctl.callerTurns || 0) + 1;
  ctl.sentiment = [...(ctl.sentiment || []), s.score].slice(-40);
  emitEvent('caller.said', ctl.sessionId, { callSid: ctl.callSid, turn: ctl.callerTurns, text: clean, sentiment: s, trend: trendOf(ctl.sentiment), via: 'typed' });
  scheduleMoodRefine(ctl);
  // ONE VOICE: inject the typed line INTO Aria's Realtime leg so she hears it, responds in her own
  // voice, and calls browse_for_caller herself (→ background browse). The old swapToSpecialist put the
  // call on the cascaded Chirp leg = a SECOND voice + its own idle-watchdog hangup. Only fall back to
  // the swap when background browse is off.
  if (config.s2s.backgroundBrowse) { injectRealtimeUserText(ctl, clean); return { ok: true, routed: 'realtime' }; }
  swapToSpecialist(ctl, { request: clean, context: 'The caller typed this message instead of speaking it.' });
  return { ok: true, routed: 'swap' };
}

/** The caller took or released manual control of the browser screen — have Aria acknowledge it. */
export function notifyControl(sessionId, state) {
  const ctl = [...calls.values()].find((c) => c.sessionId === sessionId);
  if (!ctl) return { ok: false };
  const note = state === 'taken'
    ? "(The caller has just taken manual control of the browser screen to do something themselves. In one short, warm line, tell them to go ahead and that you'll wait — then stay quiet.)"
    // Handing back must RESUME the task, not ask permission (9 Nov: the booking just sat there
    // after the caller released control). The fresh look matters: the caller changed the page.
    : "(The caller has finished and handed the screen back to you. Say one short line that you're picking it back up, and IMMEDIATELY call browse_for_caller with: 'The caller just drove the page themselves and handed back — take a fresh look at the current page and carry on with the task that was in progress.' Do NOT ask whether to continue.)";
  injectRealtimeUserText(ctl, note);
  return { ok: true };
}

/** Relay an async background result (e.g. a phone answer) to the S2S host so it tells the caller in
 * its own voice. Framed as a background note so Aria relays it naturally rather than echoing verbatim. */
function injectRealtimeRelay(ctl, text) {
  injectRealtimeUserText(ctl, `(Background update from your colleague — tell the caller this now, naturally, in your own words: ${text})`);
}

/** Inject a caller text turn into the live speech-to-speech host so it responds in its own voice.
 * OpenAI Realtime: add a user conversation item, then ask for a response. google_s2s: client content.
 * A `response.create` while the model already has one in flight is FATAL — OpenAI rejects it
 * (conversation_already_has_active_response) and jambonz ends the whole verb on that error, which
 * is how background pushes used to kill Aria's leg mid-call. The conversation item is added at
 * once (always safe); the response.create is DEFERRED until response.done when the leg is busy. */
function injectRealtimeUserText(ctl, text, { respond = true } = {}) {
  try {
    if (config.s2s.vendor === 'openai') {
      ctl.session.updateLlm({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      // respond:false = a standing note the model reads on its NEXT turn, with no response forced now.
      // 13 Nov: the hold rules used to force a response, and Aria answered the note itself ("Hey there,
      // great to have you back") on top of the delegation line she was about to say.
      if (!respond) { logger.info(`call ${ctl.callSid}: injected standing note (no response)`); return; }
      if (ctl.s2sBusy) {
        ctl.injectPending = true;
        // Safety valve: if response.done never arrives (missed event), fire late anyway.
        clearTimeout(ctl.injectFallback);
        ctl.injectFallback = setTimeout(() => { if (ctl.injectPending) { ctl.injectPending = false; sendS2sResponseCreate(ctl); } }, 12000);
        logger.info(`call ${ctl.callSid}: injected item; response deferred (model busy)`);
      } else sendS2sResponseCreate(ctl);
    } else {
      ctl.session.updateLlm({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
    }
    logger.info(`call ${ctl.callSid}: injected typed text into ${config.s2s.vendor} s2s host`);
  } catch (err) { logger.warn(`call ${ctl.callSid}: inject realtime text failed: ${err.message}`); }
}

function sendS2sResponseCreate(ctl) {
  // 13 Nov (hero take): a deferred response.create fired 300 ms after response.done — by then the
  // caller had started talking and server VAD had already opened a new response, so OpenAI threw
  // conversation_already_has_active_response and jambonz tore the leg down ("glad to have you
  // back…"). Re-check at send time; if the model is busy again, defer once more instead.
  if (ctl.s2sBusy) {
    ctl.injectPending = true;
    clearTimeout(ctl.injectFallback);
    ctl.injectFallback = setTimeout(() => { if (ctl.injectPending) { ctl.injectPending = false; sendS2sResponseCreate(ctl); } }, 6000);
    logger.info(`call ${ctl.callSid}: response.create deferred again (model busy at send time)`);
    return;
  }
  // Busy from THIS moment: OpenAI's response.created lands a beat later, and a tool output sent in
  // that gap (a 2 s fast-lane phone request vs the 1.5 s "on it" nudge — takes 1 and 4) collides →
  // conversation_already_has_active_response → leg restart.
  try { ctl.session.updateLlm({ type: 'response.create' }); ctl.s2sBusy = true; } catch (err) { logger.warn(`call ${ctl.callSid}: response.create failed: ${err.message}`); }
}

/** Resolve once the Realtime leg has no response in flight (or after maxMs). A tool output triggers
 * its own response.create inside jambonz, which is fatal while one is active — so anything that may
 * have just made Aria speak (the "on it" ack) waits here before the result is handed back. */
function awaitS2sIdle(ctl, maxMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (!ctl.s2sBusy || Date.now() - t0 > maxMs || !calls.has(ctl.callSid)) resolve(); else setTimeout(tick, 120); };
    tick();
  });
}

export const recentConductorCalls = () => [...recent];
export const liveConductorCalls = () => [...calls.values()].map((c) => ({ call_sid: c.callSid, mode: c.mode, lane: c.lane, session: c.sessionId, from: c.from, to: c.to, direction: c.direction, swaps: c.swaps, started_at: c.startedAt }));

function sdkLogger() {
  const l = createLogger('jambonz-sdk');
  const fmt = (o, m) => (typeof o === 'string' ? o : `${m || ''} ${JSON.stringify(o)}`);
  const api = { info: (o, m) => l.info(fmt(o, m)), debug: (o, m) => l.debug(fmt(o, m)), warn: (o, m) => l.warn(fmt(o, m)), error: (o, m) => l.error(fmt(o, m)), trace: () => {}, fatal: (o, m) => l.error(fmt(o, m)), child: () => api };
  return api;
}

export function createConductor({ path = '/ws' } = {}) {
  const inner = http.createServer();
  const makeService = createEndpoint({ server: inner, logger: sdkLogger() });
  const svc = makeService({ path });
  svc.on('session:new', onSession);
  svc.on('error', (err) => logger.error(`endpoint error: ${err.message}`));
  logger.info(`conductor mounted at ${path}`);
  return {
    service: svc,
    handleUpgrade(req, socket, head) {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
      if (!authorizeUpgrade(req, config.wsSecret)) { logger.warn(`rejected unauthorised upgrade on ${pathname}`); rejectUpgrade(socket); return true; }
      inner.emit('upgrade', req, socket, head);
      return true;
    }
  };
}

async function onSession(session) {
  const { callSid, from, to, direction } = session;
  const tag = (session.data?.customerData && typeof session.data.customerData === 'object') ? session.data.customerData : {};
  const mode = tag.mode === 'cascaded' ? 'cascaded' : tag.mode === 'ask' ? 'ask' : tag.mode === 'ivrmap' ? 'ivrmap' : 'hybrid';
  // Which console session owns this call? A WebRTC softphone call carries an `X-Session` INVITE header
  // (jambonz surfaces custom X-* headers here) = the device that dialed — deterministic. Fall back to
  // customerData (REST-created ask calls), then the side-channel claim, then 'main'.
  const headerSession = (() => {
    const h = session.data?.sip?.headers;
    if (!h || typeof h !== 'object') return '';
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-session') return String(h[k] || '').trim();
    return '';
  })();
  const claimed = takeClaimedSession(); // consume unconditionally so a stale claim can't bind a later call
  const ownerSession = tag.session || headerSession || claimed || 'main';
  // 16 Nov: WEB CLIENT = the softphone on the Personal Voice Browser page. It tags its INVITE with
  // X-Client: pvb-web (and X-Session); that tag — not the "app-" prefix of the dialled number — is what
  // lets Talk Settings be changed on this call (agent/webClient.js). PSTN and REST-placed calls never carry it.
  const xClient = (() => { const h = session.data?.sip?.headers; if (!h || typeof h !== 'object') return ''; for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-client') return String(h[k] || '').trim(); return ''; })();
  const webClient = direction === 'inbound' && mode !== 'ask' && mode !== 'ivrmap' && (xClient === 'pvb-web' || Boolean(headerSession));
  // An ASK call (outbound side-call to a person/IVR) gets its OWN session id: if it shared the
  // owner's, its call.start/call.end and transcript events would corrupt the owner console's
  // in-call state (cost baseline, orb, captions) and collide in session-keyed lookups.
  const ctl = { callSid, from, to, direction, session, webClient, sessionId: mode === 'ask' ? `ask:${callSid}` : mode === 'ivrmap' ? `ivrmap:${callSid}` : ownerSession, ownerSession, mode, lane: null, swaps: 0, startedAt: new Date().toISOString(), startedMs: Date.now(), events: [], transcript: [], swapping: false };
  calls.set(callSid, ctl);
  // ngrok (and some LBs) silently drop an IDLE control websocket — 10 Nov: two mid-call "socket
  // closed" drops, each re-greeting the caller from scratch and orphaning in-flight work. The
  // jambonz SDK never pings, so keep the pipe warm ourselves.
  const keepalive = setInterval(() => { try { session.ws?.ping?.(); } catch { /* closing */ } }, 20000);
  session.on('close', () => { clearInterval(keepalive); cleanup(ctl, 'socket closed'); });
  session.on('call:status', (evt) => { emitEvent('call.status', ctl.sessionId, { callSid, status: evt.call_status, duration: evt.duration }); if (['completed', 'failed', 'busy', 'no-answer'].includes(evt.call_status)) cleanup(ctl, `${evt.call_status}`); });
  session.on('jambonz:error', (evt) => { note(ctl, 'jambonz:error', evt); logger.error(`call ${callSid} jambonz:error ${JSON.stringify(evt)}`); });
  session.on('/agent-event', (evt) => onAgentEvent(ctl, evt));
  session.on('/agent-done', (evt) => {
    note(ctl, 'agent-done', evt);
    logger.info(`call ${callSid}: agent verb ended (${evt.completion_reason || 'n/a'})`);
    // Do NOT hang up when the agent verb ended because we redirected it — to the s2s host on a
    // hand-back, or to a fresh specialist. The redirect can take ~2 s, longer than the `swapping`
    // window, so the reliable signal is the lane: if we are back on (or heading to) s2s, the host
    // has the call now; only a genuine end on the cascaded/specialist lane should hang up.
    if (ctl.swapping || ctl.lane === 's2s' || evt.completion_reason === 'application_redirect') return;
    session.hangup().reply();
  });
  if (direction === 'inbound' && mode !== 'ask' && mode !== 'ivrmap') ctl.who = createDetector({ kind: 'inbound', to: from, prior: priorFor(from) }); // 14 Nov: who is CALLING (person or an agent acting for one)
  emitEvent('call.start', ctl.sessionId, { callSid, from, to, direction, mode: ctl.mode, ownerSession: ctl.ownerSession, startedAt: ctl.startedAt, webClient });
  // 16 Nov: an owner call opens with "what changed in Talk Settings since your last call" (console card).
  if (mode !== 'ask' && mode !== 'ivrmap') {
    const since = changesSince(lastCallAt());
    markCallStart();
    if (since.length) emitEvent('settings.since_last_call', ctl.sessionId, { callSid, since_ts: lastCallAt(), changes: since.slice(-12) });
  }
  getObservability().event(ctl.sessionId, 'call.start', { callSid, from, to, direction, mode: ctl.mode }).catch(() => {});

  if (ctl.mode === 'ask') { runAskCall(ctl, tag.askId); return; }
  if (ctl.mode === 'ivrmap') { runIvrMapCall(ctl, tag); return; } // 14 Nov: menu-mapping leg — listen, press, hang up

  if (ctl.mode === 'cascaded') {
    ctl.lane = 'cascaded';
    session.addVerbs([configVerb(), agentVerb({ metadata: {}, greeting: true, session: ctl.sessionId })]).send();
    setTimeout(() => startAmbience(ctl), 1200);
    return;
  }
  // Hybrid: speech-to-speech first.
  session.on('/s2s-tool', (evt) => onS2sTool(ctl, evt));
  session.on('/s2s-event', (evt) => onS2sEvent(ctl, evt));
  session.on('/s2s-done', (evt) => onS2sDone(ctl, evt));
  bus.on(topic(callSid, 'handback'), (payload) => onHandback(ctl, payload));
  ctl.lane = 's2s';
  ctl.sentiment = [];
  // If this call was started by a typed message, that's the caller's opening request — greet AND act
  // on it, rather than asking what they want (they already told us).
  const opening = takePendingIntent(ctl.sessionId);
  if (opening) ctl.transcript.push({ role: 'user', text: opening, closed: true, at: Date.now() });
  // jambonz re-dials our ws under the SAME callSid when the control socket drops mid-call. That's a
  // reconnect, not a new call: carry the transcript over and resume instead of greeting from scratch.
  const prior = recent.find((r) => r.call_sid === callSid && r.end_reason === 'socket closed' && Date.now() - (r.ended_at || 0) < 90000);
  if (prior?.transcript?.length) ctl.transcript.push(...prior.transcript.map((t) => ({ ...t, closed: true })));
  emitEvent('lane.swap', ctl.sessionId, { callSid, lane: 's2s', why: prior ? 'reconnected' : 'call start', model: config.s2s.model, voice: config.s2s.voice });
  emitEvent('speaker', ctl.sessionId, { callSid, agent: { id: HOST.id, name: HOST.name, title: HOST.title, color: HOST.color, role: 'host' }, lane: 's2s' });
  session.addVerbs([configVerb(), s2sVerb({ callerContext: renderContext(ctl.sessionId), opening, ...(prior ? { resume: { reconnect: true }, transcript: ctl.transcript } : {}) })]).send();
  setTimeout(() => startAmbience(ctl), 1200);
}

// ---- atmosphere: looping audio beds mixed UNDER the live call ---------------------
// jambonz `dub` tracks are call-level, independent of the verb running on top, so they
// survive the lane swaps and give the caller a quiet room tone plus typing while a
// specialist works — no more dead air. Injected (not queued) so a dub that an older
// feature server does not understand can never break the conversation.
/** 15 Nov: the mix level for this leg. A WebRTC caller (browser → jambonz, `to` = app-…) hears the
 *  dub at full level with no codec loss, so the same gain sounded far louder than on a phone line;
 *  trim it by AMBIENCE_WEBRTC_TRIM_DB (default -8 dB) there. */
function legGain(ctl, base) {
  const n = parseFloat(String(base));
  if (!Number.isFinite(n)) return base;
  const trim = (ctl?.webClient || /^app-/i.test(String(ctl?.to || ''))) ? ambienceSettings().webrtcTrimDb : 0;
  return `${Math.round(n + trim)} dB`;
}
function dubCmd(ctl, data, why) {
  if (!ambienceSettings().enabled) return;
  if (data.gain != null) data = { ...data, gain: legGain(ctl, data.gain) };
  try { ctl.session.injectCommand('dub', data); emitEvent('ambience', ctl.sessionId, { callSid: ctl.callSid, action: data.action, track: data.track, why }); }
  catch (err) { logger.warn(`call ${ctl.callSid}: dub ${data.action}/${data.track} failed: ${err.message}`); }
}
function startAmbience(ctl) {
  const bed = audioUrl(config.ambience.bedFile);
  const typing = audioUrl(config.ambience.typingFile);
  const hold = audioUrl(config.ambience.holdFile);
  if (!ambienceSettings().enabled || !bed) { if (ambienceSettings().enabled && !bed) logger.warn(`call ${ctl.callSid}: ambience on but PUBLIC_HOST unset — the feature server cannot fetch the audio, skipping`); return; }
  ctl.ambience = { bed, typing, hold };
  dubCmd(ctl, { action: 'addTrack', track: 'bed' }, 'call start');
  dubCmd(ctl, { action: 'addTrack', track: 'typing' }, 'call start');
  dubCmd(ctl, { action: 'addTrack', track: 'hold' }, 'call start');
  dubCmd(ctl, { action: 'playOnTrack', track: 'bed', play: bed, loop: true, gain: ambienceSettings().bedGain }, 'room tone');
}
/** Typing clatter while a specialist works the browser (on at hand-off, off at hand-back). */
function workingAudio(ctl, on) {
  if (!ctl?.ambience) return;
  if (on) dubCmd(ctl, { action: 'playOnTrack', track: 'typing', play: ctl.ambience.typing, loop: true, gain: ambienceSettings().typingGain }, 'specialist working');
  else dubCmd(ctl, { action: 'silenceTrack', track: 'typing' }, 'handed back');
}
/** Warm hold pad on the CALLER's leg for as long as an outbound call runs on their behalf (12 Nov). */
function holdAudio(ctl, on) {
  if (!ctl?.ambience?.hold) return;
  if (on) dubCmd(ctl, { action: 'playOnTrack', track: 'hold', play: ctl.ambience.hold, loop: true, gain: ambienceSettings().holdGain }, 'outbound call in progress');
  else dubCmd(ctl, { action: 'silenceTrack', track: 'hold' }, 'outbound call finished');
}
const ownerLegOf = (askCtl) => [...calls.values()].find((c) => c.mode !== 'ask' && c.sessionId === (askCtl.ownerSession || ''));

// ---- phone a person OR navigate a business's phone menu (outbound "ask" call) ------
// The call can reach a PERSON (ask the question, capture the answer) OR an automated DTMF IVR
// ("press 1 for sales…"). We LISTEN first, then an LLM decides the single next action each round —
// press a key, say something and listen, keep listening, or we're done — so the agent can work
// through a menu on the caller's behalf and still bring back the answer. Everything it presses or
// says is surfaced to the console feed.
const MAX_IVR_STEPS = 10;

function askGather(ctl, { say = '', timeout = 13 } = {}) {
  const v = { verb: 'gather', input: ['speech'], actionHook: '/ask-step', timeout, bargein: false, recognizer: recognizer() };
  if (say) v.say = { text: say };
  return v;
}

function runAskCall(ctl, askId) {
  const { session, callSid } = ctl;
  const ask = getAsk(askId) || { question: 'a quick question', name: 'there', onBehalfOf: config.agentName };
  ctl.askId = askId;
  ctl.ivr = { goal: ask.question, name: ask.name, onBehalfOf: ask.onBehalfOf || config.agentName, kind: ask.kind, opener: buildAskIntro(ask), steps: 0, heard: [], said: [] };
  session.on('/ask-step', (evt) => onAskStep(ctl, evt));
  // WHO ANSWERED (14 Nov): score the pickup from AMD + the first utterances; the verdict sets Aria's
  // posture (human pace / full brief to an agent / keys for a menu / message for voicemail).
  const prior = priorFor(ask.to, { maps: listIvrMaps() });
  ctl.who = createDetector({ kind: ask.kind, to: ask.to, prior });
  if (prior?.mapId) {
    // A mapped menu: the gather loop can choose keys from the tree instead of listening its way down.
    const tree = renderMenuTree(getIvrMap(prior.mapId));
    if (tree) { ctl.ivr.mapHint = tree; logger.info(`call ${callSid}: known menu for this number (map ${prior.mapId}) — key paths available`); }
  }
  session.on('/amd', (evt) => { const type = evt?.type || evt?.event || ''; note(ctl, 'amd', evt); logger.info(`call ${callSid}: AMD ${type}`); emitEvent('phone.amd', ctl.ownerSession || ctl.sessionId, { callSid, type }); applyWho(ctl, ctl.who.observe({ type: 'amd', result: type })); });
  emitEvent('phone.ask', ctl.ownerSession || ctl.sessionId, { callSid, askId, to: ask.to, name: ask.name, question: ask.question });
  // Tell the HOST on the owner's leg how to behave while this call runs (12 Nov): the old
  // behaviour was a "hang tight / nearly there" filler every few seconds, which the person
  // holding answered each time until they hung up in frustration. Rules: no progress
  // narration, no repeated reassurance — quiet, or light small talk, until the outcome lands.
  const ownerLeg = ownerLegOf(ctl);
  // Remember who is being rung, so a follow-up that lands after the line has dropped can ring them back.
  if (ownerLeg) ownerLeg.lastAsk = { name: ask.name, to: ask.to, question: ask.question, kind: ask.kind, onBehalfOf: ask.onBehalfOf, outcome: '' };
  // Atmosphere on the caller's leg for the whole outbound call: the hold pad comes on now and
  // goes off the moment the ask resolves (answer, timeout, or the leg dying — all land on this topic).
  if (ownerLeg) { holdAudio(ownerLeg, true); bus.once(topic(askId, 'answer'), () => holdAudio(ownerLeg, false)); }
  // 13 Nov (hero take 3): an ask leg that timed out (7 min, no audio) stayed connected to the far end
  // for ever. Whatever resolves the ask — outcome, error or timeout — the leg is torn down: at once on
  // an error/timeout, after a short grace (goodbye) on a reported outcome.
  bus.once(topic(askId, 'answer'), (payload) => {
    const grace = payload?.timed_out || payload?.error ? 1500 : 25000;
    // 13 Nov (cross-call follow-ups): the outcome is NOT the end of the venue leg — the caller may
    // send a follow-up back through Aria ("ask them for a window table") and wait for the answer.
    // So the teardown re-arms while the leg is waiting on the owner (awaitingRelay) or a relay
    // just went down the line, up to a hard ceiling after the first outcome.
    const ceilingAt = Date.now() + Number(process.env.PHONE_ASK_FOLLOWUP_MAX_MS || 150000);
    const tick = () => {
      if (!calls.has(ctl.callSid)) return;
      const busy = ctl.awaitingRelay || ctl.relayPending || (ctl.lastRelayAt && Date.now() - ctl.lastRelayAt < 30000);
      if (busy && Date.now() < ceilingAt) { setTimeout(tick, 10000); return; }
      logger.warn(`call ${callSid}: ask leg still up after the ask resolved (${busy ? 'follow-up ceiling reached' : 'nothing pending'}) — hanging it up`);
      try { ctl.session.hangup().send(); } catch { /* already down */ }
      setTimeout(() => { if (calls.has(ctl.callSid)) cleanup(ctl, 'ask resolved'); }, 4000);
    };
    setTimeout(tick, grace);
  });
  // A STANDING note (no forced response): the delegation line itself reaches Aria as the browse
  // result; these rules just govern what she does from her next turn on.
  if (ownerLeg) injectRealtimeUserText(ownerLeg, `(Standing note — do not reply to this. One of your team is now on the phone to ${ask.name || 'them'} on the caller's behalf. If you have not yet told the caller, say it ONCE when you next speak: "I've handed that to one of my team to ring them — I'll let you know the moment I hear back." WHILE IT RUNS: you have said everything there is to say about it — no progress updates and no lines about how long it will take or that an answer is coming; such a line, once said, is never repeated. If the caller asks whether they've answered yet, answer honestly in one short line ("not yet — still ringing" / "they're talking now"). If the caller says they'll hold, acknowledge in three words or fewer ONCE. If the caller merely acknowledges something ("ok", "no worries", "thanks", "sounds good"), reply with two words at most ("No worries." / "Yep.") and nothing about the errand. Then stay comfortably quiet — a hold with a bit of silence is fine. Small talk is optional and SMALL: at most ONE casual question for the whole hold (how their week is going, the weather or storms tonight, weekend plans); when they answer, respond in a few warm words WITHOUT another question, and let the silence sit. Never chain questions. Keep anything you say OPEN-ENDED: never a line that sounds like wrapping up or signing off ("fingers crossed", "anyway", "take care", "have a good one") — the caller must never think the call is ending; it is not, the errand is still in progress. Never ask them to re-confirm the request. The outcome will arrive as a message: deliver it the moment it does, and in the same breath — because your colleague still has them on the line — ask whether there's anything the caller wants asked or passed on to them ("Table's confirmed for four at 6:45, reference RB1234 — anything you'd like me to ask them while I've got them?"). If the caller does have something, call ${RELAY_TOOL} with it, tell them once that you're passing it on, and wait quietly — their answer comes back as another message; deliver it, and ask once more if there's anything else for them. Only when the caller says they need nothing more from the venue do you move to the next step ("want me to pop it in your calendar?").)`, { respond: false });
  // ALL ask calls run speech-to-speech (Realtime) when available — same voice as the main
  // call, natural latency. 12 Nov: business calls used to stay on the gather→LLM→say loop
  // (a different, slower TTS voice); now only PHONE_ASK_BUSINESS_MODE=cascaded keeps that
  // DTMF-capable loop for IVR-heavy targets. PHONE_ASK_S2S=0 turns the fast path off entirely.
  const businessCascaded = ask.kind === 'business' && /^cascaded$/i.test(process.env.PHONE_ASK_BUSINESS_MODE || '');
  if (config.phoneAsk.s2s && !businessCascaded && config.s2s.vendor === 'openai') {
    ctl.lane = 'ask-s2s';
    session.on('/ask-s2s-tool', (evt) => onAskS2sTool(ctl, evt));
    session.on('/ask-s2s-event', (evt) => onAskS2sEvent(ctl, evt));
    session.on('/ask-s2s-done', (evt) => onAskS2sDone(ctl, evt));
    logger.info(`call ${callSid}: ask-mode on S2S (${config.s2s.model}), goal="${String(ask.question).slice(0, 80)}"`);
    session.addVerbs([configVerb(), askS2sVerb(ask)]).send();
    return;
  }
  ctl.lane = 'ask';
  logger.info(`call ${callSid}: ask-mode (IVR-aware gather), goal="${String(ask.question).slice(0, 80)}"`);
  // Listen FIRST so we don't talk over an automated menu — whoever/whatever answers (a human "hello?"
  // or the start of an IVR prompt) is captured, then the first /ask-step decides what to do.
  session.addVerbs([configVerb(), askGather(ctl, { timeout: 10 })]).send();
}

// ---- S2S ask leg: Realtime model talks to the person; finish_call reports the answer --------
function onAskS2sTool(ctl, evt) {
  const { callSid } = ctl;
  const fn = evt.function_calls?.[0] || evt.functionCalls?.[0] || {};
  const name = fn.name || evt.name || evt.function_name || evt.tool_name;
  const callId = evt.tool_call_id || evt.call_id || evt.id;
  let args = fn.args ?? evt.arguments ?? evt.args ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { answer: args }; } }
  logger.info(`call ${callSid}: ask s2s tool ${name}(${JSON.stringify(args).slice(0, 140)})`);
  // The person on the line asked something only the owner can answer: pass it to the OWNER's live
  // console call (Aria asks the caller out loud), keep THIS call open, and wait for relay_to_callee.
  if (name === ASK_OWNER_TOOL) {
    const q = String(args.question || '').trim() || 'they have a question for you';
    const ask = getAsk(ctl.askId) || {};
    const owner = [...calls.values()].find((c) => c.mode !== 'ask' && c.sessionId === (ctl.ownerSession || ''));
    emitEvent('phone.relay', ctl.ownerSession || ctl.sessionId, { callSid, direction: 'question', name: ask.name, text: q });
    if (!owner) {
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: `${ask.onBehalfOf || 'the owner'} is not on the line right now, so the question cannot be answered on this call`, note: 'Tell them you will pass the question on, and wrap up what you can without it.' } });
      return;
    }
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true, note: 'Question passed on — the answer will arrive here as a message. Tell them it will just be a moment, and stay on the line.' } });
    ctl.awaitingRelay = true;
    injectRealtimeUserText(owner, `(Your colleague is on the phone with ${ask.name || 'the person'} RIGHT NOW, and ${ask.name || 'they'} asks: "${q}". Say this to the caller and get their answer out loud. The MOMENT the caller answers, call ${RELAY_TOOL} with that answer — the tool is what delivers it, saying it aloud is not enough.)`);
    return;
  }
  // Goal reached: carry the outcome to the owner while the far end is STILL on the line, so a
  // follow-up can go back on the SAME call ("ask him about Saturday too") instead of a redial.
  // The ask promise resolves here (not at hangup) — flagged `relayed` when the owner hears it
  // live, so the navigator records the answer without announcing it a second time.
  if (name === ASK_REPORT_TOOL) {
    const outcome = String(args.outcome || args.answer || '').trim();
    const ask = getAsk(ctl.askId) || {};
    // 13 Nov (retake 2): handed a relayed follow-up ("ask them for a window table"), the Realtime
    // model called report_outcome ONE SECOND later with the request itself — it never put the
    // question to the venue, and the owner heard "they've got your request". A follow-up outcome is
    // only accepted once the far end has actually spoken since the relay arrived.
    if (ctl.relayPending && !((ctl.lastFarEndAt || 0) > ctl.relayPending.at)) {
      logger.info(`call ${callSid}: report_outcome rejected — ${ask.name || 'the far end'} has not answered the relayed follow-up yet`);
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: `NOT YET — ${ask.name || 'they'} have not answered this. You have not asked them. SAY IT TO THEM NOW, out loud, in your own words: "${ctl.relayPending.text}". Then wait for THEIR reply, and only then call ${ASK_REPORT_TOOL} with what THEY said.` } });
      return;
    }
    ctl.relayPending = null;
    const owner = [...calls.values()].find((c) => c.mode !== 'ask' && c.sessionId === (ctl.ownerSession || ''));
    emitEvent('phone.relay', ctl.ownerSession || ctl.sessionId, { callSid, direction: 'outcome', name: ask.name, text: outcome });
    { const o = ownerLegOf(ctl); if (o?.lastAsk) o.lastAsk.outcome = outcome; }
    if (!ctl.askResolved && outcome) {
      if (ctl.who) applyWho(ctl, ctl.who.finalize(), { final: true });
      ctl.askResolved = true;
      // The leg's transcript rides on the event so the console/recap can show the whole outbound conversation.
      emitEvent('phone.answer', ctl.ownerSession || ctl.sessionId, { callSid, askId: ctl.askId, answer: outcome, name: ask.name, reached: 'person', answered_by: ctl.whoKind || null, transcript: ctl.transcript.slice(-24).map((t) => ({ role: t.role === 'assistant' ? 'aria' : 'them', text: t.text })) });
      resolveAsk(ctl.askId, { answer: outcome, relayed: Boolean(owner), transcript: ctl.transcript.slice(-10).map((t) => `${t.role === 'assistant' ? 'Me' : 'Them'}: ${t.text}`).join(' | ') });
    }
    if (!owner) {
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true, note: `${ask.onBehalfOf || 'The owner'} isn't on a live call — the outcome has been passed on as a message and no follow-ups will come. Wrap up now: a warm goodbye, then ${ASK_FINISH_TOOL}.` } });
      return;
    }
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true, note: `Passed to ${ask.onBehalfOf || 'the owner'} — their reply will arrive here as a message. Say ONCE "just a moment while I check back with ${ask.onBehalfOf || 'them'}", then wait: if ${ask.name || 'they'} says "take your time" or "no worries", answer with at most two words ("Cheers.") or nothing at all — nothing further about the wait; a quiet line is fine. If the reply says nothing more is needed, say a warm goodbye and call ${ASK_FINISH_TOOL}. If ${ask.name || 'the person'} needs to go before it arrives, let them go warmly and call ${ASK_FINISH_TOOL}.` } });
    ctl.awaitingRelay = true;
    owner.lastOutcomeAt = Date.now(); // a wrap-up relay is only real once the caller has spoken after this
    injectRealtimeUserText(owner, `(Your colleague is STILL ON THE PHONE with ${ask.name || 'the person'} and reports the outcome: "${outcome}". Tell the caller now, naturally, and ask if there's anything else they'd like asked or passed on while ${ask.name ? ask.name + ' is' : "they're"} still on the line. When the caller responds, call ${RELAY_TOOL} with it — a follow-up to ask, or that the caller needs nothing more (e.g. "that's everything, thanks") so the call can wrap up. The tool is what delivers it.)`);
    return;
  }
  if (name !== ASK_FINISH_TOOL) {
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: `unknown tool ${name}` } });
    return;
  }
  sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true } }); // no note: the model read "the call is ending now" aloud (13 Nov)
  ctl.askFinished = true;
  const owner = ownerLegOf(ctl); if (owner) owner.lastAskEndedAt = Date.now();
  const answer = String(args.answer || '').trim();
  const reached = String(args.reached || 'person');
  emitAskTranscript(ctl, answer);
  if (!ctl.askResolved) {
    if (ctl.who) applyWho(ctl, ctl.who.finalize(), { final: true });
    ctl.askResolved = true;
    const ask = getAsk(ctl.askId) || {};
    emitEvent('phone.answer', ctl.ownerSession || ctl.sessionId, { callSid, askId: ctl.askId, answer, name: ask.name, reached, answered_by: ctl.whoKind || null });
    resolveAsk(ctl.askId, answer
      ? { answer, transcript: ctl.transcript.slice(-10).map((t) => `${t.role === 'assistant' ? 'Me' : 'Them'}: ${t.text}`).join(' | ') }
      : { error: reached === 'voicemail' ? 'voicemail answered — I left a short message' : reached === 'ivr' ? 'an automated phone menu answered, not a person' : 'no clear answer was obtained on the call', answer: '' });
  }
  // Give any closing audio a moment to play out, then end the call.
  setTimeout(() => { try { ctl.session.hangup().send(); } catch { /* already down */ } }, 3000);
}

/** Meter the Realtime leg: OpenAI's response.done carries full token usage (text/audio split).
 * The S2S spend was invisible before — a chat-only call showed "call cost $0.0000". */
function meterS2sResponse(ctl, evt) {
  const usage = evt?.response?.usage || evt?.usage;
  if (!usage || typeof usage !== 'object') {
    if (!ctl.s2sUsageMissing) { ctl.s2sUsageMissing = true; logger.info(`call ${ctl.callSid}: response.done carries no usage — realtime leg unmetered`); }
    return;
  }
  const usd = costOfRealtimeUsage(config.s2s.model, usage);
  if (!(usd > 0)) return;
  ctl.s2sUsd = (ctl.s2sUsd || 0) + usd;
  // Ask side-calls bill to the OWNER's console (they are part of that session's errand).
  emitEvent('s2s.cost', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, usd, usd_call: ctl.s2sUsd, model: config.s2s.model });
}

function onAskS2sEvent(ctl, evt) {
  const t = evt?.type || evt?.event || '';
  // Track the response lifecycle here too: relayed answers are INJECTED into this leg, and a
  // response.create while the model is mid-response kills the whole verb (same rule as the main leg).
  if (t === 'response.created') ctl.s2sBusy = true;
  if (/^input_audio_buffer\.(speech_started|committed)$/.test(t)) ctl.s2sBusy = true;
  // 13 Nov (take 4): the far end's ANSWER is heard by the model before Whisper's transcript of it
  // arrives — the relay guard rejected a legitimate report_outcome as "they haven't answered". VAD
  // is real-time: their speech ending is the fact we need.
  if (/^input_audio_buffer\.(speech_stopped|committed)$/.test(t)) ctl.lastFarEndAt = Date.now();
  if (t === 'input_audio_buffer.speech_started') ctl.farStartAt = Date.now();
  if (t === 'response.done') {
    ctl.s2sBusy = false;
    meterS2sResponse(ctl, evt);
    if (ctl.injectPending) { ctl.injectPending = false; clearTimeout(ctl.injectFallback); setTimeout(() => sendS2sResponseCreate(ctl), 300); }
  }
  if (/error/i.test(t) || evt?.error) {
    const e = evt?.error || evt;
    logger.warn(`call ${ctl.callSid}: ask s2s error — ${e?.code || ''} ${e?.message || JSON.stringify(e).slice(0, 200)}`);
    note(ctl, 'ask-s2s-error', evt);
    return;
  }
  const found = evt?.transcript ? { text: evt.transcript, role: /input/i.test(t) ? 'user' : 'assistant' } : findTranscription(evt);
  if (!found || !String(found.text).trim()) return;
  const { text, role } = found;
  const last = ctl.transcript.at(-1);
  if (last && last.role === role) last.text += text; else ctl.transcript.push({ role, text });
  const full = ctl.transcript.at(-1).text;
  // Surface the far-end conversation in the owner's console using the existing phone rows.
  if (role === 'user') {
    ctl.lastFarEndAt = Date.now(); ctl.ivr.heard[Math.max(0, ctl.transcript.length - 1)] = full;
    emitEvent('phone.ivr', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, step: ctl.ivr.steps += 0, heard: full.slice(0, 180) });
    // How long after Aria finished did they START speaking (speech_started), not when the transcript landed.
    const sinceSaidMs = ctl.lastAriaSaidAt && ctl.farStartAt ? Math.max(0, ctl.farStartAt - ctl.lastAriaSaidAt) : null;
    const durationMs = ctl.farStartAt && ctl.lastFarEndAt > ctl.farStartAt ? ctl.lastFarEndAt - ctl.farStartAt : null;
    if (ctl.who) applyWho(ctl, ctl.who.observe({ type: 'heard', text, sinceSaidMs, durationMs }));
  } else {
    ctl.lastAriaSaidAt = Date.now();
    if (ctl.who) ctl.who.observe({ type: 'said', text });
    emitEvent('phone.ivr_action', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, step: ctl.ivr.steps, action: 'say', say: full.slice(0, 140) });
  }
}

function onAskS2sDone(ctl, evt) {
  note(ctl, 'ask-s2s-done', evt);
  if (ctl.askResolved) return;
  if (ctl.whoRedirected) { logger.info(`call ${ctl.callSid}: s2s leg ended by the IVR switch — gather loop already running`); return; }
  // The S2S leg died before finish_call (connect error, model hangup, far-end oddity). Fall back
  // to the classic gather loop on the SAME live call so the errand still completes.
  logger.warn(`call ${ctl.callSid}: ask s2s ended without an answer (${evt.completion_reason || 'n/a'}) — falling back to gather loop`);
  ctl.lane = 'ask';
  try { ctl.session.addVerbs([askGather(ctl, { say: ctl.transcript.length ? '' : ctl.ivr.opener, timeout: 12 })]).reply(); }
  catch (err) { logger.warn(`call ${ctl.callSid}: ask fallback failed: ${err.message}`); finishAsk(ctl, ''); }
}

/** Decide the next move on an ask call from everything heard so far. Returns a decision object. */
async function decideIvr(ctl, heard) {
  const { goal, name, onBehalfOf, kind, opener, heard: hist, said, steps } = ctl.ivr;
  const whoCalled = kind === 'business' ? 'a business' : ('a person' + (name && !/^(there|them|someone)$/i.test(name) ? ` named ${name}` : ''));
  const sys = `You are placing an outbound phone call on behalf of ${onBehalfOf} to ${whoCalled}. Your GOAL is: "${goal}".
YOU ARE THE CALLER: the far end did not ring you and doesn't know why you're calling. NEVER say "how can I help you" or similar — that's what THEY might say to YOU; your lines say who you are and what you're ringing about.
You cannot see anything — you only HEAR the line. The far end is either a PERSON or an automated phone menu (IVR). Decide the SINGLE next action and reply with ONLY a compact JSON object (no prose, no code fences).
- Automated MENU heard (e.g. "press 1 for sales, 2 for support"): {"action":"dtmf","digits":"<keys 0-9,*,#>"} — the option best matching the goal.
- A PERSON has answered or is waiting (e.g. "hello?", "how can I help?"): {"action":"say_and_listen","say":"<what to say>"}. On your FIRST words, introduce yourself briefly and state the goal. A good opener to adapt: "${opener}". Later, reply naturally to move toward the goal.
- You now HAVE the answer / the order or booking is confirmed: {"action":"done","answer":"<one short sentence to report back to ${onBehalfOf}>"}.
- Silence, or a menu still being read and you should keep listening: {"action":"wait"}.
${ctl.ivr.posture ? `\n${ctl.ivr.posture}\n` : ''}${ctl.ivr.mapHint ? `\nKNOWN MENU for this number (mapped on an earlier call — trust it over guessing; pick the key that leads toward the goal, and you may send a short key sequence in one dtmf action when the path is known):\n${ctl.ivr.mapHint}\n` : ''}Keep spoken lines short and natural. With a PERSON, sound like a relaxed human caller — contractions, warm and brief ("oh hi!", "no worries"), never corporate or scripted; greet first, then the reason, and respond to what they actually say rather than pushing the goal in one breath. Never hang up on silence or a pause — check in instead ("you still there?"). Never dial numbers unrelated to the goal.`;
  const user = `Heard so far:\n${hist.length ? hist.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(nothing yet)'}\nActions you've taken: ${said.length ? said.join(' ; ') : '(none)'}\nMost recent: "${heard || '(silence)'}"\nStep ${steps}. Reply with the JSON action only.`;
  const out = await completeText({ model: config.llm.fastModel, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], params: { max_tokens: 220, temperature: 0 } });
  const m = String(out).match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); if (['dtmf', 'say', 'say_and_listen', 'done', 'wait'].includes(o.action)) return o; } catch { /* fall through */ } }
  return { action: heard ? 'done' : 'wait', answer: heard || '' };
}

async function onAskStep(ctl, evt) {
  const { session, callSid } = ctl;
  if (ctl.askResolved) return;
  const heard = extractGatherSpeech(evt);
  ctl.ivr.steps += 1;
  if (heard) ctl.ivr.heard.push(heard);
  if (heard && ctl.who) applyWho(ctl, ctl.who.observe({ type: 'heard', text: heard }));
  emitEvent('phone.ivr', ctl.ownerSession || ctl.sessionId, { callSid, step: ctl.ivr.steps, heard: heard.slice(0, 180) });
  if (ctl.ivr.steps > MAX_IVR_STEPS) { logger.warn(`call ${callSid}: ask hit max IVR steps`); return finishAsk(ctl, heard || ''); }
  let decision;
  try { decision = await decideIvr(ctl, heard); }
  catch (err) { logger.warn(`call ${callSid}: IVR decide failed: ${err.message}`); decision = { action: 'done', answer: heard || '' }; }
  emitEvent('phone.ivr_action', ctl.ownerSession || ctl.sessionId, { callSid, step: ctl.ivr.steps, action: decision.action, digits: decision.digits || '', say: (decision.say || '').slice(0, 140) });
  logger.info(`call ${callSid}: IVR step ${ctl.ivr.steps} heard="${heard.slice(0, 60)}" -> ${decision.action}${decision.digits ? ` ${decision.digits}` : ''}`);
  if (ctl.askResolved) return;
  if (decision.action === 'done') return finishAsk(ctl, decision.answer || heard || '');
  const verbs = [];
  if (decision.action === 'dtmf' && decision.digits) {
    const digits = String(decision.digits).replace(/[^0-9*#]/g, '').slice(0, 12);
    if (digits) { ctl.ivr.said.push(`[pressed ${digits}]`); verbs.push({ verb: 'dtmf', dtmf: digits }); }
    verbs.push(askGather(ctl, { timeout: 15 }));
  } else if (decision.action === 'say' || decision.action === 'say_and_listen') {
    if (decision.say) { ctl.ivr.said.push(decision.say); if (ctl.who) ctl.who.observe({ type: 'said', text: decision.say }); }
    verbs.push(askGather(ctl, { say: decision.say || '', timeout: 15 }));
  } else {
    verbs.push(askGather(ctl, { timeout: 12 }));
  }
  session.addVerbs(verbs).reply();
}

// Remembered per number (in memory): the next call to the same line starts with a small prior.
const whoAnsweredBefore = new Map();
/** Act on a who-answered verdict: once decided (or revised), tell the console, remember it, and
 *  set Aria's posture — a standing note on the S2S leg, a prompt line on the gather loop, or (opt-in,
 *  PHONE_ASK_IVR_SWITCH=1) a lane switch from S2S to the DTMF-capable gather loop for a menu. */
function applyWho(ctl, v, { final = false } = {}) {
  if (!v) return;
  // Stubborn human-vs-agent tie on an outbound Realtime leg: ask the one-line probe, once.
  if (v.probe && !v.decided && ctl.mode === 'ask' && ctl.lane === 'ask-s2s' && !ctl.probed && !ctl.askResolved) {
    ctl.probed = true;
    logger.info(`call ${ctl.callSid}: who-answered tie — asking the probe line`);
    emitEvent('phone.probe', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, turns: v.turns });
    injectRealtimeUserText(ctl, `(Before you go on, ask in ONE light line: "${ctl.who.probeLine()}" Take their answer at face value, thank them, and carry on with the goal.)`, { respond: false });
  }
  if (!v.decided || (ctl.askResolved && !final)) return;
  if (ctl.whoKind === v.kind) return;
  const changed = Boolean(ctl.whoKind);
  ctl.whoKind = v.kind;
  const number = ctl.mode === 'ask' ? (getAsk(ctl.askId) || ctl.ivr || {}).to : ctl.direction === 'inbound' ? ctl.from : null;
  if (number) { whoAnsweredBefore.set(number, { kind: v.kind, at: Date.now() }); rememberVerdict(number, v); }
  if (ctl.mode !== 'ask') {
    // Inbound: who is calling. Only an agent caller changes Aria's posture.
    logger.info(`call ${ctl.callSid}: WHO IS CALLING -> ${v.kind} (${Math.round(v.confidence * 100)} %, ${v.by}${changed ? ', revised' : ''}) — ${v.cues.slice(-3).join('; ')}`);
    emitEvent('phone.answered_by', ctl.sessionId, { callSid: ctl.callSid, direction: 'inbound', kind: v.kind, confidence: v.confidence, by: v.by, changed, turns: v.turns, cues: v.cues.slice(-5) });
    if (final) return;
    const note = inboundPostureFor(v.kind);
    if (note && ctl.lane !== 'cascaded') injectRealtimeUserText(ctl, note, { respond: false });
    return;
  }
  logger.info(`call ${ctl.callSid}: WHO ANSWERED -> ${v.kind} (${Math.round(v.confidence * 100)} %, ${v.by}${changed ? ', revised' : ''}) — ${v.cues.slice(-3).join('; ')}`);
  emitEvent('phone.answered_by', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, direction: 'outbound', kind: v.kind, confidence: v.confidence, by: v.by, changed, turns: v.turns, amd: v.amd, cues: v.cues.slice(-5) });
  if (final) return; // best guess at the end of the leg: for the console and the per-number memory only
  const posture = postureFor(v.kind, { who: ctl.ivr?.onBehalfOf || config.agentName, them: ctl.ivr?.name || 'them', goal: ctl.ivr?.goal || '', callback: config.phoneAsk.fromNumber || config.jambonz.fromNumber || '' });
  ctl.ivr.posture = posture;
  if (ctl.lane === 'ask-s2s') {
    if (v.kind === 'ivr' && !/^(0|false|off)$/i.test(process.env.PHONE_ASK_IVR_SWITCH || '')) {
      // A menu can't be worked from the Realtime leg (no keys); hand the SAME call to the gather loop.
      ctl.whoRedirected = true; ctl.lane = 'ask';
      logger.info(`call ${ctl.callSid}: IVR detected — switching to the DTMF gather loop`);
      try { ctl.session.sendCommand('redirect', [askGather(ctl, { timeout: 12 })]); } catch (err) { logger.warn(`call ${ctl.callSid}: IVR switch failed: ${err.message}`); }
    } else injectRealtimeUserText(ctl, posture, { respond: false });
  }
}

function finishAsk(ctl, answer) {
  const { session, callSid } = ctl;
  if (ctl.askResolved) return;
  ctl.askResolved = true;
  const ask = getAsk(ctl.askId) || {};
  const text = String(answer || '').trim();
  if (ctl.who) applyWho(ctl, ctl.who.finalize(), { final: true });
  logger.info(`call ${callSid}: ask finished, answer="${text.slice(0, 90)}"`);
  emitEvent('phone.answer', ctl.ownerSession || ctl.sessionId, { callSid, askId: ctl.askId, answer: text, name: ask.name });
  resolveAsk(ctl.askId, text ? { answer: text, transcript: (ctl.ivr?.heard || []).join(' | ') } : { error: 'no clear answer was obtained on the call', answer: '' });
  const bye = text ? "Lovely — I'll pass that on. Thanks heaps, bye!" : "No worries — I'll try again later. Bye!";
  session.addVerbs([sayVerb(bye), hangupVerb()]).reply();
}
// Build a natural opening line for the outbound call. A PERSON gets a warm, apologetic check-in
// addressed by name; a BUSINESS gets a brief, matter-of-fact opener with no name and no "sorry to
// bother you" (you can't greet "Hi the Exchange Hotel"). The question/order follows either way.
function buildAskIntro(ask) {
  const who = String(ask.onBehalfOf || config.agentName).trim();
  const q = String(ask.question || '').trim();
  const nameRaw = String(ask.name || '').trim();
  const isBusiness = ask.kind === 'business';
  if (isBusiness) {
    return `Hi there — I'm calling on behalf of ${who}. ${q}`;
  }
  const name = nameRaw && !/^(them|there|someone)$/i.test(nameRaw) ? nameRaw : 'there';
  return `Oh hi ${name} — it's ${who}'s assistant here. ${q}`;
}
function extractGatherSpeech(evt) {
  const sp = (evt && (evt.speech || evt)) || {};
  const alt = Array.isArray(sp.alternatives) ? sp.alternatives[0] : sp.alternatives;
  return String((alt && alt.transcript) || sp.transcript || (evt && evt.transcript) || '').trim();
}
function note(ctl, what, evt) {
  const e = evt || {};
  const keys = {};
  for (const k of ['completion_reason', 'reason', 'harness_error', 'error', 'type', 'call_status']) if (e[k] !== undefined) keys[k] = e[k];
  ctl.events.push({ at: Date.now() - ctl.startedMs, what, ...keys, detail: JSON.stringify(e).slice(0, 1000) });
  if (ctl.events.length > 30) ctl.events.shift();
}

/** 13 Nov: the WHOLE outbound leg's conversation (the booking AND any relayed follow-ups) for the
 * console/recap — `phone.answer` only carried the transcript up to the first outcome. Sent once,
 * when the leg finishes (finish_call) or dies; the console swaps it into the matching call entry. */
function emitAskTranscript(ctl, finalOutcome = '') {
  if (ctl.mode !== 'ask' || ctl.askTranscriptSent || !ctl.transcript?.length) return;
  ctl.askTranscriptSent = true;
  const ask = getAsk(ctl.askId) || ctl.ivr || {};
  emitEvent('phone.transcript', ctl.ownerSession || ctl.sessionId, {
    callSid: ctl.callSid, askId: ctl.askId, name: ask.name, final: finalOutcome,
    transcript: ctl.transcript.slice(-40).map((t) => ({ role: t.role === 'assistant' ? 'aria' : 'them', text: t.text }))
  });
}

function cleanup(ctl, reason = 'closed') {
  if (!calls.has(ctl.callSid)) return;
  if (ctl.mode === 'ivrmap') ivrMapLegEnded(ctl, reason); // the mapper resolves the node with whatever was heard
  // 13 Nov (take 5): the caller said goodbye while a venue leg was still open, and that leg sat
  // in-progress on jambonz afterwards. The owner's call ending ends every ask leg it owns.
  if (ctl.mode !== 'ask') {
    for (const leg of [...calls.values()].filter((c) => c.mode === 'ask' && c.ownerSession === ctl.sessionId)) {
      logger.info(`call ${ctl.callSid}: owner call ended — hanging up ask leg ${leg.callSid}`);
      try { leg.session.hangup().send(); } catch { /* already down */ }
      setTimeout(() => { if (calls.has(leg.callSid)) cleanup(leg, 'owner call ended'); }, 4000);
    }
  }
  if (ctl.mode === 'ask') {
    ctl.askFinished = true; emitAskTranscript(ctl);
    const o = ownerLegOf(ctl);
    if (o) {
      o.lastAskEndedAt = Date.now();
      // 13 Nov (take 4): the leg died with the caller's follow-up still unanswered and NOBODY told the
      // owner — Jordan and Aria then sat in silence for 17 minutes. Ring them straight back with it.
      if (ctl.relayPending?.text && config.s2s.backgroundBrowse && o.lastAsk) {
        const la = o.lastAsk, q = ctl.relayPending.text;
        ctl.relayPending = null;
        logger.warn(`call ${ctl.callSid}: leg ended with a follow-up unanswered — ringing ${la.name || 'them'} back`);
        injectRealtimeUserText(o, `(Your colleague lost the line with ${la.name || 'them'} before they answered the caller's request ("${q}") — your team is ringing them straight back with it. Tell the caller in ONE short line that the line dropped and you're ringing them back now, then wait quietly; the answer will arrive as a message.)`);
        runBackgroundBrowse(o, { request: `Ring ${la.name || 'them'} back straight away on ${la.to} (kind: ${la.kind || 'business'}, on behalf of ${la.onBehalfOf || 'the caller'}) — the line dropped${la.outcome ? ` just after they told us: "${la.outcome}"` : ''}. Ask them: "${q}". Phone only — do not browse the web for this.`, context: '', name: BROWSE_TOOL_NAME, callId: null, fnId: null });
      }
    }
  }
  if (ctl.askId && !ctl.askResolved) {
    ctl.askResolved = true;
    // 13 Nov (hero take): Rogue Bistro's assistant confirmed the booking and hung up politely BEFORE
    // Aria's leg had called report_outcome, and the owner heard "couldn't get through". If the far
    // end actually spoke, their last substantive line IS the outcome — hand it back as the answer.
    // Take 3: ONLY when that line came AFTER Aria had put the request (intro + request = two Aria
    // lines, and their last line follows her last) — otherwise "Hi Aria, how can I help?" became the
    // "answer" and the relay summary invented a confirmation from it.
    const theirs = ctl.transcript.filter((t) => t.role === 'user' && String(t.text || '').trim().length > 12);
    const lastLine = theirs.at(-1)?.text?.trim() || '';
    const ariaLines = ctl.transcript.filter((t) => t.role === 'assistant').length;
    const lastIdx = (role) => ctl.transcript.map((t) => t.role).lastIndexOf(role);
    const answered = ariaLines >= 2 && lastIdx('user') > lastIdx('assistant');
    if (lastLine && answered) {
      const ask = getAsk(ctl.askId) || {};
      emitEvent('phone.answer', ctl.ownerSession || ctl.sessionId, { callSid: ctl.callSid, askId: ctl.askId, answer: lastLine, name: ask.name, reached: 'person', inferred: true });
      resolveAsk(ctl.askId, { answer: lastLine, transcript: ctl.transcript.slice(-10).map((t) => `${t.role === 'assistant' ? 'Me' : 'Them'}: ${t.text}`).join(' | '), note: 'They ended the call after saying this — treat it as their answer.' });
    } else resolveAsk(ctl.askId, { error: lastLine ? 'the line dropped before they answered' : `the call ended (${reason}) before an answer`, answer: '', dropped: Boolean(lastLine) });
  }
  if (ctl.mode === 'ask') { const owner = ownerLegOf(ctl); if (owner) holdAudio(owner, false); } // belt and braces: never leave the pad running
  calls.delete(ctl.callSid);
  recent.unshift({ call_sid: ctl.callSid, mode: ctl.mode, lane: ctl.lane, session: ctl.sessionId, from: ctl.from, to: ctl.to, direction: ctl.direction, started_at: ctl.startedAt, ended_at: Date.now(), ended_after_ms: Date.now() - ctl.startedMs, end_reason: reason, swaps: ctl.swaps, events: ctl.events, transcript: ctl.transcript.slice(-8) });
  if (recent.length > 20) recent.length = 20;
  bus.removeAllListeners(topic(ctl.callSid, 'handback'));
  emitEvent('call.end', ctl.sessionId, { callSid: ctl.callSid, reason, swaps: ctl.swaps, duration_ms: Date.now() - ctl.startedMs, mode: ctl.mode, ownerSession: ctl.ownerSession, webClient: Boolean(ctl.webClient) });
  scheduleCallRecap(ctl, reason);
  getObservability().event(ctl.sessionId, 'call.end', { callSid: ctl.callSid, reason, swaps: ctl.swaps, duration_ms: Date.now() - ctl.startedMs }).catch(() => {});
  logger.info(`call ${ctl.callSid} done (mode=${ctl.mode}, swaps=${ctl.swaps}, ${reason})`);
}

/** 16 Nov: a WebRTC (web-client) call that actually had a conversation leaves a recap in the Async
 *  drawer — a thread the owner can reply to ("book that one") with the whole call as context. The
 *  showcase takes already got an HTML recap; an ordinary call got nothing. Not for ask / map legs,
 *  and not for a socket drop that jambonz re-dials within the reconnect window (one recap per call). */
function scheduleCallRecap(ctl, reason) {
  if (!ctl.webClient || ctl.mode === 'ask' || ctl.mode === 'ivrmap' || process.env.CALL_RECAP_THREAD === '0') return;
  const lines = ctl.transcript.filter((t) => t && String(t.text || '').trim());
  if (lines.filter((t) => t.role === 'user').length < 1 || lines.length < 2) return;
  const wait = reason === 'socket closed' ? 95000 : 2000;
  setTimeout(async () => {
    if (calls.has(ctl.callSid)) return; // it reconnected — the call is still going
    const hhmm = (ms) => new Date(ms || Date.now()).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    const body = lines.slice(-60).map((t) => `${hhmm(t.at)} ${t.role === 'assistant' ? HOST.name : 'You'}: ${String(t.text).trim()}`).join('\n');
    let summary = '';
    try {
      summary = await completeText({ model: config.llm.summaryModel, messages: [
        { role: 'system', content: `Summarise this phone conversation between the owner ("You") and ${HOST.name}, their voice assistant, in two or three short sentences: what was asked, what was found or done, anything still pending. Plain words, no preamble, no bullet points.` },
        { role: 'user', content: body.slice(-6000) }
      ], params: { max_tokens: 160 } });
    } catch (err) { logger.warn(`call ${ctl.callSid}: recap summary failed: ${err.message}`); }
    const mins = Math.max(1, Math.round((Date.now() - ctl.startedMs - wait) / 60000));
    const text = `📞 Call recap — ${mins} min, ${lines.length} lines${summary ? `\n\n${String(summary).trim()}` : ''}\n\n${body}`;
    try {
      const { createNoteThread } = await import('../tasks/store.js');
      const t = createNoteThread({ title: `Call recap · ${hhmm(ctl.startedMs)}`, text, web: true });
      emitEvent('call.recap', ctl.sessionId, { callSid: ctl.callSid, task: t?.id || null, lines: lines.length });
      logger.info(`call ${ctl.callSid}: recap posted to thread ${t?.id || '?'}`);
    } catch (err) { logger.warn(`call ${ctl.callSid}: recap thread failed: ${err.message}`); }
  }, wait);
}

function onAgentEvent(ctl, evt) {
  if (evt.type === 'turn_end') {
    const l = evt.latency || {};
    emitEvent('jambonz.turn_end', ctl.sessionId, { callSid: ctl.callSid, harness_first_chunk_ms: l.harness_first_chunk_ms ?? l.model_latency ?? null, tts_ms: l.voice_latency ?? null, stt_ms: l.stt_latency ?? null, route: evt.turn_record?.route || '' });
  } else if (evt.type === 'harness_failure') {
    note(ctl, 'harness_failure', evt);
    logger.error(`call ${ctl.callSid}: harness failure ${JSON.stringify(evt)}`);
  } else if (evt.type && evt.type !== 'user_transcript' && evt.type !== 'llm_response') note(ctl, `agent-event:${evt.type}`, evt);
}

/** End the current transcript line of `role`: the next chunk of that role starts a new line. */
function onS2sEvent(ctl, evt) {
  // jambonz.cloud passes the raw Gemini/OpenAI message through with snake_case keys.
  const t = evt?.type || evt?.event || '';
  // Surface S2S errors (e.g. OpenAI rejecting a session field) — otherwise a bad config fails silently
  // with transcript-but-no-audio and nothing to go on.
  if (/error/i.test(t) || evt?.error) {
    const e = evt?.error || evt;
    logger.warn(`call ${ctl.callSid}: s2s error — ${e?.code || ''} ${e?.message || JSON.stringify(e).slice(0, 200)}`);
    emitEvent('s2s.error', ctl.sessionId, { callSid: ctl.callSid, code: e?.code, message: e?.message || JSON.stringify(e).slice(0, 200), param: e?.param });
    return;
  }
  // Response lifecycle: while the model is responding (or about to — caller speech commits
  // auto-create a response under server_vad), an injected response.create would kill the leg.
  if (t === 'response.created') ctl.s2sBusy = true;
  // 15 Nov: a response boundary closes Aria's current transcript line (see the folding below).
  if (t === 'response.done' || evt?.serverContent?.turnComplete || evt?.server_content?.turn_complete) noteTurnComplete(ctl); // closes Aria's line; Gemini's next line gets a new synthetic item
  if (t === 'response.done') {
    ctl.s2sBusy = false;
    meterS2sResponse(ctl, evt);
    if (ctl.injectPending) {
      ctl.injectPending = false;
      clearTimeout(ctl.injectFallback);
      setTimeout(() => sendS2sResponseCreate(ctl), 300);
    }
  }
  // Mic/VAD observability: without these rows a deaf call (VAD threshold too high, muted mic,
  // dead tab audio) is indistinguishable from a silent caller — 9 Nov's 2.5 min of dead air.
  if (/^input_audio_buffer\.(speech_started|speech_stopped|committed)$/.test(t)) {
    // speech_started while a response is in flight = a BARGE-IN registered (OpenAI cancels the
    // response; jambonz flushes the audio). Label it so "couldn't interrupt" is diagnosable: no
    // barge_in row in the feed means the VAD never heard the talk-over at all.
    const barge = t.endsWith('speech_started') && ctl.s2sBusy;
    if (t.endsWith('speech_started') || t.endsWith('committed')) ctl.s2sBusy = true; // a response will follow
    if (t.endsWith('speech_started')) noteSpeechStart(ctl);
    if (t.endsWith('speech_stopped') || t.endsWith('committed')) ctl.lastUserSpeechAt = Date.now();
    // 15 Nov: remember WHEN this utterance started, keyed by the item its transcript will carry —
    // the text transcription lands seconds later, after Aria has already begun answering.
    if (t.endsWith('committed')) noteCommitted(ctl, evt?.item_id);
    emitEvent('s2s.vad', ctl.sessionId, { callSid: ctl.callSid, phase: barge ? 'barge_in' : t.split('.')[1] });
    return;
  }
  const found = evt?.transcript ? { text: evt.transcript, role: /input/i.test(t) ? 'user' : 'assistant' } : findTranscription(evt);
  if (!found) return;
  const { text, role } = found;
  if (role === 'assistant') { ctl.lastAssistantAt = Date.now(); if (ctl.who) ctl.who.observe({ type: 'said', text }); }
  // 15 Nov: ONE transcript line per spoken item. Before this, lines folded on role adjacency alone,
  // so when the caller's transcription arrived late (it always does) Aria's next answer was glued
  // onto her previous line ("…what are we getting up to today?Sure thing, let me check…"). A line
  // is keyed by the provider's item id when there is one and closed at a response/turn boundary
  // (or the next speech start) otherwise; each line carries `at`, the moment it was spoken.
  // 16 Nov: the folding itself lives in transcript.js (unit-tested); Gemini gets synthetic item ids there.
  const { line, lineNo, newLine } = foldTranscript(ctl, { role, text, item: evt?.item_id || evt?.item?.id || null });
  const full = line.text;
  emitEvent('s2s.transcript', ctl.sessionId, { callSid: ctl.callSid, role, delta: text, text: full, item: line.item || null, line: lineNo, at: line.at, agent: role === 'assistant' ? { id: HOST.id, name: HOST.name, color: HOST.color } : null });
  // Score the caller's spoken line so the sentiment chart fills on a voice call too. The
  // Gemini transcription arrives in pieces: one point per caller line, updated as it grows.
  if (role === 'user') {
    if (newLine) ctl.callerTurns = (ctl.callerTurns || 0) + 1;
    const s = scoreSentiment(full);
    const hist = (ctl.sentiment || []);
    if (newLine) hist.push(s.score); else if (hist.length) hist[hist.length - 1] = s.score;
    ctl.sentiment = hist.slice(-40);
    emitEvent('caller.said', ctl.sessionId, { callSid: ctl.callSid, turn: ctl.callerTurns, text: full, sentiment: s, trend: trendOf(ctl.sentiment), via: 's2s', at: line.at });
    if (ctl.who && newLine) {
      const sinceSaidMs = ctl.lastAssistantAt && ctl.farStartAt ? Math.max(0, ctl.farStartAt - ctl.lastAssistantAt) : null;
      const durationMs = ctl.farStartAt && ctl.lastUserSpeechAt && ctl.lastUserSpeechAt > ctl.farStartAt ? ctl.lastUserSpeechAt - ctl.farStartAt : null;
      applyWho(ctl, ctl.who.observe({ type: 'heard', text, sinceSaidMs, durationMs }));
    }
    scheduleMoodRefine(ctl);
    armRequestWatchdog(ctl, full);
  } else if (newLine && LANGUAGE_SLIP_RX.test(text)) {
    // 13 Nov (H-07 take 1): the Realtime model answered "text me that location" with a Spanish
    // welcome-back line and the request was lost. Pull it back to English and to the request.
    const lastAsk = ctl.transcript.filter((t) => t.role === 'user').at(-1)?.text || '';
    logger.warn(`call ${ctl.callSid}: assistant slipped out of English ("${text.slice(0, 40)}") — correcting`);
    setTimeout(() => { if (calls.has(ctl.callSid)) injectRealtimeUserText(ctl, `(You just replied in the wrong language. Speak ENGLISH only. In one short line, answer the caller's last request${lastAsk ? ` — "${lastAsk.slice(0, 160)}"` : ''} — and if it needs doing, call the right tool now.)`); }, 400);
  }
}

/** Ask the fast model to re-read the recent exchange and correct the mood for the latest caller
 * turn (debounced + async in mood.js). The lexicon score in ctl.sentiment is replaced in place so
 * the trend keeps using one series. */
function scheduleMoodRefine(ctl) {
  const turn = ctl.callerTurns;
  const idx = (ctl.sentiment || []).length - 1;
  if (idx < 0) return;
  refineMood({
    sessionId: ctl.sessionId,
    turn,
    lines: ctl.transcript.slice(-6),
    apply: (score) => { if (idx < ctl.sentiment.length) ctl.sentiment[idx] = score; return trendOf(ctl.sentiment); }
  });
}

// 13 Nov: DROPPED-REQUEST WATCHDOG. H-07 take 1: "text me that location" got a (Spanish) pleasantry
// and no tool call; the caller sat in silence until Huey's "hello?". If the caller's line plainly asks
// for an ACTION and no tool has fired within a few seconds — and nothing is already in progress —
// nudge the host once to act on it, in English.
const ACTION_RX = /\b(text|sms|send|message|whatsapp|email|find|look up|search|open|pull up|bring up|book|order|ring|call|phone|drop a pin|pin it|show me|work out|figure out|check|compare|read|remind|add .* (calendar|diary)|put .* (calendar|diary))\b/i;
const LANGUAGE_SLIP_RX = /[¡¿]|\b(qué|está|estás|hola|gracias|bueno|escucharte|sigamos|hoy|cómo|puedo|ayudarte|bonjour|merci|danke|ciao|olá|beleza|bora|tô|você|obrigad[oa]|tudo bem|puxando|vamos lá)\b/i; // 15 Nov: + Portuguese (gpt-realtime opened in it)
function armRequestWatchdog(ctl, text) {
  if (!ACTION_RX.test(text) || /^(hello|hi|hey)\b.*(still there|are you there)/i.test(text)) return;
  clearTimeout(ctl.requestWatch);
  const askedAt = ctl.lastUserSpeechAt || Date.now();
  const line = String(text).slice(0, 200);
  ctl.requestWatch = setTimeout(() => {
    if (!calls.has(ctl.callSid) || ctl.swapping || ctl.browsing) return;
    if ((ctl.lastToolAt || 0) >= askedAt - 1500) return; // a tool fired for it (transcripts can lag the VAD)
    if ([...calls.values()].some((c) => c.mode === 'ask' && c.ownerSession === ctl.sessionId && !c.askResolved)) return; // holding for an outbound call
    if (ctl.s2sBusy) { ctl.requestWatch = setTimeout(() => armRequestWatchdog(ctl, text), 2500); return; }
    logger.warn(`call ${ctl.callSid}: no tool fired for "${line.slice(0, 60)}" — nudging the host`);
    emitEvent('s2s.nudge', ctl.sessionId, { callSid: ctl.callSid, reason: 'dropped_request', text: line });
    injectRealtimeUserText(ctl, `(The caller asked you to: "${line}" — and nothing has been done about it yet. Act on it NOW, in English: call browse_for_caller with that request (or start_background_task if they want it after the call), saying one short line that you're onto it. Do not just chat.)`);
  }, 7000);
}

export function findTranscription(evt, depth = 0) {
  if (!evt || typeof evt !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(evt)) {
    if (/transcription$/i.test(k) && v && typeof v === 'object' && typeof v.text === 'string' && v.text) return { text: v.text, role: /input/i.test(k) ? 'user' : 'assistant' };
    const nested = findTranscription(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function onS2sTool(ctl, evt) {
  const { session, callSid } = ctl;
  // google_s2s shape: {function_calls:[{name,args,id}], tool_call_id}; flat shape still accepted.
  const fn = evt.function_calls?.[0] || evt.functionCalls?.[0] || {};
  const name = fn.name || evt.name || evt.function_name || evt.tool_name;
  const callId = evt.tool_call_id || evt.call_id || evt.id;
  let args = fn.args ?? evt.arguments ?? evt.args ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { request: args }; } }
  logger.info(`call ${callSid}: s2s tool ${name}(${JSON.stringify(args).slice(0, 120)})`);
  ctl.lastToolAt = Date.now(); // the dropped-request watchdog (onS2sEvent) checks this
  // 13 Nov: a LONG-RUNNING job the caller does not want to wait for — created synchronously here, so
  // Aria can say "underway, I'll WhatsApp you" in the same breath instead of "give us a sec".
  if (name === TASK_TOOL_NAME) {
    const request = String(args.request || '').trim() || ctl.transcript.filter((t) => t.role === 'user').at(-1)?.text || '';
    if (!request) { sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: 'request is required' } }); return; }
    import('../tasks/store.js').then(({ createTask }) => {
      const t = createTask({ text: request, title: args.title, via: 'call' });
      emitEvent('task.created', ctl.sessionId, { task: t.id, title: t.title, via: 'call' });
      logger.info(`call ${callSid}: background task #${t.seq || '?'} "${t.title}" started from the host`);
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true, task: t.title, note: 'Started — your team is on it now and the answer lands on the caller\'s WhatsApp automatically. Tell the caller in ONE short line that it\'s underway and they\'ll get it on WhatsApp, then carry on (ask what else, or say goodbye if they are done). Do not say "give me a sec" and do not wait for it.' } });
    }).catch((err) => {
      logger.warn(`call ${callSid}: start_background_task failed: ${err.message}`);
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: 'could not start the task — hand it to browse_for_caller instead' } });
    });
    return;
  }
  // The caller answered a question relayed from a live outbound ask-call: deliver it to that leg.
  if (name === RELAY_TOOL) {
    const msg = String(args.message || args.answer || '').trim();
    // 13 Nov: the lookup used to exclude a leg once its first outcome was reported (askResolved) —
    // so a follow-up after "booking confirmed" always met "that call has already finished" while the
    // venue was still holding. A leg is out of play only when it has FINISHED (finish_call/cleanup);
    // the one waiting on the owner wins when there are several.
    const legs = [...calls.values()].filter((c) => c.mode === 'ask' && c.ownerSession === ctl.sessionId && !c.askFinished);
    const askCtl = legs.find((c) => c.awaitingRelay) || legs[0];
    // 13 Nov: the model fired this on the caller's "I'll hold" BEFORE the outbound leg had even
    // connected; the old error text ("already finished… they have hung up") was then announced to
    // the caller as "looks like Sunny's already hung up" and Huey ended the call. Only a relay that
    // answers a question/outcome your colleague actually passed through gets delivered; everything
    // else is a quiet no-op.
    if (!askCtl || !msg || !askCtl.awaitingRelay) {
      const recentlyEnded = ctl.lastAskEndedAt && Date.now() - ctl.lastAskEndedAt < 90000;
      // 13 Nov (take 3): the venue dropped off ~10 s after confirming, the caller's follow-up then met
      // "that call has already finished" and Aria asked the caller what to do. A follow-up for a
      // person who has just hung up is simply a ring-back: hand it to the team right now, as a browse,
      // and tell the caller in one line — no decision for them to make.
      const wrapUp = /^(no[,.]?\s*)?(that'?s|thats) (all|everything|it)|nothing (else|more)|all good|we'?re done|no thanks?$/i.test(msg) || /^no[,.]?\s*(that'?s all|thanks)/i.test(msg);
      if (!askCtl && msg && !wrapUp && ctl.lastAsk && ctl.lastAskEndedAt && Date.now() - ctl.lastAskEndedAt < 180000 && config.s2s.backgroundBrowse) {
        const la = ctl.lastAsk;
        logger.info(`call ${callSid}: follow-up for ${la.name || 'them'} after their line dropped — ringing back`);
        emitEvent('phone.relay', ctl.sessionId, { callSid, direction: 'answer', name: la.name, text: msg, ringback: true });
        const request = `Ring ${la.name || 'them'} back straight away on ${la.to} (kind: ${la.kind || 'business'}, on behalf of ${la.onBehalfOf || 'the caller'}) — the line dropped just after they ${la.outcome ? `told us: "${la.outcome}"` : 'answered'}. Ask them: "${msg}". Phone only — do not browse the web for this.`;
        // runBackgroundBrowse answers THIS tool call with the team's delegation line once the ring-back is placed.
        runBackgroundBrowse(ctl, { request, context: '', name, callId, fnId: fn.id });
        return;
      }
      const note = askCtl
        ? 'Nothing from the other call is waiting for an answer right now — do NOT pass this on and do not mention it; just carry on with the caller naturally.'
        : recentlyEnded
          ? 'That call has already finished and its outcome stands — say nothing about the call; just carry on with the caller\'s next step.'
          : 'No call is in progress and nothing is waiting — say NOTHING about any call; simply respond to the caller as normal.';
      logger.info(`call ${callSid}: relay ignored (${!askCtl ? 'no ask leg' : !msg ? 'empty' : 'nothing awaiting'})`);
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: false, note } });
      return;
    }
    // A question/request for the far end: report_outcome is refused until they have answered it.
    const isWrapUp = /^(no[,.]?\s*)?(that'?s|thats) (all|everything|it)|nothing (else|more)|all good|we'?re done|no thanks?$/i.test(msg) || /^no[,.]?\s*(that'?s all|thanks)/i.test(msg);
    // 13 Nov (take 5): four seconds after the outcome landed — before the caller had said a word —
    // the model relayed "that's everything, thanks" and the venue was let go; the caller's real
    // follow-up then needed a ring-back. A wrap-up is only real once the CALLER has spoken after the
    // outcome was delivered.
    if (isWrapUp && ctl.lastOutcomeAt && !((ctl.lastUserSpeechAt || 0) > ctl.lastOutcomeAt)) {
      logger.info(`call ${callSid}: wrap-up relay rejected — the caller has not responded to the outcome yet`);
      sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: false, note: 'The caller has NOT said that yet. Tell them the outcome and ASK whether there is anything they want asked while the other party is still on the line — then wait for THEIR answer and relay THAT. Do not invent the caller\'s reply.' } });
      return;
    }
    askCtl.awaitingRelay = false;
    askCtl.lastRelayAt = Date.now();
    const ask = getAsk(askCtl.askId) || {};
    emitEvent('phone.relay', ctl.sessionId, { callSid: askCtl.callSid, direction: 'answer', name: ask.name, text: msg });
    askCtl.relayPending = isWrapUp ? null : { text: msg, at: Date.now() };
    // 13 Nov: a relayed FOLLOW-UP ("can they make sure it's a window table?") must come back the same
    // way it went — the venue leg puts it to them and reports their answer with report_outcome, so
    // Aria can tell the caller while the venue is still on the line.
    injectRealtimeUserText(askCtl, askCtl.relayPending
      ? `(Message from ${ask.onBehalfOf || 'the owner'} for ${ask.name || 'them'}: "${msg}". Your NEXT turn is SPEECH, not a tool: say this to ${ask.name || 'them'} now, out loud, in your own words ("Oh, one more thing — Jordan was wondering if…"). Then WAIT for their reply. Only AFTER they have answered, call ${ASK_REPORT_TOOL} with what THEY said, in one sentence — ${ask.onBehalfOf || 'the owner'} is waiting on the other line. Do not say goodbye; wait for the next message.)`
      : `(Message from ${ask.onBehalfOf || 'the owner'}: "${msg}" — ${ask.onBehalfOf || 'the owner'} needs nothing more. Pass that on in a word, thank ${ask.name || 'them'} warmly, say goodbye, then call ${ASK_FINISH_TOOL}.)`);
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { ok: true, note: 'Delivered — your colleague is passing it on. Carry on with the caller.' } });
    return;
  }
  if (name !== BROWSE_TOOL_NAME) {
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { error: `unknown tool ${name}` } });
    return;
  }
  const request = args.request || args.question || ctl.transcript.filter((t) => t.role === 'user').at(-1)?.text || 'the caller just asked for something on the web';
  // 15 Nov: "hello" is not a job. The Realtime model browsed for a typed "hello" (the opening note
  // told it to act IMMEDIATELY); the team answered "Hey! What can I do for you?" — nonsense as a
  // tool result. Small talk gets a no-op answer and Aria just talks.
  if (isChitChat(request)) {
    logger.info(`call ${callSid}: browse_for_caller("${String(request).slice(0, 40)}") is small talk — no browse`);
    emitEvent('team.skipped', ctl.sessionId, { callSid, request: String(request).slice(0, 120), why: 'small talk' });
    sendS2sToolOutput(ctl, { name, callId, fnId: fn.id, output: { note: 'Nothing to look up — that was just a hello / small talk, not a request. Reply yourself in ONE short friendly line (say hi back, ask what they are after) and do not call this tool again until they ask for something.' } });
    return;
  }
  // ONE VOICE (default): run the team in the BACKGROUND and hand the answer back to Aria, who speaks
  // it on her own Realtime leg — the call never leaves her, so the whole call is one voice. The old
  // path (voice swap to the cascaded Chirp specialist) stays as a fallback behind S2S_BACKGROUND_BROWSE=0.
  if (config.s2s.backgroundBrowse) { runBackgroundBrowse(ctl, { request, context: args.context || '', name, callId, fnId: fn.id }); return; }
  // Legacy swap path: the model can fire browse_for_caller twice; honour only the first, ack duplicates.
  if (ctl.lane !== 's2s' || ctl.swapping) {
    logger.info(`call ${callSid}: ignoring duplicate ${name} (lane=${ctl.lane}, swapping=${ctl.swapping})`);
    try { session.sendToolOutput(callId, { toolResponse: { functionResponses: [{ id: fn.id || callId, name, response: { output: { ok: true, note: 'already on it' } } }] } }); } catch {}
    return;
  }
  swapToSpecialist(ctl, { request, context: args.context || '' });
}

/** Return a tool result to the S2S host so it speaks the answer. Shapes differ by vendor: OpenAI
 * Realtime wants a `function_call_output` item; google_s2s wants a `functionResponses` array. */
function sendS2sToolOutput(ctl, { name, callId, fnId, output }) {
  try {
    if (config.s2s.vendor === 'openai') {
      // 13 Nov (hero takes): jambonz issues its own response.create for a tool output. A DEFERRED
      // inject (the "on it" nudge waiting for response.done) could fire in the same 300 ms window →
      // two creates → conversation_already_has_active_response → the leg died. The tool output's
      // response supersedes any pending inject, and the leg is busy from this moment.
      ctl.injectPending = false; clearTimeout(ctl.injectFallback);
      ctl.session.sendToolOutput(callId, { item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } });
      ctl.s2sBusy = true;
    } else {
      ctl.session.sendToolOutput(callId, { toolResponse: { functionResponses: [{ id: fnId || callId, name, response: { output } }] } });
    }
  } catch (err) { logger.warn(`call ${ctl.callSid}: sendS2sToolOutput failed: ${err.message}`); }
}

/** Run browse_for_caller WITHOUT leaving the S2S host's leg: a background Navigator drives the (visible)
 * main tab and the deep model, its reply is CAPTURED (never spoken on a cascaded leg), and we hand that
 * text back to Aria via the tool output so she reads it in her own voice. One voice, Realtime latency. */
async function runBackgroundBrowse(ctl, { request, context, name, callId, fnId }) {
  const { callSid } = ctl;
  if (ctl.browsing) { // one browse at a time on the shared main tab
    logger.info(`call ${callSid}: browse already running, acking duplicate`);
    sendS2sToolOutput(ctl, { name, callId, fnId, output: { note: "Still finishing the previous request — I'll have it in a moment." } });
    return;
  }
  ctl.browsing = true;
  ctl.browseRequest = request;
  const gen = ctl.s2sGen || 0; // which Realtime leg this browse belongs to (a restart bumps it)
  const t0 = Date.now();
  workingAudio(ctl, true); // typing clatter under Aria while the team works
  emitEvent('team.browse', ctl.sessionId, { callSid, request: request.slice(0, 120), model: config.llm.deepModel });
  logger.info(`call ${callSid}: background browse (request="${request.slice(0, 80)}")`);
  // 13 Nov: the Realtime model often fires the tool WITHOUT saying a word first — the caller then
  // sat in 20 s of silence until Huey's "hello? are you still there?". If Aria has not spoken since
  // the caller finished talking (VAD timestamps — the caller's TEXT transcription lands late, which
  // made the transcript order lie and produced a duplicate "on it" over the top of the caller), make
  // her say one short "on it" after a beat; skipped if she or the caller is already talking.
  const askedAt = ctl.lastUserSpeechAt || 0;
  setTimeout(() => {
    if (!calls.has(ctl.callSid) || !ctl.browsing || ctl.swapping) return;
    if ((ctl.lastAssistantAt || 0) > askedAt || ctl.s2sBusy) return;
    injectRealtimeUserText(ctl, '(You went straight to work without a word. Say ONE short natural line right now that you are onto it — e.g. "Yeah, on it — give me a sec" — nothing else, then wait quietly for the result.)');
  }, 1500);
  // 13 Nov (H-07 takes 1+2): a search + pin takes ~25 s and Huey's "hello? are you still there?"
  // lands at ~20 s of silence. One mid-browse beat at 13 s — only if nobody has spoken for 9 s.
  const keepalive = setTimeout(() => {
    if (!calls.has(ctl.callSid) || !ctl.browsing || ctl.swapping || ctl.s2sBusy) return;
    const quietFor = Date.now() - Math.max(ctl.lastAssistantAt || 0, ctl.lastUserSpeechAt || 0);
    if (quietFor < 9000) return;
    // Hero take 3: "Still on it. Nearly there." on every browse tripped the hold-etiquette policy
    // (looped reassurance). Say WHAT is being done instead — content, not reassurance.
    // (Do not quote banned filler here — the model says whatever is quoted; take 6 had "still on it. Nearly there.")
    injectRealtimeUserText(ctl, '(Still working. In ONE short line tell the caller WHAT is being done for them right now — e.g. "Just reading their booking page now" / "Checking the Friday menu". Content only: no line about time, progress or patience; no question; then wait quietly.)');
  }, 13000);
  try {
    const nav = await getSession(ctl.sessionId, {
      channel: 'voice', metadata: { worker: true }, // worker:true keeps it single-task (no Lead/liveSay, which needs a cascaded leg)
      info: { callSid, from: ctl.from, to: ctl.to, direction: ctl.direction, mode: 'background-browse', webClient: Boolean(ctl.webClient) }
    });
    // Async results (e.g. a phone-a-person answer that lands after this turn) are relayed to Aria so she
    // speaks them in her own voice — NOT on a cascaded leg. onPhoneAnswer calls nav.liveSay(answer).
    nav.liveSay = (text) => injectRealtimeRelay(ctl, text);
    nav.metadata = { ...nav.metadata, worker: true }; // self-contained turn (no Lead orchestration)
    const ask = context ? `${request}\n\n(context: ${context})` : request;
    const writer = textWriter();
    const turn = await nav.turn(ask, writer, { kind: 'speech', team: true }); // team:true — the request is Aria's hand-off, not the caller's words
    const answer = (writer.text || '').trim() || "I looked but couldn't find that just now.";
    logger.info(`call ${callSid}: background browse done in ${Date.now() - t0} ms (${answer.length} chars)`);
    // 13 Nov: MULTIMODAL — the team's work is mirrored on the caller's Personal Voice Browser. When
    // this turn put something on it (a page, a list, a pin), tell Aria what is showing so she says
    // so once ("I've pulled that up on your Personal Voice Browser") — unless the answer already does.
    const output = { answer };
    const screenTools = new Set(['navigate', 'web_search', 'click', 'open_tab', 'switch_tab', 'list_options', 'show_to_user', 'drop_pin']);
    const used = (turn?.record?.own_tools || []).filter((t) => t.ok !== false && screenTools.has(t.name)).map((t) => t.name);
    const title = nav.tab?.last?.title || '';
    if (used.length && nav.tab?.url && !/^about:/i.test(nav.tab.url)) {
      output.on_screen = used.includes('drop_pin') ? `a map with a pin dropped on it${title ? ` (${title})` : ''}` : title || nav.tab.host || 'the page';
      if (!/personal voice browser/i.test(answer)) output.note = 'This is showing on the caller\'s Personal Voice Browser now — say so ONCE in your reply, naturally, then carry on.';
    }
    await awaitS2sIdle(ctl);
    // 13 Nov: if Aria's leg was RESTARTED while the team worked, the tool call this answers belongs
    // to a dead session — hand the result over as a message instead, so it is still delivered.
    if ((ctl.s2sGen || 0) !== gen || !callId) {
      logger.info(`call ${callSid}: ${callId ? 'leg restarted mid-browse' : 'no tool call to answer'} — delivering the result as a message`);
      injectRealtimeUserText(ctl, `(Your team is back with the result for "${request.slice(0, 120)}": ${answer}${output.on_screen ? ` — it is showing on the caller's Personal Voice Browser (${output.on_screen}); say so once.` : ''} Deliver it to the caller now, naturally, and carry on.)`);
      return;
    }
    sendS2sToolOutput(ctl, { name, callId, fnId, output });
  } catch (err) {
    logger.error(`call ${callSid}: background browse failed: ${err.stack || err.message}`);
    await awaitS2sIdle(ctl);
    if (!callId) injectRealtimeUserText(ctl, '(That did not work on your team\'s end. Tell the caller you had trouble with that and ask whether they would like you to try again.)');
    else sendS2sToolOutput(ctl, { name, callId, fnId, output: { error: 'That did not work on my end. Tell the caller you had trouble and ask them to try again.' } });
  } finally {
    clearTimeout(keepalive);
    ctl.browsing = false;
    workingAudio(ctl, false);
  }
}

function swapToSpecialist(ctl, { request, context }) {
  const { session, callSid } = ctl;
  ctl.swapping = true;
  ctl.swaps += 1;
  ctl.lane = 'specialist';
  const bridge = BRIDGE_LINES[ctl.swaps % BRIDGE_LINES.length];
  const summary = context || ctl.transcript.slice(-4).map((t) => `${t.role}: ${t.text}`).join(' | ');
  const { agent } = pickSpecialist({ text: request, host: '' });
  emitEvent('lane.swap', ctl.sessionId, { callSid, lane: 'specialist', why: `browse_for_caller: ${request.slice(0, 100)}`, model: config.llm.deepModel, voice: config.tts.voice });
  // The caller only ever hears ARIA — the specialist works behind the scenes (rides along as `worker`).
  emitEvent('speaker', ctl.sessionId, { callSid, agent: { id: HOST.id, name: HOST.name, title: HOST.title, color: HOST.color, role: 'host' }, worker: { id: agent.id, name: agent.name, title: agent.title, color: agent.color }, lane: 'specialist', handing_off: true });
  workingAudio(ctl, true); // 12 Nov: the "on" side was never wired — the caller sat in silence while the specialist worked
  const verbs = [
    sayVerb(bridge),
    agentVerb({ metadata: { mode: 'specialist', handoff: { question: request, summary, transcript: ctl.transcript.slice(-10) } }, greeting: true, session: ctl.sessionId })
  ];
  logger.info(`call ${callSid}: lane s2s -> specialist (request="${request.slice(0, 80)}")`);
  session.sendCommand('redirect', verbs);
  workingAudio(ctl, true); // typing clatter under the specialist until it hands back
  setTimeout(() => { ctl.swapping = false; }, 1500);
}

function onHandback(ctl, payload) {
  const { session, callSid } = ctl;
  if (ctl.lane !== 'specialist') return;
  ctl.swapping = true;
  ctl.swaps += 1;
  ctl.lane = 's2s';
  for (const t of payload.transcript || []) { const last = ctl.transcript.at(-1); if (!last || last.text !== t.text) ctl.transcript.push(t); }
  emitEvent('lane.swap', ctl.sessionId, { callSid, lane: 's2s', why: `handback: ${(payload.summary || '').slice(0, 100)}`, model: config.s2s.model, voice: config.s2s.voice });
  emitEvent('speaker', ctl.sessionId, { callSid, agent: { id: HOST.id, name: HOST.name, title: HOST.title, color: HOST.color, role: 'host' }, lane: 's2s' });
  logger.info(`call ${callSid}: lane specialist -> s2s (summary="${(payload.summary || '').slice(0, 80)}")`);
  workingAudio(ctl, false); // quiet the typing now the host is back on
  // Prepend a spoken line (same voice): the google_s2s resume does not reliably greet on a redirect,
  // which left dead air and the caller hanging up. The say guarantees Aria is heard; s2s then listens.
  const resumeLine = RESUME_LINES[ctl.swaps % RESUME_LINES.length];
  session.sendCommand('redirect', [sayVerb(resumeLine), s2sVerb({ resume: { summary: payload.summary }, transcript: ctl.transcript, callerContext: renderContext(ctl.sessionId) })]);
  setTimeout(() => { ctl.swapping = false; }, 1500);
}

const GOODBYE_RX = /\b(bye|goodbye|good bye|see ya|see you|that'?s (all|it|everything)|that is (all|it|everything)|nothing else|no(,)? (that'?s|thats) (all|it)|i'?m done|we'?re done|all good thanks|cheers bye|hang up)\b/i;
function callerSaidGoodbye(ctl) {
  const lastCaller = [...ctl.transcript].reverse().find((t) => t.role === 'user');
  return Boolean(lastCaller && GOODBYE_RX.test(lastCaller.text || ''));
}
function onS2sDone(ctl, evt) {
  const { session, callSid } = ctl;
  const reason = evt.completion_reason || '';
  note(ctl, 's2s-done', evt);
  logger.info(`call ${callSid}: s2s ended (${reason || 'n/a'})${evt.error ? ` error=${JSON.stringify(evt.error).slice(0, 200)}` : ''}`);
  if (ctl.swapping || ctl.lane === 'specialist') return;
  // Hang up ONLY when the caller actually said goodbye. Gemini Live reports "normal conversation
  // end" both for a real goodbye AND when its session just closes (e.g. a resumed session after a
  // hand-back that does not sustain) — treating every "normal" as a hangup was ending calls on the
  // caller mid-conversation. If there was no goodbye, keep the call alive on the pipeline instead.
  if (callerSaidGoodbye(ctl)) { logger.info(`call ${callSid}: caller said goodbye; hanging up`); session.hangup().reply(); return; }
  // RESUME the same voice first: a swap to the cascaded lane means a different (female Chirp)
  // voice mid-call — jarring (9 Nov: an injected-response collision killed the leg and the
  // caller suddenly heard someone else). Re-establish Aria's own leg with the recent transcript;
  // only after repeated s2s deaths fall back to the cascaded pipeline so the call still survives.
  ctl.s2sRestarts = (ctl.s2sRestarts || 0) + 1;
  ctl.s2sBusy = false; ctl.injectPending = false; clearTimeout(ctl.injectFallback);
  if (ctl.s2sRestarts <= 2) {
    logger.warn(`call ${callSid}: s2s ended (${reason}) with no goodbye; resuming the s2s lane (attempt ${ctl.s2sRestarts})`);
    ctl.lane = 's2s';
    emitEvent('lane.swap', ctl.sessionId, { callSid, lane: 's2s', why: `s2s ended (${reason}) — resuming same voice (${ctl.s2sRestarts})`, model: config.s2s.model, voice: config.s2s.voice });
    const summary = ctl.transcript.slice(-6).map((t) => `${t.role === 'assistant' ? 'You' : 'Caller'}: ${t.text}`).join(' | ').slice(0, 900) || 'the conversation so far';
    // 13 Nov: the resumed model re-did whatever the caller had last asked for — a second browse and a
    // SECOND call to the venue. Tell it what is already in flight so it waits instead of re-firing.
    ctl.s2sGen = (ctl.s2sGen || 0) + 1;
    const inflight = [];
    if (ctl.browsing && ctl.browseRequest) inflight.push(`your team is ALREADY working on "${ctl.browseRequest.slice(0, 140)}" — the result will arrive here as a message`);
    const asks = [...calls.values()].filter((c) => c.mode === 'ask' && c.ownerSession === ctl.sessionId && !c.askFinished).map((c) => c.ivr?.name).concat(pendingAsksFor(ctl.sessionId).map((a) => a.name));
    if (asks.length) inflight.push(`one of your team is ALREADY on the phone to ${[...new Set(asks.filter(Boolean))].join(' / ') || 'them'} for the caller — the outcome will arrive here as a message`);
    session.addVerbs([configVerb(), s2sVerb({ resume: { summary, inflight: inflight.join('; ') }, transcript: ctl.transcript, callerContext: renderContext(ctl.sessionId) })]).reply();
    return;
  }
  logger.warn(`call ${callSid}: s2s ended (${reason}) again; keeping the call alive on the cascaded pipeline`);
  ctl.lane = 'specialist';
  ctl.swaps += 1;
  emitEvent('lane.swap', ctl.sessionId, { callSid, lane: 'specialist', why: `s2s ended (${reason}) — staying on`, model: config.llm.deepModel, voice: config.tts.voice });
  session.addVerbs([
    sayVerb('Still here — what else can I do for you?'),
    agentVerb({ metadata: { mode: 'specialist', handoff: { question: 'Carry on the conversation naturally; ask what they would like to do on the web.', summary: '', transcript: ctl.transcript.slice(-10) } }, greeting: true, session: ctl.sessionId })
  ]).reply();
}
