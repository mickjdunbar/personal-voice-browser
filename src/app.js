// 2026-11-03 (mick-agentic-browser): entrypoint. One HTTP server hosts
//   GET  /                    the console (public/): WebRTC softphone + text box + live view
//   WS   /ui                  console feed (events, transcripts, browser frames) + text turns
//   WS   /harness             jambonz custom-harness protocol (Agent Studio + our agent verbs)
//   WS   /ws                  the conductor (jambonz application: hybrid S2S ⇄ cascaded)
//   GET  /api/health          readiness: models, lanes, KB backend, observability, browser
//   GET  /api/calls           live + recent harness/conductor calls
//   POST /api/calls           ring a phone through the conductor {to, mode?, session?}
//   GET  /api/sessions        navigator sessions
//   POST /api/sessions/:id/text   a text turn (same brain as voice) {text}
//   POST /api/sessions/:id/action a direct browser action from the console {name, args}
//   /api/tasks …              the async text channel: persistent task threads (Tasks drawer)
//   GET  /api/kb/search?q=    knowledge/SOP retrieval (what the agent would see)
//   GET  /api/kb/docs         every SOP + knowledge doc
//   GET  /api/observability   recent sessions / turns / daily counters (Upstash or memory)
// 'dotenv/config' first: static ESM imports are hoisted.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, validateConfig, harnessUrl, conductorUrl } from './config.js';
import { createHarnessServer } from './harness/server.js';
import { createConductor, liveConductorCalls, recentConductorCalls, injectCallerText, registerHarnessInjector, setPendingIntent, notifyControl, hangupSession, claimNextCall } from './conductor/app.js';
import { setContext, getContext, identify } from './context.js';
import { onProfileChange } from './profile.js';
import { setTestTarget, getTestTarget, clearTestTarget } from './phone/testTarget.js';
import { startIvrMap, listIvrMaps, getIvrMap, stopIvrMap, resumeIvrMap } from './phone/ivrmap.js'; // 14 Nov: IVR mapper
import { listBots, publicBots, setBots } from './chat/bots.js';
import { providerMeta } from './chat/providers.js';
import { listServers, publicServers, setServers, presetMeta, findServer } from './mcp/servers.js';
import { probeServer, listToolsFor } from './mcp/client.js';
import { placeCall, registerApplications, jambonz } from './jambonzApi.js';
import { getSession, peekSession, endSession, listSessions } from './agent/sessions.js';
import { listTasks, getTask, createTask, ownerMessage, setStatus, deleteTask, deleteTasks, postNote } from './tasks/store.js';
import { SERVED_TYPES as TASK_MEDIA_TYPES } from './tasks/attachments.js';
import { initTransports, handleInboundMessage } from './tasks/transports.js';
import { initMemorist } from './agent/memorist.js';
import { initScreens, listScreens, clearScreens } from './screens.js';
import { textWriter } from './agent/navigator.js';
import { executeBrowserTool } from './browser/tools.js';
import { getBrowser } from './browser/browser.js';
import { getStore } from './kb/store.js';
import { getObservability } from './observability/store.js';
import { subscribe, recentEvents, clearRecent, emitEvent, readEventLog, eventLogDays } from './events.js';
import { getSettings, updateSettings, resetSettings, recordChange, LANGUAGES } from './settings.js'; // 16 Nov: ambience + language at runtime
import { dialCounts } from './phone/dialCap.js';
import { roster } from './agent/team.js';
import { appLogger as logger } from './logger.js';

const PUBLIC_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf' };
// Task-thread media (screenshots, sketches) saved by tasks/store.attachMedia, one folder per task.
const TASK_MEDIA_DIR = path.resolve(process.env.TASKS_MEDIA_DIR || '.tasks-media');

// Warm each MCP server's tool list in the background so the agent prompt knows what they offer
// (e.g. that the Zapier server can do Gmail) before the caller's first ask.
function warmMcp() {
  for (const s of listServers()) { const full = findServer(s.id); if (full) listToolsFor(full).catch(() => {}); }
}

const harness = createHarnessServer({ path: '/harness' });
const conductor = createConductor({ path: '/ws' });
registerHarnessInjector(harness.injectText); // console text can drive a live call (reply spoken)
const store = getStore();
const obs = getObservability();
let lastRegistration = { skipped: 'not run' };

// --- call recordings (jambonz RecentCalls): list + authenticated audio proxy ----------
let recCache = { at: 0, calls: [], all: [], byId: {} };
// 14 Nov pm: WHICH recordings belong to a session's call is decided by a ledger of call sids, not
// by time. Before this, the list was "everything since the newest call to our PSTN number", so a
// WebRTC recap (dialled to the app, not the number) swept in every task call and IVR-map leg of the
// afternoon. Owner calls (inbound PSTN, WebRTC orb) open an entry; ask legs join their owner's.
const callLedger = new Map(); // ownerSession -> [{ callSid, from, to, direction, startedAt, endedAt, children: [{callSid,to,at}] }] newest first
function ledgerFor(session, callSid) {
  const list = callLedger.get(session) || [];
  return (callSid && list.find((c) => c.callSid === callSid)) || list[0] || null;
}
subscribe((ev) => {
  if (ev.type === 'call.start') {
    if (ev.mode === 'ivrmap') return; // map legs belong to their task thread, never to a call recap
    if (ev.mode === 'ask') { const own = ledgerFor(ev.ownerSession || 'main'); if (own) own.children.push({ callSid: ev.callSid, to: ev.to, at: ev.ts }); return; }
    const list = callLedger.get(ev.sessionId) || [];
    list.unshift({ callSid: ev.callSid, from: ev.from, to: ev.to, direction: ev.direction, startedAt: ev.ts, endedAt: null, children: [] });
    if (list.length > 5) list.length = 5;
    callLedger.set(ev.sessionId, list);
  } else if (ev.type === 'call.end' && ev.mode !== 'ask' && ev.mode !== 'ivrmap') {
    const c = ledgerFor(ev.sessionId, ev.callSid); if (c && !c.endedAt) c.endedAt = ev.ts;
  }
});
/**
 * Recordings for ONE call: the owner's leg plus the ask legs it spawned (by call sid, mirrors
 * folded in). Falls back to a time window when the ledger has no entry (server restarted mid-call):
 * the named call sid plus outbound legs inside [from, to]. `strict` returns [] rather than the
 * account-wide list when nothing can be scoped.
 */
