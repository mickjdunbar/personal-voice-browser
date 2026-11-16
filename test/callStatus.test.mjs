// node --test test/callStatus.test.mjs — dial failures in plain words (phone/callStatus.js). No calls placed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDialFailure, isAuShortNumber, timeoutHint, watchCallStatus, onStatusWebhook } from '../src/phone/callStatus.js';

test('Australian 13 / 1300 / 1800 numbers are recognised in every spelling', () => {
  for (const n of ['+61132334', '61132334', '132334', '0132334', '+611300123456', '1800123456']) assert.equal(isAuShortNumber(n), true, n);
  for (const n of ['+61272305100', '+61412345678', '0272305100', '+12125551234']) assert.equal(isAuShortNumber(n), false, n);
});

test('a SIP 403 on a 13 number says why and what to do instead', () => {
  const msg = describeDialFailure({ status: 'failed', sip: 403, reason: 'Forbidden' }, '+61132334');
  assert.match(msg, /refused the call \(SIP 403/);
  assert.match(msg, /13 \/ 1300 \/ 1800/);
  assert.match(msg, /local landline/);
});

test('other causes read naturally', () => {
  assert.equal(describeDialFailure({ status: 'busy', sip: 486 }, '+61272305100'), 'the line was busy');
  assert.match(describeDialFailure({ status: 'no-answer', sip: 480 }, '+61272305100'), /^nobody answered$/);
  assert.match(describeDialFailure({ status: 'failed', sip: 404 }, '+61272305100'), /not valid or not routable \(SIP 404\)/);
  assert.match(describeDialFailure({ status: 'failed', sip: 403 }, '+61272305100'), /barred on this trunk/);
  assert.match(describeDialFailure({ status: 'failed', sip: 503, reason: 'Service Unavailable' }, '+61272305100'), /could not route/);
});

test('the blind-timeout hint only fires for short numbers', () => {
  assert.match(timeoutHint('+61132334'), /local landline/);
  assert.equal(timeoutHint('+61272305100'), '');
});

test('webhooks reach the watcher once and are normalised', () => {
  const got = [];
  const unwatch = watchCallStatus('CA-1', (st) => got.push(st));
  onStatusWebhook({ call_sid: 'CA-1', call_status: 'trying', sip_status: 100 });
  onStatusWebhook({ call_sid: 'CA-1', call_status: 'failed', sip_status: '403', sip_reason: 'Forbidden', to: '61132334' });
  onStatusWebhook({ call_sid: 'CA-1', call_status: 'failed', sip_status: 403 }); // after a final status the watcher is gone
  onStatusWebhook({ call_sid: 'CA-other', call_status: 'failed', sip_status: 403 });
  assert.deepEqual(got.map((s) => [s.status, s.sip]), [['trying', 100], ['failed', 403]]);
  assert.equal(got[1].reason, 'Forbidden');
  unwatch();
});
