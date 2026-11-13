// 12 Nov 2026 — one-command launcher for the "Dinner, sorted" showcase runs.
// Re-runnable: dispatch as many takes as you like until the best journey is captured.
//
//   npm run showcase            # H-01 baseline: the full concierge arc (cold, no assumptions)
//   npm run showcase -- h2      # H-02 memory flex: "our usual dinner, same as last time"
//   npm run showcase -- h3..h7  # feature segments (weather+SMS, two tabs, ring Sunny, hang-up-and-keep-working, map pin)
//   npm run showcase -- h1 --dial-me   # redirect the outbound call to YOUR mobile instead of Sunny
//   node scripts/run-showcase.mjs --check    # gates only, no dispatch (no API key needed)
//
// Each dispatch first ENDS the console session (main): the next call starts a fresh brain, so
// anything Aria remembers provably comes from the LONG-TERM MEMORY KB, not chat history. Ending
// the session also makes the Memorist distil the PREVIOUS take into memory before the next one.
//
// Outbound calls (13 Nov): every outbound ask-call is REDIRECTED to Sunny — Huey's own voice agent
// (+61 3 4062 1105) — so the showcase is machine-to-machine end to end and no venue or person is
// ever rung. `--dial-me` points the redirect at OWNER_PHONE instead (you answer as the venue).
// TEST_DIAL_TARGET in .env overrides the default target.
//
// Recap (13 Nov): ~25 s after the call ends an open console auto-builds the shareable recap and
// posts its link into the Tasks thread (→ WhatsApp). If NO console is open on `main`, this script
// opens a headless one for the run so the recap still happens, and prints the link at the end.
//
// Env:
//   HUEY_API_KEY   required to dispatch. Mint it IN THE WEB APP: hueyos.ai -> Help ->
//                  MCP Connect -> Generate API key (shown once; put it in this repo's .env).
//   HUEY_API_URL   default https://huey-backend-g0ct.onrender.com/api — the REAL production
//                  backend (Render). api.hueyos.ai is an OLD deployment that does not front it.
//
// The gates encode every failure mode from 11-13 Nov — the script REFUSES to dispatch unless:
//   1. the local server answers (localhost:3005),
//   2. the tunnel serves mick.au.ngrok.io (jambonz can reach the harness),
//   3. the TEST-DIAL redirect is armed to the chosen target (verified back from the server),
//   4. the WhatsApp 24-hour window is open (or --skip-whatsapp-gate).
import 'dotenv/config';
import { createRequire } from 'node:module';

const SEGMENTS = {
  h1: { id: '6af3f7670c0de317a22eba42', label: 'H-01 Dinner sorted — full concierge arc (baseline)' },
  h2: { id: '6af5ac76706825be8f52165a', label: 'H-02 The usual, please — long-term memory showcase' },
  h3: { id: '6af5cf6feba54985d779af7a', label: 'H-03 Weather for Friday + text me the forecast (Lumi, SMS)' },
  h4: { id: '6af5cf72eba54985d779af8b', label: 'H-04 Compare two venues side by side (Sage, two tabs)' },
  h5: { id: '6af5cf74eba54985d779af9c', label: 'H-05 Ring Sunny and ask — question relayed back (call-inside-a-call)' },
  h6: { id: '6af5cf76eba54985d779afae', label: 'H-06 Hang up and keep working — background task to WhatsApp' },
  h7: { id: '6af63f6eeba54985d779dd8b', label: 'H-07 Pin it on the map — voice + screen + text + background task (multimodal)' }
};
const pick = (process.argv.find((a) => /^h\d$/i.test(a)) || 'h1').toLowerCase();
const SEG = SEGMENTS[pick] || SEGMENTS.h1;
const SEGMENT_ID = SEG.id;
const DIAL_IN = '+61 7 4518 8002';
const SUNNY = '+61340621105'; // Huey's agent-prototype "Sunny" — the machine-to-machine outbound target
const HUEY_API_URL = (process.env.HUEY_API_URL || 'https://huey-backend-g0ct.onrender.com/api').replace(/\/+$/, '');
const CHECK_ONLY = process.argv.includes('--check');
const DIAL_ME = process.argv.includes('--dial-me');
const LOCAL = 'http://localhost:3005';

