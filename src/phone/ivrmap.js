// 2026-11-14 (mick-agentic-browser): IVR MAPPER — chart a business's automated phone
// menu. The owner names a number ("map the HCF IVR on 13 13 34"); we ring it, listen
// to the whole prompt, have the fast model pull out the "press 1 for…" options, then
// ring AGAIN for every option, replaying the key path (IVRs rarely let you go back),
// breadth-first, until the tree is mapped or the call/depth budget is spent. Progress
// lands in an Async task thread; the result is a hosted page (SVG tree + every prompt
// transcript + Mermaid source) and the SVG attached to the thread.
//
// Safety: only a number the owner typed is ever dialled; emergency numbers are refused;
// the console's test-dial redirect applies exactly as it does to every other outbound
// call (session `ivrmap`, inheriting `main` unless overridden); nothing is ever SAID to
// the far end except a one-line apology if a human picks up, then we hang up.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { jambonz } from '../jambonzApi.js';
import { emitEvent } from '../events.js';
import { completeText } from '../llm/client.js';
import { createLogger } from '../logger.js';
import { effectiveDial } from './testTarget.js';
import { normalizeE164 } from './ask.js';
import { callOptions, trackDial, describeDialFailure, timeoutHint, isAuShortNumber } from './callStatus.js'; // 16 Nov
import { recognizer, configVerb, sayVerb, hangupVerb } from '../conductor/verbs.js';

const logger = createLogger('IvrMap');
export const IVRMAP_SESSION = 'ivrmap';
const DIR = process.env.IVR_MAPS_DIR || '.ivr-maps';
const PUBLIC_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../public');
const EMERGENCY = new Set(['000', '911', '112', '999', '111', '108', '119', '110', '101', '102']);
const NAV_RE = /\b(repeat|hear (these|the|those|this) (options|menu)|again|previous menu|main menu|go back|return to)\b/i;

const maps = new Map();      // id -> map
const legs = new Map();      // `${mapId}|${path}` -> { resolve }

// --- persistence (one JSON per map, so a restart keeps what was mapped) -------------
function save(m) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `${m.id}.json`), JSON.stringify(m, null, 1)); }
  catch (err) { logger.warn(`map ${m.id} not saved: ${err.message}`); }
}
(function load() {
  const killed = [];
  try {
    if (!fs.existsSync(DIR)) return;
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
      const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!m?.id) continue;
      if (m.status === 'running') { m.status = 'stopped'; m.error = 'server restarted mid-map'; killed.push(m); }
      maps.set(m.id, m);
    }
    if (maps.size) logger.info(`loaded ${maps.size} IVR map(s) from ${DIR}`);
    // 14 Nov pm: say so in the thread (before this, a restart-killed map looked "still running" to the
    // owner AND to Aria, who answered from the chat history). Deferred so tasks/store is importable.
    if (killed.length) setTimeout(() => { for (const m of killed) finalize(m).catch((err) => logger.warn(`map ${m.id}: post-restart finalize failed: ${err.message}`)); }, 4000);
  } catch (err) { logger.warn(`maps load failed: ${err.message}`); }
})();

const pub = (m) => ({
  id: m.id, name: m.name, to: m.to, dialed: m.dialed, redirected: m.redirected, status: m.status, error: m.error || null,
  created_at: m.created_at, updated_at: m.updated_at, calls: m.calls, max_calls: m.max_calls, max_depth: m.max_depth,
  nodes: Object.keys(m.nodes).length, queued: m.queue.length, task: m.taskId || null, page: m.page || null
});
export function listIvrMaps() { return [...maps.values()].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).map(pub); }
export function getIvrMap(id) { const m = maps.get(id); return m ? { ...pub(m), nodes: m.nodes, queue: m.queue, mermaid: m.mermaid || null } : null; }
export function stopIvrMap(id) { const m = maps.get(id); if (!m) return { error: 'no such map' }; if (m.status === 'running') { m.status = 'stopped'; m.error = 'stopped by the owner'; touch(m); } return { ok: true, map: pub(m) }; }
function touch(m) { m.updated_at = new Date().toISOString(); save(m); emitEvent('ivrmap.update', IVRMAP_SESSION, { map: pub(m) }); }

/** Branches still to ring: the queue plus any node whose call was cut off (explored=false, nothing heard). */
function pendingPaths(m) {
  const cut = Object.values(m.nodes).filter((n) => !n.explored && !m.queue.includes(n.path)).map((n) => n.path);
  return [...cut, ...m.queue];
}

