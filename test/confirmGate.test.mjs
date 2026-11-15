// node --test test/confirmGate.test.mjs — destructive Talk Settings actions need a real second turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmGate } from '../src/agent/confirmGate.js';

test('the first call always asks, even with confirm:true from the model', () => {
  const st = {};
  const r = confirmGate(st, 'remove_mcp_server:deepwiki', 3);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'first ask');
  assert.equal(st.pendingConfirm.key, 'remove_mcp_server:deepwiki');
});

test('a retry in the SAME turn is still refused (the owner has not spoken)', () => {
  const st = {};
  confirmGate(st, 'remove_chatbot:cognigy-trial', 3);
  const r = confirmGate(st, 'remove_chatbot:cognigy-trial', 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same turn/);
});

test('the same target on a later turn goes through once, then needs asking again', () => {
  const st = {};
  confirmGate(st, 'test_dial:off', 3);
  assert.equal(confirmGate(st, 'test_dial:off', 4).ok, true);
  assert.equal(st.pendingConfirm, null);
  assert.equal(confirmGate(st, 'test_dial:off', 5).ok, false, 'consent is single-use');
});

test('a different target resets the question; a stale one expires', () => {
  const st = {};
  confirmGate(st, 'remove_mcp_server:deepwiki', 3, { now: 1000 });
  const other = confirmGate(st, 'remove_mcp_server:zapier', 4, { now: 2000 });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'different target');
  const st2 = {};
  confirmGate(st2, 'remove_mcp_server:deepwiki', 3, { now: 1000 });
  assert.equal(confirmGate(st2, 'remove_mcp_server:deepwiki', 4, { now: 1000 + 11 * 60 * 1000 }).ok, false, 'ten minutes later the yes is stale');
});