async function recordingsForCall({ session = 'main', call = '', from = 0, to = 0, strict = false } = {}) {
  await recentRecordings();
  const all = recCache.all || [];
  const entry = ledgerFor(session, call);
  const allowed = new Set();
  if (entry) { allowed.add(entry.callSid); for (const ch of entry.children) allowed.add(ch.callSid); }
  if (call) allowed.add(call);
  const winFrom = (entry ? new Date(entry.startedAt).getTime() : Number(from) || 0) - 5000;
  const winTo = (entry?.endedAt ? new Date(entry.endedAt).getTime() : Number(to) || 0) + 90000;
  if (!allowed.size && !(Number(from) > 0)) return strict ? [] : recCache.calls;
  const twinOf = new Map(); for (const r of all) if (r.mirror_of) twinOf.set(r.mirror_of, r.call_sid);
  const inSet = (r) => allowed.has(r.call_sid) || (r.mirror_of && allowed.has(r.mirror_of)) || (twinOf.get(r.call_sid) && allowed.has(twinOf.get(r.call_sid)));
  const inWindow = (r) => !entry && Number(from) > 0 && r.kind === 'outbound' && !/^app-/i.test(String(r.to || '')) && r.t >= winFrom && (!to || r.t <= winTo);
  const ownerSids = new Set([entry?.callSid, call].filter(Boolean));
  return all.filter((r) => inSet(r) || inWindow(r)).map(({ t, ...r }) => ({ ...r, role: ownerSids.has(r.call_sid) || ownerSids.has(r.mirror_of) || ownerSids.has(twinOf.get(r.call_sid)) ? 'owner' : 'child' }));
}
let lastRecap = { at: 0, url: '', task: '', seq: 0 }; // dedupes the auto-recap when two consoles build it
async function recentRecordings(limit = 50) {
  if (Date.now() - recCache.at < 8000) return recCache.calls;
  if (!config.jambonz.apiKey || !config.jambonz.accountSid) return [];
  try {
    const r = await jambonz('GET', `/Accounts/${config.jambonz.accountSid}/RecentCalls?page=1&count=${limit}`);
    const raw = (Array.isArray(r) ? r : (r.data || r.calls || [])).filter((c) => c.recording_url);
    const tOf = (c) => new Date(c.attempted_at || c.answered_at || c.created_at || c.call_created_at || 0).getTime();
    const digits = (s) => String(s || '').replace(/\D/g, ''); // jambonz writes "+61…" on one leg and "61…" on the other
    // 13 Nov: WHICH call is "the caller's call" is decided by the number DIALLED, not by jambonz's
    // direction flag. Sunny (the venue stand-in) lives on this same jambonz account, so Aria's
    // outbound ask-call shows up as an INBOUND call too (to Sunny's number) — the old "newest inbound
    // = the session" anchor then hid the caller's own 173 s call and the hero recap had one audio leg.
    const dialIn = digits(config.phoneAsk.fromNumber || config.jambonz.fromNumber);
    const mapped = raw.map((c) => {
      const sid = c.call_sid || c.sid;
      // 14 Nov pm: a leg dialled to the jambonz application (to = app-…) is the browser caller's own call (the orb).
      const toUs = /^app-/i.test(String(c.to || '')) || (dialIn ? digits(c.to) === dialIn : c.direction === 'inbound');
      return { call_sid: sid, direction: c.direction, from: c.from, to: c.to, duration: c.duration, answered: c.answered, termination: c.termination_reason, at: c.attempted_at || c.answered_at, t: tOf(c), kind: toUs ? 'inbound' : 'outbound', audio: `/api/recording/${sid}` };
    }).sort((a, b) => b.t - a.t);
    // Every call between two apps on this account shows up TWICE (the A leg and the B leg): a synthetic
    // caller dialling in from our caller-ID, or Aria ringing Sunny. Tag the B leg (jambonz direction
    // "inbound" for an outbound ask-call, "outbound" for the caller's call) as a mirror so the console
    // and recap show each call once.
    for (const c of mapped) {
      if (c.mirror_of) continue;
      const twin = mapped.find((i) => i !== c && !i.mirror_of && i.kind === c.kind && digits(i.to) === digits(c.to) && Math.abs(i.t - c.t) < 15000 && Math.abs((i.duration || 0) - (c.duration || 0)) <= 5);
      if (!twin) continue;
      const keep = c.kind === 'inbound' ? (c.direction === 'inbound' ? c : twin) : (c.direction === 'outbound' ? c : twin);
      const drop = keep === c ? twin : c;
      drop.mirror_of = keep.call_sid;
    }
    // Scope to the LAST session: the most recent INBOUND call and every call from then on — i.e. that
    // inbound call plus the outbound calls it spawned. (Older inbound calls = earlier sessions, hidden.)
    const newestInbound = mapped.find((c) => c.kind === 'inbound');
    const anchor = newestInbound ? newestInbound.t - 2000 : 0; // 2s slack for clock skew
    const scoped = newestInbound ? mapped.filter((c) => c.t >= anchor) : mapped.slice(0, 4);
    const calls = scoped.map(({ t, ...c }) => c);
    const byId = {}; for (const c of raw) byId[c.call_sid || c.sid] = c.recording_url;
    recCache = { at: Date.now(), calls, all: mapped, byId };
    return calls;
  } catch (err) { logger.warn(`recordings fetch: ${err.message}`); return recCache.calls; }
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
// 13 Nov: decode the WHOLE body once. `raw += chunk` stringified each network chunk on its own, so a
// multibyte character split across chunks (an em-dash in a memory doc) became U+FFFD "�" on save.
async function readJson(req) { const parts = []; for await (const chunk of req) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); const raw = Buffer.concat(parts).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }

function serveStatic(res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/** A text turn from the console: same Navigator, same tab, same history as a voice call. */
async function textTurn(sessionId, text, { turnId } = {}) {
  // If a voice call is live for this session, treat the typed line as if the caller SPOKE it: the
  // agent answers on the call (the reply is voiced; the typed words are not). The console still sees
  // the whole exchange over the event feed. With no live call, run a normal silent console turn.
  const onCall = await injectCallerText(sessionId, String(text)).catch((err) => ({ ok: false, error: err.message }));
  if (onCall?.ok) { emitEvent('turn.start', sessionId, { channel: 'console', turnId, input: 'text→call', text }); return { reply: '', spoken_on_call: true, routed: onCall.routed, record: { route: `console→${onCall.routed}` }, hangup: false }; }
  const nav = await getSession(sessionId, { channel: 'text', info: { channel: 'text' } });
  const sentences = [];
  const writer = textWriter((s) => { sentences.push(s); emitEvent('tts.chunk', sessionId, { channel: 'text', text: s, turnId }); });
  emitEvent('turn.start', sessionId, { channel: 'text', turnId, input: 'text', text });
  const { record, hangup } = await nav.turn(text, writer, { turnId, kind: 'speech' });
  if (hangup) emitEvent('agent.hangup_requested', sessionId, { channel: 'text', reason: hangup.reason });
  return { reply: writer.text, record, hangup: Boolean(hangup) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' }); return res.end(); }
    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, calls: harness.calls.size });
    if (req.method === 'GET' && p === '/api/health') {
      const ready = Boolean(config.llm.apiKey);
      return json(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'degraded',
        name: 'mick-agentic-browser',
        harness_url: harnessUrl('navigator'),
        conductor_url: conductorUrl(),
        ws_auth: config.wsSecret ? 'token' : 'OPEN',
        harness_auth: config.harnessSecret ? 'bearer' : 'OPEN',
        lanes: { fast: config.llm.fastModel, deep: config.llm.deepModel, s2s: `${config.s2s.vendor}:${config.s2s.model}:${config.s2s.voice}`, tts: `${config.tts.vendor}:${config.tts.voice}`, stt: `${config.stt.vendor}:${config.stt.language}`, vision: config.llm.vision },
        kb: { backend: store.backend, ...store.status },
        observability: await obs.health(),
        browser: getBrowser().status,
        features: { phone_ask: config.phoneAsk.enabled, phone_from: config.phoneAsk.fromNumber || null, chatbots: listBots().map((b) => b.id) },
        // Test-dial redirect state (session main), number masked — pre-run scripts GATE on this
        // (12 Nov: outbound demo calls must never reach a real venue; the switch is in-memory).
        test_dial: (() => { const t = getTestTarget('main'); return { enabled: t.enabled, number: t.number ? `${t.number.slice(0, 4)}…${t.number.slice(-3)}` : '' }; })(),
        jambonz_applications: lastRegistration,
        live_calls: { harness: harness.calls.size, conductor: liveConductorCalls().length },
        dials_last_10min: dialCounts(), // 16 Nov: outbound-dial cap counters per session
        settings: (() => { const s = getSettings(); return { language: s.language.code, ambience: s.ambience }; })(),
        // Open consoles per session — the auto-recap is built BY a console, so a run with none
        // attached (a scripted test) gets no recap unless the launcher opens one.
        consoles: [...uiClients].reduce((m, c) => { m[c.sessionId] = (m[c.sessionId] || 0) + 1; return m; }, {}),
        sessions: listSessions()
      });
    }
    if (req.method === 'GET' && p === '/api/calls') return json(res, 200, { harness: harness.live(), harness_recent: harness.recent(), conductor: liveConductorCalls(), conductor_recent: recentConductorCalls() });
    if (req.method === 'POST' && p === '/api/calls') { const body = await readJson(req); return json(res, 201, await placeCall(body)); }
    if (req.method === 'GET' && p === '/api/sessions') return json(res, 200, { sessions: listSessions() });
    const m = /^\/api\/sessions\/([^/]+)\/(text|action|end|page|tabs|screens)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'text' && req.method === 'POST') { const body = await readJson(req); if (!body.text) return json(res, 400, { error: 'text required' }); return json(res, 200, await textTurn(id, String(body.text), { turnId: body.turnId })); }
      if (m[2] === 'action' && req.method === 'POST') {
        const body = await readJson(req);
        const nav = await getSession(id, { channel: 'text', info: { channel: 'text' } });
        emitEvent('tool.call', id, { channel: 'console', name: body.name, args: body.args || {} });
        const t0 = Date.now();
        const result = await executeBrowserTool(body.name, body.args || {}, { tab: nav.tab, state: nav.state, emit: (t, d) => nav.emit(t, d), log: nav.log });
        const { page_state, ...summary } = result;
        emitEvent('tool.result', id, { channel: 'console', name: body.name, ms: Date.now() - t0, result: summary, url: nav.tab?.url, title: nav.tab?.last?.title });
        if (nav.tab?.last) nav.emit('browser.page', { url: nav.tab.url, title: nav.tab.last.title });
        return json(res, 200, { ok: true, result: summary });
      }
      if (m[2] === 'page' && req.method === 'GET') { const nav = peekSession(id); return json(res, 200, nav?.tab?.last || null); }
      if (m[2] === 'tabs' && req.method === 'GET') return json(res, 200, { tabs: getBrowser().tabList(id) });
      // Every page the browser landed on this session (one jpeg per page) — for the shareable recap.
      if (m[2] === 'screens' && req.method === 'GET') return json(res, 200, { screens: listScreens(id, { withImages: url.searchParams.get('images') !== '0' }) });
      if (m[2] === 'end' && req.method === 'POST') { await endSession(id, 'console'); return json(res, 200, { ok: true }); }
    }
    // 13 Nov: shareable recaps — the console builds the self-contained HTML and uploads it here;
    // it is hosted at /recaps/<file> (reachable via the tunnel) and the link is posted into the
    // most recent task thread (or a fresh "Showcase recap" task), which forwards to WhatsApp.
    if (req.method === 'POST' && p === '/api/recaps') {
      const b = await readJson(req);
      const html = String(b?.html || '');
      if (html.length < 200 || html.length > 25 * 1024 * 1024) return json(res, 400, { error: 'html required (up to 25 MB)' });
      const dir = path.join(PUBLIC_DIR, 'recaps');
      fs.mkdirSync(dir, { recursive: true });
      const name = `recap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}.html`;
      fs.writeFileSync(path.join(dir, name), html, 'utf8');
      const base = config.publicHost && !/^(localhost|127\.0\.0\.1)/.test(config.publicHost) ? `https://${config.publicHost}` : `http://localhost:${config.port}`;
      const recapUrl = `${base}/recaps/${name}`;
      // Two consoles on the same session (yours + the launcher's headless one) both auto-build after a
      // call: keep the second file, but post ONE link — the first one's.
      if (Date.now() - lastRecap.at < 120000 && lastRecap.url) { logger.info(`recap saved ${name} (duplicate within 2 min — link already posted)`); return json(res, 201, { ok: true, url: lastRecap.url, deduped: true, task: lastRecap.task, seq: lastRecap.seq }); }
      const since = Date.now() - 12 * 3600 * 1000;
      const target = listTasks().filter((t) => new Date(t.updated_at).getTime() >= since).sort((a, c) => new Date(c.updated_at) - new Date(a.updated_at))[0]
        || createTask({ title: `Showcase recap ${new Date().toLocaleDateString('en-AU')}`, text: '', via: 'console' });
      postNote(target.id, `📎 Shareable recap of ${String(b?.title || 'this session').slice(0, 60)} is ready (audio, screens, calls, messages, tasks): ${recapUrl}`);
      logger.info(`recap saved ${name} (${Math.round(html.length / 1024)} KB) → task #${target.seq}`);
      lastRecap = { at: Date.now(), url: recapUrl, task: target.id, seq: target.seq };
      return json(res, 201, { ok: true, url: recapUrl, task: target.id, seq: target.seq });
    }
    // 14 Nov: IVR mapper — chart a business's phone menu by DTMF (progress + result land in an Async task).
    //   POST /api/ivr/map {to, name?, max_depth?, max_calls?, task_id?}  → 202 {map}
    //   GET  /api/ivr/maps · GET /api/ivr/maps/:id · POST /api/ivr/maps/:id/stop
    if (p === '/api/ivr/map' && req.method === 'POST') {
      const b = await readJson(req);
      const r = await startIvrMap({ to: b.to, name: b.name, maxDepth: b.max_depth, maxCalls: b.max_calls, taskId: b.task_id || null, via: 'console' });
      return json(res, r.error ? 400 : 202, r);
    }
    if (p === '/api/ivr/maps' && req.method === 'GET') return json(res, 200, { maps: listIvrMaps() });
    const im = /^\/api\/ivr\/maps\/([^/]+)(?:\/(stop|resume))?$/.exec(p);
    if (im) {
      const id = decodeURIComponent(im[1]);
      if (!im[2] && req.method === 'GET') { const m = getIvrMap(id); return json(res, m ? 200 : 404, m || { error: 'no such map' }); }
      if (im[2] === 'stop' && req.method === 'POST') { const r = stopIvrMap(id); return json(res, r.error ? 404 : 200, r); }
      if (im[2] === 'resume' && req.method === 'POST') { const b = await readJson(req).catch(() => ({})); const r = resumeIvrMap(id, { extraCalls: b?.extra_calls }); return json(res, r.error ? 400 : 202, r); }
    }
    // 14 Nov: the test-dial redirect over HTTP (same power as the console switch on the WebSocket):
    //   GET /api/test-dial?session=… · POST {session?, enabled, number} · DELETE ?session=… (drop a
    //   session's override so it inherits `main` again; `main` itself can only be set).
    if (p === '/api/test-dial') {
      const s = url.searchParams.get('session') || 'main';
      if (req.method === 'GET') return json(res, 200, { session: s, ...getTestTarget(s) });
      if (req.method === 'POST') { const b = await readJson(req); const sid = String(b.session || 'main'); const t = setTestTarget(sid, { enabled: b.enabled, number: b.number }); logger.info(`test-dial ${sid}: ${t.enabled ? 'ON -> ' + t.number.replace(/\d(?=\d{3})/g, '•') : 'off'} (via API)`); return json(res, 200, { session: sid, ...t }); }
      if (req.method === 'DELETE') { const r = clearTestTarget(s); logger.info(`test-dial ${s}: override cleared (via API)`); return json(res, r.error ? 400 : 200, r); }
    }
    // Tasks: the async text channel (the console's Tasks drawer; transport-agnostic server-side).
    if (p === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: listTasks() });
    if (p === '/api/tasks' && req.method === 'POST') {
      const b = await readJson(req);
      if (!String(b.text || b.title || '').trim() && !(Array.isArray(b.attachments) && b.attachments.length)) return json(res, 400, { error: 'text, title or attachments required' });
      const task = createTask(b);
      return task.error ? json(res, 400, task) : json(res, 201, { task });
    }
    // Bulk delete (14 Nov): body {ids:[…]} deletes those, {all:true} deletes every task. Nothing implicit.
    if (p === '/api/tasks' && req.method === 'DELETE') {
      const b = await readJson(req);
      if (b.all === true) return json(res, 200, deleteTasks(null));
      if (!Array.isArray(b.ids) || !b.ids.length) return json(res, 400, { error: 'ids[] or all:true required' });
      return json(res, 200, deleteTasks(b.ids));
    }
    const tm = /^\/api\/tasks\/([^/]+)(?:\/(message|status))?$/.exec(p);
    if (tm) {
      const id = decodeURIComponent(tm[1]);
      if (!tm[2] && req.method === 'GET') { const t = getTask(id); return json(res, t ? 200 : 404, t || { error: 'no such task' }); }
      if (!tm[2] && req.method === 'DELETE') { const r = deleteTask(id); return json(res, r.error ? 404 : 200, r); }
      if (tm[2] === 'message' && req.method === 'POST') { const b = await readJson(req); const r = ownerMessage(id, b.text, b.via || 'console', b.attachments); return json(res, r.error ? 400 : 200, r); }
      if (tm[2] === 'status' && req.method === 'POST') { const b = await readJson(req); const r = setStatus(id, b.status); return json(res, r.error ? 400 : 200, r); }
    }
    // Tasks over SMS/WhatsApp: the Twilio Messaging webhook ("A MESSAGE COMES IN" on the number
    // / the WhatsApp sandbox → https://<PUBLIC_HOST>/webhooks/message). Owner-only; always 200 TwiML.
    if (req.method === 'POST' && /^\/webhooks\/(message|sms|whatsapp)$/.test(p)) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const r = await handleInboundMessage({ raw, headers: req.headers, path: p });
      res.writeHead(r.status || 200, { 'Content-Type': 'text/xml' });
      return res.end(r.twiml || '');
    }
    // Images attached to task threads (screenshots, sketches). SVGs are model-authored: the CSP
    // header keeps them inert even if opened directly rather than through an <img>.
    // 14 Nov: owner attachments too (pdf/txt/md/csv/json/docx + gif/webp). Uploaded HTML is served
    // as plain text and docx as a download, so nothing an owner pastes ever runs in the console origin.
    const mediaM = /^\/task-media\/([A-Za-z0-9]+)\/([a-z0-9]+\.([a-z0-9]+))$/.exec(p);
    if (req.method === 'GET' && mediaM && TASK_MEDIA_TYPES[mediaM[3]]) {
      const file = path.join(TASK_MEDIA_DIR, mediaM[1], mediaM[2]);
      if (!file.startsWith(TASK_MEDIA_DIR) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const type = TASK_MEDIA_TYPES[mediaM[3]];
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        ...(mediaM[3] === 'svg' || mediaM[3] === 'pdf' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}),
        ...(mediaM[3] === 'docx' ? { 'Content-Disposition': 'attachment' } : {})
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/kb/search') { const q = url.searchParams.get('q') || ''; const kind = url.searchParams.get('kind') || undefined; return json(res, 200, await store.search(q, { kind, topK: Number(url.searchParams.get('k')) || 5 })); }
    if (req.method === 'GET' && p === '/api/team') return json(res, 200, { agents: roster() });
    if (req.method === 'GET' && p === '/api/bots') return json(res, 200, { bots: publicBots(), providers: providerMeta() });
    if (req.method === 'GET' && p === '/api/providers') return json(res, 200, { providers: providerMeta() });
    if (req.method === 'GET' && p === '/api/mcp') return json(res, 200, { servers: publicServers(), presets: presetMeta() });
    if (req.method === 'GET' && p === '/api/recordings') {
      // ?session=&call=&from=&to=&strict=1 → that call's legs only (14 Nov pm); bare → the legacy account-wide list.
      const q = url.searchParams;
      if (q.get('session') || q.get('call')) return json(res, 200, { recordings: await recordingsForCall({ session: q.get('session') || 'main', call: q.get('call') || '', from: q.get('from'), to: q.get('to'), strict: q.get('strict') === '1' }), scoped: true });
      return json(res, 200, { recordings: await recentRecordings() });
    }
    if (req.method === 'GET' && p === '/api/calls/ledger') return json(res, 200, { sessions: Object.fromEntries([...callLedger.entries()]) });
    const rm = p.match(/^\/api\/recording\/([a-f0-9-]{8,})$/i);
    if (req.method === 'GET' && rm) {
      await recentRecordings();
      const recUrl = recCache.byId[rm[1]];
      if (!recUrl) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no recording'); }
      const up = await fetch(config.jambonz.apiBase + '/v1' + recUrl, { headers: { Authorization: `Bearer ${config.jambonz.apiKey}` } });
      if (!up.ok) { res.writeHead(up.status, { 'Content-Type': 'text/plain' }); return res.end('recording unavailable'); }
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'GET' && p === '/api/kb/docs') return json(res, 200, { backend: store.backend, status: store.status, sops: store.sops.map(d => ({ id: d.id, title: d.title, triggers: d.triggers, tags: d.tags, priority: d.priority, always: d.always, sites: d.sites, body: d.body })), knowledge: store.knowledge.map(d => ({ id: d.id, title: d.title, tags: d.tags, sites: d.sites, body: d.body })), memory: store.memory.map(d => ({ id: d.id, title: d.title, tags: d.tags, body: d.body, meta: d.meta })) });
    // KB admin (the console's Knowledge drawer): create/update + delete. Docs are markdown files
    // on disk (the source of truth); each save/delete rewrites the file and re-indexes Qdrant.
    if (req.method === 'POST' && p === '/api/kb/docs') { const b = await readJson(req); const r = await store.saveDoc({ ...(b || {}), by: String(b?.by || 'console') }); return json(res, r.error ? 400 : 200, r); }
    if (req.method === 'DELETE' && p === '/api/kb/docs') { const r = await store.removeDoc(url.searchParams.get('kind') || '', url.searchParams.get('id') || ''); return json(res, r.error ? 400 : 200, r); }
    if (req.method === 'GET' && p === '/api/observability') { const id = url.searchParams.get('session'); if (id) return json(res, 200, { session: id, turns: await obs.turns(id) }); return json(res, 200, { backend: obs.backend, health: await obs.health(), daily: await obs.daily(), sessions: await obs.recentSessions(20) }); }
    if (req.method === 'GET' && p === '/api/events') {
      // 16 Nov: ?day=YYYY-MM-DD reads the persisted log (plus session=, type=a,b, since=ISO, limit=); no day = the live ring.
      const day = url.searchParams.get('day');
      if (day) return json(res, 200, { day, events: readEventLog({ day, session: url.searchParams.get('session') || '', type: url.searchParams.get('type') || '', since: url.searchParams.get('since') || '', limit: Number(url.searchParams.get('limit')) || 2000 }) });
      return json(res, 200, { events: recentEvents().filter((e) => e.type !== 'browser.frame') });
    }
    if (req.method === 'GET' && p === '/api/events/days') return json(res, 200, { days: eventLogDays() });
    // 16 Nov: runtime settings (ambience mix, call language) — the Talk Settings drawer and Aria both edit these.
    if (p === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, { ...getSettings(), languages: LANGUAGES });
      if (req.method === 'PUT' || req.method === 'POST') {
        const b = await readJson(req);
        try {
          const r = updateSettings(b || {}, { by: 'console' });
          if (r.changed.length) emitEvent('settings.changed', null, { what: r.changed.some((c) => c.field.startsWith('language')) ? 'language' : 'ambience', action: 'set', by: 'console', changes: r.changed, name: r.changed.map((c) => `${c.field.split('.').pop()} → ${c.to}`).join(', ') });
          return json(res, 200, { ...r.settings, changed: r.changed, languages: LANGUAGES });
        } catch (err) { return json(res, 400, { error: err.message }); }
      }
      if (req.method === 'DELETE') { const r = resetSettings({ by: 'console' }); emitEvent('settings.changed', null, { what: 'ambience', action: 'reset', by: 'console', name: 'back to .env defaults' }); return json(res, 200, { ...r.settings, languages: LANGUAGES }); }
    }
    // 16 Nov: is anything live that a restart would kill? scripts/dev.mjs defers restarts while this says busy.
    if (req.method === 'GET' && p === '/api/busy') {
      const reasons = [];
      if (harness.calls.size) reasons.push(`${harness.calls.size} harness call(s)`);
      const live = liveConductorCalls().length; if (live) reasons.push(`${live} live call(s)`);
      const maps = listIvrMaps().filter((m) => m.status === 'running').length; if (maps) reasons.push(`${maps} IVR map(s) running`);
      // A turn that has shown no sign of life for 10 min is wedged, not busy — never let it block a restart forever.
      const working = listTasks().filter((t) => t.status === 'working' && Date.now() - new Date(t.updated_at || 0).getTime() < 10 * 60 * 1000).length; if (working) reasons.push(`${working} task turn(s) in flight`);
      return json(res, 200, { busy: reasons.length > 0, reasons });
    }
    if (req.method === 'POST' && p === '/api/events/clear') { clearRecent(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (err) {
    logger.error(`${req.method} ${p} failed: ${err.stack || err.message}`);
    json(res, err.status || 500, { error: err.message });
  }
});