/**
 * 14 Nov pm: carry a stopped/failed map on from where it stopped — same record, same thread, the
 * interrupted branch first, then the queue. `extraCalls` tops up the call budget when it was spent.
 */
export function resumeIvrMap(id, { extraCalls = 0 } = {}) {
  const m = maps.get(String(id || ''));
  if (!m) return { error: 'no such map' };
  if (m.status === 'running') return { error: 'that map is already running', map: pub(m) };
  const running = [...maps.values()].find((x) => x.status === 'running');
  if (running) return { error: `a map is already running (${running.name || running.to}) — one at a time`, map: pub(running) };
  const pre = checkIvrTarget(m.to);
  if (pre) return { error: pre };
  const left = pendingPaths(m);
  if (!left.length) return { error: 'nothing left to ring on that map — every branch within the depth limit was explored', map: pub(m) };
  m.queue = left;
  const extra = Math.max(0, Math.min(40, Number(extraCalls) || 0));
  if (extra) m.max_calls = Math.min(40, m.max_calls + extra);
  if (m.calls >= m.max_calls) m.max_calls = Math.min(40, m.calls + left.length); // the budget was spent: room for what is queued
  if (m.calls >= m.max_calls) return { error: 'the call budget (40) is used up', map: pub(m) };
  const dial = effectiveDial(IVRMAP_SESSION, m.to);
  m.dialed = normalizeE164(dial.to); m.redirected = dial.redirected;
  m.status = 'running'; m.error = null; m.failures = 0;
  touch(m);
  const where = m.redirected ? ` ⚠ the test-dial redirect is ON, so I'm actually ringing ${m.dialed}, not ${m.to}.` : '';
  note(m, `▶ Resuming the map of ${m.name}: ${left.length} branch${left.length === 1 ? '' : 'es'} left, ${m.max_calls - m.calls} call${m.max_calls - m.calls === 1 ? '' : 's'} in the budget. Carrying on from where it stopped.${where}`);
  crawl(m).catch((err) => { logger.error(`map ${m.id} crashed: ${err.message}`); m.status = 'failed'; m.error = err.message; touch(m); note(m, `✗ The map stopped: ${err.message}`); });
  return { ok: true, map: pub(m), left: left.length };
}

/** One line per map in a task thread — read fresh each turn so Aria never reports a dead map as running. */
export function ivrMapStatus(taskId) {
  const mine = [...maps.values()].filter((m) => m.taskId === taskId).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!mine.length) return '';
  return mine.map((m) => {
    const explored = Object.values(m.nodes).filter((n) => n.explored).length;
    const left = pendingPaths(m).length;
    const state = m.status === 'running' ? `RUNNING now (call ${m.calls} of up to ${m.max_calls}, ${left} branch${left === 1 ? '' : 'es'} queued)`
      : m.status === 'done' ? `finished (${explored} points over ${m.calls} calls)`
        : `NOT running — ${m.status}${m.error ? ` (${m.error})` : ''} after ${m.calls} call${m.calls === 1 ? '' : 's'}, ${explored} points mapped, ${left} branch${left === 1 ? '' : 'es'} never rung${left ? ' → it can be resumed with resume_ivr_map' : ''}${m.status === 'failed' && explored <= 1 ? ' → the NUMBER could not be reached: to try another number (the business\'s local landline — look it up on the web if the owner has not given one) call map_ivr with it; phone_someone is NOT for mapping' : ''}`;
    return `• ${m.name} (${m.to}, map_id ${m.id}): ${state}${m.page ? ` · page ${m.page}` : ''}`;
  }).join('\n');
}

async function note(m, text) {
  if (!m.taskId) return;
  try { const { postNote } = await import('../tasks/store.js'); postNote(m.taskId, text); } catch (err) { logger.warn(`note failed: ${err.message}`); }
}

/** Pre-flight: an error string, or null. */
export function checkIvrTarget(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (digits.length < 5) return `"${to || ''}" is not a phone number I can call`;
  if (EMERGENCY.has(digits)) return 'I will not place a call to an emergency number';
  if (!config.phoneAsk.enabled) return 'outbound calling is turned off (PHONE_ASK_ENABLED)';
  if (!config.jambonz.apiKey || !config.jambonz.accountSid || !config.jambonz.applicationSid) return 'outbound calling is not configured';
  if (!(config.phoneAsk.fromNumber || config.jambonz.fromNumber)) return 'no caller ID is set for outbound calls';
  return null;
}

/**
 * Start a map. Returns at once; the crawl runs in the background and reports into the task.
 * @param {{to:string,name?:string,maxDepth?:number,maxCalls?:number,taskId?:string,via?:string}} opts
 */
