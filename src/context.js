// 2026-11-04 (mick-agentic-browser): per-session CALLER CONTEXT — free notes the
// user types about themselves (name, location, preferences) plus facts an agent
// learns during a call. It personalizes both lanes (the Navigator system prompt
// and the speech-to-speech persona). The console owns the durable copy in the
// browser's localStorage and syncs it here; the server keeps the live copy for
// the running call and pushes back anything an agent adds (when remembering is on).
import { loadProfile, saveProfile, isValidEmail, normalizeEmail } from './profile.js';

const store = new Map(); // sessionId -> { text, remember, updatedAt }
const identity = new Map(); // sessionId -> email (when the user has signed in)
const MAX = 4000;

export function getContext(sessionId = 'main') {
  return store.get(sessionId) || { text: '', remember: true };
}

export function getIdentity(sessionId = 'main') { return identity.get(sessionId) || null; }

/** Bind a session to an email so its long-term memory is the SHARED profile (synced
 *  across the user's devices). Loads the stored profile into the session; if none
 *  exists yet, seeds it from whatever this session currently holds. Empty/invalid
 *  email signs the session out (keeps the current in-session copy). Returns the
 *  live context + the bound email (null when signed out). */
export function identify(sessionId, email) {
  if (!isValidEmail(email)) {
    identity.delete(sessionId);
    return { ...getContext(sessionId), email: null };
  }
  const em = normalizeEmail(email);
  identity.set(sessionId, em);
  const p = loadProfile(em);
  if (p) {
    store.set(sessionId, { text: p.text, remember: p.remember, updatedAt: p.updatedAt });
  } else {
    const cur = getContext(sessionId);
    saveProfile(em, { text: cur.text, remember: cur.remember }, sessionId); // seed from this device
    store.set(sessionId, { ...cur });
  }
  return { ...getContext(sessionId), email: em };
}

/** Replace the user-authored context and the remember flag (from the console). */
export function setContext(sessionId, { text, remember } = {}) {
  const cur = store.get(sessionId) || { text: '', remember: true };
  if (text !== undefined) cur.text = String(text).slice(0, MAX);
  if (remember !== undefined) cur.remember = Boolean(remember);
  cur.updatedAt = Date.now();
  store.set(sessionId, cur);
  const em = identity.get(sessionId);
  if (em) saveProfile(em, { text: cur.text, remember: cur.remember }, sessionId);
  return cur;
}

/** Append a fact an agent learned (deduped). Returns {added, text}. */
export function appendContext(sessionId, note) {
  const cur = store.get(sessionId) || { text: '', remember: true };
  const n = String(note || '').trim().replace(/^[-•*]\s*/, '');
  if (!n) return { added: false, text: cur.text };
  const hay = cur.text.toLowerCase();
  if (hay.includes(n.toLowerCase())) return { added: false, text: cur.text };
  cur.text = ((cur.text ? cur.text + '\n' : '') + '• ' + n).slice(-MAX);
  cur.updatedAt = Date.now();
  store.set(sessionId, cur);
  const em = identity.get(sessionId);
  if (em) saveProfile(em, { text: cur.text, remember: cur.remember }, sessionId);
  return { added: true, text: cur.text };
}

/** The context as a prompt block, or '' when empty. */
export function renderContext(sessionId) {
  const t = getContext(sessionId).text.trim();
  return t;
}