const ok = (m) => console.log('  \x1b[32mOK\x1b[0m ', m);
const bad = (m) => console.log('  \x1b[31mFAIL\x1b[0m', m);
const info = (m) => console.log('      ' + m);
const die = (m) => { console.error('\n\x1b[31mABORTED:\x1b[0m ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (n) => (n ? `${n.slice(0, 4)}…${n.slice(-3)}` : '');
const getJson = async (url, opts = {}, timeoutMs = 10000) => {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

console.log('\n=== Dinner, sorted — showcase launcher ===\n');
console.log('Pre-flight gates:');

// 1. local server
let health;
try {
  ({ body: health } = await getJson(`${LOCAL}/api/health`));
  if (health?.status !== 'ready') throw new Error('status ' + health?.status);
  ok('local server ready (localhost:3005)');
} catch (e) { bad('local server: ' + e.message); die('start it with `npm run dev`.'); }
if (health?.live_calls?.conductor || health?.live_calls?.harness) { bad(`a call is still live (${JSON.stringify(health.live_calls)})`); die('wait for it to end (or hang it up in the console), then retry.'); }

// 2. tunnel serves THIS server (retry a few times — a just-started ngrok takes seconds to attach,
// and its offline/interstitial page would otherwise read as "answered but not with this app")
{
  let lastErr = '';
  let tunnelOk = false;
  for (let attempt = 1; attempt <= 4 && !tunnelOk; attempt++) {
    try {
      const { status, body: t } = await getJson('https://mick.au.ngrok.io/api/health', { headers: { 'ngrok-skip-browser-warning': '1' } }, 12000);
      if (t?.name === 'mick-agentic-browser') { ok('tunnel live (mick.au.ngrok.io -> this server)'); tunnelOk = true; break; }
      lastErr = `HTTP ${status}, ${t ? `app "${t.name}"` : 'non-JSON page (ngrok still attaching / offline page)'}`;
    } catch (e) { lastErr = e.message; }
    if (!tunnelOk && attempt < 4) { info(`tunnel not ready (${lastErr}) — retrying in 3s…`); await sleep(3000); }
  }
  if (!tunnelOk) { bad('tunnel: ' + lastErr); die('run `npm run tunnel` (must serve mick.au.ngrok.io), wait for "Forwarding", then retry.'); }
}

// 3. test-dial redirect: ALWAYS (re)armed here to the chosen target, then read back from the server.
// The server persists it (.test-dial.json) and is the single source of truth — but a console tab still
// running pre-13-Nov JS re-pushes its own saved switch on reconnect, so never trust what was there.
{
  const owner = (process.env.OWNER_PHONE || '').replace(/[^\d+]/g, '');
  const target = DIAL_ME ? owner : (process.env.TEST_DIAL_TARGET || SUNNY).replace(/[^\d+]/g, '');
  if (target.replace(/\D/g, '').length < 5) { bad(DIAL_ME ? 'OWNER_PHONE is not set' : 'no test-dial target'); die('set OWNER_PHONE (for --dial-me) or TEST_DIAL_TARGET in .env.'); }
  const WebSocket = createRequire(import.meta.url)('ws');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3005/ui?session=main`);
    const t = setTimeout(() => { ws.terminate(); reject(new Error('console WS timeout')); }, 6000);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'test_dial', enabled: true, number: target, session: 'main' })); setTimeout(() => { clearTimeout(t); ws.close(); resolve(); }, 400); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  }).catch((e) => die('could not arm test-dial over the console WS: ' + e.message));
  const { body: h2 } = await getJson(`${LOCAL}/api/health`);
  health = h2 || health;
  if (h2?.test_dial?.enabled && h2.test_dial.number === mask(target)) ok(`test-dial armed -> ${mask(target)} (${DIAL_ME ? 'your mobile — answer as the venue' : target === SUNNY ? 'Sunny, Huey\'s voice agent — machine to machine' : 'TEST_DIAL_TARGET'})`);
  else { bad(`arming did not stick (server reports ${JSON.stringify(h2?.test_dial)})`); die('arm it manually: console -> Harness -> Talk Settings, then retry.'); }
}

// 4. WhatsApp 24-hour window (13 Nov): Twilio accepts the message but WhatsApp drops it (63016)
// unless the owner has messaged the sandbox within the last 24 h — every notification on 12 Nov
// died that way. Real check against Twilio; --skip-whatsapp-gate to run without it.
{
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const owner = (process.env.OWNER_PHONE || '').replace(/[^\d+]/g, '');
  const sandbox = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';
  if (sid && tok && owner && !process.argv.includes('--skip-whatsapp-gate')) {
    try {
      const r = await getJson(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?From=${encodeURIComponent('whatsapp:' + owner)}&To=${encodeURIComponent('whatsapp:' + sandbox)}&PageSize=1`, { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') } }, 15000);
      const last = r.body?.messages?.[0];
      const ageH = last ? (Date.now() - new Date(last.date_sent || last.date_created).getTime()) / 3600000 : Infinity;
      if (ageH < 23) ok(`WhatsApp window open (you messaged the sandbox ${ageH.toFixed(1)} h ago)`);
      else { bad(`WhatsApp window closed (last message from you ${Number.isFinite(ageH) ? ageH.toFixed(0) + ' h' : 'never'} ago) — notifications would silently fail`); die(`on your phone, send any WhatsApp message (e.g. "hi") to ${sandbox}, then retry. (--skip-whatsapp-gate to run anyway.)`); }
    } catch (e) { info('WhatsApp window check skipped: ' + e.message); }
  }
}
info('reminders it cannot check: Zapier calendar action; phone in hand (only for --dial-me).');

if (CHECK_ONLY) { console.log('\n--check: gates passed, not dispatching.'); process.exit(0); }

// --- dispatch ---------------------------------------------------------------
const KEY = process.env.HUEY_API_KEY || '';
if (!KEY) die('HUEY_API_KEY is not set. Mint one at hueyos.ai -> Help -> MCP Connect -> Generate API key, put it in this repo\'s .env, retry. Or run with --check.');
const H = { 'X-API-Key': KEY, 'Content-Type': 'application/json' };

// Fresh take: end the console session so recall can ONLY come from the long-term memory KB
// (this also makes the Memorist flush the previous take's learnings before the new call).
await getJson(`${LOCAL}/api/sessions/main/end`, { method: 'POST' }).catch(() => null);
const mem = await getJson(`${LOCAL}/api/kb/docs`).catch(() => null);
info(`session reset · long-term memory holds ${mem?.body?.memory?.length ?? '?'} ${(mem?.body?.memory?.length ?? 0) === 1 ? 'doc' : 'docs'} going into this take`);

// A console must be watching `main` for the auto-recap to build. Always run a headless one for the
// take (a console tab loaded before the auto-recap existed counts as "open" but builds nothing);
// the server posts ONE link even when your own console builds too.
let headless = null;
{
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`${LOCAL}/?session=main`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    headless = browser;
    info(`opened a headless console on main so the recap auto-builds${health?.consoles?.main > 0 ? ' (your own console is open too — one link will be posted)' : ''}`);
  } catch (e) { info(`could not open a headless console (${e.message}) — the recap will only build if you open localhost:3005`); }
}

console.log(`\nDispatching ${SEG.label}\n  (segment ${SEGMENT_ID}) -> Aria on ${DIAL_IN} …`);
const t0 = Date.now();
const d = await getJson(`${HUEY_API_URL}/campaign-segments/${SEGMENT_ID}/run`, { method: 'POST', headers: H, body: '{}' }, 180000);
if (d.status >= 300) { await headless?.close().catch(() => {}); die(`dispatch failed: HTTP ${d.status} ${JSON.stringify(d.body).slice(0, 300)}`); }
console.log('  dispatched. Expect the inbound call within ~30s; a healthy run lasts MINUTES.');
console.log(`  Watch the console (localhost:3005)${DIAL_ME ? ' and answer the redirected call when it comes' : ''}.\n`);

// --- poll -------------------------------------------------------------------
// The run record lives at data.activities[] (dispatchResult carries callData/transcript/compliance).
let done = null;
for (let i = 0; i < 60 && !done; i++) { // ~15 min
  await sleep(15000);
  let acts = [];
  try {
    const r = await getJson(`${HUEY_API_URL}/monitor-activities/segment/${SEGMENT_ID}`, { headers: H }, 15000);
    const dd = r.body?.data;
    acts = Array.isArray(dd) ? dd : (dd?.activities || Object.values(dd || {}).find(Array.isArray) || []);
  } catch { continue; }
  const fresh = acts.filter((a) => new Date(a.timestamp || a.createdAt || 0).getTime() >= t0 - 15000);
  // A record exists from dispatch onwards; it is finished only once completedAt AND the call data are in.
  for (const a of fresh) if (a.completedAt && (a.dispatchResult?.callData || a.dispatchResult?.transcript?.length)) done = a;
  if (!done && i % 4 === 3) info(`still running (${Math.round((Date.now() - t0) / 1000)}s)…`);
}
if (!done) { console.log('\nTimed out waiting for the run record (the call may still be going) — check hueyos.ai.'); await headless?.close().catch(() => {}); process.exit(2); }

const dr = done.dispatchResult || {};
const cd = dr.callData || {};
const secs = Math.round((done.duration || 0) / 1000);
const turns = cd.turns ?? ((done.agentMessageCount || 0) + (done.userMessageCount || 0));
if (secs < 15 && !turns) {
  console.log('\n\x1b[31m  WARNING: ~' + secs + 's with no turns = the call never connected.\x1b[0m');
  console.log('  Check: tunnel, then jambonz RecentCalls (inbound to …002?), then the trunk attach.');
} else {
  console.log(`\n\x1b[32m  Run complete: ${done.status} · ${secs}s · ${turns} turns · idle prompts ${cd.idle_prompts ?? '?'} · interruptions ${cd.interruptions ?? '?'}\x1b[0m`);
  const cr = dr.complianceResult || done.complianceResult || {};
  for (const p of (cr.results || [])) console.log(`  ${p.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${p.policy_name}${p.passed ? '' : ' — ' + String(p.reason || '').slice(0, 160)}`);
  if (dr.summary || done.summary) console.log('  summary: ' + String(dr.summary || done.summary).slice(0, 400));
  const tr = dr.transcript || done.transcript || [];
  if (tr.length) { console.log(`  transcript (${tr.length} lines):`); for (const t of tr.slice(0, 40)) console.log(`    ${t.role === 'agent' ? 'ARIA  ' : 'JORDAN'}: ${String(t.text).slice(0, 150)}`); }
}

// --- recap link (auto-built by the console ~25 s after the call ends) ------------
let recapUrl = '';
for (let i = 0; i < 24 && !recapUrl; i++) {
  await sleep(5000);
  try {
    const { body } = await getJson(`${LOCAL}/api/tasks`);
    for (const t of body?.tasks || []) {
      const m = /https?:\/\/\S+\/recaps\/\S+\.html/.exec(t.last?.text || '');
      if (m && new Date(t.last?.at || t.updated_at).getTime() >= t0) { recapUrl = m[0]; break; }
    }
  } catch { /* keep polling */ }
}
await headless?.close().catch(() => {});
if (recapUrl) console.log(`\n  📎 Shareable recap: ${recapUrl}\n  (also posted into the Tasks thread → your WhatsApp)`);
else console.log('\n  No recap link appeared within 2 min — open localhost:3005 → Harness → Activity → ★ Create shareable recap.');
console.log('\n  The Memorist distils this take ~25s after the session ends — review/edit in Harness -> 🧠 Memory.');
console.log('  Re-run: npm run showcase -- ' + pick + '   ·   other takes: h1 h2 h3 h4 h5 h6 h7   ·   --dial-me to answer the outbound call yourself');
process.exit(0);