export async function startIvrMap({ to, name = '', maxDepth = 3, maxCalls = 20, taskId = null, via = 'console' } = {}) {
  const num = normalizeE164(to);
  const pre = checkIvrTarget(num);
  if (pre) return { error: pre };
  const running = [...maps.values()].find((m) => m.status === 'running');
  if (running) return { error: `a map is already running (${running.name || running.to}) — one at a time`, map: pub(running) };
  const dial = effectiveDial(IVRMAP_SESSION, num);
  const id = 'ivr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const label = String(name || '').trim() || num;
  const m = {
    id, name: label, to: num, dialed: normalizeE164(dial.to), redirected: dial.redirected, status: 'running', error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    max_depth: Math.max(1, Math.min(5, Number(maxDepth) || 3)), max_calls: Math.max(1, Math.min(40, Number(maxCalls) || 20)),
    lead_s: Number(process.env.IVRMAP_LEAD_S) || 4, call_cap_ms: Number(process.env.IVRMAP_CALL_CAP_MS) || 110000,
    calls: 0, failures: 0, nodes: {}, queue: [''], taskId: taskId || null, page: null, mermaid: null, via
  };
  m.nodes[''] = newNode('');
  maps.set(id, m);
  // The thread: attach to the owner's task when started from one, else open a task for it.
  try {
    const store = await import('../tasks/store.js');
    if (!m.taskId || !store.getTask(m.taskId)) m.taskId = store.createTask({ title: `IVR map — ${label}`, via }).id;
  } catch (err) { logger.warn(`task for map failed: ${err.message}`); }
  touch(m);
  const where = m.redirected ? ` ⚠ the test-dial redirect is ON for this session, so I'm actually ringing the test number ${m.dialed}, not ${num}.` : '';
  // 16 Nov: a finished map of the same business is worth a mention (HCF was mapped on its landline on 14 Nov);
  // and a 13 / 1300 / 1800 number is usually refused by the trunk's carrier — say so before the first dial.
  const earlier = [...maps.values()].filter((x) => x.id !== id && x.status === 'done' && x.name.toLowerCase() === label.toLowerCase()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const seen = earlier ? ` (I already have a finished map of ${earlier.name} on ${earlier.to} from ${new Date(earlier.created_at).toLocaleDateString('en-AU')}${earlier.page ? `: ${earlier.page}` : ''})` : '';
  const shortWarn = isAuShortNumber(m.dialed) ? ' ⚠ That is an Australian 13 / 1300 / 1800 number — this trunk\'s carrier usually refuses those; if the first call fails, give me the business\'s local landline.' : '';
  await note(m, `🗺️ Mapping the phone menu on ${num}${label !== num ? ` (${label})` : ''}: up to ${m.max_depth} levels deep and ${m.max_calls} calls. I ring once per branch, listen to the whole prompt, press each option in turn, and post what I find here as I go.${where}${seen}${shortWarn}`);
  crawl(m).catch((err) => { logger.error(`map ${id} crashed: ${err.message}`); m.status = 'failed'; m.error = err.message; touch(m); note(m, `✗ The map stopped: ${err.message}`); });
  return { ok: true, map: pub(m) };
}

function newNode(p) {
  return { path: p, key: p ? p.at(-1) : '', depth: p.length, parent: p ? p.slice(0, -1) : null, heard: [], prompt: '', kind: 'pending', title: '', summary: '', options: [], children: [], call_sid: null, duration_ms: 0, ended: '', explored: false };
}
const keyPath = (p) => (p ? p.split('').join(' → ') : 'start');

// --- the crawl: one call per node, breadth-first ------------------------------------
async function crawl(m) {
  while (m.status === 'running' && m.queue.length && m.calls < m.max_calls) {
    const p = m.queue.shift();
    const node = m.nodes[p] || (m.nodes[p] = newNode(p));
    m.calls += 1;
    touch(m);
    const ok = await exploreNode(m, node);
    if (!ok) { m.failures += 1; if (m.failures >= 3) { m.status = 'failed'; m.error = 'three calls in a row could not be placed or captured'; break; } }
    else m.failures = 0;
    if (m.status !== 'running') break;
    if (m.queue.length && m.calls < m.max_calls) await new Promise((r) => setTimeout(r, Number(process.env.IVRMAP_GAP_MS) || 3500));
  }
  if (m.status === 'running') {
    // The opening call never captured anything (carrier 403, no answer…): that is a failed map, not a finished one.
    const root = m.nodes[''];
    if (root && (root.kind === 'error' || root.kind === 'silent')) { m.status = 'failed'; m.error = root.ended || 'the opening call captured nothing'; }
    else m.status = 'done';
  }
  await finalize(m);
}

async function exploreNode(m, node) {
  const from = config.phoneAsk.fromNumber || config.jambonz.fromNumber;
  const legKey = `${m.id}|${node.path}`;
  let unwatch = () => {};
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { legs.delete(legKey); resolve({ error: `no leg answered within the time limit${timeoutHint(m.dialed)}` }); }, 75000 + m.call_cap_ms);
    legs.set(legKey, { resolve: (r) => { clearTimeout(timer); legs.delete(legKey); unwatch(); resolve(r); } });
  });
  try {
    const created = await jambonz('POST', `/Accounts/${config.jambonz.accountSid}/Calls`, {
      application_sid: config.jambonz.applicationSid, from,
      to: { type: 'phone', number: m.dialed.replace(/^\+/, '') },
      tag: { mode: 'ivrmap', mapId: m.id, path: node.path, session: IVRMAP_SESSION },
      timeout: 40,
      ...callOptions() // 16 Nov: status webhooks → a refused dial fails the leg NOW, with the SIP cause
    });
    const sid = created?.sid || created?.call_sid || '';
    if (sid) {
      node.call_sid = sid;
      unwatch = trackDial(sid, (st) => legs.get(legKey)?.resolve({ error: describeDialFailure(st, m.dialed), sip: st.sip }));
    }
    logger.info(`map ${m.id}: call ${m.calls} -> ${m.dialed} path="${node.path || '(root)'}"${sid ? ` sid ${sid.slice(0, 8)}…` : ''}`);
  } catch (err) {
    legs.get(legKey)?.resolve({ error: err.message });
    node.kind = 'error'; node.ended = `could not place the call: ${err.message}`; node.explored = true; touch(m);
    await note(m, `✗ Call ${m.calls} (${keyPath(node.path)}): could not place the call — ${err.message}`);
    return false;
  }
  const r = await done;
  if (r?.error && !node.heard.length) {
    node.kind = 'error'; node.ended = r.error; node.explored = true; touch(m);
    await note(m, `✗ Call ${m.calls} (${keyPath(node.path)}): ${r.error}`);
    return false;
  }
  await classify(m, node);
  node.explored = true;
  // Children: every pressable option, unless we're at the depth limit or it only loops back.
  if (node.kind === 'menu' && node.depth < m.max_depth) {
    for (const o of node.options) {
      if (NAV_RE.test(o.label)) continue;
      const cp = node.path + o.key;
      if (m.nodes[cp]) continue;
      m.nodes[cp] = { ...newNode(cp), title: o.label };
      node.children.push(cp);
      m.queue.push(cp);
    }
  }
  touch(m);
  const opts = node.options.length ? node.options.map((o) => `${o.key} ${o.label}`).join(' · ') : '';
  const left = Math.min(m.queue.length, Math.max(0, m.max_calls - m.calls));
  await note(m, `📞 Call ${m.calls} · ${keyPath(node.path)} → ${node.title || node.kind} [${node.kind}]${node.summary ? ` — ${node.summary}` : ''}${opts ? `\nOptions: ${opts}` : ''}${left ? `\n(${left} more branch${left === 1 ? '' : 'es'} to ring)` : ''}`);
  return true;
}

