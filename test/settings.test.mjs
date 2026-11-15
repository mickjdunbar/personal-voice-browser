// node --test test/settings.test.mjs — the runtime settings store (settings.js) against a scratch file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), `pvb-settings-test-${process.pid}.json`);
process.env.SETTINGS_FILE = file;
const S = await import('../src/settings.js');

test.after(() => { try { fs.unlinkSync(file); } catch { /* fine */ } });

test('defaults come from config; nothing is overridden at first', () => {
  const s = S.getSettings();
  assert.equal(typeof s.ambience.bedDb, 'number');
  assert.deepEqual(s.overridden, { ambience: [], language: [] });
  assert.match(S.ambience().bedGain, /^-?\d+ dB$/);
});

test('ambience values are validated, clamped and reported as changes', () => {
  const r = S.updateSettings({ ambience: { bedDb: -80, typingDb: 'abc' === 'x' ? 0 : -30, webrtcTrimDb: 20 } }, { by: 'test' });
  const byField = Object.fromEntries(r.changed.map((c) => [c.field, c.to]));
  assert.equal(byField['ambience.bedDb'], -60, 'clamped to the floor');
  assert.equal(byField['ambience.webrtcTrimDb'], 6, 'clamped to the ceiling');
  assert.equal(S.ambience().bedGain, '-60 dB');
  assert.throws(() => S.updateSettings({ ambience: { holdDb: 'loud' } }), /decibels/);
  assert.deepEqual(S.updateSettings({ ambience: { bedDb: -60 } }).changed, [], 'same value = no change');
});

test('language codes are normalised and bad ones rejected; the pin names the language', () => {
  const r = S.updateSettings({ language: { code: 'en_gb' } });
  assert.equal(r.changed[0].to, 'en-GB');
  assert.equal(S.language().name, 'British English');
  assert.match(S.language().pin, /^LANGUAGE: British English only/);
  assert.equal(S.language().short, 'en');
  assert.throws(() => S.updateSettings({ language: { code: 'english' } }), /language code/);
});

test('snapshot / restore is a clean undo; reset drops every override', () => {
  const snap = S.snapshotOverrides();
  S.updateSettings({ language: { code: 'fr-FR' } });
  assert.equal(S.language().code, 'fr-FR');
  S.restoreOverrides(snap);
  assert.equal(S.language().code, 'en-GB');
  S.resetSettings();
  assert.deepEqual(S.getSettings().overridden, { ambience: [], language: [] });
});

test('the change log answers "what changed since the last call"', () => {
  S.markCallStart(1_000);
  const before = S.changesSince(1_000).length;
  S.recordChange({ what: 'bots', label: 'chatbot add Cognigy trial', by: 'aria' });
  assert.equal(S.changesSince(1_000).length, before + 1);
  assert.equal(S.changesSince(Date.now() + 60_000).length, 0);
  S.markCallStart();
  assert.ok(S.lastCallAt() > 1_000);
});
