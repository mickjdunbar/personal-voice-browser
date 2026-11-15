// node --test test/greetings.test.mjs — how the host opens a call (conductor/greetings.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openingPlan } from '../src/conductor/greetings.js';

const PIN = 'LANGUAGE: Australian English only. ';
const plan = (o) => openingPlan({ hostName: 'Aria', langPin: PIN, ...o });

test('every variant starts with the language pin (the per-response instruction replaces the session prompt)', () => {
  for (const o of [{}, { opening: 'hello' }, { opening: 'find me a pizza near Newstead' }, { resume: { reconnect: true } }, { resume: { summary: 'mid-request' } }]) {
    assert.ok(plan(o).greeting.startsWith(PIN), `${JSON.stringify(o)} lacks the pin`);
  }
});

test('a typed hello is a hello, not a job', () => {
  const p = plan({ opening: 'hello' });
  assert.equal(p.kind, 'hello');
  assert.match(p.greeting, /Do NOT call any tool/);
  assert.match(p.openNote, /not a request/);
  assert.equal(plan({ opening: 'hi there, how are you?' }).kind, 'hello');
});

test('a typed request greets AND acts', () => {
  const p = plan({ opening: 'open uber eats and find me a pizza' });
  assert.equal(p.kind, 'request');
  assert.match(p.greeting, /IMMEDIATELY call browse_for_caller/);
  assert.match(p.openNote, /IMMEDIATELY call browse_for_caller/);
  assert.match(p.greeting, /open uber eats and find me a pizza/);
});

test('a cold call greets like a mate and never with a service line', () => {
  const p = plan({});
  assert.equal(p.kind, 'cold');
  assert.match(p.greeting, /say you're Aria/);
  assert.match(p.greeting, /NEVER stiff service lines/);
  assert.equal(p.openNote, '');
});

test('a resume continues instead of greeting', () => {
  const p = plan({ resume: { reconnect: true }, opening: 'hello' });
  assert.equal(p.kind, 'resume');
  assert.match(p.greeting, /Do not greet again/);
  assert.doesNotMatch(p.greeting, /browse_for_caller/);
});
