// The harness protocol end to end: a fake jambonz over harness.jambonz.org
// against createHarnessServer, with a fake Navigator session (no models, no browser).
import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.GEMINI_API_KEY = 'test';
process.env.PUBLIC_HOST = '';
process.env.KB_EMBEDDINGS = 'false';

// A fake Navigator stands in for the real one so the role never touches Playwright or Gemini.
const fakeNav = {
  sessionId: 'main', channel: 'voice', deepTurns: 1, handoff: null, ended: false, startedAt: Date.now(), tab: { url: 'https://example.com', last: { title: 'Example' } },
  emit() {},
  async turn(text, writer, { kind }) {
    if (kind === 'greeting') { writer.write('Hello there. What can I open?'); return { record: { route: 'navigator:scripted_greeting', steps: [], model_calls: [], flags: [] }, hangup: null }; }
    if (/bye/i.test(text)) { writer.write('Bye for now.'); return { record: { route: 'navigator:fast', lane: 'fast', steps: [], model_calls: [], flags: [] }, hangup: { reason: 'caller_done' } }; }
    writer.write('Opening that. '); writer.push('I can see the home page. What next?');
    return { record: { route: 'navigator:deep', lane: 'deep', steps: [], model_calls: [{ model: 'fake', first_token_ms: 5, ms: 9 }], flags: [], own_tools: [{ name: 'navigate', ok: true, ms: 3 }] }, hangup: null, handback: false };
  },
  async summary() { return 'summary'; },
  transcript() { return []; }
};
const roles = await import('../src/harness/roles/navigator.js');
// Re-bind the role's import by shadowing through the module cache is not possible in ESM; instead
// the server is constructed with a role that uses our fake directly.
const { createHarnessServer, HARNESS_SUBPROTOCOL } = await import('../src/harness/server.js');
const rolesIndex = await import('../src/harness/roles/index.js');
rolesIndex.ROLES.navigator = {
  name: 'navigator',
  create(ctx) {
    const inner = roles.create(ctx);
    // swap the session getter used inside the role
    return {
      ...inner,
      async start() {},
      async greeting(turn, writer) { const r = await fakeNav.turn('', writer, { kind: 'greeting' }); return r; },
      async turn(turn, writer) { return fakeNav.turn(turn.text, writer, { kind: 'speech' }); },
      async noInput(turn, writer) { writer.write('Go on?'); return { record: { route: 'navigator:no_input' } }; }
    };
  }
};

let server, harness, port;
before(async () => {
  harness = createHarnessServer({ path: '/harness' });
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => { if (!harness.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(async () => { await new Promise((r) => server.close(r)); });

function connect(metadata = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/harness?session=test`, HARNESS_SUBPROTOCOL);
  const inbox = []; const waiters = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred, ms = 4000) => new Promise((resolve, reject) => { const hit = inbox.find(pred); if (hit) return resolve(hit); const t = setTimeout(() => reject(new Error('timeout')), ms); waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } }); });
  const send = (m) => ws.send(JSON.stringify({ call_sid: 'c1', ...m }));
  return new Promise((resolve) => ws.on('open', () => { send({ type: 'session:start', protocol: 1, direction: 'inbound', from: '+1', to: '+2', metadata, tools: [] }); resolve({ ws, inbox, next, send }); }));
}

test('greeting + a browsing turn stream chunks and a turn record with first_chunk_ms', async () => {
  const c = await connect({ role: 'navigator' });
  c.send({ type: 'turn:start', turn_id: 1, input: { type: 'greeting' } });
  const d1 = await c.next((m) => m.type === 'reply:done' && m.turn_id === 1);
  assert.equal(d1.turn_record.route, 'navigator:scripted_greeting');
  const chunks1 = c.inbox.filter((m) => m.type === 'reply:chunk' && m.turn_id === 1);
  assert.equal(chunks1[0].chunk.object, 'chat.completion.chunk');
  assert.equal(chunks1.map((m) => m.chunk.choices[0].delta.content).join(''), 'Hello there. What can I open?');
  c.send({ type: 'turn:start', turn_id: 2, input: { type: 'speech', text: 'open example dot com' } });
  const d2 = await c.next((m) => m.type === 'reply:done' && m.turn_id === 2);
  assert.equal(d2.turn_record.lane, 'deep');
  assert.ok(Number.isFinite(d2.turn_record.first_chunk_ms));
  assert.equal(d2.turn_record.own_tools[0].name, 'navigate');
  assert.ok(d2.turn_record.steps.at(-1).name === 'turn_total');
  c.ws.close();
});

test('end_call -> hangup command after reply_spoken; session:end closes cleanly', async () => {
  const c = await connect({ role: 'navigator' });
  c.send({ type: 'turn:start', turn_id: 1, input: { type: 'speech', text: 'ok bye' } });
  const done = await c.next((m) => m.type === 'reply:done' && m.turn_id === 1);
  c.send({ type: 'event', name: 'reply_spoken', reply_id: done.reply_id });
  const cmd = await c.next((m) => m.type === 'command' && m.name === 'hangup');
  assert.equal(cmd.args.reason, 'caller_done');
  c.send({ type: 'command:result', command_id: cmd.command_id, ok: true });
  c.send({ type: 'session:end', reason: 'harness_hangup', duration_ms: 1234 });
  await new Promise((r) => setTimeout(r, 50));
  c.ws.close();
});

test('turn:cancel drops the reply; wrong protocol closes with 4000; missing subprotocol is refused', async () => {
  const c = await connect({ role: 'navigator' });
  c.send({ type: 'turn:start', turn_id: 1, input: { type: 'speech', text: 'open example' } });
  c.send({ type: 'turn:cancel', turn_id: 1, reason: 'barge_in' });
  c.send({ type: 'turn:start', turn_id: 2, input: { type: 'no_input' } });
  const d2 = await c.next((m) => m.type === 'reply:done' && m.turn_id === 2);
  assert.equal(d2.turn_record.route, 'navigator:no_input');
  c.ws.close();

  const bad = new WebSocket(`ws://127.0.0.1:${port}/harness`, HARNESS_SUBPROTOCOL);
  const code = await new Promise((resolve) => { bad.on('open', () => bad.send(JSON.stringify({ type: 'session:start', protocol: 2, call_sid: 'x' }))); bad.on('close', (c2) => resolve(c2)); });
  assert.equal(code, 4000);

  const noProto = new WebSocket(`ws://127.0.0.1:${port}/harness`);
  const status = await new Promise((resolve) => { noProto.on('unexpected-response', (_r, res) => resolve(res.statusCode)); noProto.on('error', () => {}); });
  assert.equal(status, 400);
});
