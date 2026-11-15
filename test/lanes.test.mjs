// node --test test/lanes.test.mjs — which opening filler a request implies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { intentOf } from '../src/llm/lanes.js';

test('a real call request is phone', () => {
  assert.equal(intentOf('Can you ring the restaurant and check they have a table?'), 'phone');
  assert.equal(intentOf('Phone Dave and ask what time he lands'), 'phone');
  assert.equal(intentOf('call 0412 345 678 for me'), 'phone');
});

test('ruling calling OUT is not a call', () => {
  assert.notEqual(intentOf("Open the BOM forecast for Toogoolawah and tell me today's maximum. No screenshot needed, no phone calls."), 'phone');
  assert.notEqual(intentOf("Find their opening hours online, don't ring them"), 'phone');
  assert.notEqual(intentOf('Check the website without calling anyone'), 'phone');
  assert.notEqual(intentOf('No need to phone, just look it up'), 'phone');
});

test('looking up a phone number is a browse, not a call', () => {
  assert.notEqual(intentOf("What's the phone number for Chu the Phat?"), 'phone');
});

test('a negated mention does not hide a real request elsewhere in the text', () => {
  assert.equal(intentOf("Don't ring the bistro, ring the bar instead and ask if they're open"), 'phone');
});

test('chatbot and browse still classify', () => {
  assert.equal(intentOf('ask the HIA chatbot about scaffolding'), 'chatbot');
  assert.equal(intentOf('search for gluten free pizza near Newstead'), 'browse');
});
