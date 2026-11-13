// Observability store: Upstash pipeline shape (fake fetch) and the memory fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityStore, UpstashRedis } from '../src/observability/store.js';

test('memory backend keeps sessions, turns and daily counters', async () => {
  const o = new ObservabilityStore({ redis: new UpstashRedis({ url: '', token: '' }) });
  assert.equal(o.backend, 'memory');
  await o.sessionStart('s1', { channel: 'voice' });
  await o.turn('s1', { lane: 'deep', model_calls: [{ first_token_ms: 900, input_tokens: 10, output_tokens: 5 }], own_tools: [{ name: 'navigate' }] });
  await o.sessionEnd('s1', { turns: 1 });
  const sessions = await o.recentSessions();
  assert.equal(sessions[0].id, 's1');
  assert.equal(sessions[0].turns, 1);
  assert.equal((await o.turns('s1')).length, 1);
  assert.equal((await o.daily()).turns, 1);
});

test('upstash backend sends one pipeline per write with the documented keys', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(JSON.parse(init.body).map(() => ({ result: 1 }))), { status: 200 }); };
  try {
    const o = new ObservabilityStore({ redis: new UpstashRedis({ url: 'https://x.upstash.io', token: 't' }) });
    assert.equal(o.backend, 'upstash');
    await o.sessionStart('s2', { channel: 'text' });
    await o.turn('s2', { lane: 'fast', model_calls: [{ first_token_ms: 500 }] });
    assert.equal(sent[0].url, 'https://x.upstash.io/pipeline');
    assert.equal(sent[0].body[0][0], 'ZADD');
    assert.equal(sent[0].body[1][1], 'mab:session:s2');
    const turnCmds = sent[1].body.map((c) => c[0] + ' ' + c[1]);
    assert.ok(turnCmds.includes('RPUSH mab:turns:s2'));
    assert.ok(turnCmds.some((c) => c.startsWith('HINCRBY mab:metrics:daily:')));
  } finally { global.fetch = realFetch; }
});

test('upstash failure falls back to memory without throwing', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('nope', { status: 500 });
  try {
    const o = new ObservabilityStore({ redis: new UpstashRedis({ url: 'https://x.upstash.io', token: 't' }) });
    await o.sessionStart('s3', {});
    await o.turn('s3', { lane: 'fast' });
    assert.ok(o.lastError);
    assert.equal((await o.turns('s3')).length, 1);
  } finally { global.fetch = realFetch; }
});
