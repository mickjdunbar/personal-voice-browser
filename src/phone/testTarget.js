// 2026-11-06 (mick-agentic-browser): TEST-CALL redirect. Because phone_someone places
// a REAL outbound call, the console has a "redirect calls to a test number" switch
// (Talk Settings). When it is on, every outbound ask/order call dials the test number
// instead of the real one, keeping the name/question intact so the exercise is realistic
// and no real person or business is ever rung during testing. Per-session, set from the
// console, lives only for the running server.
import fs from 'node:fs';

const store = new Map(); // sessionId -> { enabled, number }

// 12 Nov: the switch is PERSISTED. It used to live only in memory, so every server restart —
// including a `node --watch` reload from an innocent edit — silently turned the redirect OFF.
// Take 3: a mid-call restart dropped it and the venue-confirmation call went to a real number.
const FILE = process.env.TEST_DIAL_FILE || '.test-dial.json';
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) store.set(k, v); } catch { /* nothing saved */ }
function persist() { try { fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store))); } catch { /* best effort */ } }

export function setTestTarget(sessionId = 'main', { enabled, number } = {}) {
  const num = String(number || '').replace(/[^\d+]/g, '');
  const cur = { enabled: Boolean(enabled) && num.replace(/\D/g, '').length >= 5, number: num };
  store.set(sessionId, cur);
  persist();
  return cur;
}

// 12 Nov: the redirect is effectively GLOBAL — a session without its own setting inherits
// `main`'s. Calls are also placed from task sessions (`task-…`) and worker sub-sessions
// (`main#w-1`), and those used to bypass the console switch entirely.
export function getTestTarget(sessionId = 'main') {
  return store.get(sessionId) || store.get('main') || { enabled: false, number: '' };
}

/**
 * Given the real number we were about to dial, return the number we should ACTUALLY dial.
 * When the test switch is on, that is the test number; otherwise the real one.
 * @returns {{ to:string, redirected:boolean, real:string }}
 */
export function effectiveDial(sessionId, realTo) {
  const real = String(realTo || '');
  const t = getTestTarget(sessionId);
  if (t.enabled && t.number) return { to: t.number, redirected: true, real };
  return { to: real, redirected: false, real };
}
