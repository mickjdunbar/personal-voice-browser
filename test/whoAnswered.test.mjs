// node --test test/whoAnswered.test.mjs — canned pickups, no calls placed.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.WHO_ANSWERED_FILE = new URL('./.who-answered.test.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
import fs from 'node:fs';
import { createDetector, postureFor, inboundPostureFor, rememberVerdict, priorFor, renderMenuTree } from '../src/phone/whoAnswered.js';

const run = (opts, steps) => {
  const d = createDetector(opts);
  let v;
  for (const s of steps) v = d.observe(s);
  return v;
};

test('a person: "hello?" then a real reply', () => {
  const v = run({ kind: 'person' }, [
    { type: 'amd', result: 'amd_human_detected' },
    { type: 'heard', text: 'Hello?' },
    { type: 'said', text: "Oh hi Dave, it's Aria, Mick's assistant" },
    { type: 'heard', text: 'Oh yeah, hi, um, what can I do for you?', sinceSaidMs: 1400 }
  ]);
  assert.equal(v.kind, 'human');
  assert.ok(v.decided);
});

test('a business receptionist is still a human', () => {
  const v = run({ kind: 'business' }, [
    { type: 'heard', text: 'Chu the Phat, Sam speaking.' },
    { type: 'said', text: "Hi Sam, it's Aria calling for Mick about a table on Friday" },
    { type: 'heard', text: 'Friday, yep, how many was it?', sinceSaidMs: 900 }
  ]);
  assert.equal(v.kind, 'human');
});

test('HCF after-hours menu (verbatim from the mapper) is an IVR', () => {
  const v = run({ kind: 'business' }, [
    { type: 'amd', result: 'amd_machine_detected' },
    { type: 'heard', text: "Thank you for calling HCF. Our office is closed. If you're an existing HCF member and you would like to access our 24/7 health helpline to find a doctor or hospital or to speak to a nurse, press one. Otherwise please call back during business hours, which are 8:30 a.m. to 5:00 p.m. Monday to Friday, New South Wales time." }
  ]);
  assert.equal(v.kind, 'ivr');
  assert.ok(v.decided, 'decided on the first utterance');
});

test('speech IVR that repeats after we talk is an IVR', () => {
  const v = run({ kind: 'business' }, [
    { type: 'heard', text: 'Welcome to Riverbend Energy. In a few words, tell me why you are calling.' },
    { type: 'said', text: "Hi, it's Aria calling for Mick about quote Q-7731" },
    { type: 'heard', text: "Sorry, I didn't get that. In a few words, tell me why you are calling.", sinceSaidMs: 2200 }
  ]);
  assert.equal(v.kind, 'ivr');
});

test('an AI receptionist that says so is an agent', () => {
  const v = run({ kind: 'business' }, [
    { type: 'amd', result: 'amd_machine_detected' },
    { type: 'heard', text: "Hi, you've reached Sunny's Bistro. I'm Sunny, the restaurant's AI assistant. I can help you with bookings, opening hours or tonight's specials. How can I help you today?" }
  ]);
  assert.equal(v.kind, 'agent');
  assert.ok(v.decided);
});

test('an agent that does not announce itself: fast, long, fluent, on-topic', () => {
  const v = run({ kind: 'business' }, [
    { type: 'heard', text: 'Good evening, thanks for calling Riverbend Energy, how can I help you today?' },
    { type: 'said', text: "Hi, it's Aria calling for Mick about quote Q-7731 for the four solar panels" },
    { type: 'heard', text: "Certainly. I can see quote Q-7731 for four solar panels totalling three thousand four hundred and eighty dollars, valid until the twenty-eighth of February. I'd be happy to help you accept it, adjust the panel count, or arrange an installation date. Which would you like to do?", sinceSaidMs: 900 }
  ]);
  assert.equal(v.kind, 'agent');
});

test('Sunny, verbatim from the 14 Nov dry run: receptionist opener, instant booking with a reference', () => {
  const d = createDetector({ kind: 'business' });
  d.observe({ type: 'heard', text: 'Thanks for calling. This is Sunny at the front desk. How can I help you today?' });
  assert.equal(d.verdict().decided, false, 'the opener alone could be a person');
  d.observe({ type: 'said', text: "Oh hey Sunny, it's Aria here, Mick's assistant. I'm checking whether you've got a table for two at 7 tonight under Mick." });
  const v = d.observe({ type: 'heard', text: 'Booked. A table for two tonight at 7 p.m. under Mic. Reference RB 9849. Is there anything else I can help with?', sinceSaidMs: 1200 });
  assert.equal(v.kind, 'agent');
  assert.ok(v.decided);
});

test('finalize() turns an undecided leg into a best guess', () => {
  const d = createDetector({ kind: 'business' });
  d.observe({ type: 'heard', text: 'Thanks for calling. This is Sunny at the front desk. How can I help you today?' });
  const v = d.finalize();
  assert.ok(v.decided);
  assert.equal(v.by, 'end');
});

test('voicemail greeting + beep', () => {
  const v = run({ kind: 'person' }, [
    { type: 'amd', result: 'amd_machine_detected' },
    { type: 'heard', text: "Hi, you've reached Dave. I can't take your call right now, please leave a message after the tone." },
    { type: 'amd', result: 'amd_tone_detected' }
  ]);
  assert.equal(v.kind, 'voicemail');
});

