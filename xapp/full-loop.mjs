// Full conversation loop test (no phone): one harness session —
//   turn 1 "send me a map…"  -> agent creates the xApp (agent.link seen on /ui)
//   (headless Chromium opens the link, drops a pin, confirms)
//   the WATCHER pushes: expect an unprompted agent.said with the address (no "done" needed).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const CWD = 'C:/Users/mick/Code/Current/vibes/jambonz/mick-agentic-browser';
const require = createRequire(CWD + '/package.json');
const WebSocket = require('ws');

const session = 'fullloop-' + Date.now().toString(36);
let xappUrl = null;
const pushed = []; // unprompted agent.said lines from the watcher

// 1) watch the UI stream for agent.link + the watcher's pushes
const ui = new WebSocket(`ws://localhost:3005/ui?session=${encodeURIComponent(session)}`);
ui.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  const e = m.event || m;
  if (e.type === 'agent.link') { xappUrl = e.url; console.log('agent.link:', e.url.slice(0, 70) + '…'); }
  if (e.type === 'agent.said' && e.unprompted && e.lane === 'xapp') { pushed.push(e.text); console.log('PUSH:', e.text); }
});
await new Promise((r) => ui.on('open', r));

// 2) harness session
const ws = new WebSocket(`ws://localhost:3005/harness?session=${encodeURIComponent(session)}`, 'harness.jambonz.org');
const send = (m) => ws.send(JSON.stringify(m));
const callSid = 'fl-' + Math.random().toString(16).slice(2, 8);
let turnId = 0, pendingDone = null, lastReply = '';
const turn = (text) => {
  turnId += 1; lastReply = '';
  console.log(`\n>> turn ${turnId}: "${text}"`);
  send({ type: 'turn:start', call_sid: callSid, turn_id: turnId, input: { type: 'speech', text, confidence: 0.95 } });
  return new Promise((r) => { pendingDone = r; });
};
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'reply:chunk') { const c = m.chunk?.choices?.[0]?.delta?.content || ''; lastReply += c; process.stdout.write('   ' + c.trim() + '\n'); }
  else if (m.type === 'reply:done') { setTimeout(() => send({ type: 'event', call_sid: callSid, name: 'reply_spoken', reply_id: m.reply_id }), 150); if (m.turn_id !== undefined && pendingDone) { const r = pendingDone; pendingDone = null; r(); } }
  else if (m.type === 'command') { send({ type: 'command:result', call_sid: callSid, command_id: m.command_id, ok: true }); }
});
await new Promise((r) => ws.on('open', r));
send({ type: 'session:start', protocol: 1, call_sid: callSid, account_sid: 'a', application_sid: 'a', direction: 'inbound', from: '+61400000000', to: '+61745188002', language: 'en-AU', metadata: { role: 'navigator', session, agent: 'fullloop' }, tools: [] });
await new Promise((r) => setTimeout(r, 300));

await turn('send me a map so I can show you a pickup spot');
for (let i = 0; i < 20 && !xappUrl; i++) await new Promise((r) => setTimeout(r, 300));
if (!xappUrl) { console.error('NO agent.link — aborting'); process.exit(1); }

// 3) complete the xApp in a browser
console.log('\n>> driving the map page…');
const b = spawn('node', ['e2e-browser.mjs', xappUrl], { cwd: CWD + '/xapp' });
let bout = ''; b.stdout.on('data', (d) => { bout += d; });
await new Promise((r) => b.on('exit', r));
console.log(bout.split('\n').filter((l) => /address|CONFIRMED|OPENED/.test(l)).join('\n'));

// 4) the watcher should PUSH the result without any "done" from the caller
console.log('\n>> waiting for the watcher push (no "done" spoken)…');
for (let i = 0; i < 20 && !pushed.some((t) => /got that|picked/i.test(t)); i++) await new Promise((r) => setTimeout(r, 1000));
const resultPush = pushed.find((t) => /got that|picked/i.test(t)) || '';
const pass = /queen|brisbane|street|-27\.4/i.test(resultPush);
console.log(pass ? 'PASS: result pushed with location, unprompted' : `CHECK: no location push (got: ${JSON.stringify(pushed)})`);

// 5) follow-up uses the pin from history
await turn('what cafes are near that spot? just answer from what you know');
console.log('\nfollow-up reply:', JSON.stringify(lastReply.slice(0, 220)));
send({ type: 'session:end', call_sid: callSid, reason: 'caller_hangup', duration_ms: 1000 });
setTimeout(() => process.exit(pass ? 0 : 2), 600);