// --- console WebSocket (/ui): feed out, text turns + actions in -------------
const uiWss = new WebSocketServer({ noServer: true });
// Every open console, so an edit to a signed-in user's long-term memory on one
// device can be pushed live to their OTHER devices (same email, different session).
const uiClients = new Set(); // { sessionId, email, send }
// 15 Nov: Aria changed Talk Settings (talk_settings tool) — refresh the drawer on every open console.
subscribe((ev) => {
  if (ev.type !== 'settings.changed') return;
  // 16 Nov: every change goes in the settings change log, so the next call can open with "what changed".
  const label = ev.what === 'test_dial' ? `test-dial ${ev.enabled ? 'ON → ' + (ev.number || '') : 'OFF'}` : `${ev.what === 'bots' ? 'chatbot' : ev.what === 'mcp' ? 'MCP server' : ev.what} ${String(ev.action || '').replace(/_.*/, '')} ${ev.name || ev.id || ''}`.trim();
  recordChange({ what: ev.what, label, by: ev.by || (ev.sessionId ? 'aria' : 'console') });
  if (ev.what === 'bots') for (const c of uiClients) c.send({ kind: 'bots', bots: publicBots() });
  else if (ev.what === 'mcp') { for (const c of uiClients) c.send({ kind: 'mcp', servers: publicServers() }); warmMcp(); }
  else if (ev.what === 'test_dial') for (const c of uiClients) c.send({ kind: 'test_dial', ...getTestTarget(c.sessionId) });
  else if (ev.what === 'ambience' || ev.what === 'language') for (const c of uiClients) c.send({ kind: 'settings', ...getSettings() });
});
onProfileChange(({ email, text, remember, sourceSession }) => {
  for (const c of uiClients) {
    if (c.email && c.email === email && c.sessionId !== sourceSession) c.send({ kind: 'context_sync', text, remember });
  }
});
uiWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || 'main';
  const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
  const client = { sessionId, email: null, send };
  uiClients.add(client);
  // Each console only sees ITS OWN session's events — so a call on one device (e.g. the phone app,
  // session `app-xxxx`) doesn't light up every other open console. A global event (no sessionId) is
  // shown to all; background-browse/worker sub-sessions (`<session>#w-1`) count as this session's.
  const forSession = (ev) => !ev.sessionId || ev.sessionId === sessionId || String(ev.sessionId).startsWith(`${sessionId}#`);
  // 14 Nov pm: WATCH — the console asks to see one task session's browser (`{type:'watch', session:'task-…'}`)
  // while that thread is open in the Async drawer. Only browser.* events of the watched session are
  // forwarded, tagged `watched`, so the pane can mirror a background task without touching main state.
  // Before this a task agent said "it's on your Personal Voice Browser" and the pane stayed empty.
  let watched = '';
  const WATCHED_TYPES = new Set(['browser.frame', 'browser.page', 'browser.tabs']);
  const forWatched = (ev) => watched && WATCHED_TYPES.has(ev.type) && (ev.sessionId === watched || String(ev.sessionId || '').startsWith(`${watched}#`));
  for (const ev of recentEvents()) if (forSession(ev)) send({ kind: 'event', event: ev });
  const unsub = subscribe((ev) => { if (forSession(ev)) send({ kind: 'event', event: ev }); else if (forWatched(ev)) send({ kind: 'event', event: { ...ev, watched: true } }); });
  // test_dial rides on hello: the SERVER is the source of truth for the redirect (13 Nov — consoles
  // used to replay their own saved switch on every connect, so a fresh browser profile DISARMED it).
  send({ kind: 'hello', sessionId, harness_url: harnessUrl('navigator'), conductor_url: conductorUrl(), team: roster(), bots: listBots(), mcp: listServers(), test_dial: getTestTarget(sessionId), settings: getSettings() });
  // Push the current browser frame so a freshly opened console is not staring at a black panel,
  // and the current tab list so the tab strip restores (sent directly: emitTabs dedupes repeats).
  peekSession(sessionId)?.tab?.frame().catch(() => {});
  send({ kind: 'event', event: { type: 'browser.tabs', sessionId, ts: new Date().toISOString(), tabs: getBrowser().tabList(sessionId) } });
  // Keep the pane honest while a console is open: a gentle refresh catches late SPA paints and
  // page changes between tool calls (the turn-time 900ms ticker only runs DURING a deep turn —
  // outside one, a stale white frame used to sit there forever).
  const frameTick = setInterval(() => {
    const tab = peekSession(sessionId)?.tab;
    if (tab && tab.url && tab.url !== 'about:blank') tab.frame().catch(() => {});
    const wt = watched ? peekSession(watched)?.tab : null;
    if (wt && wt.url && wt.url !== 'about:blank') wt.frame().catch(() => {});
  }, 2500);
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.type === 'text' && msg.text) { const r = await textTurn(msg.session || sessionId, String(msg.text), { turnId: msg.turnId }); send({ kind: 'reply', turnId: msg.turnId, ...r }); }
      else if (msg.type === 'action' && msg.name) {
        const id = msg.session || sessionId;
        const nav = await getSession(id, { channel: 'text', info: { channel: 'text' } });
        emitEvent('tool.call', id, { channel: 'console', name: msg.name, args: msg.args || {} });
        const t0 = Date.now();
        const result = await executeBrowserTool(msg.name, msg.args || {}, { tab: nav.tab, state: nav.state, emit: (t, d) => nav.emit(t, d), log: nav.log });
        const { page_state, ...summary } = result;
        emitEvent('tool.result', id, { channel: 'console', name: msg.name, ms: Date.now() - t0, result: summary, url: nav.tab?.url, title: nav.tab?.last?.title });
        if (nav.tab?.last) nav.emit('browser.page', { url: nav.tab.url, title: nav.tab.last.title });
        send({ kind: 'action', id: msg.id, result: summary });
      }
      else if (msg.type === 'frame') { const nav = peekSession(msg.session || sessionId); await nav?.tab?.frame(); }
      else if (msg.type === 'watch') {
        watched = /^task-[a-z0-9]+$/i.test(String(msg.session || '')) ? String(msg.session) : '';
        const nav = watched ? peekSession(watched) : null;
        send({ kind: 'watch', session: watched, live: !!(nav?.tab?.url && nav.tab.url !== 'about:blank'), url: nav?.tab?.url || '', title: nav?.tab?.last?.title || '' });
        if (nav?.tab) { send({ kind: 'event', event: { type: 'browser.tabs', sessionId: watched, watched: true, ts: new Date().toISOString(), tabs: getBrowser().tabList(watched) } }); nav.tab.frame().catch(() => {}); }
      }
      // Tab strip: the user opens/switches/closes tabs in the SAME group the agent browses in.
      else if (msg.type === 'tab' && msg.action) {
        const id = msg.session || sessionId;
        const nav = await getSession(id, { channel: 'text', info: { channel: 'text' } });
        if (msg.action === 'new') await getBrowser().newTab(id, { url: msg.url || '' });
        else if (msg.action === 'switch') getBrowser().switchTab(id, msg.tab);
        else if (msg.action === 'close') await getBrowser().closeTabAt(id, msg.tab ?? null);
        const t = nav.tab;
        // Only announce a REAL page (a fresh blank tab must not collapse the console pane).
        if (t && t.url && t.url !== 'about:blank') nav.emit('browser.page', { url: t.url, title: t.last?.title || '' });
      }
      // "Take control": the caller drives the live page directly from the console frame (click / scroll /
      // type). Forward to the real Playwright page, then push a fresh frame so they see the result fast.
      else if (msg.type === 'browser_input') {
        const nav = peekSession(msg.session || sessionId); const tab = nav?.tab;
        if (tab) {
          try {
            if (msg.action === 'click') await tab.userClick(msg.x, msg.y, { button: msg.button, clicks: msg.clicks });
            else if (msg.action === 'move') await tab.userMove(msg.x, msg.y);
            else if (msg.action === 'scroll') await tab.userScroll(msg.dy || 0);
            else if (msg.action === 'scrollTo') await tab.userScrollTo(msg.frac);
            else if (msg.action === 'type') await tab.userType(msg.text);
            else if (msg.action === 'key') await tab.userKey(msg.key);
          } catch (err) { logger.debug(`browser_input ${msg.action} failed: ${err.message}`); }
          tab.frame().catch(() => {});
        }
      }
      // A typed message that STARTS a call: stash it as the call's opening request so the greeting
      // addresses it (consumed in the conductor's onSession when the call connects).
      else if (msg.type === 'call_intent' && msg.text) { setPendingIntent(msg.session || sessionId, String(msg.text)); }
      else if (msg.type === 'control' && msg.state) {
        const r = notifyControl(msg.session || sessionId, msg.state);
        // No live voice call to relay through (text session, or the call already ended): drive the
        // navigator directly, so handing the screen back still resumes the task instead of stalling.
        if (!r?.ok && msg.state === 'released') {
          textTurn(msg.session || sessionId, '(I have just driven the browser myself and handed it back to you. Take a fresh look at the current page and carry on with the task in progress — do not ask, just continue.)')
            .catch((err) => logger.warn(`control-release resume failed: ${err.message}`));
        }
      }
      else if (msg.type === 'context') { setContext(msg.session || sessionId, { text: msg.text, remember: msg.remember }); }
      else if (msg.type === 'identify') { const r = identify(msg.session || sessionId, msg.email); client.email = r.email; send({ kind: 'identity', email: r.email, text: r.text, remember: r.remember }); }
      else if (msg.type === 'test_dial') { setTestTarget(msg.session || sessionId, { enabled: msg.enabled, number: msg.number }); }
      else if (msg.type === 'call_claim') { claimNextCall(msg.session || sessionId); }
      else if (msg.type === 'hangup') { const r = hangupSession(msg.session || sessionId); send({ kind: 'hangup_result', ...r }); }
      else if (msg.type === 'bots') { setBots(msg.bots); send({ kind: 'bots', bots: publicBots() }); }
      else if (msg.type === 'mcp') { setServers(msg.servers); send({ kind: 'mcp', servers: publicServers() }); warmMcp(); }
      else if (msg.type === 'mcp_probe') { const r = await probeServer(msg.server || {}); send({ kind: 'mcp_probe', ok: !r.error, error: r.error, tools: (r.tools || []).map((t) => t.name), serverInfo: r.serverInfo }); }
      else if (msg.type === 'clear') {
        clearRecent();
        clearScreens(msg.session || sessionId);
        peekSession(msg.session || sessionId)?.clearBrowser().catch((err) => logger.warn(`browser clear failed: ${err.message}`));
      }
    } catch (err) { send({ kind: 'error', error: err.message, turnId: msg.turnId }); logger.warn(`ui message failed: ${err.message}`); }
  });
  ws.on('close', () => { unsub(); uiClients.delete(client); clearInterval(frameTick); });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/ui') { uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit('connection', ws, req)); return; }
  if (harness.handleUpgrade(req, socket, head)) return;
  if (conductor.handleUpgrade(req, socket, head)) return;
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
});