test('IVR transfers to a person: the verdict follows', () => {
  const d = createDetector({ kind: 'business' });
  d.observe({ type: 'heard', text: 'Thank you for calling. For bookings press one, for the kitchen press two, to speak to a team member press zero.' });
  assert.equal(d.verdict().kind, 'ivr');
  d.observe({ type: 'heard', text: 'Please hold while we connect you to a team member.' });
  d.observe({ type: 'heard', text: "G'day, Jess speaking?" });
  assert.equal(d.verdict().kind, 'human');
});

test('three unclear turns fall back to human', () => {
  const v = run({ kind: 'business' }, [
    { type: 'heard', text: 'Yes.' },
    { type: 'said', text: 'Hi there' },
    { type: 'heard', text: 'Go ahead.' },
    { type: 'said', text: "It's Aria for Mick" },
    { type: 'heard', text: 'Right.' }
  ]);
  assert.equal(v.kind, 'human');
  assert.ok(v.decided);
});

test('a prior verdict for the number tilts the start, not the end', () => {
  const d = createDetector({ kind: 'business', prior: { kind: 'ivr' } });
  assert.equal(d.verdict().decided, false);
  const v = d.observe({ type: 'heard', text: 'Hello? Hello?' });
  assert.equal(v.kind, 'human');
});

test('probe is suggested once when human and agent tie after two exchanges', () => {
  const d = createDetector({ kind: 'business' });
  d.observe({ type: 'heard', text: 'Riverbend Energy, good afternoon.' });
  d.observe({ type: 'said', text: "Hi, it's Aria for Mick about quote Q-7731" });
  const v = d.observe({ type: 'heard', text: 'Sure, I can help with that quote. What would you like to do with it?', sinceSaidMs: 1000 });
  assert.equal(v.decided, false);
  assert.equal(v.probe, true);
  const again = d.observe({ type: 'said', text: 'Quick one — am I talking to a person or an automated assistant?' });
  assert.equal(again.probe, false, 'suggested once only');
  const v2 = d.observe({ type: 'heard', text: "Ha, yeah, I'm a real person, last time I checked." });
  assert.equal(v2.kind, 'human'); assert.ok(v2.decided);
});

test('probe answered the other way', () => {
  const d = createDetector({ kind: 'business' });
  d.observe({ type: 'heard', text: 'Riverbend Energy, good afternoon.' });
  d.observe({ type: 'said', text: 'am I talking to a person or an automated assistant?' });
  const v = d.observe({ type: 'heard', text: "I'm an automated assistant for Riverbend Energy, not a person — but I can help with quotes." });
  assert.equal(v.kind, 'agent'); assert.ok(v.decided);
});

test('timing prosody: metronomic fast delivery leans agent', () => {
  const d = createDetector({ kind: 'business' });
  const line = 'I can certainly help you with that booking request for this evening at your preferred time.';
  let v;
  for (let i = 0; i < 3; i++) { d.observe({ type: 'said', text: 'ok' }); v = d.observe({ type: 'heard', text: line, durationMs: 4300, sinceSaidMs: 900 }); }
  assert.ok(v.scores.agent > v.scores.human);
});

test('per-number memory persists and becomes a prior; a map beats memory', () => {
  try { fs.unlinkSync(process.env.WHO_ANSWERED_FILE); } catch {}
  rememberVerdict('+61700000001', { kind: 'agent', confidence: 0.7, by: 'score' });
  assert.equal(priorFor('+61700000001').kind, 'agent');
  assert.equal(priorFor('+61700000002'), null);
  const maps = [{ id: 'm1', to: '+61700000001', dialed: '+61700000001', status: 'stopped', calls: 14 }, { id: 'm2', to: '+61700000003', dialed: '+61340621105', status: 'done', calls: 1 }];
  assert.equal(priorFor('+61700000001', { maps }).mapId, 'm1');
  assert.equal(priorFor('+61700000003', { maps }), null, 'a test-redirected map does not count');
  const raw = JSON.parse(fs.readFileSync(process.env.WHO_ANSWERED_FILE, 'utf8'));
  assert.equal(raw['+61700000001'].history.length, 1);
  fs.unlinkSync(process.env.WHO_ANSWERED_FILE);
});

test('renderMenuTree lists menu nodes with their keys', () => {
  const tree = renderMenuTree({ nodes: { '': { path: '', depth: 0, title: 'Main', options: [{ key: '1', label: 'bookings' }, { key: '2', label: 'kitchen' }] }, '1': { path: '1', depth: 1, title: 'Bookings', options: [{ key: '1', label: 'new' }] }, '2': { path: '2', depth: 1, title: 'Kitchen', options: [] } } });
  assert.match(tree, /at pickup — Main: 1=bookings, 2=kitchen/);
  assert.match(tree, /after keys 1 — Bookings: 1=new/);
  assert.ok(!/Kitchen/.test(tree));
});

test('inbound: an agent caller is spotted from its brief', () => {
  const d = createDetector({ kind: 'inbound' });
  const v = d.observe({ type: 'heard', text: 'Hello. This is Orbit, an automated AI assistant calling on behalf of Dana Reyes. I need two things: the weather in Brisbane tonight, and whether the Queensland Museum is open tomorrow.', durationMs: 7000 });
  assert.equal(v.kind, 'agent'); assert.ok(v.decided);
  assert.ok(inboundPostureFor('agent').length > 80);
  assert.equal(inboundPostureFor('human'), '');
});

test('postures exist for every kind', () => {
  for (const k of ['human', 'agent', 'ivr', 'voicemail']) assert.ok(postureFor(k, { who: 'Mick', goal: 'a table for four' }).length > 80);
});
