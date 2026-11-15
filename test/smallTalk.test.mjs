// node --test test/smallTalk.test.mjs — what counts as a hello (no tool) vs a request (llm/lanes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChitChat } from '../src/llm/lanes.js';

test('greetings, thanks and bare yes/no are small talk', () => {
  for (const t of ['hello', 'Hi', 'hey there', 'how are you?', 'thanks', 'Thank you!', 'yes', 'nope', 'bye', '']) assert.equal(isChitChat(t), true, t);
});

test('anything with a job in it is not', () => {
  for (const t of ['hello, can you find me a pizza', 'open uber eats', 'check the storms this afternoon', 'ring the restaurant', 'what is the time in Tokyo', 'text me that link']) {
    assert.equal(isChitChat(t), false, t);
  }
});