validateConfig(logger);
server.listen(config.port, async () => {
  logger.info(`mick-agentic-browser on http://localhost:${config.port} | harness ${harnessUrl('navigator')} | conductor ${conductorUrl()} | fast=${config.llm.fastModel} deep=${config.llm.deepModel} s2s=${config.s2s.vendor}:${config.s2s.voice}`);
  store.init().then(() => logger.info(`KB: ${store.chunks.length} chunks from ${store.docs.length} docs; backend=${store.backend}; qdrant=${store.status.qdrant}; embeddings=${store.status.embeddings}`)).catch((err) => logger.warn(`KB init failed: ${err.message}`));
  obs.health().then((h) => logger.info(`observability: ${JSON.stringify(h)}`));
  warmMcp(); // pre-fetch MCP servers' tool lists so the agent knows their capabilities up front
  initTransports(); // tasks over SMS/WhatsApp: forward Aria's task replies to the owner's phone
  initMemorist(); // long-term memory: distil self-learnings after each session, notify the owner
  initScreens();  // one screenshot per page visited, per session — for the shareable recap
  if (config.jambonz.selfRegister) {
    try { lastRegistration = await registerApplications(); logger.info(`jambonz self-register: ${JSON.stringify(lastRegistration)}`); }
    catch (err) { lastRegistration = { error: err.message }; }
  } else lastRegistration = { skipped: 'JAMBONZ_SELF_REGISTER=false' };
  // Warm the browser so the first call does not pay the launch cost.
  if (!process.env.BROWSER_LAZY) getBrowser().launch().then(() => getSession('main', { channel: 'text', info: { channel: 'boot' } })).catch((err) => logger.warn(`browser warm-up failed: ${err.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { logger.info('shutting down'); await getBrowser().close().catch(() => {}); process.exit(0); });
