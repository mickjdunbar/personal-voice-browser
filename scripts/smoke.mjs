#!/usr/bin/env node
// 2026-11-03 (mick-agentic-browser): drive the harness exactly as jambonz would
// (a fake feature-server over the harness.jambonz.org subprotocol) against a
// RUNNING server with the real models and the real browser. Prints every reply
// chunk with its time from turn start, the turn record and any commands.
//
//   node scripts/smoke.mjs                                   # scripted browse conversation
//   node scripts/smoke.mjs --say "open wikipedia and tell me about jambonz"
//   node scripts/smoke.mjs --specialist                       # hybrid hand-off shape
//   node scripts/smoke.mjs --url ws://localhost:3005/harness --session smoke
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const flag = (name) => args.includes(`--${name}`);
const session = opt('session', 'smoke-' + Date.now().toString(36));
const url = opt('url', `ws://localhost:${process.env.PORT || 3005}/harness?session=${encodeURIComponent(session)}`);
const secret = opt('secret', process.env.HARNESS_SECRET || '');
const say = opt('say');
const script = say ? [say] : flag('specialist')
  ? ['Great, thanks. Actually, how are you going today?']
  : ["G'day, how's it going?", 'Open wikipedia and tell me what jambonz is', 'Thanks, that was great. Bye!'];
const metadata = flag('specialist')
  ? { role: 'navigator', mode: 'specialist', session, handoff: { question: 'Open the ABC news site and read me the top headline', summary: 'Caller was chatting about their morning.', transcript: [{ role: 'assistant', text: "G'day! How's your day going?" }, { role: 'user', text: 'Good thanks, lazy Sunday.' }] } }
  : { role: 'navigator', session, agent: 'smoke' };

const ws = new WebSocket(url, 'harness.jambonz.org', { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
const send = (m) => ws.send(JSON.stringify(m));
let turnId = 0, turnStart = 0, firstChunkAt = null, pendingDone = null;
const callSid = 'smoke-' + Math.random().toString(16).slice(2, 10);

function turn(input) {
  turnId += 1; turnStart = Date.now(); firstChunkAt = null;
  console.log(`\n--- turn ${turnId} [${input.type}] ${input.text ? `"${input.text}"` : ''}`);
  send({ type: 'turn:start', call_sid: callSid, turn_id: turnId, input });
  return new Promise((resolve) => { pendingDone = resolve; });
}

ws.on('open', async () => {
  console.log(`connected ${url}`);
  send({ type: 'session:start', protocol: 1, call_sid: callSid, account_sid: 'acc', application_sid: 'app', direction: 'inbound', from: '+61400000000', to: '+61745188002', language: 'en-AU', metadata, tools: [] });
  await new Promise((r) => setTimeout(r, 300));
  await turn({ type: 'greeting' });
  for (const line of script) {
    await new Promise((r) => setTimeout(r, 400));
    await turn({ type: 'speech', text: line, confidence: 0.95 });
    if (ws.readyState !== ws.OPEN) break;
  }
  await new Promise((r) => setTimeout(r, 4000));
  send({ type: 'session:end', call_sid: callSid, reason: 'caller_hangup', duration_ms: Date.now() - turnStart });
  setTimeout(() => ws.close(), 500);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  const dt = Date.now() - turnStart;
  if (m.type === 'reply:chunk') {
    if (firstChunkAt === null) firstChunkAt = dt;
    console.log(`  +${String(dt).padStart(6)}ms chunk${m.turn_id === undefined ? ' (unprompted)' : ''}: ${JSON.stringify(m.chunk?.choices?.[0]?.delta?.content || '')}`);
  } else if (m.type === 'reply:done') {
    const r = m.turn_record || {};
    console.log(`  +${String(dt).padStart(6)}ms done  first_chunk=${firstChunkAt}ms lane=${r.lane} sops=${(r.sops || []).map((s) => s.id).join(',')} kb=${(r.knowledge || []).length}/${r.knowledge_backend || '-'} tools=${(r.own_tools || []).map((t) => `${t.name}:${t.ms}`).join(',')} models=${(r.model_calls || []).map((c) => `${c.model}@${c.first_token_ms}/${c.ms}ms`).join(',')} flags=${(r.flags || []).join(',')}`);
    setTimeout(() => send({ type: 'event', call_sid: callSid, name: 'reply_spoken', reply_id: m.reply_id }), 800);
    if (m.turn_id !== undefined && pendingDone) { const r2 = pendingDone; pendingDone = null; r2(); }
  } else if (m.type === 'tool:call') {
    console.log(`  tool:call ${m.name}(${JSON.stringify(m.args)}) -> stub`);
    send({ type: 'tool:result', call_sid: callSid, call_id: m.call_id, result: { ok: true, note: 'stub' } });
  } else if (m.type === 'command') {
    console.log(`  command ${m.name} ${JSON.stringify(m.args)}`);
    send({ type: 'command:result', call_sid: callSid, command_id: m.command_id, ok: true });
    if (m.name === 'hangup') { send({ type: 'session:end', call_sid: callSid, reason: 'harness_hangup', duration_ms: 1000 }); setTimeout(() => ws.close(), 300); }
  } else console.log('  <-', JSON.stringify(m).slice(0, 200));
});
ws.on('close', (code, reason) => { console.log(`\nclosed ${code} ${reason}`); process.exit(0); });
ws.on('error', (err) => { console.error('ws error', err.message || err); process.exit(1); });
ws.on('unexpected-response', (_req, res) => { console.error(`unexpected HTTP ${res.statusCode} on upgrade`); process.exit(1); });
