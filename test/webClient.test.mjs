// node --test test/webClient.test.mjs — the "may change Talk Settings" gate (agent/webClient.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebClient } from '../src/agent/webClient.js';

test('a WebRTC call tagged by the softphone headers is the web client; a PSTN call is not', () => {
  assert.equal(isWebClient({ channel: 'voice', info: { to: 'app-735e', webClient: true } }), true);
  assert.equal(isWebClient({ channel: 'voice', info: { to: '+61745188002', from: '+61400000000', webClient: false } }), false);
});

test('the explicit tag wins over the app- prefix either way', () => {
  assert.equal(isWebClient({ channel: 'voice', info: { to: 'app-735e', webClient: false } }), false);
  assert.equal(isWebClient({ channel: 'voice', info: { to: '+61745188002', webClient: true } }), true);
});

test('legacy voice legs with no tag fall back to the dialled-app prefix', () => {
  assert.equal(isWebClient({ channel: 'voice', info: { to: 'app-735e' } }), true);
  assert.equal(isWebClient({ channel: 'specialist', info: { to: '+61745188002' } }), false);
});

test('task threads follow the per-turn webOwner mark', () => {
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'task' }, metadata: { task: 't1', webOwner: true } }), true);
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'task' }, metadata: { task: 't1', webOwner: false } }), false);
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'task', webClient: true }, metadata: { task: 't1' } }), false, 'a task ignores info and trusts the store');
});

test('the console text box and the boot warm-up are the web client; anything else is not', () => {
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'text' } }), true);
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'boot' } }), true);
  assert.equal(isWebClient({ channel: 'text', info: { channel: 'whatsapp' } }), false);
  assert.equal(isWebClient({}), false);
});
