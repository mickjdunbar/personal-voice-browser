// 2026-11-03 (mick-agentic-browser): the console feed. Every notable step of
// a session (transcripts, lane swaps, model calls with TTFT, tool runs, SOP
// selection, knowledge hits, sentiment, browser frames) is emitted here and
// pushed to every open console over the /ui WebSocket. Late joiners get the
// recent buffer first so a page opened mid-call still shows the whole call.
//
// Screenshot frames are large (tens of KB) and are kept out of the replay
// buffer: only the latest frame is replayed.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(500);

const MAX_RECENT = 600;
const recent = [];
let latestFrame = null;
let seq = 0;

/** Record one event {seq, ts, type, sessionId, ...data}. */
export function emitEvent(type, sessionId, data = {}) {
  const ev = { seq: ++seq, ts: new Date().toISOString(), type, sessionId, ...data };
  if (type === 'browser.frame') latestFrame = ev;
  else {
    recent.push(ev);
    if (recent.length > MAX_RECENT) recent.shift();
  }
  bus.emit('event', ev);
  return ev;
}

export const recentEvents = () => (latestFrame ? [...recent, latestFrame] : recent.slice());

/** Subscribe to live events; returns the unsubscribe function. */
export function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}

/** Clear the replay buffer and the last frame (console "clear"), so a reconnect starts blank. */
export function clearRecent() {
  recent.length = 0;
  latestFrame = null;
}