/** The fast model reads the prompt transcript and names the node + its pressable options. */
async function classify(m, node) {
  const text = node.heard.join(' ').replace(/\s+/g, ' ').trim();
  node.prompt = text;
  const parent = node.parent !== null ? m.nodes[node.parent] : null;
  if (!text) { node.kind = 'silent'; node.title = node.title || 'no prompt heard'; node.summary = 'nothing was heard on this branch'; return; }
  // The replay didn't take (same prompt as the parent): don't descend, say so.
  if (parent?.prompt && similar(parent.prompt, text)) { node.kind = 'repeat'; node.title = node.title || 'same menu again'; node.summary = 'pressing this key played the previous menu again (the key may not have been accepted)'; return; }
  const sys = 'You read transcripts of automated phone menus (IVR). Reply with ONLY a JSON object, no prose: '
    + '{"kind":"menu|input|queue|message|human|unknown","title":"<2-5 word name for this point in the menu>","summary":"<one short sentence>","options":[{"key":"1","label":"<what that key is for, 2-6 words>"}]}. '
    + 'kind: "menu" = the caller is offered choices to PRESS; "input" = asks the caller to enter/type a number (membership, phone, date of birth…); "queue" = being transferred or placed on hold for a person; "human" = a real person answered; "message" = information only, no choices; "unknown" otherwise. '
    + 'options: ONLY choices selected by pressing a single key (0-9, * or #), in the order spoken, with the key exactly as said. Include keys that repeat or return to a previous menu too (label them as such). Spoken-word choices ("say claims") are NOT options. No options for a non-menu.';
  const user = `Transcript heard after pressing: ${node.path ? node.path.split('').join(', ') : 'nothing (this is the opening prompt)'}\n"""${text.slice(0, 3000)}"""`;
  try {
    const out = await completeText({ model: config.llm.fastModel, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], params: { max_tokens: 600, temperature: 0 } });
    const j = JSON.parse(String(out).match(/\{[\s\S]*\}/)?.[0] || '{}');
    node.kind = ['menu', 'input', 'queue', 'message', 'human', 'unknown'].includes(j.kind) ? j.kind : 'unknown';
    node.title = String(j.title || node.title || node.kind).slice(0, 60);
    node.summary = String(j.summary || '').slice(0, 200);
    const seen = new Set();
    node.options = (Array.isArray(j.options) ? j.options : [])
      .map((o) => ({ key: String(o.key || '').trim().replace(/^star$/i, '*').replace(/^(hash|pound)$/i, '#'), label: String(o.label || '').trim().slice(0, 60) }))
      .filter((o) => /^[0-9*#]$/.test(o.key) && o.label && !seen.has(o.key) && seen.add(o.key));
    if (node.kind === 'menu' && !node.options.length) node.kind = 'message';
  } catch (err) {
    logger.warn(`map ${m.id}: classify failed: ${err.message}`);
    node.kind = 'unknown'; node.title = node.title || 'unparsed'; node.summary = `could not parse the prompt (${err.message})`;
  }
}
function similar(a, b) {
  const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  return y.includes(x.slice(0, 90)) || x.includes(y.slice(0, 90));
}

// --- the call side (driven by the conductor when a tagged leg arrives) ------------------
function listenVerb({ timeout }) {
  // Continuous ASR: jambonz keeps collecting speech until `asrTimeout` seconds of silence, then
  // returns the whole prompt in one go — a menu's pauses between options don't cut it short.
  return { verb: 'gather', input: ['speech'], actionHook: '/ivr-step', timeout, bargein: false, recognizer: recognizer({ asrTimeout: Number(process.env.IVRMAP_ASR_TIMEOUT_S) || 3.5 }) };
}
function extract(evt) {
  const sp = (evt && (evt.speech || evt)) || {};
  const alt = Array.isArray(sp.alternatives) ? sp.alternatives[0] : sp.alternatives;
  return String((alt && alt.transcript) || sp.transcript || (evt && evt.transcript) || '').trim();
}

export function runIvrMapCall(ctl, tag = {}) {
  const m = maps.get(String(tag.mapId || ''));
  const p = String(tag.path || '');
  const { session, callSid } = ctl;
  if (!m || m.status !== 'running') { logger.warn(`call ${callSid}: ivrmap leg for unknown/finished map — hanging up`); try { session.addVerbs([hangupVerb()]).send(); } catch { /* */ } return; }
  const node = m.nodes[p] || (m.nodes[p] = newNode(p));
  node.call_sid = callSid;
  ctl.ivrmap = { mapId: m.id, path: p, heard: [], listens: 0, startedAt: Date.now(), done: false };
  session.on('/ivr-step', (evt) => onStep(ctl, evt));
  const verbs = [configVerb()];
  if (p) {
    verbs.push({ verb: 'pause', length: m.lead_s });
    for (const d of p) { verbs.push({ verb: 'dtmf', dtmf: d, duration: 250 }); verbs.push({ verb: 'pause', length: 2 }); }
  }
  verbs.push(listenVerb({ timeout: 25 }));
  session.addVerbs(verbs).send();
  emitEvent('phone.ivr', IVRMAP_SESSION, { callSid, step: 0, heard: '', path: p, map: m.id, dialing: true });
  logger.info(`call ${callSid}: ivrmap leg for ${m.id} path="${p || '(root)'}"`);
  ctl.ivrmap.cap = setTimeout(() => finishLeg(ctl, 'time cap', false), m.call_cap_ms);
}

function onStep(ctl, evt) {
  const st = ctl.ivrmap;
  if (!st || st.done) return;
  const m = maps.get(st.mapId);
  const text = extract(evt);
  st.listens += 1;
  if (text) {
    st.heard.push(text);
    emitEvent('phone.ivr', IVRMAP_SESSION, { callSid: ctl.callSid, step: st.listens, heard: text.slice(0, 180), path: st.path, map: st.mapId });
    logger.info(`call ${ctl.callSid}: ivrmap heard (${st.listens}) "${text.slice(0, 80)}"`);
    // A human on the line: apologise and go — we are not here to talk to anyone.
    if (st.listens === 1 && text.length < 90 && /\b(speaking|how can i help|how may i help)\b|^(hi|hello|hey)[ ,.!?]*$/i.test(text)) { st.human = true; return finishLeg(ctl, 'human answered', true); }
    if (st.listens < 10 && Date.now() - st.startedAt < (m?.call_cap_ms || 110000) - 8000) { ctl.session.addVerbs([listenVerb({ timeout: 4 })]).reply(); return; }
    return finishLeg(ctl, 'listen cap', true);
  }
  // Nothing yet (still ringing through / silence before the prompt): wait a little longer, twice.
  if (!st.heard.length && st.listens < 3) { ctl.session.addVerbs([listenVerb({ timeout: 15 })]).reply(); return; }
  finishLeg(ctl, st.heard.length ? 'prompt ended' : 'silence', true);
}

function finishLeg(ctl, reason, inHook) {
  const st = ctl.ivrmap;
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.cap);
  const m = maps.get(st.mapId);
  const node = m?.nodes[st.path];
  if (node) { node.heard = st.heard.slice(); node.duration_ms = Date.now() - st.startedAt; node.ended = reason; if (st.human) node.kind = 'human'; }
  const verbs = st.human ? [sayVerb("Oh sorry — wrong option, I'll call back later. Bye!"), hangupVerb()] : [hangupVerb()];
  try { if (inHook) ctl.session.addVerbs(verbs).reply(); else ctl.session.addVerbs(verbs).send(); } catch { /* leg already gone */ }
  legs.get(`${st.mapId}|${st.path}`)?.resolve({ ok: true, reason });
}
/** Conductor cleanup hook: the leg is gone (far end hung up, failed, no answer). */
export function ivrMapLegEnded(ctl, reason) {
  const st = ctl.ivrmap;
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.cap);
  const m = maps.get(st.mapId);
  const node = m?.nodes[st.path];
  if (node) { node.heard = st.heard.slice(); node.duration_ms = Date.now() - st.startedAt; node.ended = `call ended (${reason})`; }
  legs.get(`${st.mapId}|${st.path}`)?.resolve(st.heard.length ? { ok: true, reason } : { error: `the call ended before anything was heard (${reason})` });
}

