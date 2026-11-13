// 2026-11-10 (mick-agentic-browser): TASKS — the async text channel. A task is a
// long-running conversation with Aria that does not need a live call or an open
// console: the owner drops a message, Aria works (browse, phone, MCP — the full
// Navigator), and every reply/update lands back in the task's thread. Threads
// are persisted to disk so they survive `node --watch` restarts, and every
// change is pushed to all open consoles as a GLOBAL `tasks.update` event
// (no sessionId — the Tasks drawer is owner-wide, not per-console-session).
//
// Each task runs on its OWN session (`task-<id>`): its own browser tab and its
// own history, so three tasks can browse three sites at once without stepping
// on the live call's tab. After a restart the Navigator is gone but the thread
// is not — the next owner message re-seeds the fresh session's history from the
// stored messages, so Aria picks up where the thread left off.
//
// Channel-agnostic on purpose: ownerMessage(id, text, via) is the single entry
// point, so a future SMS/WhatsApp webhook can feed the same threads.
import fs from 'node:fs';
import path from 'node:path';
import { subscribe, emitEvent } from '../events.js';
import { getSession, peekSession, endSession } from '../agent/sessions.js';
import { textWriter } from '../agent/navigator.js';
import { completeText } from '../llm/client.js';
import { getBrowser } from '../browser/browser.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Tasks');
const FILE = process.env.TASKS_FILE || '.tasks.json';
const MAX_MESSAGES = 400; // per task — old turns roll off the stored thread
const STATUSES = new Set(['working', 'waiting', 'done']);

// How Aria should behave on this channel (appended to the Navigator persona via
// metadata.instructions): async text, not a live call.
const TASK_NOTE = 'This conversation is an ASYNC TASK THREAD over text (like texting an assistant): '
  + 'the owner sends a message and may not read your reply for hours. Do the work NOW — browse, phone, '
  + 'use your tools — and report the actual outcome in your reply. Never say "hold on" or "one moment" '
  + '(there is nothing to hold for), never promise to do something without doing it this turn, and never '
  + 'pad the reply. If you genuinely need something only the owner knows, ask for it plainly in one short '
  + 'message and stop. Write like a text message: short, concrete, no greetings after the first exchange. '
  // The voice persona spells numbers out for TTS ("nineteen sixty-six") — wrong in writing.
  + 'This is a WRITTEN channel: numbers, prices, times, phone numbers and addresses go as digits and '
  + 'symbols ($12.50, 7:30pm, 1966), never spelled out for speech. '
  // 11 Nov: tasks can SHOW things now — screenshots of the live page and drawn SVG sketches land
  // in the thread as images (and on the owner's phone when WhatsApp is connected).
  + 'You can SHOW things on this thread: share_screenshot attaches a picture of the page your browser '
  + 'is on RIGHT NOW, and share_sketch attaches a diagram you draw yourself as SVG. Use one whenever a '
  + 'picture beats words (a chart, a map, a product, a layout, a comparison), then refer to it in your reply. '
  // 13 Nov (H-07): a task agent went hunting for a WhatsApp MCP action and told the owner "WhatsApp
  // isn't connected" — while its own reply was already being forwarded to their WhatsApp.
  + 'YOUR REPLY IN THIS THREAD *IS* THE MESSAGE TO THE OWNER: it is delivered to their phone (WhatsApp/SMS) '
  + 'automatically the moment you send it. So "message me / WhatsApp me / text me the answer" simply means: '
  + 'put the answer in your reply. NEVER look for, enable or call a WhatsApp/messaging action for the owner, '
  + 'and NEVER say WhatsApp is not connected. An SMS tool is only for texting OTHER people the owner named.';

const tasks = new Map(); // id -> { id, seq, title, status, created_at, updated_at, messages[], contact?, running, queue }
// Short per-task numbers (#1, #2 …) so a flat SMS/WhatsApp chat can address a thread: "#3 yes do that".
let seqCounter = 0;
// Attached images (screenshots, sketches) live on disk, one folder per task, served at /task-media/….
const MEDIA_DIR = process.env.TASKS_MEDIA_DIR || '.tasks-media';

