// 16 Nov 2026 (mick-agentic-browser): runtime settings the owner (or Aria, via talk_settings) can
// change without a restart — the ambience mix and the call language. `.env` still supplies the
// DEFAULTS (config.js); this store holds the overrides, persisted to .settings.json (git-ignored),
// plus a short log of every Talk Settings change so a call can open with "what changed since last
// time" (conductor → settings.since_last_call).
import fs from 'node:fs';
import { config } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('Settings');
const FILE = process.env.SETTINGS_FILE || '.settings.json';
const MAX_CHANGES = 60;

const dB = (s) => { const n = parseFloat(String(s)); return Number.isFinite(n) ? n : 0; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Languages the call can run in. The pin text is what the Realtime greeting gets prefixed with. */
export const LANGUAGES = {
  'en-AU': 'Australian English', 'en-NZ': 'New Zealand English', 'en-GB': 'British English', 'en-US': 'American English',
  'en-IE': 'Irish English', 'en-IN': 'Indian English', 'fr-FR': 'French', 'de-DE': 'German', 'es-ES': 'Spanish',
  'it-IT': 'Italian', 'pt-BR': 'Brazilian Portuguese', 'ja-JP': 'Japanese', 'zh-CN': 'Mandarin Chinese', 'hi-IN': 'Hindi'
};

function defaults() {
  return {
    ambience: {
      enabled: config.ambience.enabled,
      bedDb: dB(config.ambience.bedGain), typingDb: dB(config.ambience.typingGain), holdDb: dB(config.ambience.holdGain),
      webrtcTrimDb: Number(config.ambience.webrtcTrimDb) || 0
    },
    language: { code: process.env.CALL_LANGUAGE || 'en-AU' }
  };
}

let state = { overrides: {}, changes: [], lastCallAt: 0 };
try {
  if (fs.existsSync(FILE)) {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { overrides: raw.overrides || {}, changes: Array.isArray(raw.changes) ? raw.changes.slice(-MAX_CHANGES) : [], lastCallAt: Number(raw.lastCallAt) || 0 };
  }
} catch (err) { logger.warn(`settings not loaded: ${err.message}`); }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify({ saved_at: new Date().toISOString(), ...state }, null, 1)); }
    catch (err) { logger.warn(`settings not saved: ${err.message}`); }
  }, 150);
  if (saveTimer.unref) saveTimer.unref();
}

/** Effective settings (defaults + overrides) plus the defaults themselves, for the UI. */
export function getSettings() {
  const d = defaults();
  const o = state.overrides || {};
  return {
    ambience: { ...d.ambience, ...(o.ambience || {}) },
    language: { ...d.language, ...(o.language || {}) },
    defaults: d,
    overridden: { ambience: Object.keys(o.ambience || {}), language: Object.keys(o.language || {}) }
  };
}

/** The ambience block in the shape the conductor's dub commands want ('-36 dB' strings). */
export function ambience() {
  const a = getSettings().ambience;
  return { enabled: Boolean(a.enabled), bedGain: `${Math.round(a.bedDb)} dB`, typingGain: `${Math.round(a.typingDb)} dB`, holdGain: `${Math.round(a.holdDb)} dB`, webrtcTrimDb: Number(a.webrtcTrimDb) || 0 };
}

/** The call language: BCP-47 code, display name, the short code for transcription, and the prompt pin. */
export function language() {
  const code = getSettings().language.code || 'en-AU';
  const name = LANGUAGES[code] || code;
  const short = code.split('-')[0].toLowerCase();
  const relaxed = short === 'en' ? ' — relaxed, natural' : '';
  return { code, name, short, pin: `LANGUAGE: ${name} only${relaxed} (the caller speaks ${name}). ` };
}

/**
 * Apply a partial update. `patch` = { ambience?: {enabled?, bedDb?, typingDb?, holdDb?, webrtcTrimDb?}, language?: {code?} }.
 * Values are validated and clamped; unknown keys are ignored. Returns the new effective settings and
 * the list of fields that actually changed (empty = nothing to do). Does NOT emit events — callers do.
 */
export function updateSettings(patch = {}, { by = 'console' } = {}) {
  const before = getSettings();
  const o = state.overrides = { ambience: { ...(state.overrides.ambience || {}) }, language: { ...(state.overrides.language || {}) } };
  const changed = [];
  const a = patch.ambience && typeof patch.ambience === 'object' ? patch.ambience : {};
  if (typeof a.enabled === 'boolean' && a.enabled !== before.ambience.enabled) { o.ambience.enabled = a.enabled; changed.push({ field: 'ambience.enabled', from: before.ambience.enabled, to: a.enabled }); }
  for (const [k, lo, hi] of [['bedDb', -60, 0], ['typingDb', -60, 0], ['holdDb', -60, 0], ['webrtcTrimDb', -30, 6]]) {
    if (a[k] == null || a[k] === '') continue;
    const n = Number(a[k]);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number of decibels`);
    const v = Math.round(clamp(n, lo, hi));
    if (v !== before.ambience[k]) { o.ambience[k] = v; changed.push({ field: `ambience.${k}`, from: before.ambience[k], to: v }); }
  }
  const l = patch.language && typeof patch.language === 'object' ? patch.language : {};
  if (l.code != null && l.code !== '') {
    const code = String(l.code).trim().replace(/_/g, '-');
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(code)) throw new Error(`"${l.code}" is not a language code like en-AU`);
    const norm = code.slice(0, 2).toLowerCase() + (code.length > 2 ? '-' + code.slice(3).toUpperCase() : '');
    if (norm !== before.language.code) { o.language.code = norm; changed.push({ field: 'language.code', from: before.language.code, to: norm }); }
  }
  if (changed.length) {
    persist();
    logger.info(`settings changed by ${by}: ${changed.map((c) => `${c.field} ${c.from} → ${c.to}`).join(', ')}`);
  }
  return { settings: getSettings(), changed };
}

/** Drop every override (back to .env defaults). */
export function resetSettings({ by = 'console' } = {}) {
  const before = getSettings();
  state.overrides = {};
  persist();
  logger.info(`settings reset to defaults by ${by}`);
  return { settings: getSettings(), before };
}

/** Raw override snapshot (for talk_settings undo). */
export function snapshotOverrides() { return JSON.parse(JSON.stringify(state.overrides || {})); }
export function restoreOverrides(snap) { state.overrides = JSON.parse(JSON.stringify(snap || {})); persist(); return getSettings(); }

// --- the change log: what changed since the last call -------------------------------------------
/** Record a Talk Settings change (any kind) — called from the settings.changed subscriber in app.js. */
export function recordChange({ what, label, by = '' } = {}) {
  const entry = { ts: new Date().toISOString(), what: String(what || ''), label: String(label || '').slice(0, 160), by: String(by || '') };
  state.changes.push(entry);
  if (state.changes.length > MAX_CHANGES) state.changes.splice(0, state.changes.length - MAX_CHANGES);
  persist();
  return entry;
}
export function changesSince(ts = 0) {
  const t = typeof ts === 'number' ? ts : new Date(ts || 0).getTime();
  return state.changes.filter((c) => new Date(c.ts).getTime() > t);
}
export function lastCallAt() { return state.lastCallAt || 0; }
export function markCallStart(at = Date.now()) { state.lastCallAt = at; persist(); }
