// 12 Nov 2026 (mick-agentic-browser): SCREENS — a per-session ring of page screenshots, one
// per page the browser landed on, so the shareable recap can show every screen the team
// worked through (not just the last frame). Captured off the event bus: a `browser.page`
// event (URL/title changed) schedules a frame of the ACTIVE tab a moment later, once the
// page has painted. Worker sub-sessions (`main#w-1`) fold into their base session.
import { subscribe } from './events.js';
import { peekSession } from './agent/sessions.js';
import { createLogger } from './logger.js';

const logger = createLogger('Screens');
const MAX_PER_SESSION = 40;
const TTL_MS = 12 * 3600 * 1000;
const rings = new Map(); // base session -> [{ at, url, title, jpeg }]
const timers = new Map();

const baseOf = (sid) => String(sid || '').split('#')[0];

export function initScreens() {
  subscribe((ev) => {
    if (ev.type !== 'browser.page' || !ev.url || /^about:/i.test(ev.url)) return;
    const base = baseOf(ev.sessionId);
    if (!base) return;
    clearTimeout(timers.get(base));
    timers.set(base, setTimeout(() => capture(base, ev.sessionId, ev.url, ev.title || ''), 1500));
  });
  logger.info('screen capture armed (one shot per page, up to 40 per session)');
}

async function capture(base, sid, url, title) {
  try {
    const tab = peekSession(sid)?.tab || peekSession(base)?.tab;
    if (!tab || tab.url !== url) return; // moved on already — the next page event will capture that one
    const jpeg = await tab.frame({ quality: 55 });
    if (!jpeg) return;
    const ring = rings.get(base) || [];
    const last = ring[ring.length - 1];
    const entry = { at: new Date().toISOString(), url, title: title || tab.last?.title || '', jpeg };
    if (last && last.url === url && Date.now() - new Date(last.at).getTime() < 20000) ring[ring.length - 1] = entry; // same page re-painted: keep the newest shot
    else ring.push(entry);
    while (ring.length > MAX_PER_SESSION) ring.shift();
    rings.set(base, ring);
  } catch (err) { logger.debug(`capture failed: ${err.message}`); }
}

/** Screens for a session (newest last), dropping anything older than the TTL. */
export function listScreens(sessionId, { withImages = true } = {}) {
  const base = baseOf(sessionId);
  const cutoff = Date.now() - TTL_MS;
  const ring = (rings.get(base) || []).filter((s) => new Date(s.at).getTime() >= cutoff);
  rings.set(base, ring);
  return ring.map((s) => (withImages ? s : { at: s.at, url: s.url, title: s.title }));
}

export function clearScreens(sessionId) { rings.delete(baseOf(sessionId)); }
