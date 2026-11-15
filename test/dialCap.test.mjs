// node --test test/dialCap.test.mjs — the outbound-dial cap (phone/dialCap.js). No calls placed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dialAllowed, recordDial, resetDialCap, rootSession, dialCounts } from '../src/phone/dialCap.js';

const cap = { perSession: 3, total: 5, windowMs: 60_000 };

test('worker sub-sessions and the owner session share one bucket', () => {
  assert.equal(rootSession('main#w-3'), 'main');
  assert.equal(rootSession('task-abc'), 'task-abc');
  assert.equal(rootSession(undefined), 'main');
});

test('per-session cap, then it refuses with a sentence for the model', () => {
  resetDialCap();
  for (let i = 0; i < 3; i++) { assert.equal(dialAllowed('main#w-1', { now: 1000 + i, cap }).ok, true); recordDial('main', 1000 + i); }
  const r = dialAllowed('main', { now: 2000, cap });
  assert.equal(r.ok, false);
  assert.match(r.error, /call cap reached: 3 outbound calls from this session/);
  assert.match(r.error, /do not retry/);
});

test('the window slides: old dials stop counting', () => {
  resetDialCap();
  for (let i = 0; i < 3; i++) recordDial('main', 1000);
  assert.equal(dialAllowed('main', { now: 1000 + 59_000, cap }).ok, false);
  assert.equal(dialAllowed('main', { now: 1000 + 61_000, cap }).ok, true);
});

test('the total cap spans sessions', () => {
  resetDialCap();
  for (const s of ['a', 'b', 'c', 'd', 'e']) recordDial(s, 5000);
  const r = dialAllowed('fresh-session', { now: 5001, cap });
  assert.equal(r.ok, false);
  assert.match(r.error, /across the whole system/);
  assert.equal(dialCounts(5001)['*'], 5);
});