// --- persistence ---------------------------------------------------------------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = [...tasks.values()].map(({ running, queue, ...t }) => t);
      fs.writeFileSync(FILE, JSON.stringify({ saved_at: new Date().toISOString(), tasks: out }, null, 1));
    } catch (err) { logger.warn(`tasks not saved: ${err.message}`); }
  }, 250);
}
(function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const t of raw.tasks || []) {
      if (!t?.id) continue;
      // A restart killed any in-flight turn: 'working' would be a lie, so it demotes to 'waiting'.
      tasks.set(t.id, { ...t, status: t.status === 'working' ? 'waiting' : t.status, messages: t.messages || [], running: 0, queue: Promise.resolve() });
      seqCounter = Math.max(seqCounter, Number(t.seq) || 0);
    }
    // Older tasks saved before seq existed: number them oldest-first so new tasks count on from there.
    for (const t of [...tasks.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
      if (!t.seq) t.seq = ++seqCounter;
    }
    if (tasks.size) logger.info(`loaded ${tasks.size} task(s) from ${FILE}`);
  } catch (err) { logger.warn(`tasks load failed: ${err.message}`); }
})();

// --- shapes ----------------------------------------------------------------------
const sessionOf = (id) => `task-${id}`;
function publicTask(t) {
  const last = t.messages.at(-1) || null;
  return {
    id: t.id, seq: t.seq, title: t.title, status: t.status,
    created_at: t.created_at, updated_at: t.updated_at,
    message_count: t.messages.length,
    last: last ? { role: last.role, text: String(last.text || '').slice(0, 160), at: last.at } : null
  };
}
function broadcast(t, msg) { emitEvent('tasks.update', null, { task: publicTask(t), ...(msg ? { msg } : {}) }); }

export function listTasks() {
  return [...tasks.values()].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).map(publicTask);
}
export function getTask(id) {
  const t = tasks.get(id);
  return t ? { ...publicTask(t), messages: t.messages } : null;
}
/** Resolve a task by its short number (the "#3" in an SMS/WhatsApp reply). */
export function taskBySeq(seq) {
  for (const t of tasks.values()) if (t.seq === Number(seq)) return getTask(t.id);
  return null;
}
/** The phone contact a task was started from ({channel, to}), or null (console/call-born tasks). */
export const taskContact = (id) => tasks.get(id)?.contact || null;

// --- lifecycle --------------------------------------------------------------------
export function createTask({ title, text, via = 'console', contact = null } = {}) {
  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const now = new Date().toISOString();
  const t = {
    id,
    seq: ++seqCounter,
    title: String(title || '').trim() || String(text || '').trim().slice(0, 56) || 'New task',
    status: 'waiting', created_at: now, updated_at: now, messages: [],
    // Where this task was born when it came from a phone message: Aria's replies go back there.
    ...(contact ? { contact: { channel: contact.channel, to: contact.to } } : {}),
    running: 0, queue: Promise.resolve()
  };
  tasks.set(id, t);
  save();
  // `created` lets consoles show an "Aria's on it" toast — a task started from a CALL or another
  // device would otherwise only flip a badge nobody is looking at.
  emitEvent('tasks.update', null, { task: publicTask(t), created: true, via });
  // A nicer title in the background (best effort — the truncated first message already stands).
  if (!title && String(text || '').trim()) {
    completeText({
      model: config.llm.summaryModel,
      messages: [
        // "NEVER answer it": the summary model happily ANSWERED the request instead of naming it
        // (first live task: request "what is 17 times 23" was titled "391").
        { role: 'system', content: 'You label tasks for a to-do list. Reply with ONLY a 3-6 word noun-phrase title naming what the request below is about. NEVER answer or carry out the request itself. No quotes, no trailing punctuation.' },
        { role: 'user', content: 'The request to title:\n' + String(text).slice(0, 400) }
      ],
      params: { max_tokens: 20, temperature: 0.2 }
    }).then((out) => {
      const line = String(out || '').trim().replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 64);
      const task = tasks.get(id);
      if (line && task) { task.title = line; save(); broadcast(task); }
    }).catch(() => {});
  }
  if (String(text || '').trim()) ownerMessage(id, text, via);
  return getTask(id);
}

