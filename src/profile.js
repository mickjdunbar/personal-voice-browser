// 2026-11-06 (mick-agentic-browser): SHARED long-term memory, keyed by IDENTITY.
// The caller's long-term memory (the free-text notes the team personalizes from +
// the "let the team add what they learn" flag) used to live only in each browser's
// localStorage + a per-session in-memory copy, so the web console and the Android
// app each had their own siloed memory. A profile keyed by the signed-in EMAIL
// persists it to profiles/<hash>.json, so the SAME person sees the SAME memory on
// every device, and edits (or facts the team learns) fan out live to their other
// open sessions. Identity today is an email the user types; a Google-verified email
// (an OAuth IdP) would produce the same key, so it can drop in later unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const logger = createLogger('Profile');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
const bus = new EventEmitter(); bus.setMaxListeners(300);
const cache = new Map(); // key -> {email, text, remember, updatedAt}
const MAX = 4000;

export function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}
export function normalizeEmail(s) { return String(s || '').trim().toLowerCase(); }
// The file name is a hash of the email, never the email itself — no PII in the
// directory listing, and every address maps to a safe fixed-length filename.
function keyFor(email) { return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 24); }
function fileFor(email) { return path.join(dir, keyFor(email) + '.json'); }

export function loadProfile(email) {
  if (!isValidEmail(email)) return null;
  const k = keyFor(email);
  if (cache.has(k)) return cache.get(k);
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(email), 'utf8'));
    const p = { email: normalizeEmail(email), text: String(raw.text || '').slice(0, MAX), remember: raw.remember !== false, updatedAt: raw.updatedAt || 0 };
    cache.set(k, p); return p;
  } catch { return null; }
}

/** Create or update the stored profile, then fan out a change event to the owner's
 *  other sessions. sourceSession (the session that made the edit) is echoed back so
 *  the originating console can skip its own update. */
export function saveProfile(email, { text, remember } = {}, sourceSession = null) {
  if (!isValidEmail(email)) return null;
  const k = keyFor(email);
  const cur = loadProfile(email) || { email: normalizeEmail(email), text: '', remember: true, updatedAt: 0 };
  if (text !== undefined) cur.text = String(text).slice(0, MAX);
  if (remember !== undefined) cur.remember = Boolean(remember);
  cur.updatedAt = Date.now();
  cache.set(k, cur);
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fileFor(email), JSON.stringify(cur, null, 2)); }
  catch (err) { logger.warn(`profile save failed: ${err.message}`); }
  bus.emit('change', { email: cur.email, text: cur.text, remember: cur.remember, sourceSession });
  return cur;
}

/** Subscribe to profile changes (for live cross-device sync). Returns an unsubscribe fn. */
export function onProfileChange(fn) { bus.on('change', fn); return () => bus.off('change', fn); }
