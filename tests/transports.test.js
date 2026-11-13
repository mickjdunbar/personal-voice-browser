// Tasks-over-messaging helpers: number matching, #tag routing, Twilio signature check.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sameNumber, parseTaskTag, validTwilioSignature } from '../src/tasks/transports.js';

test('sameNumber matches across formats and rejects strangers', () => {
  assert.ok(sameNumber('+61400123456', '0400 123 456'));
  assert.ok(sameNumber('whatsapp-stripped +61400123456'.slice(-12), '+61400123456'));
  assert.ok(!sameNumber('+61400123456', '+61400123457'));
  assert.ok(!sameNumber('', '+61400123456'));
  assert.ok(!sameNumber('+61400123456', ''));
  assert.ok(!sameNumber('1234', '1234')); // too short to trust
});

test('parseTaskTag pulls #seq and the rest, ignores untagged text', () => {
  assert.deepEqual(parseTaskTag('#3 yes, do the watchlist'), { seq: 3, rest: 'yes, do the watchlist' });
  assert.deepEqual(parseTaskTag('  #12: more please'), { seq: 12, rest: 'more please' });
  assert.deepEqual(parseTaskTag('#7'), { seq: 7, rest: '' });
  assert.equal(parseTaskTag('meet at 3pm works for me'), null);
  assert.equal(parseTaskTag('new task about #tags'), null);
});

test('validTwilioSignature verifies the documented HMAC scheme', () => {
  const authToken = 'test-token-123';
  const url = 'https://example.ngrok.io/webhooks/message';
  const params = { From: 'whatsapp:+61400000000', Body: 'hello', MessageSid: 'SM123' };
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const signature = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  assert.ok(validTwilioSignature({ url, params, signature, authToken }));
  assert.ok(!validTwilioSignature({ url, params, signature: signature.slice(0, -2) + 'xx', authToken }));
  assert.ok(!validTwilioSignature({ url: url + '2', params, signature, authToken }));
  assert.ok(validTwilioSignature({ url, params, signature: '', authToken: '' })); // nothing to verify against
});
