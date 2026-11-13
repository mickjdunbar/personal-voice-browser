// 2026-11-03 (mick-agentic-browser): session registry. A session = one
// Navigator (history + browser tab). The console's text box and a voice call
// can share a session so you can type a URL and then talk about it: the
// conductor and the harness bind to `main` unless metadata.session says
// otherwise (Agent Studio variable `session`).
import { Navigator } from './navigator.js';

const sessions = new Map();
const starting = new Map();

export async function getSession(id = 'main', opts = {}) {
  const existing = sessions.get(id);
  if (existing && !existing.ended) {
    if (opts.externalTools?.length) { existing.externalTools = opts.externalTools; existing.callExternalTool = opts.callExternalTool; }
    if (opts.channel) existing.channel = opts.channel;
    return existing;
  }
  if (starting.has(id)) return starting.get(id);
  const p = (async () => {
    const nav = new Navigator({ sessionId: id, ...opts });
    await nav.start(opts.info || {});
    sessions.set(id, nav);
    return nav;
  })();
  starting.set(id, p);
  try { return await p; } finally { starting.delete(id); }
}

export function peekSession(id = 'main') { return sessions.get(id) || null; }

export async function endSession(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.end(reason);
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ id: s.sessionId, channel: s.channel, turns: s.turns, deep_turns: s.deepTurns, url: s.tab?.url || null, started_at: new Date(s.startedAt).toISOString(), ended: s.ended }));
}
