// 2026-11-03 (mick-agentic-browser): the console feed. Every notable step of
// a session (transcripts, lane swaps, model calls with TTFT, tool runs, SOP
// selection, knowledge hits, sentiment, browser frames) is emitted here and
// pushed to every open console over the /ui WebSocket. Late joiners get the
// recent buffer first so a page opened mid-call still shows the whole call.
//
// Screenshot frames are large (tens of KB) and are kept out of the replay
// buffer: only the latest frame is replayed.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const bus = new EventEmitter();
bus.setMaxListeners(500);

const MAX_RECENT = 600;
const recent = [];
let latestFrame = null;
let seq = 0;

// 16 Nov: the ring is the only forensic record and it vanished on every restart. Every event (bar
// browser frames) is now also appended to logs/events-YYYY-MM-DD.jsonl — git-ignored, one file a
// day, read back with /api/events?day=… (readEventLog). EVENT_LOG=0 turns it off.
const LOG_DIR = process.env.EVENT_LOG_DIR || 'logs';
const LOG_ON = process.env.EVENT_LOG !== '0';
const MAX_LINE = 16 * 1024; // a tasks.update carries a whole thread; keep the file sane
let logStream = null, logDay = '';
function appendLog(ev) {
  if (!LOG_ON || ev.type === 'browser.frame') return;
  try {
    const day = ev.ts.slice(0, 10);
    if (day !== logDay) {
      logStream?.end();
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, `events-${day}.jsonl`), { flags: 'a' });
      logStream.on('error', () => {});
      logDay = day;
    }
    let line = JSON.stringify(ev);
    if (line.length > MAX_LINE) line = JSON.stringify({ seq: ev.seq, ts: ev.ts, type: ev.type, sessionId: ev.sessionId, _truncated: line.length, text: typeof ev.text === 'string' ? ev.text.slice(0, 400) : undefined });
    logStream.write(line + '\n');
  } catch { /* logging must never break the call */ }
}
export const eventLogFile = (day) => path.join(LOG_DIR, `events-${day}.jsonl`);
/** Days that have a log file, newest first. */
export function eventLogDays() {
  try { return fs.readdirSync(LOG_DIR).map((f) => (/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f) || [])[1]).filter(Boolean).sort().reverse(); } catch { return []; }
}
/** Read one day's log back: { day, session?, type?, since? (ISO), limit=2000 } → newest-last array. */
export function readEventLog({ day, session = '', type = '', since = '', limit = 2000 } = {}) {
  const file = eventLogFile(day || new Date().toISOString().slice(0, 10));
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sinceMs = since ? new Date(since).getTime() : 0;
  const types = type ? new Set(String(type).split(',').map((t) => t.trim()).filter(Boolean)) : null;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (session && ev.sessionId !== session) continue;
    if (types && !types.has(ev.type)) continue;
    if (sinceMs && new Date(ev.ts).getTime() < sinceMs) continue;
    out.push(ev);
  }
  return out.length > limit ? out.slice(-limit) : out;
}

/** Record one event {seq, ts, type, sessionId, ...data}. */
export function emitEvent(type, sessionId, data = {}) {
  const ev = { seq: ++seq, ts: new Date().toISOString(), type, sessionId, ...data };
  if (type === 'browser.frame') latestFrame = ev;
  else {
    recent.push(ev);
    if (recent.length > MAX_RECENT) recent.shift();
  }
  appendLog(ev);
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
