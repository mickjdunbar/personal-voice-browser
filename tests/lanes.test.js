// Lane classifier, sentence splitter, speech scrubber, sentiment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/llm/lanes.js';
import { SentenceSplitter, scrubForSpeech } from '../src/llm/sentences.js';
import { scoreSentiment, trendOf } from '../src/sentiment.js';

test('classify: chit-chat fast, web requests deep, confirmations deep only when pending', () => {
  assert.equal(classify("G'day, how's it going?"), 'fast');
  assert.equal(classify('thanks, bye!'), 'fast');
  assert.equal(classify('open uber eats'), 'deep');
  assert.equal(classify('search for the best laptop under 1500 dollars'), 'deep');
  assert.equal(classify("what's on this page?"), 'deep');
  assert.equal(classify('yes'), 'fast');
  assert.equal(classify('yes', { pendingConfirmation: true }), 'deep');
  assert.equal(classify('go ahead', { pendingConfirmation: true }), 'deep');
  assert.equal(classify('read me the top story on the abc'), 'deep');
});

test('sentence splitter streams complete sentences and flushes the tail', () => {
  const s = new SentenceSplitter();
  const out = [...s.push('Sure. Let me '), ...s.push('look at that. The total is 3.'), ...s.push('5 dollars. Ok')];
  assert.deepEqual(out, ['Sure. ', 'Let me look at that. ', 'The total is 3.5 dollars. ']);
  assert.equal(s.flush(), 'Ok');
});

test('scrubForSpeech removes refs, markdown and URLs', () => {
  assert.equal(scrubForSpeech('Click [12] **Checkout** at https://www.ubereats.com/au/checkout now'), 'Click Checkout at ubereats.com now');
});

test('sentiment: negation, intensifiers, trend', () => {
  assert.equal(scoreSentiment('this is great, thanks').label, 'positive');
  assert.equal(scoreSentiment('this is not great at all').label, 'negative');
  assert.ok(scoreSentiment('really awful').score < scoreSentiment('awful').score);
  assert.equal(trendOf([-0.5, -0.2, 0.1, 0.4]).trend, 'improving');
  assert.equal(trendOf([0.5]).trend, 'steady');
});