// --- output: hosted page + SVG tree + Mermaid --------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_COLOR = { menu: '#2563eb', input: '#d97706', queue: '#059669', message: '#6b7280', human: '#db2777', repeat: '#9ca3af', silent: '#9ca3af', error: '#dc2626', unknown: '#7c3aed', pending: '#9ca3af', unexplored: '#9ca3af' };

function mermaidOf(m) {
  const id = (p) => 'n' + (p ? p.replace(/\*/g, 's').replace(/#/g, 'h') : 'root');
  const lab = (s) => String(s).replace(/"/g, "'").replace(/[[\]{}()|]/g, ' ').slice(0, 48);
  const lines = ['flowchart TD', `  ${id('')}(["${lab(m.name)} · ${lab(m.to)}"])`];
  const ordered = Object.values(m.nodes).sort((a, b) => a.path.localeCompare(b.path));
  for (const n of ordered) {
    if (n.path) lines.push(`  ${id(n.path)}["${lab(n.title || n.kind)}"]`, `  ${id(n.parent)} -->|${n.key}| ${id(n.path)}`);
    // options not explored (depth/call budget) still show as leaves
    if (n.kind === 'menu') for (const o of n.options) { const cp = n.path + o.key; if (!m.nodes[cp]) lines.push(`  ${id(cp)}>"${lab(o.label)}"]`, `  ${id(n.path)} -.->|${o.key}| ${id(cp)}`); }
  }
  for (const n of ordered) { const c = KIND_COLOR[n.kind] || KIND_COLOR.unknown; lines.push(`  style ${id(n.path)} stroke:${c},stroke-width:2px`); }
  return lines.join('\n');
}

/** A plain SVG of the tree: boxes per node, unexplored options as dashed leaves. */
function svgOf(m) {
  const items = {}; // path -> {label, kind, explored, children[]}
  for (const n of Object.values(m.nodes)) items[n.path] = { path: n.path, key: n.key, label: n.path ? (n.title || n.kind) : `${m.name}`, sub: n.path ? n.kind : m.to, kind: n.kind, children: [], explored: true };
  for (const n of Object.values(m.nodes)) if (n.kind === 'menu') for (const o of n.options) { const cp = n.path + o.key; if (!items[cp]) items[cp] = { path: cp, key: o.key, label: o.label, sub: 'not explored', kind: 'unexplored', children: [], explored: false }; }
  for (const it of Object.values(items)) if (it.path) items[it.path.slice(0, -1)]?.children.push(it);
  for (const it of Object.values(items)) it.children.sort((a, b) => a.key.localeCompare(b.key));
  const W = 168, H = 48, GX = 14, GY = 86;
  const leaves = (it) => (it.children.length ? it.children.reduce((s, c) => s + leaves(c), 0) : 1);
  let depthMax = 0;
  const place = (it, x0, d) => { depthMax = Math.max(depthMax, d); const w = leaves(it) * (W + GX); it.x = x0 + w / 2; it.y = 40 + d * GY; let cx = x0; for (const c of it.children) { place(c, cx, d + 1); cx += leaves(c) * (W + GX); } };
  const root = items[''];
  if (!root) return '';
  place(root, 20, 0);
  const totalW = leaves(root) * (W + GX) + 40, totalH = 40 + (depthMax + 1) * GY + 20;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`, `<rect width="${totalW}" height="${totalH}" fill="#ffffff"/>`];
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const walk = (it) => {
    for (const c of it.children) { out.push(`<path d="M${it.x},${it.y + H / 2} C${it.x},${it.y + H / 2 + 30} ${c.x},${c.y - H / 2 - 30} ${c.x},${c.y - H / 2}" fill="none" stroke="#9ca3af" stroke-width="1.5"${c.explored ? '' : ' stroke-dasharray="5 4"'}/>`); walk(c); }
    const color = KIND_COLOR[it.kind] || '#9ca3af';
    out.push(`<g><title>${esc(it.path ? `press ${it.path.split('').join(' → ')} · ${it.label} (${it.sub})` : `${it.label} ${it.sub}`)}</title>`);
    out.push(`<rect x="${it.x - W / 2}" y="${it.y - H / 2}" width="${W}" height="${H}" rx="9" fill="${it.explored ? '#f8fafc' : '#ffffff'}" stroke="${color}" stroke-width="${it.path ? 1.6 : 2.4}"${it.explored ? '' : ' stroke-dasharray="5 4"'}/>`);
    if (it.path) out.push(`<rect x="${it.x - W / 2 + 7}" y="${it.y - 12}" width="22" height="24" rx="5" fill="${color}"/><text x="${it.x - W / 2 + 18}" y="${it.y + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${esc(it.key)}</text>`);
    const tx = it.path ? it.x - W / 2 + 36 : it.x, anchor = it.path ? 'start' : 'middle';
    out.push(`<text x="${tx}" y="${it.y - 3}" text-anchor="${anchor}" font-size="12.5" font-weight="600" fill="#111827">${esc(trunc(it.label, it.path ? 19 : 24))}</text>`);
    out.push(`<text x="${tx}" y="${it.y + 14}" text-anchor="${anchor}" font-size="10.5" fill="${it.explored ? color : '#9ca3af'}">${esc(trunc(it.sub, 22))}</text></g>`);
  };
  walk(root);
  out.push('</svg>');
  return out.join('');
}

function pageOf(m, svg, mermaid) {
  const explored = Object.values(m.nodes).filter((n) => n.explored);
  const rows = explored.sort((a, b) => a.path.localeCompare(b.path)).map((n) => `<details${n.path ? '' : ' open'}><summary><b>${esc(n.path ? 'press ' + n.path.split('').join(' → ') : 'opening prompt')}</b> — ${esc(n.title || n.kind)} <span class="k" style="--c:${KIND_COLOR[n.kind] || '#9ca3af'}">${esc(n.kind)}</span><small>${Math.round(n.duration_ms / 1000)} s · ${esc(n.ended)}</small></summary>${n.summary ? `<p class="s">${esc(n.summary)}</p>` : ''}${n.options.length ? `<ul>${n.options.map((o) => `<li><b>${esc(o.key)}</b> ${esc(o.label)}${m.nodes[n.path + o.key]?.explored ? '' : ' <i>(not explored)</i>'}</li>`).join('')}</ul>` : ''}<blockquote>${esc(n.prompt || '(nothing heard)')}</blockquote></details>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IVR map — ${esc(m.name)}</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#111827;--mut:#6b7280;--line:#e5e7eb;--card:#f8fafc}@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e5e7eb;--mut:#94a3b8;--line:#1f2937;--card:#111827}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px max(16px,env(safe-area-inset-left)) 48px}main{max-width:1100px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}.meta{color:var(--mut);font-size:13px;margin-bottom:18px}
.tree{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff;padding:8px;margin-bottom:22px}.tree svg{display:block;max-width:none;height:auto}
details{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0;background:var(--card)}summary{cursor:pointer}summary small{color:var(--mut);margin-left:8px;font-size:12px}.k{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--c);color:var(--c);margin-left:6px}
blockquote{margin:8px 0 2px;padding:8px 12px;border-left:3px solid var(--line);color:var(--mut);font-size:13.5px;white-space:pre-wrap}.s{margin:6px 0}ul{margin:6px 0 4px 18px;padding:0}pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;font-size:12.5px}
.legend span{display:inline-block;margin:0 10px 6px 0;font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}</style></head><body><main>
<h1>IVR map — ${esc(m.name)}</h1><div class="meta">${esc(m.to)}${m.redirected ? ` (actually dialled ${esc(m.dialed)} — test-dial redirect was on)` : ''} · ${explored.length} points mapped over ${m.calls} call${m.calls === 1 ? '' : 's'} · depth limit ${m.max_depth} · ${esc(m.status)}${m.error ? ` (${esc(m.error)})` : ''} · ${esc(new Date(m.updated_at).toLocaleString('en-AU'))}</div>
<div class="legend">${Object.entries(KIND_COLOR).filter(([k]) => ['menu', 'input', 'queue', 'message', 'human', 'repeat', 'error'].includes(k)).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')}<span><i style="border:1px dashed #9ca3af"></i>not explored (depth or call budget)</span></div>
<div class="tree">${svg}</div>
<h2>Every prompt, verbatim</h2>${rows}
<h2>Mermaid source</h2><pre>${esc(mermaid)}</pre>
</main></body></html>`;
}

async function finalize(m) {
  const mermaid = mermaidOf(m);
  const svg = svgOf(m);
  m.mermaid = mermaid;
  try {
    const dir = path.join(PUBLIC_DIR, 'ivr-maps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${m.id}.html`), pageOf(m, svg, mermaid), 'utf8');
    fs.writeFileSync(path.join(dir, `${m.id}.svg`), svg, 'utf8');
    const base = config.publicHost && !/^(localhost|127\.0\.0\.1)/.test(config.publicHost) ? `https://${config.publicHost}` : `http://localhost:${config.port}`;
    m.page = `${base}/ivr-maps/${m.id}.html`;
  } catch (err) { logger.warn(`map ${m.id}: page not written: ${err.message}`); }
  touch(m);
  const explored = Object.values(m.nodes).filter((n) => n.explored);
  const menus = explored.filter((n) => n.kind === 'menu').length;
  const unexplored = Object.values(m.nodes).filter((n) => n.kind === 'menu').reduce((s, n) => s + n.options.filter((o) => !m.nodes[n.path + o.key]?.explored && !NAV_RE.test(o.label)).length, 0);
  try {
    const store = await import('../tasks/store.js');
    if (m.taskId && svg) store.attachMedia(m.taskId, { svg, caption: `IVR map of ${m.name} — ${explored.length} points, ${menus} menus, ${m.calls} calls${unexplored ? `, ${unexplored} option${unexplored === 1 ? '' : 's'} left unexplored` : ''}`, kind: 'sketch' });
  } catch (err) { logger.warn(`map ${m.id}: svg not attached: ${err.message}`); }
  const left = m.status === 'done' ? 0 : pendingPaths(m).length;
  const retry = m.status === 'failed' && explored.length <= 1 ? `\nGive me another number for them${isAuShortNumber(m.dialed) ? ' (their local landline, not the 13 / 1300 number)' : ''} and say "map it on that number" — I'll start a fresh map there.` : '';
  await note(m, `${m.status === 'done' ? '✅ Map complete' : `⚠ Map ${m.status}${m.error ? ` — ${m.error}` : ''}`}: ${explored.length} points over ${m.calls} call${m.calls === 1 ? '' : 's'}${unexplored ? ` (${unexplored} deeper option${unexplored === 1 ? '' : 's'} not rung — raise the depth or call budget to continue)` : ''}.${left ? `\n${left} branch${left === 1 ? '' : 'es'} ${left === 1 ? 'was' : 'were'} still to ring — say "resume the map" here and I'll carry on from where it stopped.` : ''}${m.page ? `\nFull map with every prompt transcript: ${m.page}` : ''}${retry}`);
  if (m.taskId) { try { const store = await import('../tasks/store.js'); store.setStatus(m.taskId, 'waiting'); } catch { /* */ } }
  logger.info(`map ${m.id} ${m.status}: ${explored.length} nodes, ${m.calls} calls`);
}
