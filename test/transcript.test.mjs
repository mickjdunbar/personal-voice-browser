// node --test test/transcript.test.mjs — live-call transcript folding (conductor/transcript.js),
// replayed in the order the providers really send things.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTranscript, noteSpeechStart, noteCommitted, noteTurnComplete, closeLine } from '../src/conductor/transcript.js';

const fresh = () => ({ transcript: [] });
const lines = (ctl) => ctl.transcript.map((l) => `${l.role}:${l.text}`);

test('OpenAI: a late caller transcription does not glue the next answer onto the previous line', () => {
  const ctl = fresh();
  // T+0 Aria greets (item A), response done
  foldTranscript(ctl, { role: 'assistant', text: 'Hey hey! Aria here — what are we getting up to today?', item: 'A', now: 1000 });
  noteTurnComplete(ctl);
  // T+3000 the caller starts speaking; T+5000 committed under item U — no text yet
  noteSpeechStart(ctl, 3000);
  noteCommitted(ctl, 'U', 5000);
  // T+6000 Aria's SECOND response begins (item B) before the caller's transcript arrives
  foldTranscript(ctl, { role: 'assistant', text: 'Sure thing, let me check the storms.', item: 'B', now: 6000 });
  // T+6500 the caller's transcription lands
  const u = foldTranscript(ctl, { role: 'user', text: 'Hey, any storms this afternoon?', item: 'U', now: 6500 });
  // T+6700 more of Aria's SAME response folds into her line, not a new bubble
  const b2 = foldTranscript(ctl, { role: 'assistant', text: ' Give me a sec.', item: 'B', now: 6700 });
  assert.deepEqual(lines(ctl), [
    'assistant:Hey hey! Aria here — what are we getting up to today?',
    'assistant:Sure thing, let me check the storms.',
    'user:Hey, any storms this afternoon?'
  ].map((s, i) => (i === 1 ? 'assistant:Sure thing, let me check the storms. Give me a sec.' : s)));
  assert.equal(u.newLine, true);
  assert.equal(u.line.at, 3000, 'the caller line is stamped when they STARTED speaking, not when the text arrived');
  assert.equal(b2.newLine, false);
  assert.equal(b2.lineNo, 1);
});

test('OpenAI: deltas of one item fold; a new item starts a new line even for the same role', () => {
  const ctl = fresh();
  foldTranscript(ctl, { role: 'assistant', text: 'One', item: 'A' });
  foldTranscript(ctl, { role: 'assistant', text: ' two', item: 'A' });
  foldTranscript(ctl, { role: 'assistant', text: 'Three', item: 'B' });
  assert.deepEqual(lines(ctl), ['assistant:One two', 'assistant:Three']);
});

test('Gemini (no item ids): synthetic items give one line per utterance', () => {
  const ctl = fresh();
  foldTranscript(ctl, { role: 'assistant', text: 'Hey hey! ', now: 1000 });
  foldTranscript(ctl, { role: 'assistant', text: 'Aria here.', now: 1100 });
  noteTurnComplete(ctl);
  foldTranscript(ctl, { role: 'user', text: 'Storms ', now: 5000 });
  foldTranscript(ctl, { role: 'user', text: 'this arvo?', now: 5200 });
  foldTranscript(ctl, { role: 'assistant', text: 'Let me check.', now: 6000 });
  noteTurnComplete(ctl);
  foldTranscript(ctl, { role: 'user', text: 'Ta.', now: 9000 });
  assert.deepEqual(lines(ctl), ['assistant:Hey hey! Aria here.', 'user:Storms this arvo?', 'assistant:Let me check.', 'user:Ta.']);
  assert.deepEqual(ctl.transcript.map((l) => l.item), ['assistant#0', 'user#0', 'assistant#1', 'user#1']);
});

test('the next speech start closes an open caller line', () => {
  const ctl = fresh();
  foldTranscript(ctl, { role: 'user', text: 'first thing', item: 'U1', now: 1000 });
  noteSpeechStart(ctl, 4000);
  foldTranscript(ctl, { role: 'user', text: 'second thing', item: 'U1', now: 4500 }); // same id reused by a quirky provider
  assert.deepEqual(lines(ctl), ['user:first thing', 'user:second thing']);
  closeLine(ctl, 'user');
  assert.equal(ctl.transcript.at(-1).closed, true);
});
