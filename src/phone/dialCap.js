// 16 Nov 2026 (mick-agentic-browser): a sliding-window cap on OUTBOUND DIALS. Every ask call is a
// real phone call to a real person or business; a confused model loop (or a resumed leg re-firing
// its tool) must never be able to place a dozen in a minute. Per owner session AND overall.
//   PHONE_MAX_DIALS_PER_SESSION  default 6  per 10 min
//   PHONE_MAX_DIALS_TOTAL        default 12 per 10 min (all sessions together)
//   PHONE_DIAL_WINDOW_MS         default 600000
const windows = new Map(); // root session -> [ms]
const ALL = '*';

const env = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
export const DIAL_CAP = { perSession: env('PHONE_MAX_DIALS_PER_SESSION', 6), total: env('PHONE_MAX_DIALS_TOTAL', 12), windowMs: env('PHONE_DIAL_WINDOW_MS', 10 * 60 * 1000) };

/** 'main#w-3' → 'main'; 'ask:abc' → 'ask:abc'; 'task-x' → 'task-x'. */
export const rootSession = (sid) => String(sid || 'main').split('#')[0];

function prune(key, now, windowMs) {
  const list = (windows.get(key) || []).filter((t) => now - t < windowMs);
  windows.set(key, list);
  return list;
}

/** Can this session dial now? { ok, count, total, error? } — error is a sentence for the model/owner. */
export function dialAllowed(sessionId, { now = Date.now(), cap = DIAL_CAP } = {}) {
  const key = rootSession(sessionId);
  const mine = prune(key, now, cap.windowMs).length;
  const all = prune(ALL, now, cap.windowMs).length;
  const mins = Math.round(cap.windowMs / 60000);
  if (mine >= cap.perSession) return { ok: false, count: mine, total: all, error: `call cap reached: ${mine} outbound calls from this session in the last ${mins} minutes (limit ${cap.perSession}). Tell the owner no more calls can be placed for a few minutes — do not retry.` };
  if (all >= cap.total) return { ok: false, count: mine, total: all, error: `call cap reached: ${all} outbound calls in the last ${mins} minutes across the whole system (limit ${cap.total}). Tell the owner and do not retry.` };
  return { ok: true, count: mine, total: all };
}

/** Record a dial that is actually being placed. */
export function recordDial(sessionId, now = Date.now()) {
  const key = rootSession(sessionId);
  prune(key, now, DIAL_CAP.windowMs).push(now);
  prune(ALL, now, DIAL_CAP.windowMs).push(now);
}

/** Current counts (for /api/health and the console). */
export function dialCounts(now = Date.now()) {
  const out = {};
  for (const [k, list] of windows) { const n = list.filter((t) => now - t < DIAL_CAP.windowMs).length; if (n) out[k] = n; }
  return out;
}

export function resetDialCap() { windows.clear(); }