export function setStatus(id, status) {
  const t = tasks.get(id);
  if (!t) return { error: 'no such task' };
  if (!STATUSES.has(status)) return { error: `status must be one of ${[...STATUSES].join(', ')}` };
  t.status = status;
  t.updated_at = new Date().toISOString();
  if (status === 'done') closeSession(id, 'task_done');
  save();
  broadcast(t);
  return { ok: true, task: publicTask(t) };
}

export function deleteTask(id) {
  const t = tasks.get(id);
  if (!t) return { error: 'no such task' };
  tasks.delete(id);
  closeSession(id, 'task_deleted');
  try { fs.rmSync(path.join(MEDIA_DIR, String(id)), { recursive: true, force: true }); } catch { /* best effort */ }
  save();
  emitEvent('tasks.update', null, { deleted: id });
  return { ok: true };
}

/** End the task's navigator AND close its browser tab (endSession alone leaks the tab). */
function closeSession(id, reason) {
  endSession(sessionOf(id), reason).catch(() => {});
  try { getBrowser().closeTab?.(sessionOf(id)); } catch { /* browser may be down */ }
}

// --- media: screenshots + sketches attached to the thread ---------------------------
// An SVG is only ever shown via <img> (scripts inert) and the serving route adds a no-script
// CSP, but strip the obvious active content anyway — the markup is model-authored.
function sanitizeSvg(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
}

/** Attach an image to a task's thread as its own Aria message: a browser screenshot
 *  ({buffer, type}) or a drawn sketch ({svg}). Broadcast like any other message, so the
 *  drawer renders it live and the phone transports forward it. */
export function attachMedia(id, { buffer, svg, type = 'image/jpeg', caption = '', kind = 'image' } = {}) {
  const t = tasks.get(id);
  if (!t) return { error: 'no such task' };
  if (!buffer && !svg) return { error: 'nothing to attach' };
  const dir = path.join(MEDIA_DIR, String(id));
  const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${svg ? 'svg' : type === 'image/png' ? 'png' : 'jpg'}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (svg) fs.writeFileSync(path.join(dir, file), sanitizeSvg(svg), 'utf8');
    else fs.writeFileSync(path.join(dir, file), buffer);
  } catch (err) { return { error: `could not save the image: ${err.message}` }; }
  const msg = {
    role: 'aria', text: String(caption || ''), at: new Date().toISOString(),
    media: [{ url: `/task-media/${id}/${file}`, type: svg ? 'image/svg+xml' : type, kind }]
  };
  push(t, msg);
  save();
  broadcast(t, msg);
  return { ok: true, url: msg.media[0].url };
}

/** 13 Nov: post a plain Aria note into a thread WITHOUT running the navigator (the recap link,
 *  a system notice). Broadcast like any other Aria message, so it reaches the drawer and the
 *  owner's WhatsApp forward. */
export function postNote(id, text) {
  const t = tasks.get(id);
  if (!t) return { error: 'no such task' };
  const msg = { role: 'aria', text: String(text || '').trim(), at: new Date().toISOString() };
  if (!msg.text) return { error: 'empty note' };
  push(t, msg);
  save();
  broadcast(t, msg);
  return { ok: true };
}

// --- the owner speaks ---------------------------------------------------------------
/** The single entry point for an owner message, whatever the transport (console today;
 *  an SMS/WhatsApp webhook would call this too, with its own `via`). Returns at once —
 *  the turn runs in the background and the thread fills via `tasks.update` events. */
export function ownerMessage(id, text, via = 'console') {
  const t = tasks.get(id);
  if (!t) return { error: 'no such task' };
  const line = String(text || '').trim();
  if (!line) return { error: 'text required' };
  const msg = { role: 'owner', text: line, at: new Date().toISOString(), via };
  push(t, msg);
  t.status = 'working';
  save();
  broadcast(t, msg);
  t.running += 1;
  t.queue = t.queue
    .then(() => runTurn(t, line))
    .catch((err) => logger.warn(`task ${id} turn failed: ${err.message}`))
    .finally(() => {
      t.running = Math.max(0, t.running - 1);
      settleStatus(t);
    });
  return { ok: true, task: publicTask(t) };
}

function push(t, msg) {
  t.messages.push(msg);
  if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
  t.updated_at = msg.at;
}

async function runTurn(t, text) {
  const sid = sessionOf(t.id);
  // metadata.task: marks the Navigator as a task session — it gets a bigger tool budget for
  // research (nobody is waiting on a live line) and does NOT get the create_task tool (no
  // tasks spawning tasks).
  const nav = await getSession(sid, { channel: 'text', info: { channel: 'task', task: t.id, title: t.title }, metadata: { instructions: TASK_NOTE, task: t.id } });
  // Fresh Navigator (first turn, or a server restart dropped the old one): re-seed its history
  // from the stored thread so the conversation continues instead of starting over. The last
  // message is the one this turn is about to run — it must not be pre-seeded too.
  if (nav.turns === 0 && nav.history.length === 0 && t.messages.length > 1) {
    for (const m of t.messages.slice(0, -1).slice(-24)) {
      if (m.text) nav.history.push({ role: m.role === 'owner' ? 'user' : 'assistant', content: m.text });
    }
  }
  const writer = textWriter();
  emitEvent('turn.start', sid, { channel: 'task', input: 'text', text });
  await nav.turn(text, writer, { kind: 'speech' });
  // The reply itself arrives through the agent.said subscription below (one path for
  // prompted replies AND async updates — phone answers, team narration).
}

/** 'working' while anything is still in flight for this task; 'waiting' (= the owner's turn) once quiet. */
function settleStatus(t) {
  if (t.status === 'done') return;
  const nav = peekSession(sessionOf(t.id));
  const busy = t.running > 0 || Boolean(nav && ((nav.workPending || 0) > 0 || (nav.phonePending || 0) > 0 || nav.lead?.live));
  const next = busy ? 'working' : 'waiting';
  if (t.status !== next) { t.status = next; save(); broadcast(t); }
}

// --- Aria speaks: capture everything said on a task session into its thread ---------
// agent.said is the one spoken-output event for prompted replies, phone relays and team
// updates alike — so the thread records exactly what the owner would have HEARD on a call.
// Worker sub-sessions (`task-<id>#w-…`) are internal and deliberately NOT matched.
subscribe((ev) => {
  if (ev.type !== 'agent.said' || !ev.sessionId) return;
  const m = /^task-([^#]+)$/.exec(String(ev.sessionId));
  if (!m) return;
  const t = tasks.get(m[1]);
  if (!t) return;
  const text = String(ev.text || '').trim();
  if (!text) return;
  const msg = { role: 'aria', text, at: new Date().toISOString(), ...(ev.async ? { async: true } : {}) };
  push(t, msg);
  settleStatusInline(t);
  save();
  broadcast(t, msg);
});
// settleStatus without the extra broadcast (the message broadcast right after carries the status).
function settleStatusInline(t) {
  if (t.status === 'done') return;
  const nav = peekSession(sessionOf(t.id));
  const busy = t.running > 0 || Boolean(nav && ((nav.workPending || 0) > 0 || (nav.phonePending || 0) > 0 || nav.lead?.live));
  t.status = busy ? 'working' : 'waiting';
}
