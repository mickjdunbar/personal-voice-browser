// 2026-11-03 (mick-agentic-browser): the console.
//  - Talk: the official jambonz WebRTC client (bundled locally, /vendor) registers a Client and dials.
//  - Type: text turns go to the same team session as voice (shared tab + history).
//  - Team: a roster of agents; one speaks at a time, all listen. The active speaker is highlighted.
//  - Live: /ui streams every event (transcripts, who's speaking, models, TTFT, tools, SOPs,
//    knowledge, sentiment) and the browser frames. Ambient + typing sound covers the quiet.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Escape, then turn bare http(s) URLs into clickable links (new tab). Trailing punctuation stays outside the link.
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<>"']+?(?=[.,;:!?)\]]*(?:\s|$|&lt;|&quot;))/g,
  (u) => `<a href="${u}" target="_blank" rel="noopener" class="autolink">${u}</a>`);
// 11 Nov: the Android Capacitor shell is RETIRED — SMS/WhatsApp are the phone surface now and the
// web console (this page) is the only UI. All IS_APP / body.app branches are gone with it.
document.title = 'Personal Voice Browser';
// Session id: an explicit ?session= wins; otherwise the web console lives on 'main'
// (inbound PSTN calls surface there).
const SESSION = new URLSearchParams(location.search).get('session') || 'main';
const AGENT_COLORS = { host: 'host', concierge: 'concierge', shopper: 'shopper', scout: 'scout', local: 'local' };
const colorVar = (key) => `var(--${AGENT_COLORS[key] ? 'ag-' + key : key})`;
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`);
const money = (n) => (n == null ? '–' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
// Running cost of the CURRENT call under the brand title (web only): the feed's cost_total is the
// session's cumulative spend, so the call's own cost = cumulative minus a baseline taken at call start.
let costTotal = 0, callCostBase = 0;
let s2sCostCall = 0; // realtime-leg (speech) spend this call, metered from OpenAI response.done usage
const smsLog = [];  // {at,to,body,ok} — every SMS the agent sent this session (drawer + recap)
const botLog = [];  // {at,dir:'out'|'in',bot,text,error} — chatbot exchanges (drawer + recap)
const phoneLog = []; // {at,kind:'request'|'relay'|'answer'|'error',name,text,transcript?} — outbound calls Aria made (recap)
const ownerLog = []; // {at,dir:'out'|'in',channel,body} — WhatsApp/SMS between Aria and the owner (recap)
const pinLog = [];   // {at,label,address,lat,lon,url,share_link} — pins dropped on the map this session (recap)
// 13 Nov: ids of background tasks STARTED during the current call (or this console session before
// any call) — the recap shows only these, not everything touched in the last 12 h.
const callTasks = new Set();
// 14 Nov pm: the window of the call the recap is about — set at call.start, frozen at call.end (so a
// new call starting before the 25 s auto-recap fires cannot leak into it). Transcript bubbles,
// logs, screens and tasks are all cut to this window; recordings are fetched for this call sid.
let callWin = null, lastCallWin = null;
const inWin = (at, w) => { if (!w) return true; const t = typeof at === 'number' ? at : new Date(at || 0).getTime(); return t >= w.startedAt - 2000 && (!w.endedAt || t <= w.endedAt + 2000); };
function updateCallCost() {
  const el = $('call-cost'); if (!el || el.hidden) return;
  el.textContent = `call cost ${money(Math.max(0, costTotal - callCostBase) + s2sCostCall)}`;
}

// ---------- settings (this browser only) ---------------------------------------
const KEYS = ['wss', 'realm', 'user', 'pass', 'number'];
const DEFAULTS = { wss: 'wss://sip.jambonz.cloud:8443', realm: 'huey.sip.jambonz.cloud', user: '', pass: '', number: 'app:735e68db-412b-4a4c-9a3f-4eae1b89e355' };
for (const k of KEYS) {
  let v = null; try { v = localStorage.getItem(`mab.sip.${k}`); } catch {}
  $(k).value = v ?? DEFAULTS[k];
  $(k).addEventListener('input', () => { try { localStorage.setItem(`mab.sip.${k}`, $(k).value); } catch {} });
}
const siplog = $('siplog');
const log = (...p) => { siplog.textContent += `[${new Date().toLocaleTimeString()}] ${p.join(' ')}\n`; siplog.scrollTop = siplog.scrollHeight; };
// Auto-register on load if the client settings are already filled in (saved in this browser).
function maybeAutoRegister() { if ($('wss').value.trim() && $('user').value.trim() && $('pass').value) setTimeout(() => register().catch(() => {}), 400); }
const setCallState = (s) => { const el = $('callstate'); el.textContent = s; el.dataset.state = s; if (s === 'connected') sound.callLive(true); if (s === 'ended' || s === 'failed') sound.callLive(false); audioWatch(s); };
const setRegState = (s) => { const el = $('reg-pill'); const reg = s === 'registered'; if (el) { el.textContent = reg ? 'registered' : s; el.dataset.state = reg ? 'registered' : (s === 'connecting' || s === 'connected' ? 'connecting' : s === 'failed' ? 'failed' : 'idle'); } const dot = $('talk-dot'); if (dot) dot.hidden = !reg; };

// ---------- sound: ambient bed + typing clicks (WebAudio, no assets) ------------
// Covers the quiet while agents work. Off by default; a user gesture starts the context.
const sound = (() => {
  let ctx = null, on = false, bed = null, bedGain = null, working = false, inCall = false, idleTimer = null;
  const ensure = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    return ctx;
  };
  const noiseBuffer = (secs = 2) => {
    const n = ctx.sampleRate * secs, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown-ish
    return buf;
  };
  const startBed = () => {
    if (!on || bed || !ensure()) return;
    bed = ctx.createBufferSource(); bed.buffer = noiseBuffer(3); bed.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480;
    bedGain = ctx.createGain(); bedGain.gain.value = 0;
    bed.connect(lp).connect(bedGain).connect(ctx.destination); bed.start();
    bedGain.gain.linearRampToValueAtTime(0.02, ctx.currentTime + 0.8);
  };
  const stopBed = () => { if (!bed) return; const b = bed, g = bedGain; bed = null; bedGain = null; try { g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6); setTimeout(() => b.stop(), 700); } catch {} };
  const refreshBed = () => { if (on && (working || inCall)) startBed(); else stopBed(); };
  const click = (when, f) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.05);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.06, when + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    src.connect(bp).connect(g).connect(ctx.destination); src.start(when); src.stop(when + 0.06);
  };
  return {
    get on() { return on; },
    // Touch/resume the audio stack from within a user gesture so later playback isn't autoplay-blocked.
    prime() { try { const c = ensure(); if (c && c.state === 'suspended') c.resume(); } catch {} },
    ctx() { try { return ensure(); } catch { return null; } },
    toggle() { on = !on; $('sound').setAttribute('aria-pressed', String(on)); $('sound').textContent = on ? 'Sound on' : 'Sound off'; ensure(); refreshBed(); return on; },
    callLive(v) { inCall = v; refreshBed(); },
    work(v) { working = v; clearTimeout(idleTimer); if (v) refreshBed(); else idleTimer = setTimeout(refreshBed, 2500); },
    typing(n = 3) { if (!on || !working || !ensure()) return; const t0 = ctx.currentTime; for (let i = 0; i < n; i++) click(t0 + i * (0.05 + Math.random() * 0.07), 1600 + Math.random() * 1400); },
    tick() { if (!on || !ensure()) return; click(ctx.currentTime, 900); }
  };
})();
$('sound').addEventListener('click', () => sound.toggle());

// ---------- theme: auto (follow OS) · light · dark, persisted in this browser --------
(() => {
  const btn = $('theme'); if (!btn) return;
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '🌙 Dark' };
  let mode = 'auto'; try { mode = localStorage.getItem('mab.theme') || 'auto'; } catch {}
  if (!ORDER.includes(mode)) mode = 'auto';
  const apply = () => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    btn.textContent = LABEL[mode];
    btn.setAttribute('title', `Theme: ${mode} — click to change`);
  };
  btn.addEventListener('click', () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    try { localStorage.setItem('mab.theme', mode); } catch {}
    apply();
  });
  apply();
})();

// ---------- activity drawer: minimized by default, opens near-full-screen -------
const drawer = (() => {
  let unread = 0;
  const el = $('drawer'), back = $('drawer-backdrop'), toggle = $('drawer-toggle'), badge = $('drawer-badge');
  // The unread count also shows on the Harness edge tab (the Activity toggle itself is hidden
  // behind it since 11 Nov).
  const setBadges = (text, hidden) => { for (const b of [badge, $('harness-badge')]) if (b) { b.hidden = hidden; b.textContent = text; } };
  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle.setAttribute('aria-expanded', 'true'); unread = 0; setBadges('0', true); try { loadRecordings(); } catch {} };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', open);
  $('drawer-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return {
    get isOpen() { return el.classList.contains('open'); },
    open, close,
    bump() { if (this.isOpen) return; unread++; setBadges(unread > 99 ? '99+' : String(unread), false); },
    reset() { unread = 0; setBadges('0', true); }
  };
})();

// ---------- talk drawer: the softphone settings, minimized to an edge tab --------
const talkDrawer = (() => {
  const el = $('talk-drawer'), back = $('talk-backdrop'), toggle = $('talk-toggle');
  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle.setAttribute('aria-expanded', 'true'); };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', open);
  $('talk-close').addEventListener('click', close);
  back.addEventListener('click', close);
  // App layout: the edge tab is hidden, so a plain button in the team card opens this drawer.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { get isOpen() { return el.classList.contains('open'); }, open, close };
})();

// ---------- this-turn drawer: live metrics, minimized to an edge tab ---------------
const turnDrawer = (() => {
  const el = $('turn-drawer'), back = $('turn-backdrop'), toggle = $('turn-toggle');
  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle.setAttribute('aria-expanded', 'true'); };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', open);
  $('turn-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { get isOpen() { return el.classList.contains('open'); }, open, close };
})();

// ---------- Text drawer: the console docks right, minimized at start --------
// The Text card node MOVES in here, so #text-form/#transcript and all their handlers keep working.
const textDrawer = (() => {
  const el = $('text-drawer'), back = $('text-backdrop'), toggle = $('text-toggle'), badge = $('text-badge');
  if (!el || !toggle) return null;
  const card = $('text-form')?.closest('.card');
  if (card) $('text-drawer-body').append(card);
  let unread = 0;
  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle.setAttribute('aria-expanded', 'true'); unread = 0; badge.hidden = true; badge.textContent = '0'; setTimeout(() => { try { $('text').focus({ preventScroll: true }); } catch {} }, 180); };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', open);
  $('text-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return {
    get isOpen() { return el.classList.contains('open'); },
    open, close,
    bump() { if (this.isOpen) return; unread++; badge.hidden = false; badge.textContent = unread > 99 ? '99+' : String(unread); },
    reset() { unread = 0; badge.hidden = true; badge.textContent = '0'; }
  };
})();

// ---------- Tasks drawer (web + app): the async text channel ----------------------------
// Long-running conversations with Aria. Each task is a persistent server-side thread on its
// own session: she works in the background (browse, phone, team) and every reply/update is
// pushed here as a global `tasks.update` event — whether or not the drawer is open, and
// across every device. Unread state stays per-device (localStorage).
// ---------- Toasts: transient corner notifications (task started / update landed) ----
const toasts = (() => {
  let holder = null;
  function show({ icon = '✦', title, body = '', onClick, ttl = 6500 }) {
    if (!holder) { holder = document.createElement('div'); holder.id = 'toasts'; document.body.appendChild(holder); }
    const d = document.createElement('div');
    d.className = 'toast';
    d.innerHTML = '<span class="toast-icon"></span><span class="toast-main"><b></b><small></small></span>';
    d.querySelector('.toast-icon').textContent = icon;
    d.querySelector('b').textContent = title;
    if (body) d.querySelector('small').textContent = body; else d.querySelector('small').remove();
    let gone = false;
    const dismiss = () => { if (gone) return; gone = true; d.classList.remove('in'); d.classList.add('out'); setTimeout(() => d.remove(), 320); };
    if (onClick) d.addEventListener('click', () => { onClick(); dismiss(); });
    holder.appendChild(d);
    requestAnimationFrame(() => d.classList.add('in'));
    setTimeout(dismiss, ttl);
    while (holder.children.length > 4) holder.firstChild.remove(); // never stack into a wall
  }
  return { show };
})();

const tasksUi = (() => {
  const el = $('tasks-drawer'), back = $('tasks-backdrop'), toggle = $('tasks-toggle');
  if (!el) return { handle() {} };
  const listEl = $('task-list'), thread = $('task-thread'), input = $('task-input');
  const head = $('task-head'), titleEl = $('task-title'), statusEl = $('task-status');
  const STATUS_LABEL = { working: 'working…', waiting: 'your turn', done: 'done' };
  let TASKS = [];                    // list rows (previews only; threads are fetched on open)
  let current = null;                // the open task id (null = composing a new task)
  let rendered = new Set();          // keys of bubbles in the open thread (fetch/event dedupe)
  let read = {};                     // taskId -> epoch ms this device last saw the thread
  try { read = JSON.parse(localStorage.getItem('mab.tasks.read') || '{}') || {}; } catch {}
  const saveRead = () => { try { localStorage.setItem('mab.tasks.read', JSON.stringify(read)); } catch {} };
  const at = (iso) => new Date(iso).getTime() || 0;
  const when = (iso) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
  const keyOf = (m) => `${m.at}|${m.role}|${String(m.text || '').slice(0, 60)}|${m.media?.[0]?.url || ''}`;
  const isOpen = () => el.classList.contains('open');
  const unread = (t) => t.status !== 'done' && t.last && t.last.role === 'aria' && at(t.updated_at) > (read[t.id] || 0) && !(isOpen() && current === t.id);

  function paintBadge() {
    const n = TASKS.filter(unread).length;
    const b = $('tasks-badge'); if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
  }
  // 14 Nov: multi-select for bulk delete. Ticked ids live here; rows re-render from it.
  let picked = new Set();
  function paintTools() {
    picked = new Set([...picked].filter((id) => TASKS.some((t) => t.id === id)));
    const n = picked.size, all = $('task-select-all'), cnt = $('task-sel-count'), sel = $('task-delete-selected'), delAll = $('task-delete-all');
    if (all) { all.checked = n > 0 && n === TASKS.length; all.indeterminate = n > 0 && n < TASKS.length; all.disabled = !TASKS.length; }
    if (cnt) cnt.textContent = n ? `${n} selected` : 'Select all';
    if (sel) { sel.disabled = !n; sel.textContent = n ? `Delete selected (${n})` : 'Delete selected'; }
    if (delAll) delAll.disabled = !TASKS.length;
  }
  function renderList() {
    listEl.innerHTML = '';
    paintTools();
    if (!TASKS.length) { listEl.innerHTML = '<li class="task-none hint">No tasks yet — start one and Aria gets to work.</li>'; return; }
    for (const t of TASKS) {
      const li = document.createElement('li');
      li.className = `task-row${t.id === current ? ' on' : ''}${unread(t) ? ' unread' : ''}${t.status === 'done' ? ' is-done' : ''}${picked.has(t.id) ? ' picked' : ''}`;
      li.innerHTML = `<input type="checkbox" class="task-pick" title="Select for delete"${picked.has(t.id) ? ' checked' : ''}>`
        + `<span class="task-dot ${esc(t.status)}" title="${esc(STATUS_LABEL[t.status] || t.status)}"></span>`
        + `<span class="task-row-main"><b>${esc(t.title)}</b><small>${t.last ? `${t.last.role === 'owner' ? 'you: ' : ''}${esc(t.last.text)}` : 'no messages yet'}</small></span>`
        + `<span class="task-row-side"><time>${esc(when(t.updated_at))}</time>${unread(t) ? '<i class="task-new-dot"></i>' : ''}</span>`;
      const cb = li.querySelector('.task-pick');
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', () => { if (cb.checked) picked.add(t.id); else picked.delete(t.id); li.classList.toggle('picked', cb.checked); paintTools(); });
      li.addEventListener('click', () => openTask(t.id));
      listEl.appendChild(li);
    }
  }
  /** Remove tasks from the local list right away (the feed's `deleted` events will agree). */
  function dropLocal(ids) {
    const gone = new Set(ids);
    if (!gone.size) return;
    TASKS = TASKS.filter((t) => !gone.has(t.id));
    for (const id of gone) { picked.delete(id); delete read[id]; }
    saveRead();
    if (current && gone.has(current)) startNew();
    renderList(); paintBadge();
  }
  /** DELETE one task or many; the HTTP reply drives the UI, the feed event is a bonus.
   *  (Before 14 Nov the row only vanished when the feed delivered `deleted` — after a server
   *  restart the feed could be mid-reconnect and the click looked like it did nothing.) */
  async function deleteTasks(ids, label) {
    ids = [...new Set(ids)].filter(Boolean);
    if (!ids.length) return;
    try {
      const r = ids.length === 1
        ? await fetch(`/api/tasks/${encodeURIComponent(ids[0])}`, { method: 'DELETE' })
        : await fetch('/api/tasks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 404) throw new Error(body.error || `HTTP ${r.status}`);
      dropLocal(ids.length === 1 ? ids : (body.deleted || ids));
      toasts.show({ icon: '🗑', title: label || (ids.length === 1 ? 'Task deleted' : `${ids.length} tasks deleted`), ttl: 3500 });
      loadTasks(); // re-sync with the server in case anything raced
    } catch (e2) {
      toasts.show({ icon: '⚠️', title: 'Could not delete', body: e2.message, ttl: 6000 });
    }
  }
  function paintHead() {
    const t = TASKS.find((x) => x.id === current);
    head.hidden = !t;
    if (!t) return;
    titleEl.textContent = t.title;
    statusEl.textContent = STATUS_LABEL[t.status] || t.status;
    statusEl.dataset.status = t.status;
    $('task-done').textContent = t.status === 'done' ? '↺ Reopen' : '✓ Done';
    typingRow(t.status === 'working');
  }
  function bubble(m) {
    const d = document.createElement('div');
    d.className = `tmsg ${m.role === 'owner' ? 'owner' : 'aria'}`;
    // Attached images (screenshots / sketches): shown inline, click opens full size in a new tab.
    const media = (Array.isArray(m.media) ? m.media : []).map((md) => md.kind === 'document'
      ? `<a class="tmsg-file" href="${esc(md.url)}" target="_blank" rel="noopener" title="${esc(md.name || 'document')}">📄 <b>${esc(md.name || 'document')}</b>${md.size ? `<small>${fmtBytes(md.size)}</small>` : ''}</a>`
      : `<a class="tmsg-media" href="${esc(md.url)}" target="_blank" rel="noopener"><img class="tmsg-img" src="${esc(md.url)}" alt="${esc(md.name || md.kind || 'image')}" loading="lazy"></a>`).join('');
    d.innerHTML = `<span class="tmsg-text">${linkify(m.text)}</span>${media}<span class="tmsg-meta">${m.role === 'owner' ? 'you' : 'Aria'}${m.async ? ' · update' : ''} · ${esc(when(m.at))}</span>`;
    return d;
  }
  function typingRow(on) {
    let row = thread.querySelector('.task-typing');
    if (on && !row) { row = document.createElement('div'); row.className = 'task-typing'; row.innerHTML = '<i></i><i></i><i></i><span>Aria is working…</span>'; thread.appendChild(row); thread.scrollTop = thread.scrollHeight; }
    else if (!on && row) row.remove();
  }
  function appendMsg(m) {
    const k = keyOf(m);
    if (rendered.has(k)) return;
    rendered.add(k);
    thread.querySelector('.task-empty')?.remove();
    const typing = thread.querySelector('.task-typing');
    thread.insertBefore(bubble(m), typing || null);
    thread.scrollTop = thread.scrollHeight;
  }
  async function openTask(id) {
    current = id;
    rendered = new Set();
    thread.innerHTML = '';
    setWatch(`task-${id}`, (TASKS.find((t) => t.id === id) || {}).title || '');
    try {
      const t = await (await fetch(`/api/tasks/${encodeURIComponent(id)}`)).json();
      if (t.error) throw new Error(t.error);
      for (const m of t.messages || []) appendMsg(m);
      const i = TASKS.findIndex((x) => x.id === id);
      if (i >= 0) TASKS[i] = { ...TASKS[i], title: t.title, status: t.status, updated_at: t.updated_at, last: t.last };
    } catch (e2) { thread.innerHTML = `<div class="task-empty hint">could not load this task: ${esc(e2.message)}</div>`; }
    read[id] = Date.now(); saveRead();
    paintHead(); renderList(); paintBadge();
    thread.scrollTop = thread.scrollHeight;
    input.focus({ preventScroll: true });
  }
  function startNew() {
    current = null;
    rendered = new Set();
    setWatch('');
    head.hidden = true;
    thread.innerHTML = '<div class="task-empty hint">A fresh task — tell Aria what to get done, then check back whenever. She works in the background and every update lands here.</div>';
    renderList();
    input.focus({ preventScroll: true });
  }
  // --- attachments (14 Nov): paste, drop or pick images + documents; sent base64 in the message body.
  let pendingFiles = [];
  const attachList = $('task-attach-list'), fileInput = $('task-file'), sendBtn = $('task-send');
  const MAX_FILES = 8, MAX_BYTES = 15 * 1024 * 1024;
  const OK_DOC = /\.(pdf|txt|md|csv|json|docx)$/i;
  function fmtBytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
  function addFiles(files) {
    for (const f of Array.from(files || [])) {
      if (pendingFiles.length >= MAX_FILES) { toasts.show({ icon: '⚠️', title: `Up to ${MAX_FILES} files per message`, ttl: 4000 }); break; }
      const isImg = /^image\/(png|jpe?g|gif|webp)$/.test(f.type);
      if (!isImg && !OK_DOC.test(f.name || '')) { toasts.show({ icon: '⚠️', title: 'Not a supported file', body: `${f.name || f.type}: images (png/jpg/gif/webp) or documents (pdf/txt/md/csv/json/docx)`, ttl: 6000 }); continue; }
      if (f.size > MAX_BYTES) { toasts.show({ icon: '⚠️', title: 'Too big', body: `${f.name} is over 15 MB`, ttl: 5000 }); continue; }
      const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      pendingFiles.push({ file: f, name, type: f.type, kind: isImg ? 'image' : 'document', preview: isImg ? URL.createObjectURL(f) : null });
    }
    paintAttach();
  }
  function paintAttach() {
    if (!attachList) return;
    attachList.hidden = !pendingFiles.length;
    attachList.innerHTML = pendingFiles.map((a, i) => `<span class="task-chip">${a.preview ? `<img src="${a.preview}" alt="">` : '<i>📄</i>'}<b title="${esc(a.name)}">${esc(a.name)}</b><small>${fmtBytes(a.file.size)}</small><button type="button" data-i="${i}" title="Remove">×</button></span>`).join('');
  }
  function clearAttach() { for (const a of pendingFiles) if (a.preview) URL.revokeObjectURL(a.preview); pendingFiles = []; paintAttach(); }
  const toB64 = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => bad(r.error || new Error('read failed')); r.readAsDataURL(f); });
  attachList?.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; const [a] = pendingFiles.splice(Number(b.dataset.i), 1); if (a?.preview) URL.revokeObjectURL(a.preview); paintAttach(); input.focus({ preventScroll: true }); });
  $('task-attach')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  input.addEventListener('paste', (ev) => { const files = Array.from(ev.clipboardData?.files || []); if (!files.length) return; ev.preventDefault(); addFiles(files); });
  el.addEventListener('dragover', (ev) => { if (Array.from(ev.dataTransfer?.types || []).includes('Files')) { ev.preventDefault(); el.classList.add('dropping'); } });
  el.addEventListener('dragleave', (ev) => { if (!el.contains(ev.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', (ev) => { el.classList.remove('dropping'); const files = ev.dataTransfer?.files; if (!files?.length) return; ev.preventDefault(); addFiles(files); input.focus({ preventScroll: true }); });

  async function sendMsg(text, files = []) {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`); return j; });
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = files.length ? 'Uploading…' : 'Sending…'; }
    try {
      const attachments = await Promise.all(files.map(async (a) => ({ name: a.name, type: a.type, data: await toB64(a.file) })));
      const body = attachments.length ? { text, attachments } : { text };
      if (current) {
        await post(`/api/tasks/${encodeURIComponent(current)}/message`, body);
        read[current] = Date.now(); saveRead();
      } else {
        const r = await post('/api/tasks', body);
        if (r.task) { await openTask(r.task.id); }
      }
      for (const a of files) if (a.preview) URL.revokeObjectURL(a.preview);
    } catch (e2) {
      appendMsg({ role: 'aria', text: `couldn't send that: ${e2.message}`, at: new Date().toISOString() });
      // Give the files back so a retry is one click, not a re-paste.
      if (files.length && !pendingFiles.length) { pendingFiles = files; paintAttach(); }
      if (text && !input.value) input.value = text;
    } finally { if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; } }
  }
  async function loadTasks() {
    try { TASKS = (await (await fetch('/api/tasks')).json()).tasks || []; renderList(); paintBadge(); paintHead(); } catch { /* server away — the feed will catch us up */ }
  }

  /** A `tasks.update` event from the feed: upsert the row, append to the open thread, keep badges honest. */
  function handle(e) {
    if (e.deleted) {
      TASKS = TASKS.filter((t) => t.id !== e.deleted);
      if (current === e.deleted) startNew();
      renderList(); paintBadge();
      return;
    }
    if (!e.task) return;
    const i = TASKS.findIndex((t) => t.id === e.task.id);
    if (i >= 0) TASKS[i] = e.task; else TASKS.unshift(e.task);
    TASKS.sort((a, b) => at(b.updated_at) - at(a.updated_at));
    // Surface it: a task STARTED (from a call, another device, or the API) → "Aria's on it";
    // an Aria update landing while the thread isn't on screen → a peek at the message. Click opens it.
    const view = () => { open(); openTask(e.task.id); };
    if (e.created && !isOpen()) toasts.show({ icon: '📝', title: "Aria's on it", body: e.task.title, onClick: view });
    else if (e.msg && e.msg.role === 'aria' && !(isOpen() && current === e.task.id)) toasts.show({ icon: e.msg.media?.length ? '🖼️' : '💬', title: `Aria — ${e.task.title}`, body: String(e.msg.text || (e.msg.media?.length ? 'image attached' : '')).slice(0, 120), onClick: view });
    if (current === e.task.id) {
      if (e.msg) appendMsg(e.msg);
      if (isOpen()) { read[current] = Date.now(); saveRead(); }
      paintHead();
    }
    renderList(); paintBadge();
  }

  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle?.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle?.setAttribute('aria-expanded', 'true'); loadTasks().then(() => { if (current) { read[current] = Date.now(); saveRead(); paintBadge(); renderList(); } }); setTimeout(() => input.focus({ preventScroll: true }), 180); };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle?.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle?.setAttribute('aria-expanded', 'false'); setWatch(''); };
  toggle?.addEventListener('click', open);
  $('tasks-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('task-new').addEventListener('click', startNew);
  $('task-form').addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (!t && !pendingFiles.length) return; const files = pendingFiles; pendingFiles = []; paintAttach(); input.value = ''; sendMsg(t, files); });
  $('task-done').addEventListener('click', () => { if (!current) return; const t = TASKS.find((x) => x.id === current); fetch(`/api/tasks/${encodeURIComponent(current)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: t?.status === 'done' ? 'waiting' : 'done' }) }); });
  $('task-delete').addEventListener('click', () => { if (!current) return; if (!confirm('Delete this task and its whole thread?')) return; deleteTasks([current]); });
  $('task-select-all')?.addEventListener('change', (ev) => { picked = ev.target.checked ? new Set(TASKS.map((t) => t.id)) : new Set(); renderList(); });
  $('task-delete-selected')?.addEventListener('click', () => {
    const ids = [...picked]; if (!ids.length) return;
    if (!confirm(`Delete ${ids.length === 1 ? 'this task' : `these ${ids.length} tasks`} and their threads?`)) return;
    deleteTasks(ids);
  });
  $('task-delete-all')?.addEventListener('click', async () => {
    if (!TASKS.length) return;
    if (!confirm(`Delete ALL ${TASKS.length} tasks and their threads? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/tasks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      dropLocal(TASKS.map((t) => t.id));
      toasts.show({ icon: '🗑', title: `${(body.deleted || []).length} tasks deleted`, ttl: 3500 });
      loadTasks();
    } catch (e2) { toasts.show({ icon: '⚠️', title: 'Could not delete', body: e2.message, ttl: 6000 }); }
  });
  loadTasks(); // badge is honest from boot, before the drawer is ever opened
  return { handle };
})();

// ---------- Knowledge drawer: view / create / edit / delete the two KBs (web only) ----
const kbAdmin = (() => {
  const el = $('kb-drawer'), back = $('kb-backdrop'), toggle = $('kb-toggle');
  if (!el || !toggle) return null;
  let docs = { sop: [], knowledge: [], memory: [] };
  let kind = 'sop';
  let selected = null; // doc id being edited; null = new
  const f = (id) => $(id);
  const msg = (t, bad) => { const m = f('kb-msg'); m.textContent = t; m.style.color = bad ? 'var(--bad, #e5484d)' : ''; if (t) setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 4000); };

  async function refresh() {
    try {
      const r = await fetch('/api/kb/docs').then((x) => x.json());
      docs = { sop: r.sops || [], knowledge: r.knowledge || [], memory: r.memory || [] };
      f('kb-backend').textContent = r.backend || '?';
      f('kb-backend').title = `retrieval backend: ${r.backend} · qdrant: ${r.status?.qdrant || '-'} · embeddings: ${r.status?.embeddings || '-'}`;
      f('kb-count-sop').textContent = docs.sop.length;
      f('kb-count-knowledge').textContent = docs.knowledge.length;
      f('kb-count-memory').textContent = docs.memory.length;
      renderList();
    } catch (err) { msg(`could not load: ${err.message}`, true); }
  }

  function renderList() {
    const ul = f('kb-list');
    ul.innerHTML = '';
    for (const d of docs[kind]) {
      const li = document.createElement('li');
      li.className = d.id === selected ? 'on' : '';
      // Memory docs wear their self-learning scorecard (composite score + kind + update count).
      const card = d.meta && kind === 'memory' ? ` · 🧠 ${d.meta.score ?? '–'}${d.meta.kind ? ' · ' + esc(d.meta.kind) : ''} · v${d.meta.version ?? 1}${(d.meta.updates?.length || 0) > 1 ? ` · ×${d.meta.updates.length}` : ''}` : d.meta?.version ? ` · v${d.meta.version}` : '';
      li.innerHTML = `<b>${esc(d.title)}</b><small>${esc(d.id)}${d.always ? ' · always' : ''}${card}</small>`;
      li.addEventListener('click', () => { selected = d.id; fill(d); renderList(); });
      ul.appendChild(li);
    }
  }

  function fill(d) {
    f('kbf-id').value = d?.id || '';
    f('kbf-id').disabled = Boolean(d); // the id names the file + Qdrant points: fixed once created
    f('kbf-title').value = d?.title || '';
    f('kbf-priority').value = d?.priority ?? 5;
    f('kbf-always').checked = Boolean(d?.always);
    f('kbf-triggers').value = (d?.triggers || []).join(', ');
    f('kbf-tags').value = (d?.tags || []).join(', ');
    f('kbf-sites').value = (d?.sites || []).join(', ');
    f('kbf-body').value = d?.body || '';
    f('kb-delete').hidden = !d;
    renderMeta(d);
  }

  // 13 Nov: METADATA panel — every doc's version, timestamps and provenance (memory docs add their
  // self-learning scorecard, usage and the revision history). Read-only; the server stamps it on save.
  function renderMeta(d) {
    const box = f('kbf-meta');
    if (!box) return;
    const m = d?.meta;
    if (!d || !m) { box.hidden = true; box.innerHTML = ''; return; }
    const when = (iso) => { if (!iso) return '–'; const t = new Date(iso); return Number.isNaN(t.getTime()) ? esc(String(iso)) : `${t.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}`; };
    const cell = (k, v, title) => `<div class="kb-meta-cell"${title ? ` title="${esc(title)}"` : ''}><span>${esc(k)}</span><b>${v}</b></div>`;
    const cells = [
      cell('version', `v${m.version ?? 1}`),
      cell('created', `${when(m.created_at)} <i>${esc(m.created_by || 'unknown')}</i>`, m.created_at || ''),
      cell('last edited', `${when(m.updated_at)} <i>${esc(m.updated_by || 'unknown')}</i>`, m.updated_at || '')
    ];
    if (kind === 'memory' || d.kind === 'memory') {
      const pct = (x) => Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) + '%' : '–';
      cells.push(cell('score', `🧠 ${m.score ?? '–'} <i>${esc(m.kind || '')}</i>`, `novelty ${pct(m.novelty)} · utility ${pct(m.utility)} · confidence ${pct(m.confidence)} — score = 100 × (0.45 utility + 0.3 confidence + 0.25 novelty)`));
      cells.push(cell('learned', `${when(m.learned_at)}${m.source?.session ? ` <i>${esc(m.source.session)}</i>` : ''}`, m.source ? `trigger: ${m.source.trigger || '?'} · model: ${m.source.model || '?'}` : ''));
      cells.push(cell('used', `${m.used_count || 0}×${m.last_used_at ? ` <i>${when(m.last_used_at)}</i>` : ''}`, m.last_used_in ? `last armed in session ${m.last_used_in}` : 'times this memory was retrieved into a turn'));
      cells.push(cell('refinements', `${m.updates?.length || 0}`, (m.updates || []).slice(-6).map((u) => `${when(u.at)} · ${u.note} · score ${u.score}${u.session ? ' · ' + u.session : ''}`).join('\n')));
    }
    const hist = (m.history || []).slice(-6).reverse().map((h) => `<li>v${h.version} · ${when(h.at)} · ${esc(h.by || '?')} · ${esc(h.change || '')}</li>`).join('');
    box.innerHTML = `<div class="kb-meta-row">${cells.join('')}</div>${hist ? `<details class="kb-meta-hist"><summary>revision history</summary><ul>${hist}</ul></details>` : ''}`;
    box.hidden = false;
  }

  function startNew() {
    selected = null;
    const next = kind === 'sop'
      ? 'SOP-' + String(Math.max(0, ...docs.sop.map((d) => Number((/^SOP-(\d+)/.exec(d.id) || [])[1] || 0))) + 1).padStart(3, '0')
      : kind === 'memory' ? 'MEM-' : 'KB-';
    fill(null);
    f('kbf-id').value = next;
    f('kbf-id').disabled = false;
    renderList();
    f('kbf-title').focus();
  }

  function setKind(k) {
    kind = k;
    el.classList.toggle('kind-knowledge', k !== 'sop'); // FAQs and Memory both hide the SOP-only fields
    document.querySelectorAll('.kb-kind').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    selected = null;
    fill(null);
    renderList();
  }

  async function save() {
    const body = {
      kind,
      id: f('kbf-id').value.trim(),
      title: f('kbf-title').value.trim(),
      priority: Number(f('kbf-priority').value) || 5,
      always: f('kbf-always').checked,
      triggers: f('kbf-triggers').value,
      tags: f('kbf-tags').value,
      sites: f('kbf-sites').value,
      body: f('kbf-body').value
    };
    f('kb-save').disabled = true;
    msg('saving & re-indexing…');
    try {
      const r = await fetch('/api/kb/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      if (r.error) return msg(r.error, true);
      selected = r.id;
      await refresh();
      fill(docs[kind].find((d) => d.id === r.id));
      msg(r.created ? 'created & indexed ✓' : 'saved & re-indexed ✓');
    } catch (err) { msg(`save failed: ${err.message}`, true); }
    finally { f('kb-save').disabled = false; }
  }

  async function remove() {
    if (!selected) return;
    if (!confirm(`Delete ${selected} from the ${kind === 'sop' ? 'SOP' : kind === 'memory' ? 'long-term memory' : 'FAQ'} knowledge base? This removes the file and its Qdrant points.`)) return;
    try {
      const r = await fetch(`/api/kb/docs?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(selected)}`, { method: 'DELETE' }).then((x) => x.json());
      if (r.error) return msg(r.error, true);
      selected = null;
      fill(null);
      await refresh();
      msg('deleted ✓');
    } catch (err) { msg(`delete failed: ${err.message}`, true); }
  }

  const open = () => { el.classList.add('open'); back.classList.add('open'); toggle.classList.add('open'); el.setAttribute('aria-hidden', 'false'); toggle.setAttribute('aria-expanded', 'true'); refresh(); };
  const close = () => { el.classList.remove('open'); back.classList.remove('open'); toggle.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', open);
  $('kb-close').addEventListener('click', close);
  back.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.querySelectorAll('.kb-kind').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
  $('kb-new').addEventListener('click', startNew);
  $('kb-save').addEventListener('click', save);
  $('kb-delete').addEventListener('click', remove);
  fill(null);
  return { open, close, setKind };
})();

// ---------- Harness: ONE edge tab bundling This turn / Talk Settings / Knowledge / Activity ----
// The four drawers and all their code are untouched: their own edge tabs are hidden (CSS), this
// tab opens the last-used one, and a sub-nav injected under each drawer's head hops between them.
const harness = (() => {
  // 12 Nov: 🧠 Memory is a first-class Harness section — the long-term-memory KB (the Memorist's
  // self-learnings, scorecards, hand edits). It opens the Knowledge drawer straight onto the
  // memory kind, so it shares that aside with "Knowledge" (one nav per aside, highlight by key).
  const subs = {
    turn: { label: 'This turn', mod: turnDrawer, aside: 'turn-drawer' },
    talk: { label: 'Talk Settings', mod: talkDrawer, aside: 'talk-drawer' },
    kb: { label: 'Knowledge', mod: { open: () => { kbAdmin.open(); kbAdmin.setKind('sop'); }, close: kbAdmin.close }, aside: 'kb-drawer' },
    memory: { label: '🧠 Memory', mod: { open: () => { kbAdmin.open(); kbAdmin.setKind('memory'); }, close: kbAdmin.close }, aside: 'kb-drawer' },
    activity: { label: 'Activity', mod: drawer, aside: 'drawer' }
  };
  let last = 'turn';
  try { if (subs[localStorage.getItem('mab.harness.sub')]) last = localStorage.getItem('mab.harness.sub'); } catch {}
  const mark = (key) => document.querySelectorAll('.harness-nav .hn').forEach((b) => b.classList.toggle('on', b.dataset.h === key));
  const show = (key) => {
    last = key;
    try { localStorage.setItem('mab.harness.sub', key); } catch {}
    for (const [k, s] of Object.entries(subs)) if (k !== key && s.aside !== subs[key].aside) s.mod.close();
    subs[key].mod.open();
    mark(key);
  };
  const navDone = new Set();
  for (const [key, s] of Object.entries(subs)) {
    if (navDone.has(s.aside)) continue;
    navDone.add(s.aside);
    const nav = document.createElement('nav');
    nav.className = 'harness-nav';
    nav.setAttribute('aria-label', 'Harness sections');
    nav.innerHTML = '<span class="hn-tag">Harness</span>' + Object.entries(subs).map(([k, x]) => `<button class="hn${k === key ? ' on' : ''}" data-h="${k}" type="button">${x.label}</button>`).join('');
    nav.addEventListener('click', (ev) => { const b = ev.target.closest('.hn'); if (b && !b.classList.contains('on')) show(b.dataset.h); });
    $(s.aside).querySelector('.drawer-head').after(nav);
  }
  $('harness-toggle').addEventListener('click', () => show(last));
  return { show };
})();

// ---------- caller context: persisted in this browser, synced to the live session ----
const ctx = (() => {
  const el = $('caller-context'), remember = $('context-remember'), status = $('context-status');
  try { el.value = localStorage.getItem('mab.context') || ''; } catch {}
  try { remember.checked = localStorage.getItem('mab.context.remember') !== '0'; } catch {}
  const push = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'context', text: el.value, remember: remember.checked, session: SESSION })); };
  const save = (flash) => {
    try { localStorage.setItem('mab.context', el.value); localStorage.setItem('mab.context.remember', remember.checked ? '1' : '0'); } catch {}
    push();
    if (flash) { status.textContent = 'saved'; setTimeout(() => { status.textContent = ''; }, 1200); }
  };
  let t = null;
  el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save(true), 500); });
  remember.addEventListener('change', () => save(true));
  $('context-clear').addEventListener('click', () => { el.value = ''; save(true); });
  return {
    sync: push,
    // Apply a copy that came FROM the server (sign-in pulled the shared profile, or
    // another device edited it) — update the card + localStorage but do NOT push back,
    // so there's no echo loop between devices.
    setFromServer(text, rememberFlag) {
      if (typeof text === 'string') { el.value = text; try { localStorage.setItem('mab.context', text); } catch {} }
      if (typeof rememberFlag === 'boolean') { remember.checked = rememberFlag; try { localStorage.setItem('mab.context.remember', rememberFlag ? '1' : '0'); } catch {} }
    },
    learned(note, text) {
      if (!remember.checked) return;
      const n = String(note || '').trim().replace(/^[-•*]\s*/, '');
      // Append the new fact to what's already in the card (the caller's original startup context),
      // rather than overwriting with the server copy — so the original is always preserved on screen.
      // Fall back to the server's full text only if we have no note.
      if (n) {
        const cur = el.value;
        if (!cur.toLowerCase().includes(n.toLowerCase())) {
          el.value = (cur ? cur.replace(/\s*$/, '') + '\n' : '') + '• ' + n;
          try { localStorage.setItem('mab.context', el.value); } catch {}
          push(); // keep the live session's copy aligned with the merged card
        }
      } else if (typeof text === 'string' && text.trim()) {
        el.value = text; try { localStorage.setItem('mab.context', text); } catch {}
      }
      status.textContent = 'learned: ' + n.slice(0, 36);
      setTimeout(() => { status.textContent = ''; }, 2600);
      // The About You card now lives in the Talk Settings drawer — flag the edge tab when it's shut
      // so the user notices a fact was added without having to have it open.
      try { if (!talkDrawer.isOpen) { const tt = $('harness-toggle'); tt.classList.add('learned'); setTimeout(() => tt.classList.remove('learned'), 6000); } } catch {} // talk-toggle hides behind Harness now
    }
  };
})();

// ---------- identity: sign in with an email so Long Term Memory is SHARED across ----
// devices (web + app) instead of siloed per browser. The email is the profile key;
// signing in pulls the shared memory, and edits on one device sync live to the others.
const identity = (() => {
  const emailEl = $('user-email'), btn = $('id-save'), status = $('id-status');
  if (!emailEl || !btn) return { sync() {} };
  let email = ''; try { email = localStorage.getItem('mab.email') || ''; } catch {}
  if (email) emailEl.value = email;
  const paint = (signedIn) => {
    status.textContent = signedIn ? `signed in as ${email}` : (email ? 'press Sign in to sync' : 'not signed in — memory stays on this device');
    status.className = signedIn ? 'hint ok' : 'hint';
    btn.textContent = signedIn ? 'Sign out' : 'Sign in';
  };
  let signedIn = false;
  const send = (em) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'identify', email: em, session: SESSION })); };
  const apply = () => {
    if (signedIn) { // sign out
      email = ''; try { localStorage.removeItem('mab.email'); } catch {}
      emailEl.value = ''; signedIn = false; send(''); paint(false); return;
    }
    const v = emailEl.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { status.textContent = 'enter a valid email'; status.className = 'hint warn'; return; }
    email = v; try { localStorage.setItem('mab.email', v); } catch {}
    send(v);
  };
  btn.addEventListener('click', apply);
  emailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  paint(false);
  return {
    sync() { if (email) send(email); }, // re-identify on (re)connect
    confirmed(em) { signedIn = !!em; email = em || ''; paint(signedIn); }
  };
})();

// ---------- test-call redirect: the SERVER owns this switch; the console shows and edits it ----
// When on, every REAL outbound call the team places is redirected to a test number you control.
// 13 Nov: it used to be persisted per browser and replayed on every connect — so a fresh profile
// (a Playwright check, a second device) pushed "off" and silently disarmed the redirect before a
// run. Now the server's persisted state arrives on hello and only a USER change is pushed back.
const testCalls = (() => {
  const on = $('test-calls'), num = $('test-number'), status = $('test-status');
  if (!on || !num) return { sync() {}, adopt() {} };
  const clean = (s) => String(s || '').replace(/[^\d+]/g, '');
  const valid = () => clean(num.value).replace(/\D/g, '').length >= 5;
  const paint = () => {
    const live = on.checked && valid();
    status.textContent = live ? `ON — every call goes to ${clean(num.value)}`
      : on.checked ? 'enter a valid test number to activate' : 'off — calls go to their real numbers';
    status.className = live ? 'hint warn' : 'hint';
  };
  const push = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'test_dial', enabled: on.checked, number: clean(num.value), session: SESSION })); };
  const save = () => { paint(); push(); };
  let t = null;
  on.addEventListener('change', save);
  num.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 400); });
  paint();
  return {
    sync() {}, // nothing to replay — the server tells us its state on hello
    adopt(td) { if (!td) return; on.checked = Boolean(td.enabled); if (td.number || !on.checked) num.value = td.number || num.value; paint(); }
  };
})();

// ---------- resizable dividers (drag to resize, double-click to reset) -------------
function makeResizer({ grid, handle, measure, varName, key, min, max, def }) {
  if (!grid || !handle) return;
  const cur = () => parseInt(getComputedStyle(grid).getPropertyValue(varName), 10) || (measure ? measure.offsetWidth : def);
  const set = (w) => grid.style.setProperty(varName, Math.max(min, Math.min(max, w)) + 'px');
  try { const w = parseInt(localStorage.getItem(key) || '', 10); if (w) set(w); } catch {}
  let startX = 0, startW = 0, dragging = false;
  const move = (e) => { if (!dragging) return; const x = e.touches ? e.touches[0].clientX : e.clientX; set(startW + (x - startX)); if (e.cancelable) e.preventDefault(); };
  const up = () => {
    if (!dragging) return; dragging = false;
    handle.classList.remove('drag'); document.body.classList.remove('col-resizing');
    try { localStorage.setItem(key, String(cur())); } catch {}
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up);
  };
  const down = (e) => {
    dragging = true; startX = e.touches ? e.touches[0].clientX : e.clientX; startW = cur();
    handle.classList.add('drag'); document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', up);
    e.preventDefault();
  };
  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, { passive: false });
  handle.addEventListener('dblclick', () => { grid.style.removeProperty(varName); try { localStorage.removeItem(key); } catch {} });
}
makeResizer({ grid: document.querySelector('main.grid'), handle: $('col-resizer'), measure: document.querySelector('.col.left'), varName: '--leftw', key: 'mab.leftw', min: 300, max: 780, def: 380 });
makeResizer({ grid: document.querySelector('.band'), handle: $('band-resizer'), measure: document.querySelector('.band .team.card'), varName: '--bandw', key: 'mab.bandw', min: 280, max: 900, def: 620 });

// ---------- softphone: local jambonz client SDK bundle ---------------------------
let sdk = null, client = null, call = null, registered = false, wantCall = false, muted = false;
async function loadSdk() {
  if (sdk) return sdk;
  try { sdk = await import('/vendor/jambonz-client.js'); log('jambonz client SDK loaded (local bundle)'); }
  catch (e) { log('SDK load failed:', e.message || e); throw e; }
  return sdk;
}
// ---------- call audio: unlock on gesture + force-play the SDK's hidden element ----------
// The jambonz SDK plays call audio through a hidden <audio autoplay> it creates itself the moment
// the remote track arrives — but it never calls play(), so Chrome's autoplay policy can leave it
// silent when the element is born several async hops after the tap (register → getUserMedia →
// negotiate). We (a) prime the audio stack on the user's gesture and (b) watch for the SDK's audio
// element and force it to play (with a few retries, since srcObject is set just after it's added).
let _audioPrimed = false;
function unlockAudio() {
  sound.prime();
  if (_audioPrimed) return; _audioPrimed = true;
  try { const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAABAAgAZGF0YQAAAAA='); a.muted = true; const p = a.play(); if (p) p.catch(() => {}); } catch {}
}
// Remote call audio: force-play with retries; if the browser still refuses (autoplay policy),
// fall back to piping the WebRTC stream through the (gesture-primed) WebAudio context; and if even
// that is locked, surface a visible 🔊 Enable audio button instead of failing silently. Feed events
// distinguish the two failure classes: "BLOCKED" (autoplay) vs "no audio arrived" (media/network).
let _remoteEl = null, _waTap = null, _audioState = '', _audioWatchTimer = null;
function audioStatus(state, detail) {
  if (state === _audioState) return; _audioState = state;
  const btn = $('audio-fix');
  if (state === 'playing') {
    if (btn) btn.hidden = true;
    try { ev('ok', '<b>call audio</b> playing ✓', Date.now()); } catch {}
  } else if (state === 'blocked') {
    if (btn) btn.hidden = false;
    try { ev('bad', `<b>call audio BLOCKED</b> by the browser${detail ? ' (' + esc(String(detail)) + ')' : ''} — tap the 🔊 Enable audio button`, Date.now()); } catch {}
  } else if (state === 'notrack') {
    try { ev('bad', '<b>no call audio arrived</b> — the WebRTC media never reached this browser (network/firewall), not an autoplay block', Date.now()); } catch {}
  }
}
/** Pipe the remote stream through WebAudio (works once the ctx was resumed by any gesture). */
function webAudioTap(el) {
  try {
    const c = sound.ctx(); if (!c || !el.srcObject) return false;
    if (c.state === 'suspended') { try { c.resume(); } catch {} }
    if (c.state === 'suspended') return false; // still locked — needs a real gesture (the 🔊 button)
    if (_waTap) { try { _waTap.disconnect(); } catch {} }
    _waTap = c.createMediaStreamSource(el.srcObject);
    _waTap.connect(c.destination);
    el.muted = true; // keep the element as the stream sink (Chrome quirk) but silent — WebAudio carries the sound
    return true;
  } catch { return false; }
}
function wireRemoteAudio(el) {
  _remoteEl = el;
  el.muted = false; el.volume = 1; try { el.setAttribute('playsinline', ''); } catch {}
  el.addEventListener('playing', () => { if (!el.muted) audioStatus('playing'); }, { once: true });
  let n = 0;
  const go = () => {
    if (!el.isConnected) return;
    if (!el.srcObject) { if (++n < 20) setTimeout(go, 300); return; } // track not attached yet
    const p = el.play();
    if (p && p.then) p.then(() => audioStatus('playing')).catch((err) => {
      if (++n < 10) { setTimeout(go, 350); return; }
      if (webAudioTap(el)) audioStatus('playing'); else audioStatus('blocked', err && err.name);
    });
    else audioStatus('playing');
  };
  go();
}
try {
  new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'AUDIO' && node.id !== 'remoteAudio') wireRemoteAudio(node);
      else if (node.querySelector) { const a = node.querySelector('audio:not(#remoteAudio)'); if (a) wireRemoteAudio(a); }
    }
  }).observe(document.body, { childList: true, subtree: true });
} catch {}
/** 7 s after connect: if no stream reached an audio element, say so; if it's just paused, re-wire. */
function audioWatch(s) {
  clearTimeout(_audioWatchTimer);
  if (s === 'connected') {
    _audioState = '';
    _audioWatchTimer = setTimeout(() => {
      const el = _remoteEl || document.querySelector('audio:not(#remoteAudio)');
      if (!el || !el.srcObject) audioStatus('notrack');
      else if (el.paused) wireRemoteAudio(el);
    }, 7000);
  } else if (s === 'ended' || s === 'failed') {
    _audioState = ''; const btn = $('audio-fix'); if (btn) btn.hidden = true;
    if (_waTap) { try { _waTap.disconnect(); } catch {} _waTap = null; }
    _remoteEl = null;
  }
}
(() => {
  const btn = $('audio-fix'); if (!btn) return;
  btn.addEventListener('click', () => {
    unlockAudio(); // real gesture: resume the ctx
    const el = _remoteEl || document.querySelector('audio:not(#remoteAudio)');
    if (!el) { btn.hidden = true; return; }
    el.muted = false; el.volume = 1;
    const p = el.play();
    if (p && p.then) p.then(() => audioStatus('playing')).catch(() => { if (webAudioTap(el)) audioStatus('playing'); });
    else audioStatus('playing');
  });
})();

async function register() {
  unlockAudio(); // a gesture has (usually) just happened — prime audio so call speech can play
  const wss = $('wss').value.trim(), realm = $('realm').value.trim(), user = $('user').value.trim(), pass = $('pass').value;
  if (!wss || !user) { log('WSS URL and username are required.'); return; }
  try {
    const { createJambonzClient } = await loadSdk();
    client = createJambonzClient({ server: wss, username: user, password: pass, ...(realm ? { realm } : {}), displayName: user });
    client.on('stateChanged', (s) => { log('client:', s); setRegState(s); registered = (s === 'registered'); if (registered && wantCall) { wantCall = false; placeCall(); } });
    client.on('error', (err) => log('client error:', err.message || err));
    client.on('incoming', (c) => { log('incoming from', c.remoteIdentity, '(auto-answer)'); bindCall(c); c.answer(); });
    await client.connect();
  } catch (e) { log('register failed:', e.message || e); setCallState('failed'); }
}
function bindCall(c) {
  call = c;
  c.on('stateChanged', (s) => { log('call:', s); setCallState(s); if (s === 'connected') { setCallBtn(true); $('mute').disabled = false; } });
  c.on('ended', (why) => { log('ended', JSON.stringify(why)); setCallState('ended'); setCallBtn(false); $('mute').disabled = true; setMuteBtn(false); muted = false; call = null; });
  c.on('failed', (why) => { log('failed', JSON.stringify(why)); setCallState('failed'); call = null; });
  c.on('mute', (m) => { muted = m; setMuteBtn(m); updateOrb(currentAgent); });
}
async function placeCall() {
  if (!client) return;
  const target = $('number').value.trim();
  try {
    // Ask the browser for a PROCESSED mic stream: echo cancellation so the agent's own TTS coming out
    // of the speakers isn't picked up by the mic and mistaken for the caller barging in (that was
    // cutting replies off), plus noise suppression + auto gain. Plain `audio:true` doesn't guarantee
    // these are on. The SDK forwards mediaConstraints straight to getUserMedia.
    // X-Session pins the call to THIS device's console session deterministically (jambonz surfaces
    // custom X-* INVITE headers as session.data.sip.headers) — so the call's UI/events land on the
    // device that placed it, not every open console.
    const opts = { headers: { 'X-Session': SESSION }, mediaConstraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false } };
    const c = target.startsWith('app:') ? client.callApplication(target.slice(4), opts) : client.call(target, opts);
    bindCall(c); setCallBtn(true); log('calling', target);
  } catch (e) { log('call failed:', e.message || e); setCallState('failed'); }
}
// One-tap connect: register first if needed, then dial. No Call button — the orb (and sending text
// while idle) starts the call. Safe to call repeatedly; it no-ops while a call is already up.
async function startCall() {
  if (call) return;                                  // already in a call
  unlockAudio();                                     // gesture is live — prime audio for call speech
  claimNextCall();                                   // bind the next call to THIS device's session
  try {
    if (!client) { wantCall = true; await register(); return; } // register() → placeCall on 'registered'
    if (registered) placeCall(); else wantCall = true;          // wait for registration
  } catch (e) { log('start call failed:', e.message || e); }
}
// Tell the server the next call belongs to this console session, so its events don't light up other
// consoles. Sent just before dialing (and the server also honours it on the resulting call).
function claimNextCall() { send({ type: 'call_claim', session: SESSION }); }
// Authoritative hang up: drop the local WebRTC leg AND tell the server to end the call for this
// session — so Hang up works even if the leg is held elsewhere or the client-side drop doesn't take.
function hangUp() {
  try { call?.hangup(); } catch (e) { log('hangup error:', e.message || e); }
  send({ type: 'hangup', session: SESSION });
  setCallBtn(false);
}
const callIdle = () => !call && !inCall;

// Prime audio on the very first user interaction anywhere, so call speech is never autoplay-blocked.
window.addEventListener('pointerdown', () => unlockAudio(), { once: true, capture: true });
$('register').addEventListener('click', register);
// One icon connects AND disconnects — and the state pill toggles too, since that's where
// fingers went ("pressing connected" to hang up, 10 Nov).
const callToggle = () => { if (callIdle()) startCall(); else hangUp(); };
$('hangup').addEventListener('click', callToggle);
$('callstate').addEventListener('click', callToggle);
$('mute').addEventListener('click', () => call?.toggleMute());
function setMute(on) { if (!call) return; if (muted !== on) { try { call.toggleMute(); } catch {} muted = on; } }
/** The call control is an ICON toggle: green handset = connect, red handset-down = hang up. */
function setCallBtn(live) {
  const b = $('hangup'); if (!b) return;
  b.classList.toggle('live', !!live);
  const label = live ? 'Hang up' : 'Start call';
  b.title = label; b.setAttribute('aria-label', label);
  const pill = $('callstate'); if (pill) pill.title = live ? 'tap to disconnect' : 'tap to connect';
}
/** The mute control is an ICON button: live mic normally, red slashed mic while muted. */
function setMuteBtn(m) {
  const b = $('mute'); if (!b) return;
  b.classList.toggle('is-muted', !!m);
  b.setAttribute('aria-label', m ? 'Unmute microphone' : 'Mute microphone');
  b.title = m ? 'Unmute' : 'Mute';
}
// The orb is the primary control: TAP to call when idle; mid-call a tap toggles MUTE. It must NEVER
// hang up — as a floating chat-head a stray tap (or a sub-threshold drag, which synthesizes a click)
// was ending live calls (10 Nov: "the session hangs up"). Hang up is the red button, nothing else.
const orbTap = () => {
  if (controlling) { setControl(false); return; } // selecting Huey hands the browser back to Aria
  if (callIdle()) startCall(); else { setMute(!muted); setMuteBtn(muted); updateOrb(currentAgent); }
};
$('assistant-orb').addEventListener('click', orbTap);

// ---------- floating Huey (chat-head) -----------------------------------------------
// The orb + call controls MOVE into a fixed container the user can drag anywhere, like a
// chat head; the position is remembered per device. Moving the nodes keeps every handler.
// A drag must never read as a tap (taps start/end calls): an 9px threshold splits them, and
// taking pointer capture on the container starves the orb of the rest of the gesture.
(() => {
  const float = $('orb-float'), orb = $('assistant-orb');
  const controls = document.querySelector('.call-controls');
  if (!float || !orb) return;
  float.append(orb);
  if (controls) float.append(controls);
  const clamp = (x, y) => {
    const r = float.getBoundingClientRect();
    return {
      x: Math.min(Math.max(10 - r.width * 0.4, x), innerWidth - r.width * 0.6),
      y: Math.min(Math.max(6, y), innerHeight - 90)
    };
  };
  const apply = (x, y) => { float.style.left = x + 'px'; float.style.top = y + 'px'; };
  try { const p = JSON.parse(localStorage.getItem('mab.orbPos2') || 'null'); if (p && Number.isFinite(p.x)) { const c = clamp(p.x, p.y); apply(c.x, c.y); } } catch { /* default CSS position */ }
  addEventListener('resize', () => { const r = float.getBoundingClientRect(); const c = clamp(r.left, r.top); apply(c.x, c.y); });
  let start = null, dragging = false;
  float.addEventListener('pointerdown', (e) => {
    const r = float.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
    dragging = false;
  });
  float.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.px, dy = e.clientY - start.py;
    if (!dragging && Math.hypot(dx, dy) > 9) {
      dragging = true;
      float.classList.add('dragging');
      try { float.setPointerCapture(e.pointerId); } catch { /* mouse without capture still drags */ }
      orb.dispatchEvent(new PointerEvent('pointercancel')); // cancel a pending hold-to-talk
    }
    if (dragging) { const c = clamp(start.x + dx, start.y + dy); apply(c.x, c.y); }
  });
  const end = () => {
    if (dragging) {
      const r = float.getBoundingClientRect();
      try { localStorage.setItem('mab.orbPos2', JSON.stringify({ x: r.left, y: r.top })); } catch { /* fine */ }
      float.classList.remove('dragging');
    }
    start = null;
    setTimeout(() => { dragging = false; }, 0); // outlive the synthesized click
  };
  float.addEventListener('pointerup', end);
  float.addEventListener('pointercancel', end);
  float.addEventListener('click', (e) => { if (dragging) { e.stopPropagation(); e.preventDefault(); } }, true);
})();
$('sip-form').addEventListener('submit', (e) => e.preventDefault());

// ---------- team roster ----------------------------------------------------------
let TEAM = [];
// Agents the Lead currently has WORKING in the background (one per running task, several at once).
// They light up alongside whoever is speaking — the team is parallel, so the roster shows it.
// Reference-counted per agent (the same specialist can run two tasks at once) and mapped by task id
// so a finishing task clears the right agent.
const activeWorkers = new Set();
const taskAgent = new Map();   // taskId -> agentId
const agentWork = new Map();   // agentId -> running task count
function setWorking(agentId, delta) {
  if (!agentId) return;
  const n = Math.max(0, (agentWork.get(agentId) || 0) + delta);
  agentWork.set(agentId, n);
  if (n > 0) activeWorkers.add(agentId); else activeWorkers.delete(agentId);
}
function clearWorkers() { activeWorkers.clear(); taskAgent.clear(); agentWork.clear(); }
// The Huey mascot (brand SVG) — body fill comes from the element's --c via CSS (.hy-body).
const HUEY_SVG = '<svg class="hy" viewBox="0 0 57.03 47.74" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path class="hy-body" fill-rule="evenodd" d="M6.37,37.1c-.88.04-1.7.21-2.59.02-.8-.18-1.71-.73-2.2-1.22-.35-.43-.66-.77-.98-1.22-.24-.49-.45-1.06-.53-1.62-.14-.98-.07-1.76,0-2.6.27-2.77,1.21-5.36,2.55-7.79.93-1.68,2.06-3,3.39-4.38,1.78-1.85,2.77-4.04,3.76-6.41.64-1.53,1.21-3.1,2.15-4.47.88-1.28,2.06-2.33,3.29-3.29,1.05-.82,2.15-1.6,3.34-2.22C22.24-.02,26.61-.41,30.68.39c1.08.21,3.18.71,4.22,1.08,4.35,1.57,7.31,4.54,8.89,8.88.21.57.64,1.45.96,1.97.19.3.4.63.73.74.38.12.78-.07,1.1-.3.82-.57,1.48-1.36,2.33-1.88.96-.59,2.12-.79,3.25-.79s2.37.24,3.21,1.03c.55.52.88,1.23,1.17,1.93.27.67.5,1.37.5,2.09,0,.43-.09.85-.18,1.27-.29,1.29-.67,2.57-1.32,3.72-1.2,2.13-3.15,3.43-4.58,5.37-.35.48-.81,1.13-1.12,1.63-.29.46-.51.92-.79,1.41-.58,1.03-.4,2.37-.44,3.55,0,.26.04.66.04.92.06,1.99.66,4.06.24,5.83-.17.71-.29,1.3-.55,1.98-.3.77-.55,1.76-1.08,2.39-.98,1.15-2.3,1.94-3.57,2.77-2.91,1.92-6.66,2.06-10.09,1.43-1.06-.2-2.13-.46-3.06-1.02-.64-.39-1.2-.9-1.81-1.33-.84-.6-1.79-1.04-2.78-1.36-1.07-.34-2.22-.53-3.32-.35-2.18.35-3.91,2-5.97,2.79-2.68,1.02-5.91.44-8.05-1.48-.29-.26-.55-.57-.77-.89-.95-1.42-1.89-2.86-2.09-4.66-.04-.33-.02-.66.02-.99.03-.23.06-.7.36-.83"/>'
  + '<path fill="#20243a" d="M5.9,37.59c-.96-.03-2.42-.04-3.09-.86.03-.25.32-.04.55,0,3.46,1.23,5.65-2.51,6.23-5.62.07-.4.08-.48.15-.76.1-.39.12-.8.25-1.18.13-.38.25-.76.35-1.1.11-.48.82-2.46,1.48-1.82-2.16,4.11-.9,9.32-5.93,11.32Z"/>'
  + '<g class="hy-eyes">'
  + '<path class="hy-eye" fill="#f4f5f5" d="M32.21,15.59c-1.34.11-2.11-1.21-1.98-2.34.08-.66.21-1.13.65-1.42.5-.34,1.15-.43,1.82-.31.98.18,1.43,1.21,1.38,2.13-.04.92-.71,1.85-1.87,1.94ZM32.85,13.59c0-.43-.35-.79-.79-.79s-.79.35-.79.79.35.79.79.79.79-.35.79-.79Z"/>'
  + '<path class="hy-pupil" fill="#20243a" d="M31.92,14.54c-.43-.05-.68-.57-.63-.86.05-.38.26-.9.7-.91.66-.01.88.4.88.89,0,.46-.23.97-.95.88Z"/>'
  + '<path class="hy-pupil" fill="#20243a" d="M24.65,14.38c.43,0,.79-.35.79-.79s-.35-.79-.79-.79-.79.35-.79.79.35.79.79.79Z"/>'
  + '<path class="hy-eye" fill="#f4f5f5" d="M24.79,15.65c-1.34.11-2.11-1.21-1.98-2.34.08-.66.21-1.13.65-1.42.5-.34,1.15-.43,1.82-.31.98.18,1.43,1.21,1.38,2.13-.04.92-.71,1.85-1.87,1.94ZM25.43,13.66c0-.43-.35-.79-.79-.79s-.79.35-.79.79.35.79.79.79.79-.35.79-.79Z"/>'
  + '</g>'
  + '<path class="hy-mouth" fill="#20243a" d="M31.15,16.69c.55.53.11,1.12-.36,1.41-2.76,1.67-5.85-.51-5.5-1.33.06-.16.37-.13.51.04,1.25,1.59,3.99,1.67,5.34-.12h0Z"/>'
  + '</svg>';

function renderTeam(active) {
  const speakingId = active ? active.id : null;
  const box = $('team'); box.innerHTML = '';
  const N = Math.max(TEAM.length, 1);
  TEAM.forEach((a, i) => {
    const speaking = speakingId === a.id;
    const working = activeWorkers.has(a.id) && !speaking;
    const listening = inCall && !speaking && !working;
    const el = document.createElement('div');
    el.className = `huey-mini ${speaking ? 'speaking' : working ? 'working' : listening ? 'listening' : 'idle'}`;
    el.style.setProperty('--c', colorVar(a.color));
    el.style.setProperty('--angle', (-90 + i * (360 / N)) + 'deg'); // ring around the orb, first at top
    el.style.setProperty('--dur', (5.2 + (i % 3) * 0.7).toFixed(1) + 's');
    el.style.setProperty('--delay', (i * 0.3).toFixed(1) + 's');
    el.title = `${a.name} — ${a.title}${a.role === 'host' ? ' (host)' : ''}\n${a.job}`;
    el.innerHTML = `<div class="huey-wrap"><span class="nm">${esc(a.name)}</span>${HUEY_SVG}</div>`;
    box.appendChild(el);
  });
}

// ---------- feed: /ui WebSocket ----------------------------------------------------
let ws = null, turnSeq = 0, inCall = false, currentAgent = null;
const pending = new Map();
function connectFeed() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui?session=${encodeURIComponent(SESSION)}`;
  ws = new WebSocket(url);
  // Push this device's local copy FIRST, then identify: so a brand-new sign-in seeds the
  // shared profile from what's on screen, while a returning sign-in overwrites it with the
  // shared copy (server decides based on whether a profile already exists).
  ws.onopen = () => { $('feed-state').textContent = 'feed: live'; $('feed-state').className = 'pill ok'; ctx.sync(); identity.sync(); testCalls.sync(); };
  ws.onclose = () => { $('feed-state').textContent = 'feed: reconnecting…'; $('feed-state').className = 'pill warn'; setTimeout(connectFeed, 1500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === 'event') render(msg.event);
    else if (msg.kind === 'reply' || msg.kind === 'error') { const p = pending.get(msg.turnId); if (p) { pending.delete(msg.turnId); p(msg); } }
    else if (msg.kind === 'hello') { if (msg.team) { TEAM = msg.team; renderTeam(null); } if (msg.bots) { BOTS = msg.bots; renderBots(); } testCalls.adopt(msg.test_dial); log('feed session', msg.sessionId); }
    else if (msg.kind === 'bots') { BOTS_FULL = msg.bots || []; BOTS = BOTS_FULL; renderBots(); botsAdmin.render(); }
    else if (msg.kind === 'mcp') { MCP_SERVERS = msg.servers || []; mcpAdmin.render(); }
    else if (msg.kind === 'test_dial') { testCalls.adopt(msg); } // 15 Nov: Aria flipped it via talk_settings
    else if (msg.kind === 'mcp_probe') { mcpAdmin.flash(msg.ok ? `✓ ${(msg.tools || []).length} tool(s)${(msg.tools || []).length ? ': ' + msg.tools.slice(0, 6).join(', ') : ''}` : `✗ ${msg.error || 'could not reach server'}`, msg.ok); }
    // Signed in: the server returns the SHARED long-term memory for this email.
    else if (msg.kind === 'identity') { identity.confirmed(msg.email); if (msg.email) ctx.setFromServer(msg.text, msg.remember); }
    // Another of your devices edited the shared memory (or the team learned a fact there).
    else if (msg.kind === 'context_sync') { ctx.setFromServer(msg.text, msg.remember); }
  };
}
let BOTS = [], BOTS_FULL = [], PROVIDERS = [];
// 15 Nov: the "Chatbots on this call: …" hint under the composer is gone (Mick) — ask Aria to list
// chatbots / MCP servers instead (talk_settings action=list). Kept as a no-op so callers stay simple.
function renderBots() {}
async function loadTeam() { try { const j = await (await fetch('/api/team')).json(); TEAM = j.agents; renderTeam(null); } catch {} }
async function loadBots() {
  try {
    const j = await (await fetch('/api/bots')).json();
    BOTS_FULL = j.bots || []; BOTS = BOTS_FULL; PROVIDERS = j.providers || [];
    renderBots(); botsAdmin.fillProviders(); botsAdmin.render();
  } catch {}
}

// ---------- chatbots admin: list + add/edit, synced to the server registry ----------
const botsAdmin = (() => {
  const prov = $('bot-provider');
  if (!prov) return { render() {}, fillProviders() {} };
  const listEl = $('bots-list'), note = $('bot-note'), status = $('bot-status');
  const urlRow = $('bot-url-row'), urlLabel = $('bot-url-label'), urlHint = $('bot-url-hint');
  const keyRow = $('bot-key-row'), keyLabel = $('bot-key-label'), keyHint = $('bot-key-hint'), keyInput = $('bot-key');
  const modelRow = $('bot-model-row'), modelHint = $('bot-model-hint'), advanced = $('bot-advanced'), editor = $('bot-editor'), summary = $('bot-editor-summary');
  let editingId = null;
  const meta = () => PROVIDERS.find((p) => p.id === prov.value) || PROVIDERS[0] || {};
  const flash = (t, ok) => { status.textContent = t; status.className = 'hint' + (ok ? ' ok' : ''); if (ok) setTimeout(() => { status.textContent = ''; status.className = 'hint'; }, 1600); };

  function fillProviders() {
    if (!PROVIDERS.length) return;
    if (prov.options.length !== PROVIDERS.length) prov.innerHTML = PROVIDERS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    applyProvider();
  }
  function applyProvider() {
    const p = meta();
    note.textContent = p.note || '';
    $('bot-url').placeholder = p.urlHint || 'https://…';
    urlLabel.textContent = p.urlLabel || 'Endpoint';
    urlHint.textContent = p.urlHint ? 'e.g. ' + p.urlHint : '';
    const needKey = p.auth && p.auth !== 'none';
    keyRow.hidden = !needKey;
    keyHint.hidden = !needKey;
    keyLabel.textContent = (needKey && p.keyLabel) ? p.keyLabel : 'API key';
    keyHint.textContent = needKey ? (p.keyHint || '') : '';
    modelRow.hidden = !p.model;
    modelHint.hidden = !p.model;
    // A bearer-auth provider genuinely needs its token — pop Advanced open so it isn't missed.
    if (advanced && p.auth === 'bearer') advanced.open = true;
  }
  prov.addEventListener('change', applyProvider);

  function render() {
    if (!listEl) return;
    if (!BOTS_FULL.length) { listEl.innerHTML = '<span class="hint">no chatbots configured yet</span>'; return; }
    listEl.innerHTML = BOTS_FULL.map((b) => {
      const pm = PROVIDERS.find((p) => p.id === b.provider);
      const host = (() => { try { return new URL(b.url).host; } catch { return b.url || ''; } })();
      return `<div class="bot-row"><div class="bot-row-main"><b>${esc(b.name)}</b><span class="bot-row-sub">${esc(pm ? pm.label : b.provider)} · ${esc(host)}${b.hasKey ? ' · 🔑' : ''}</span></div>`
        + `<div class="bot-row-btns"><button class="btn ghost small-btn" data-bot-edit="${esc(b.id)}">Edit</button><button class="btn ghost small-btn" data-bot-del="${esc(b.id)}">Remove</button></div></div>`;
    }).join('');
    listEl.querySelectorAll('[data-bot-edit]').forEach((el) => el.addEventListener('click', () => edit(el.getAttribute('data-bot-edit'))));
    listEl.querySelectorAll('[data-bot-del]').forEach((el) => el.addEventListener('click', () => remove(el.getAttribute('data-bot-del'))));
  }

  function resetForm() {
    editingId = null;
    for (const id of ['bot-name', 'bot-url', 'bot-key', 'bot-model', 'bot-replypath', 'bot-droppattern', 'bot-headers', 'bot-body']) { const el = $(id); if (el) el.value = ''; }
    keyInput.placeholder = '';
    $('bot-name').placeholder = 'Chatbot #' + (BOTS_FULL.length + 1);
    if (PROVIDERS.length) prov.value = PROVIDERS[0].id;
    applyProvider();
    if (advanced) advanced.open = false;
    $('bot-save').textContent = 'Add chatbot';
    summary.textContent = '+ Add a chatbot';
  }
  function edit(id) {
    const b = BOTS_FULL.find((x) => x.id === id); if (!b) return;
    editingId = id;
    $('bot-name').value = b.name || '';
    prov.value = b.provider || (PROVIDERS[0] && PROVIDERS[0].id) || 'cognigy';
    applyProvider();
    $('bot-url').value = b.url || '';
    $('bot-key').value = ''; keyInput.placeholder = b.hasKey ? '•••••• (leave blank to keep)' : '';
    $('bot-model').value = b.model || '';
    $('bot-replypath').value = b.replyPath || '';
    $('bot-droppattern').value = b.dropPattern || '';
    $('bot-headers').value = b.headers ? JSON.stringify(b.headers) : '';
    $('bot-body').value = b.bodyTemplate ? JSON.stringify(b.bodyTemplate) : '';
    $('bot-save').textContent = 'Save changes';
    summary.textContent = 'Editing: ' + (b.name || id);
    editor.open = true;
    // Reveal Advanced when it holds anything worth seeing for this bot.
    if (advanced) advanced.open = !!(b.hasKey || b.model || b.replyPath || b.dropPattern || b.headers || b.bodyTemplate) || meta().auth === 'bearer';
  }
  function parseJson(id, label) {
    const v = $(id).value.trim(); if (!v) return undefined;
    try { const o = JSON.parse(v); if (o && typeof o === 'object') return o; } catch {}
    throw new Error(`${label} must be valid JSON`);
  }
  function save() {
    const name = $('bot-name').value.trim() || ('Chatbot #' + (BOTS_FULL.length + 1));
    const url = $('bot-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return flash('enter a full https:// endpoint URL');
    let headers, body;
    try { headers = parseJson('bot-headers', 'Extra headers'); body = parseJson('bot-body', 'Body template'); }
    catch (e) { return flash(e.message); }
    // Build this bot. For an edit with a blank key, send the redaction placeholder so the server keeps
    // the stored secret; for a new/changed key, send what was typed.
    const existing = editingId ? BOTS_FULL.find((x) => x.id === editingId) : null;
    const typedKey = $('bot-key').value;
    const apiKey = typedKey ? typedKey : (existing && existing.hasKey ? '••••••' : '');
    const bot = {
      id: editingId || undefined, name, provider: prov.value, url, apiKey,
      model: $('bot-model').value.trim() || undefined,
      replyPath: $('bot-replypath').value.trim() || undefined,
      dropPattern: $('bot-droppattern').value.trim() || undefined,
      headers, bodyTemplate: body
    };
    // Send the FULL list (others keep their secrets via the placeholder they already carry).
    const others = BOTS_FULL.filter((x) => x.id !== editingId).map((x) => ({ ...x, apiKey: x.hasKey ? '••••••' : '' }));
    send({ type: 'bots', bots: [...others, bot], session: SESSION });
    flash(editingId ? 'saved' : 'added', true);
    resetForm(); editor.open = false;
  }
  function remove(id) {
    const keep = BOTS_FULL.filter((x) => x.id !== id).map((x) => ({ ...x, apiKey: x.hasKey ? '••••••' : '' }));
    send({ type: 'bots', bots: keep, session: SESSION });
    if (editingId === id) resetForm();
  }
  $('bot-save').addEventListener('click', save);
  $('bot-reset').addEventListener('click', resetForm);
  return { render, fillProviders };
})();
// ---------- MCP servers admin: list + add/edit/test, synced to the server registry ----------
let MCP_SERVERS = [], MCP_PRESETS = [];
async function loadMcp() {
  try { const j = await (await fetch('/api/mcp')).json(); MCP_SERVERS = j.servers || []; MCP_PRESETS = j.presets || []; mcpAdmin.fillPresets(); mcpAdmin.render(); } catch {}
}
const mcpAdmin = (() => {
  const addBtn = $('mcp-save'); if (!addBtn) return { render() {}, fillPresets() {}, flash() {} };
  const listEl = $('mcp-list'), preset = $('mcp-preset'), presetNote = $('mcp-preset-note'), status = $('mcp-status');
  const auth = $('mcp-auth'), keyRow = $('mcp-key-row'), keyLabel = $('mcp-key-label'), keyInput = $('mcp-key'), headerRow = $('mcp-header-row');
  const editor = $('mcp-editor'), summary = $('mcp-editor-summary');
  let editingId = null;
  const flash = (t, ok) => { status.textContent = t; status.className = 'mcp-status-msg' + (ok ? ' ok' : ''); if (ok) setTimeout(() => { status.textContent = ''; status.className = 'mcp-status-msg'; }, 2400); };
  function fillPresets() { if (!MCP_PRESETS.length || !preset) return; preset.innerHTML = MCP_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join(''); }
  function applyAuth() { const a = auth.value; keyRow.hidden = a === 'none'; headerRow.hidden = a !== 'key'; keyLabel.textContent = a === 'bearer' ? 'Bearer token' : 'Header value'; }
  auth.addEventListener('change', applyAuth);
  preset.addEventListener('change', () => {
    const p = MCP_PRESETS.find((x) => x.id === preset.value);
    if (!p || !p.id) { presetNote.textContent = ''; return; }
    presetNote.textContent = p.note || '';
    if (p.id !== 'custom' && !$('mcp-name').value.trim()) $('mcp-name').value = p.id.charAt(0).toUpperCase() + p.id.slice(1);
    if (p.url) $('mcp-url').value = p.url;
    auth.value = p.auth || 'none'; applyAuth();
  });
  function render() {
    if (!listEl) return;
    if (!MCP_SERVERS.length) { listEl.innerHTML = '<span class="hint">no MCP servers configured yet</span>'; return; }
    listEl.innerHTML = MCP_SERVERS.map((s) => {
      const host = (() => { try { return new URL(s.url).host; } catch { return s.url || ''; } })();
      const initial = (s.name || '?').trim().charAt(0).toUpperCase();
      const metaBits = [esc(host)];
      metaBits.push(s.auth === 'none' ? 'public' : (s.auth === 'bearer' ? '🔑 bearer' : '🔑 header'));
      if (s.allow?.length) metaBits.push(`${s.allow.length} tools only`);
      else if (s.toolCount != null) metaBits.push(`${s.toolCount} tools`);
      const apps = (s.apps && s.apps.length)
        ? `<div class="mcp-conn-apps"><span class="mcp-live">● live</span>${s.apps.map((a) => `<span class="mcp-app">${esc(a)}</span>`).join('')}</div>`
        : '';
      return `<div class="mcp-conn">`
        + `<div class="mcp-conn-ava">${esc(initial)}</div>`
        + `<div class="mcp-conn-main"><b>${esc(s.name)}</b><span class="mcp-conn-sub">${metaBits.join(' · ')}</span>${apps}</div>`
        + `<div class="mcp-conn-btns"><button class="btn ghost small-btn" data-mcp-edit="${esc(s.id)}">Edit</button><button class="btn ghost small-btn" data-mcp-del="${esc(s.id)}">Remove</button></div></div>`;
    }).join('');
    listEl.querySelectorAll('[data-mcp-edit]').forEach((el) => el.addEventListener('click', () => edit(el.getAttribute('data-mcp-edit'))));
    listEl.querySelectorAll('[data-mcp-del]').forEach((el) => el.addEventListener('click', () => remove(el.getAttribute('data-mcp-del'))));
  }
  function reset() {
    editingId = null;
    for (const id of ['mcp-name', 'mcp-url', 'mcp-key', 'mcp-header', 'mcp-headers', 'mcp-allow']) { const el = $(id); if (el) el.value = ''; }
    if (preset) preset.value = ''; presetNote.textContent = ''; keyInput.placeholder = '';
    auth.value = 'none'; applyAuth();
    $('mcp-name').placeholder = 'MCP server #' + (MCP_SERVERS.length + 1);
    addBtn.textContent = 'Add server'; summary.textContent = '+ Add an MCP server';
  }
  function edit(id) {
    const s = MCP_SERVERS.find((x) => x.id === id); if (!s) return;
    editingId = id;
    $('mcp-name').value = s.name || ''; $('mcp-url').value = s.url || '';
    auth.value = s.auth || 'none'; applyAuth();
    keyInput.placeholder = s.hasKey ? '•••••• (leave blank to keep)' : ''; $('mcp-key').value = '';
    $('mcp-header').value = s.headerName || ''; $('mcp-headers').value = s.headers ? JSON.stringify(s.headers) : '';
    $('mcp-allow').value = (s.allow || []).join(', ');
    addBtn.textContent = 'Save changes'; summary.textContent = 'Editing: ' + (s.name || id); editor.open = true;
  }
  function parseJson(id, label) { const v = $(id).value.trim(); if (!v) return undefined; try { const o = JSON.parse(v); if (o && typeof o === 'object') return o; } catch {} throw new Error(label + ' must be valid JSON'); }
  function build() {
    const name = $('mcp-name').value.trim() || ('MCP server #' + (MCP_SERVERS.length + 1));
    const url = $('mcp-url').value.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('enter a full https:// server URL');
    const headers = parseJson('mcp-headers', 'Extra headers');
    const existing = editingId ? MCP_SERVERS.find((x) => x.id === editingId) : null;
    const typedKey = $('mcp-key').value;
    const apiKey = typedKey ? typedKey : (existing && existing.hasKey ? '••••••' : '');
    const allow = $('mcp-allow').value.trim();
    return { id: editingId || undefined, name, url, auth: auth.value, apiKey,
      headerName: auth.value === 'key' ? ($('mcp-header').value.trim() || 'X-API-Key') : undefined,
      headers, allow: allow ? allow.split(',').map((x) => x.trim()).filter(Boolean) : undefined };
  }
  function save() { let srv; try { srv = build(); } catch (e) { return flash(e.message); } const others = MCP_SERVERS.filter((x) => x.id !== editingId).map((x) => ({ ...x, apiKey: x.hasKey ? '••••••' : '' })); send({ type: 'mcp', servers: [...others, srv], session: SESSION }); flash(editingId ? 'saved' : 'added', true); reset(); editor.open = false; }
  function remove(id) { const keep = MCP_SERVERS.filter((x) => x.id !== id).map((x) => ({ ...x, apiKey: x.hasKey ? '••••••' : '' })); send({ type: 'mcp', servers: keep, session: SESSION }); if (editingId === id) reset(); }
  function test() { let srv; try { srv = build(); } catch (e) { return flash(e.message); } flash('testing…'); send({ type: 'mcp_probe', server: srv, session: SESSION }); }
  $('mcp-save').addEventListener('click', save);
  $('mcp-reset').addEventListener('click', reset);
  $('mcp-test').addEventListener('click', test);
  return { render, fillPresets, flash };
})();

loadTeam(); loadBots(); loadMcp(); connectFeed(); maybeAutoRegister();
const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };

// text turns
// Sending text while idle also brings the call up (so the conversation continues by voice), then the
// message runs as usual — on the text channel now, bridging onto the call once it connects.
function sendTextAndConnect(t) {
  // Idle: this text STARTS the call and becomes its opening request — the greeting will address it,
  // so send it as a call intent (not a console turn) and echo it in the transcript. Mid-call: it's a
  // normal typed turn the live call answers.
  if (callIdle()) { startCall(); addMsg('caller', t, '', ''); send({ type: 'call_intent', text: t, session: SESSION }); return Promise.resolve(); }
  return sendText(t);
}
$('text-form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('text').value.trim(); if (!t) return; $('text').value = ''; sendTextAndConnect(t); });
function sendText(text) { const turnId = `t${++turnSeq}-${Date.now()}`; send({ type: 'text', text, turnId, session: SESSION }); return new Promise((r) => pending.set(turnId, r)); }
// The web browser pane stays minimised until it's actually needed — revealed the moment an agent
// (or the user) loads/uses a page, collapsed again on Clear. (On the app it lives in a pull-up sheet.)
// Reveal the live-browser pane. Soft calls (activity/items) only count when a REAL page is loaded —
// MCP/tool work (e.g. a calendar check) fires activity events without ever touching the browser, and
// revealing it then shows a weird blank "New tab". force = a page/frame event or a user navigation.
function revealBrowser(force) {
  if (!force && !/^https?:/i.test($('url').value || '')) return;
  document.body.classList.add('browser-live');
}
// direct browser actions from the console
const action = (name, args = {}) => { revealBrowser(true); send({ type: 'action', name, args, session: SESSION, id: `a${Date.now()}` }); };
$('b-go').addEventListener('click', () => { const v = $('url').value.trim(); if (!v) return; /^(https?:\/\/|[\w-]+\.[a-z]{2,})/i.test(v) ? action('navigate', { url: v }) : action('web_search', { query: v }); });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('b-go').click(); } });
$('b-back').addEventListener('click', () => action('go_back'));
$('b-look').addEventListener('click', () => action('look'));
$('b-newtab').addEventListener('click', () => { revealBrowser(true); send({ type: 'tab', action: 'new', session: SESSION }); });

// ---------- tabs: the strip above the URL bar (agent + user share the same tab group) ----------
function renderTabs(tabs) {
  const strip = $('tab-strip');
  if (!tabs || tabs.length <= 1) { strip.hidden = true; strip.innerHTML = ''; return; }
  revealBrowser(true);
  strip.hidden = false;
  strip.innerHTML = '';
  for (const t of tabs) {
    const chip = document.createElement('button');
    chip.className = 'tab-chip' + (t.active ? ' active' : '');
    const label = t.title || (t.url && t.url !== 'about:blank' ? t.url.replace(/^https?:\/\/(www\.)?/, '') : 'New tab');
    chip.innerHTML = `<span class="tab-label">${esc(label.slice(0, 34))}</span><span class="tab-x" title="Close tab">×</span>`;
    chip.title = t.url && t.url !== 'about:blank' ? t.url : 'blank tab';
    chip.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('tab-x')) { send({ type: 'tab', action: 'close', tab: t.index, session: SESSION }); return; }
      if (!t.active) send({ type: 'tab', action: 'switch', tab: t.index, session: SESSION });
    });
    strip.appendChild(chip);
  }
  const plus = document.createElement('button');
  plus.className = 'tab-chip tab-new'; plus.textContent = '+'; plus.title = 'New tab';
  plus.addEventListener('click', () => send({ type: 'tab', action: 'new', session: SESSION }));
  strip.appendChild(plus);
}
$('b-list').addEventListener('click', () => action('list_options'));

// ---------- scroll rail (11 Nov, replaced the Scroll up/down buttons): mirrors the real page's
// scroll position (frames carry it) and dragging/clicking it scrolls the actual page. ----------
const scrollRail = $('scroll-rail'), scrollThumb = $('scroll-thumb');
let railDrag = false, lastRailSend = 0;
function updateRail(scroll) {
  if (railDrag) return; // don't fight the user's drag with incoming frames
  if (!scroll || !(scroll.max > 0)) { scrollRail.hidden = true; return; }
  scrollRail.hidden = false;
  const total = scroll.max + scroll.vh;
  const h = Math.max(8, (scroll.vh / total) * 100);
  scrollThumb.style.height = `${h}%`;
  scrollThumb.style.top = `${Math.max(0, Math.min(100 - h, (scroll.y / total) * 100))}%`;
}
function railSend(clientY, immediate) {
  const r = scrollRail.getBoundingClientRect();
  const th = scrollThumb.getBoundingClientRect().height || 24;
  const frac = Math.max(0, Math.min(1, (clientY - r.top - th / 2) / Math.max(1, r.height - th)));
  scrollThumb.style.top = `${frac * Math.max(0, 100 - (th / r.height) * 100)}%`;
  const now = Date.now();
  if (!immediate && now - lastRailSend < 90) return; // throttle the drag stream
  lastRailSend = now;
  send({ type: 'browser_input', action: 'scrollTo', frac, session: SESSION });
}
scrollRail.addEventListener('pointerdown', (ev) => { ev.preventDefault(); railDrag = true; scrollRail.setPointerCapture(ev.pointerId); railSend(ev.clientY, true); });
scrollRail.addEventListener('pointermove', (ev) => { if (railDrag) railSend(ev.clientY); });
scrollRail.addEventListener('pointerup', (ev) => { if (railDrag) { railDrag = false; railSend(ev.clientY, true); } });
scrollRail.addEventListener('pointercancel', () => { railDrag = false; });

// ---------- Take control: drive the live page yourself (click / scroll / type) ----------
let controlling = false;
let controlPoll = null;
const frameEl = $('frame');
const frameWrap = document.querySelector('.frame-wrap');
function setControl(on) {
  controlling = on;
  $('b-control').classList.toggle('on', on);
  $('b-control').textContent = on ? '✋ Release control' : '✋ Take control';
  frameWrap?.classList.toggle('controlling', on);
  document.body.classList.toggle('controlling', on); // reveals the browser-controls row
  updateOrb(currentAgent); // orb label flips to "tap to hand back" while driving
  if (on) { frameEl.setAttribute('tabindex', '0'); frameEl.focus({ preventScroll: true }); controlPoll = setInterval(() => send({ type: 'frame', session: SESSION }), 350); }
  else if (controlPoll) { clearInterval(controlPoll); controlPoll = null; }
  send({ type: 'control', state: on ? 'taken' : 'released', session: SESSION }); // let Aria acknowledge
}
$('b-control').addEventListener('click', () => setControl(!controlling));
const frameXY = (ev) => { const r = frameEl.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) }; };
frameEl.addEventListener('click', (ev) => {
  // Selecting the browser IS taking control (the first click only grabs it; later clicks drive the page).
  if (!controlling) { if (frameEl.getAttribute('src')) setControl(true); return; }
  ev.preventDefault(); const { x, y } = frameXY(ev); send({ type: 'browser_input', action: 'click', x, y, session: SESSION }); frameEl.focus({ preventScroll: true });
});
frameEl.addEventListener('wheel', (ev) => { if (!controlling) return; ev.preventDefault(); send({ type: 'browser_input', action: 'scroll', dy: ev.deltaY, session: SESSION }); }, { passive: false });
const SPECIAL_KEYS = { Enter: 1, Backspace: 1, Tab: 1, Delete: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Escape: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };
frameEl.addEventListener('keydown', (ev) => {
  if (!controlling) return;
  if (SPECIAL_KEYS[ev.key]) { ev.preventDefault(); send({ type: 'browser_input', action: 'key', key: ev.key, session: SESSION }); }
  else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); send({ type: 'browser_input', action: 'type', text: ev.key, session: SESSION }); }
});
function clearScreen() {
  // Wipe everything the session put on screen, back to a fresh-load state. Status pills (models, kb,
  // obs, feed) are live system state, not session data, so they stay.
  events.innerHTML = '';
  transcript.innerHTML = '';
  resetSentiment();
  turns = 0; partialEl = null; lastCaller = { turn: -1, el: null }; seen.clear();
  // "This turn" band + speaker + team roster
  for (const id of ['st-lane', 'st-model', 'st-ttft', 'st-first', 'st-tokens', 'st-tools', 'st-cost', 'st-cost-total']) $(id).textContent = '–';
  $('st-turns').textContent = '0';
  setSpeaker(null); // resets the speaker pill, st-agent, turn-who and the team to idle/listening
  // Centre: browser view + options — collapse the pane back to minimised until used again
  document.body.classList.remove('browser-live');
  document.body.classList.remove('cards-live');
  { const cc = $('call-cost'); if (cc) { cc.hidden = true; cc.classList.remove('live'); } costTotal = 0; callCostBase = 0; s2sCostCall = 0; }
  const f = $('frame'); f.removeAttribute('src');
  $('tab-strip').hidden = true; $('tab-strip').innerHTML = '';
  $('scroll-rail').hidden = true;
  $('frame-activity').classList.remove('on'); document.querySelector('.frame-wrap')?.classList.remove('busy');
  $('frame-badge').classList.remove('on'); $('frame-badge').textContent = '';
  $('frame-meta').textContent = ''; $('url').value = '';
  $('items').innerHTML = ''; $('items-title').firstChild.textContent = 'Options on this page ';
  // Drawer panels
  $('sops').innerHTML = '<span class="hint">none yet</span>'; $('sop-why').textContent = '';
  $('knowledge').innerHTML = '<span class="hint">no knowledge hits yet</span>'; $('kb-meta').textContent = '';
  $('mood-pill').textContent = 'mood: –'; $('mood-pill').removeAttribute('data-mood');
  smsLog.length = 0; botLog.length = 0; phoneLog.length = 0; ownerLog.length = 0; renderSmsLog(); renderBotLog();
  drawer.reset(); textDrawer?.reset();
  send({ type: 'clear', session: SESSION });
}
$('clear').addEventListener('click', clearScreen);

// ---------- health pills -----------------------------------------------------------
async function health() {
  try {
    const j = await (await fetch('/api/health')).json();
    $('model-pill').textContent = `fast ${j.lanes.fast} · deep ${j.lanes.deep} · s2s ${j.lanes.s2s.split(':')[1]}`;
    $('kb-pill').textContent = `kb: ${j.kb.backend} (${j.kb.chunks} chunks)`; $('kb-pill').className = `pill ${/qdrant/.test(j.kb.backend) ? 'ok' : ''}`;
    $('obs-pill').textContent = `obs: ${j.observability.backend}`; $('obs-pill').className = `pill ${j.observability.backend === 'upstash' ? 'ok' : ''}`;
  } catch { $('model-pill').textContent = 'server unreachable'; }
}
health(); setInterval(health, 15000);

// ---------- rendering --------------------------------------------------------------
const seen = new Set();
const events = $('events'), transcript = $('transcript');
let turns = 0, partialEl = null, sent = { caller: [] }, lastCaller = { turn: -1, el: null };

function setSpeaker(agent, lane) {
  currentAgent = agent || null;
  const p = $('speaker-pill');
  if (agent) { p.textContent = `${agent.name} speaking · ${agent.title}`; p.style.setProperty('--c', colorVar(agent.color)); p.setAttribute('data-color', agent.color); }
  else { p.textContent = 'nobody speaking'; p.removeAttribute('data-color'); }
  $('turn-who').textContent = agent ? `${agent.name} · ${agent.title}${lane ? ' · ' + lane + ' lane' : ''}` : '—';
  $('st-agent').textContent = agent ? agent.name : '–';
  $('st-agent').style.setProperty('--c', agent ? colorVar(agent.color) : 'var(--ink)');
  renderTeam(agent);
  updateOrb(agent);
}
// --- orb state machine: speaking > working > listening > idle --------------------------
// SPEAKING is held for roughly as long as the words take to SAY: transcripts/TTS text stream
// far faster than the audio plays out, so we model a playout QUEUE (each chunk appends its
// estimated speech time) instead of flipping to listening the moment the text stops arriving.
// WORKING = a deep turn is in flight and nobody is audibly talking (spinner around the Huey).
let orbBusy = false;
let speakEnd = 0; // epoch ms when the queued speech is estimated to finish playing out
const estimateSayMs = (text) => Math.min(15000, Math.max(160, String(text || '').length * 62));
function holdSpeaking(agent, chunk) {
  speakEnd = Math.max(speakEnd, Date.now()) + estimateSayMs(chunk); // append to the playout queue
  clearTimeout(s2sFloorTimer);
  s2sFloorTimer = setTimeout(() => { speakEnd = 0; setSpeaker(null); }, Math.max(500, speakEnd - Date.now()));
  if (agent && (!currentAgent || currentAgent.id !== agent.id)) setSpeaker(agent);
  else updateOrb(currentAgent);
}
function setOrbBusy(on) { if (orbBusy === !!on) return; orbBusy = !!on; updateOrb(currentAgent); }
function updateOrb(agent) {
  const orb = $('assistant-orb'); if (!orb) return;
  const talking = !!agent && Date.now() < speakEnd; // an agent is set AND the voice is still playing
  // Muted beats listening (she genuinely can't hear you) but not speaking/working — her own
  // voice and the task spinner still carry information while your mic is off.
  const isMuted = muted && inCall;
  orb.dataset.state = talking ? 'speaking' : orbBusy ? 'working' : inCall ? (isMuted ? 'muted' : 'listening') : 'idle';
  orb.style.setProperty('--c', agent ? colorVar(agent.color) : 'var(--accent)');
  const mutedLabel = orb.classList.contains('held') ? 'muted — release to talk' : 'muted — tap to unmute';
  const l = $('orb-label'); if (l) l.textContent = controlling ? 'tap to hand back' : talking ? agent.name : orbBusy ? 'working on it…' : (inCall ? (isMuted ? mutedLabel : 'tap to mute') : 'tap to talk');
  orb.title = controlling ? "You're driving the browser — tap to hand back to Aria" : talking ? `${agent.name} speaking · tap to mute` : isMuted ? "Mic muted — tap to unmute so she can hear you" : (inCall ? 'In a call · tap to mute' : 'Tap to talk');
}
let s2sFloorTimer = null;
function s2sFloor(role, agent, chunk) {
  if (role === 'assistant') {
    const a = { id: agent?.id || 'host', name: agent?.name || 'Aria', title: agent?.title || 'voice host', color: agent?.color || 'host', role: 'host' };
    holdSpeaking(a, chunk);
  } else { // the caller is talking → the host is listening (a real barge-in kills the TTS server-side too)
    speakEnd = 0; clearTimeout(s2sFloorTimer);
    if (inCall && currentAgent) setSpeaker(null); else updateOrb(currentAgent);
  }
}
function laneClass(ev) { return (ev.agent && ev.agent.color) || ev.lane || (ev.type && ev.type.startsWith('s2s.') ? 's2s' : ''); }
/** Server-stamped "spoken at" (ms) moved onto this browser's clock via the event's own ts. */
const atLocal = (e) => (e && e.at && e.ts ? Date.now() - Math.max(0, Date.parse(e.ts) - e.at) : 0);
function addMsg(role, text, who, meta, colorKey, at = 0) {
  if (partialEl && role === 'caller') { partialEl.remove(); partialEl = null; }
  if (role !== 'caller') textDrawer?.bump(); // closed Text drawer shows an unread count
  const d = document.createElement('div'); d.className = `msg ${role}`;
  if (colorKey) d.style.setProperty('--c', colorVar(colorKey));
  const ava = /^agent\b/.test(role) ? `<span class="msg-ava" aria-hidden="true">${HUEY_SVG}</span>` : '';
  d.dataset.ts = String(at || Date.now()); // when it was SAID (so a recap can cut the transcript to one call's window)
  d.innerHTML = `${ava}${who ? `<span class="who">${esc(who)}</span>` : ''}<span class="bubble-text">${linkify(text)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}`;
  // A URL in an agent reply (e.g. an xApp map link, SOP-011) becomes a tappable card + QR —
  // bubbles are textContent-escaped, so this is the only way a link is ever clickable here.
  if (/^agent\b/.test(role)) {
    const urls = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
    if (urls.length) d.appendChild(buildLinkCards(urls));
  }
  // Newest on TOP (just under the Send box). 15 Nov: a line that carries `at` (a voice transcript —
  // the caller's text lands after Aria has started answering) is slotted where it was SPOKEN,
  // not where it arrived, so the thread reads in the order the conversation actually happened.
  let before = transcript.firstChild;
  if (at) { before = null; for (const c of transcript.children) if ((Number(c.dataset.ts) || 0) <= at) { before = c; break; } }
  transcript.insertBefore(d, before); transcript.scrollTop = 0; return d;
}

/** Tappable cards (and a QR for the first link) for URLs an agent put in its reply. */
function buildLinkCards(urls) {
  const wrap = document.createElement('div'); wrap.className = 'link-cards';
  urls.slice(0, 2).forEach((url, i) => {
    let host = url; try { host = new URL(url).hostname; } catch { /* leave as-is */ }
    const a = document.createElement('a');
    a.className = 'link-card'; a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = `<span class="lc-icon">🗺️</span><span class="lc-text"><b>Open on this device</b><small>${esc(host)}</small></span><span class="lc-go">›</span>`;
    wrap.appendChild(a);
    if (i === 0 && typeof qrcode === 'function') {
      try {
        const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
        const q = document.createElement('div'); q.className = 'link-qr';
        q.innerHTML = `<img alt="QR code for the link" src="${qr.createDataURL(4, 8)}"><small>or scan with your phone</small>`;
        wrap.appendChild(q);
      } catch { /* QR is a nicety — the card still works */ }
    }
  });
  return wrap;
}
function ev(cls, html, ts) {
  const li = document.createElement('li'); li.className = `ev ${cls || ''}`;
  li.innerHTML = `<span class="t">${new Date(ts).toLocaleTimeString([], { hour12: false })}</span><span>${html}</span>`;
  events.appendChild(li);
  if ($('autoscroll').checked) events.scrollTop = events.scrollHeight;
  while (events.children.length > 400) events.firstChild.remove();
  drawer.bump();
}
const sentChip = (s) => s ? `<span class="chip-sent ${s.label}">${s.label} ${s.score > 0 ? '+' : ''}${s.score}</span>` : '';

// 14 Nov pm: WATCHING a task — while a thread is open in the Async drawer and no call is live on
// main, the pane mirrors that task's browser (the server forwards its browser.* events tagged
// `watched`). A main-session frame always wins: the moment the caller's own browser paints, the
// watched view yields until the next watched frame after main goes quiet again.
let watching = null;         // { session, title } the task being watched, or null
let mainFrameAt = 0;         // last time a MAIN frame with a real page painted
function setWatch(session, title) {
  const next = session || '';
  if ((watching?.session || '') === next) return;
  watching = next ? { session: next, title: title || '' } : null;
  send({ type: 'watch', session: next });
  const b = $('frame-badge');
  if (!watching) { if (b.dataset.watched) { delete b.dataset.watched; b.textContent = ''; b.classList.remove('on'); if (Date.now() - mainFrameAt > 10000) { document.body.classList.remove('browser-live'); $('frame').removeAttribute('src'); $('frame-meta').textContent = ''; } } }
}
function renderWatched(e) {
  if (!watching || e.sessionId !== watching.session && !String(e.sessionId || '').startsWith(watching.session + '#')) return;
  if (inCall || Date.now() - mainFrameAt < 10000) return; // the caller's own browser has the pane
  const b = $('frame-badge');
  if (e.type === 'browser.frame') {
    if (!(e.url && /^https?:/i.test(e.url))) return;
    revealBrowser(true);
    $('frame').src = `data:image/jpeg;base64,${e.jpeg}`;
    $('frame-meta').textContent = `watching task · ${Math.round(e.bytes / 1024)} KB · ${new Date(e.ts).toLocaleTimeString()}`;
    updateRail(e.scroll);
    $('url').value = e.url; b.textContent = `👁 ${watching.title ? watching.title + ' · ' : ''}${e.title || e.url}`; b.classList.add('on'); b.dataset.watched = '1';
  } else if (e.type === 'browser.page') {
    const real = e.url && !/^about:/i.test(e.url);
    if (real) { revealBrowser(true); $('url').value = e.url; if (e.title) { b.textContent = `👁 ${watching.title ? watching.title + ' · ' : ''}${e.title}`; b.classList.add('on'); b.dataset.watched = '1'; } }
  }
}
function render(e) {
  if (e.watched) return renderWatched(e);
  if (e.sessionId && e.sessionId !== SESSION) return;
  if (e.type === 'browser.frame') {
    if (e.url && /^https?:/i.test(e.url)) { mainFrameAt = Date.now(); if ($('frame-badge').dataset.watched) { delete $('frame-badge').dataset.watched; } }
    if (e.url && /^https?:/i.test(e.url)) revealBrowser(true); // ignore the boot about:blank frame
    $('frame').src = `data:image/jpeg;base64,${e.jpeg}`;
    $('frame-meta').textContent = `${Math.round(e.bytes / 1024)} KB · ${new Date(e.ts).toLocaleTimeString()}`;
    updateRail(e.scroll);
    if (e.url && /^https?:/i.test(e.url)) { $('url').value = e.url; const b = $('frame-badge'); b.textContent = e.title || e.url; b.classList.add('on'); }
    return;
  }
  // Tab list: idempotent, so handled before the seen-dedupe (the server also sends one on connect).
  if (e.type === 'browser.tabs') { renderTabs(e.tabs || []); return; }
  if (seen.has(e.seq)) return; seen.add(e.seq);
  switch (e.type) {
    case 'call.start': {
      const already = inCall; // a second call.start while live must not re-baseline the cost
      inCall = true; setCallBtn(true); renderTeam(currentAgent); updateOrb(currentAgent);
      if (!already) {
        callCostBase = costTotal; s2sCostCall = 0; // this call's spend starts from here
        callTasks.clear(); // the recap's "Background tasks" = tasks this call starts
        callWin = { callSid: e.callSid || '', from: e.from || '', to: e.to || '', startedAt: Date.now(), endedAt: 0, tasks: callTasks };
        const cc = $('call-cost'); if (cc) { cc.hidden = false; cc.classList.add('live'); cc.textContent = 'call cost $0.0000'; }
      }
      ev('ok', `<b>call</b> ${esc(e.direction)} from ${esc(e.from)} · mode ${esc(e.mode)}`, e.ts); break;
    }
    case 'call.end': if (callWin) { callWin.endedAt = Date.now(); lastCallWin = { ...callWin, tasks: new Set(callTasks) }; } inCall = false; setCallBtn(false); $('mute').disabled = true; clearTimeout(s2sFloorTimer); speakEnd = 0; setOrbBusy(false); $('call-cost')?.classList.remove('live'); clearWorkers(); $('frame-activity').classList.remove('on'); document.querySelector('.frame-wrap')?.classList.remove('busy'); sound.work(false); setSpeaker(null); ev('', `<b>call ended</b> ${esc(e.reason)} · ${e.swaps} lane swaps · ${ms(e.duration_ms)}`, e.ts); setTimeout(loadRecordings, 2500); scheduleAutoRecap(); break;
    case 'speaker': setSpeaker(e.agent, e.lane); ev(e.agent?.color || e.lane, `<b>${esc(e.agent?.name || '?')}</b> has the floor <span class="t">${esc(e.agent?.title || '')}${e.worker ? ' · ' + esc(e.worker.name) + ' working on it' : ''}${e.handing_off ? ' · handed the task' : ''}</span>`, e.ts); break;
    case 'lane.swap': ev(e.lane === 's2s' ? 's2s' : 'deep', `<b>lane → ${esc(e.lane)}</b> ${esc(e.why)} <code>${esc(e.model)}</code>`, e.ts); break;
    case 'turn.lane': $('st-lane').textContent = e.lane; setOrbBusy(e.lane === 'deep'); if (e.lane === 'deep') sound.work(true); break;
    case 'stt.speech_start': ev('you', `<b>speech start</b> (jambonz VAD)`, e.ts); break;
    case 'stt.partial': { if (!partialEl) partialEl = addMsg('caller', '', '', '', ''); (partialEl.querySelector('.bubble-text') || partialEl).textContent = e.text; partialEl.classList.toggle('partial', !e.final); break; }
    case 'turn.start': ev('you', `<b>turn ${e.turnId ?? ''}</b> ${esc(e.input)} ${e.text ? `“${esc(e.text)}”` : ''}`, e.ts); break;
    case 'caller.said': {
      turns = Math.max(turns, e.turn || 0); $('st-turns').textContent = turns || $('st-turns').textContent;
      if (e.via !== 's2s') addMsg('caller', e.text, '', e.sentiment ? `sentiment ${e.sentiment.label} ${e.sentiment.score > 0 ? '+' : ''}${e.sentiment.score}` : '');
      // One feed row per caller line (voice transcripts arrive in chunks); update it as it grows.
      const html = `<b>caller</b> “${esc((e.text || '').slice(0, 110))}”${sentChip(e.sentiment)}`;
      if (lastCaller.turn === e.turn && lastCaller.el && lastCaller.el.isConnected) lastCaller.el.lastElementChild.innerHTML = html;
      else { ev('caller', html, e.ts); lastCaller = { turn: e.turn, el: events.lastElementChild }; }
      if (e.sentiment) { recordSentiment(e.turn, e.sentiment, e.trend); setMood(e.sentiment); }
      break;
    }
    // Async LLM mood read (mood.js): corrects the lexicon score for a turn once the model has
    // judged the TONE of the recent exchange — pill + chart move, the transcript stays as is.
    case 'sentiment.update': if (e.sentiment) { recordSentiment(e.turn, e.sentiment, e.trend); setMood(e.sentiment); } break;
    // An xApp link (SOP-011): spoken replies are URL-scrubbed, so the card below the bubble is
    // how the caller actually opens it — tap on this device, or scan the QR with a phone.
    case 'agent.link': {
      if (!e.url) break;
      const d = addMsg('agent', 'Tap to open — or scan the code with your phone.', 'Aria', '', 'host');
      d.appendChild(buildLinkCards([e.url]));
      textDrawer?.open(); // the card + QR must be SEEN — surface the docked console for this moment
      ev('deep', `<b>link</b> <code>${esc(e.url.slice(0, 90))}</code>`, e.ts);
      break;
    }
    // Caller-mic detection on the speech-to-speech leg: proof the model heard (or didn't).
    case 's2s.vad': if (e.phase !== 'speech_stopped') ev('you', `<b>mic</b> ${esc(e.phase === 'speech_started' ? 'caller speech detected' : e.phase === 'barge_in' ? 'barge-in — caller talked over the reply' : 'utterance captured')}`, e.ts); break;
    case 'ambience': ev('', `<b>atmosphere</b> ${esc(e.action || '')} <code>${esc(e.track || '')}</code> ${esc(e.why || '')}`, e.ts); break;
    // The Tasks inbox (async text channel): global events — every console keeps its drawer live.
    case 'tasks.update': if (e.created && e.task?.id) callTasks.add(e.task.id); tasksUi.handle(e); break;
    case 'context.updated': ctx.learned(e.note, e.text); ev('ok', `<b>remembered</b> ${esc(e.note || '')}`, e.ts); break;
    case 'team.plan': {
      const n = (e.tasks || []).length;
      const titles = (e.tasks || []).map((t) => `${t.title}${(t.needs || []).length ? ` (after ${t.needs.join(', ')})` : ''}`).join(' · ');
      addMsg('agent relay-team', titles || `${n} tasks`, 'the team', `👥 plan · ${n} task${n === 1 ? '' : 's'}`, 'host');
      ev('host', `<b>👥 Lead planned ${n} task${n === 1 ? '' : 's'}</b> <span class="t">${esc(titles)}</span>`, e.ts);
      break;
    }
    case 'task.start': {
      if (e.agent?.id) { taskAgent.set(e.id, e.agent.id); setWorking(e.agent.id, +1); renderTeam(currentAgent); }
      ev(e.agent?.color || 'deep', `<b>▶ ${esc(e.agent?.name || 'worker')}</b> ${esc(e.title || '')} <span class="t">${esc(e.kind || '')}</span>`, e.ts);
      break;
    }
    case 'task.done': {
      const agentId = taskAgent.get(e.id); taskAgent.delete(e.id);
      if (agentId) { setWorking(agentId, -1); renderTeam(currentAgent); }
      ev(e.ok ? 'ok' : 'bad', `<b>${e.ok ? '✓' : '✗'} ${esc(e.title || 'task')}</b> <span class="t">${esc((e.result || '').slice(0, 90))}</span>`, e.ts);
      break;
    }
    case 'team.cancelled': clearWorkers(); renderTeam(currentAgent); ev('', `<b>👥 team stopped</b> ${esc(e.reason || '')}`, e.ts); break;
    case 'phone.request': addMsg('phoneout', e.question, '📞 → ' + (e.name || 'them'), ''); ev('shopper', `<b>📞 calling ${esc(e.name || '')}</b> “${esc((e.question || '').slice(0, 70))}”`, e.ts); phoneLog.push({ at: Date.now(), kind: 'request', name: e.name || '', text: e.question || '' }); break;
    case 'phone.result':
      if (e.error) { addMsg('phonein err', e.error, '📞 ' + (e.name || 'call') + ' — no answer', ''); ev('bad', `<b>📞 ${esc(e.name || 'call')} —</b> ${esc(e.error)}`, e.ts); phoneLog.push({ at: Date.now(), kind: 'error', name: e.name || '', text: e.error }); }
      else { addMsg('phonein', e.answer, '📞 ' + (e.name || 'they') + ' said', e.relayed ? 'heard live on the call' : ''); ev('ok', `<b>📞 ${esc(e.name || 'they')} said</b> “${esc((e.answer || '').slice(0, 70))}”${e.relayed ? ' · heard live' : ''}`, e.ts); }
      break;
    case 'phone.answered_by': {
      const icon = { human: '🙂', agent: '🤖', ivr: '🔢', voicemail: '📼' }[e.kind] || '❓';
      ev(e.kind === 'human' ? 'ok' : 'shopper', `<b>${icon} ${e.direction === 'inbound' ? 'caller is' : 'answered by'} ${esc(e.kind)}</b> ${Math.round((e.confidence || 0) * 100)} %${e.changed ? ' (revised)' : ''} — ${esc((e.cues || []).slice(-2).join('; '))}`, e.ts);
      toasts.show({ icon, title: `${e.direction === 'inbound' ? (e.changed ? 'Caller is now' : 'Caller is') : e.changed ? 'Now talking to' : 'Answered by'} ${e.kind === 'ivr' ? 'a phone menu' : e.kind === 'agent' ? 'an AI agent' : e.kind === 'voicemail' ? 'voicemail' : 'a person'}`, body: (e.cues || []).slice(-1)[0] || '', ttl: 5000 });
      break;
    }
    case 'phone.amd': ev('', `<b>📞 AMD</b> ${esc(e.type)}`, e.ts); break;
    case 'phone.probe': ev('shopper', `<b>❓ probe</b> person or assistant? (tie after ${e.turns} turns)`, e.ts); break;
    case 'phone.ask': ev('shopper', `<b>📞 ask-call</b> → ${esc(e.name || e.to || '')}: “${esc((e.question || '').slice(0, 60))}”`, e.ts); break;
    case 'phone.answer': ev(e.answer ? 'ok' : '', `<b>📞 answer</b> “${esc((e.answer || '(none)').slice(0, 70))}”`, e.ts); phoneLog.push({ at: Date.now(), kind: 'answer', callSid: e.callSid || '', name: e.name || '', text: e.answer || '', transcript: Array.isArray(e.transcript) ? e.transcript : [] }); break;
    // 13 Nov: the whole outbound leg once it ends (booking + relayed follow-ups) replaces the
    // first-outcome transcript on that call's entry, so the recap shows the full venue conversation.
    case 'phone.transcript': {
      const full = Array.isArray(e.transcript) ? e.transcript : [];
      const row = [...phoneLog].reverse().find((p) => p.kind === 'answer' && (p.callSid ? p.callSid === e.callSid : p.name === (e.name || '')));
      if (row) { if (full.length >= (row.transcript || []).length) row.transcript = full; if (e.final && e.final !== row.text) row.final = e.final; }
      else if (full.length) phoneLog.push({ at: Date.now(), kind: 'answer', callSid: e.callSid || '', name: e.name || '', text: e.final || '', transcript: full });
      ev('', `<b>📞 ${esc(e.name || 'call')} — full conversation</b> ${full.length} lines`, e.ts);
      break;
    }
    // Aria ↔ owner messaging (WhatsApp / SMS task threads, self-learning notices) — for the recap.
    case 'transport.sent': if (e.body) ownerLog.push({ at: Date.now(), dir: 'out', channel: e.channel || 'message', body: e.body, dry_run: !!e.dry_run }); break;
    case 'transport.inbound': if (e.body) ownerLog.push({ at: Date.now(), dir: 'in', channel: e.channel || 'message', body: e.body }); break;
    case 'transport.failed':
      ev('bad', `<b>${esc(e.channel || 'message')} NOT DELIVERED</b> (${esc(String(e.error_code || e.status))}) — ${esc(e.hint || '')}`, e.ts);
      toasts.show({ icon: '⚠️', title: `${e.channel || 'Message'} not delivered`, body: e.hint || e.status, ttl: 12000 });
      break;
    // Mid-call relay: the callee asked something only the caller can answer, the answer going back,
    // or the finished OUTCOME arriving while the callee is still on the line (follow-ups welcome).
    case 'phone.relay':
      if (e.direction === 'question') { addMsg('phonein', e.text, '📞 ' + (e.name || 'they') + ' asks', ''); ev('shopper', `<b>📞 ${esc(e.name || 'callee')} asks</b> “${esc((e.text || '').slice(0, 80))}”`, e.ts); }
      else if (e.direction === 'outcome') ev('ok', `<b>📞 outcome from ${esc(e.name || 'the call')}</b> “${esc((e.text || '').slice(0, 80))}” — they're still on the line for follow-ups`, e.ts);
      else ev('ok', `<b>📞 relayed to ${esc(e.name || 'callee')}</b> “${esc((e.text || '').slice(0, 80))}”`, e.ts);
      phoneLog.push({ at: Date.now(), kind: 'relay', name: e.name || '', direction: e.direction, text: e.text || '' });
      break;
    case 'chatbot.request':
      addMsg('botout', e.message, '→ ' + (e.bot || 'bot'), '', 'scout'); ev('scout', `<b>→ ${esc(e.bot || 'bot')}</b> “${esc((e.message || '').slice(0, 80))}”`, e.ts);
      botLog.push({ at: Date.now(), dir: 'out', bot: e.bot || 'bot', text: e.message || '' }); renderBotLog();
      break;
    case 'chatbot.reply':
      if (e.error) { ev('bad', `<b>${esc(e.bot || 'bot')} error</b> ${esc(e.error)}`, e.ts); addMsg('botin', e.error, (e.name || e.bot || 'bot') + ' (error)', '', 'scout'); }
      else { addMsg('botin', e.reply, (e.name || e.bot || 'bot') + ' · bot', ms(e.ms), 'scout'); ev('ok', `<b>${esc(e.name || e.bot || 'bot')} ←</b> “${esc((e.reply || '').slice(0, 80))}” ${ms(e.ms)}`, e.ts); }
      botLog.push({ at: Date.now(), dir: 'in', bot: e.bot || e.name || 'bot', text: e.error || e.reply || '', error: !!e.error }); renderBotLog();
      break;
    case 's2s.cost': s2sCostCall += e.usd || 0; updateCallCost(); break;
    case 'sms.sent':
      ev(e.ok ? 'ok' : 'bad', `<b>📨 SMS ${e.ok ? '→' : 'FAILED →'} ${esc(e.to || '?')}</b> “${esc((e.body || '').slice(0, 70))}”`, e.ts);
      smsLog.push({ at: Date.now(), to: e.to || '', body: e.body || '', ok: !!e.ok }); renderSmsLog();
      break;
    case 'mcp.call': ev('concierge', `<b>MCP →</b> ${esc(e.server || '')}${e.tool ? ' · ' + esc(e.tool) : ' · list tools'}`, e.ts); break;
    case 'mcp.result': ev(e.error ? 'bad' : 'ok', `<b>MCP ←</b> ${esc(e.server || '')}${e.tool ? ' · ' + esc(e.tool) : ''} ${e.error ? 'error: ' + esc(e.error) : (e.count != null ? e.count + ' tools' : 'ok')} ${ms(e.ms)}`, e.ts); break;
    case 's2s.transcript': {
      const role = e.role === 'user' ? 'caller' : 'agent';
      // 15 Nov: one bubble per spoken LINE (the server numbers them per call) placed by when it was
      // spoken. Before this the newest same-role bubble was updated in place, which glued Aria's
      // next answer onto her previous one whenever the caller's transcript arrived late.
      const key = e.line != null ? `${e.callSid || ''}:${e.line}` : '';
      let d = key ? transcript.querySelector(`.msg[data-line="${CSS.escape(key)}"]`) : null;
      if (!d && !key) { const top = transcript.firstElementChild; if (top && top.dataset.s2s === role && !top.dataset.line) d = top; }
      if (d) (d.querySelector('.bubble-text') || d).textContent = e.text;
      else { d = addMsg(role, e.text, role === 'agent' ? (e.agent?.name || 'Host') : '', '', e.agent?.color || 'host', atLocal(e)); d.dataset.s2s = role; if (key) d.dataset.line = key; }
      s2sFloor(e.role, e.agent, e.delta || e.text); // drive the orb from the voice stream (queue model)
      break;
    }
    case 'tts.chunk': if (inCall) holdSpeaking(currentAgent || { id: 'host', name: 'Aria', title: 'Host', color: 'host', role: 'host' }, e.text); ev(currentAgent?.color || 'deep', `<b>${esc(currentAgent?.name || 'say')}</b> “${esc(e.text)}”`, e.ts); break;
    case 'turn.context': {
      // Only ARIA speaks to the caller now — the specialist is the behind-the-scenes WORKER, shown
      // in the This-turn panel but never flipping the speaker pill / orb colour.
      if (e.agent) { $('st-agent').textContent = e.agent.name; $('st-agent').style.setProperty('--c', colorVar(e.agent.color)); }
      $('sops').innerHTML = (e.sops || []).map((s) => `<span class="tag ${s.why === 'always' ? 'always' : /retrieval/.test(s.why) ? 'retrieval' : /site/.test(s.why) ? 'site' : ''}" title="${esc(s.why)}">${esc(s.id)}</span>`).join('') || '<span class="hint">none</span>';
      $('sop-why').textContent = e.sop_retrieval ? `+retrieval ${e.sop_retrieval.backend}` : '';
      $('knowledge').innerHTML = (e.knowledge || []).map((k) => `<div class="hit"><b>${esc(k.title)}</b><span class="s">score ${k.score} · lex ${k.lexical} · sem ${k.semantic}</span><div>${esc(k.text)}</div></div>`).join('') || '<span class="hint">no knowledge hits this turn</span>';
      $('kb-meta').textContent = e.knowledge_backend ? `${e.knowledge_backend} · ${e.knowledge_ms} ms` : '';
      ev(e.agent?.color || 'deep', `<b>${esc(e.agent?.name || 'context')}</b> ${(e.sops || []).length} SOPs · ${(e.knowledge || []).length} knowledge hits (${esc(e.knowledge_backend || 'n/a')})`, e.ts);
      break;
    }
    case 'model.request': sound.tick(); ev(currentAgent?.color || e.lane, `<b>model →</b> <code>${esc(e.model)}</code> round ${e.round}${e.vision ? ' + screenshot' : ''}`, e.ts); $('st-model').textContent = e.model; break;
    case 'model.response': {
      ev(currentAgent?.color || e.lane, `<b>model ←</b> TTFT <b>${ms(e.first_token_ms)}</b> · ${ms(e.ms)} · ${e.input_tokens ?? '?'}/${e.output_tokens ?? '?'} tok${e.tool_calls?.length ? ` · ${esc(e.tool_calls.join(', '))}` : ''}`, e.ts);
      if (e.purpose?.endsWith?.('_reply') || /reply/.test(e.purpose || '')) { $('st-ttft').textContent = ms(e.first_token_ms); $('st-tokens').textContent = `${e.input_tokens ?? '?'} / ${e.output_tokens ?? '?'}`; }
      break;
    }
    case 'tool.call': sound.typing(); ev(currentAgent?.color || '', `<b>tool</b> <code>${esc(e.name)}</code> ${esc(JSON.stringify(e.args || {})).slice(0, 120)}`, e.ts); break;
    case 'tool.result': ev(e.result?.error ? 'bad' : 'ok', `<b>${esc(e.name)}</b> ${ms(e.ms)} ${e.result?.error ? 'error: ' + esc(e.result.error) : e.result?.needs_confirmation ? 'needs confirmation' : e.result?.blocked ? 'blocked' : 'ok'}${e.title ? ' · ' + esc(e.title) : ''}`, e.ts); break;
    case 'browser.activity': {
      const fa = $('frame-activity'), fw = document.querySelector('.frame-wrap');
      if (e.state === 'start') { revealBrowser(); $('frame-activity-label').textContent = e.label || 'Working…'; fa.classList.add('on'); fw && fw.classList.add('busy'); }
      else { fa.classList.remove('on'); fw && fw.classList.remove('busy'); }
      break;
    }
    case 'browser.page': {
      const real = e.url && !/^about:/i.test(e.url);
      if (real) revealBrowser(true);
      $('url').value = real ? e.url : '';
      const b = $('frame-badge');
      if (e.title) { b.textContent = e.title; b.classList.add('on'); }
      // Browser wiped to a blank tab (Clear): collapse the pane everywhere — this also undoes a
      // reveal from a stale frame the 2.5s refresher captured between the click and the wipe.
      else if (!real) { b.textContent = ''; b.classList.remove('on'); document.body.classList.remove('browser-live'); $('frame').removeAttribute('src'); }
      break;
    }
    case 'browser.items': revealBrowser(); renderItems(e.title, e.items); break;
    case 'agent.show': renderItems(e.title, e.items, true); ev(currentAgent?.color || 'deep', `<b>shown on screen</b> ${esc(e.title)} (${(e.items || []).length})`, e.ts); break;
    // 13 Nov: a pin dropped on the map — the screen half of a "where is it" (multimodal showcase).
    case 'map.pin': {
      revealBrowser(true);
      const b = $('frame-badge'); b.textContent = `📍 ${e.label || e.place || 'pin'}`; b.classList.add('on');
      ev('local', `<b>📍 pin dropped</b> ${esc(e.label || e.place || '')}${e.address ? ' — ' + esc(e.address) : ''}${e.share_link ? ` · <a href="${esc(e.share_link)}" target="_blank" rel="noopener">maps link</a>` : ''}`, e.ts);
      toasts.show({ icon: '📍', title: `Pin dropped — ${e.label || e.place || ''}`, body: e.address || '', ttl: 8000, onClick: e.share_link ? () => window.open(e.share_link, '_blank') : undefined });
      pinLog.push({ at: Date.now(), label: e.label || e.place || '', address: e.address || '', lat: e.lat, lon: e.lon, url: e.url || '', share_link: e.share_link || '' });
      break;
    }
    // Long-term memory (12 Nov): the Memorist's self-learnings + the session's armed count.
    case 'memory.armed': if (e.count) ev('ok', `<b>🧠 armed</b> with ${e.count} long-term ${e.count === 1 ? 'memory' : 'memories'}`, e.ts); break;
    case 'memory.learned': {
      ev('ok', `<b>🧠 self-learning</b> [${e.score}] ${esc(e.title)}${e.updated ? ' <span class="hint">(refined)</span>' : ''}`, e.ts);
      toasts.show({ icon: '🧠', title: `Self-learning (${e.score})${e.updated ? ' · refined' : ''}`, body: e.title, ttl: 7000 });
      break;
    }
    case 'agent.confirmation': ev('bad', `<b>confirmation required</b> “${esc(e.label)}” on ${esc(e.host)}`, e.ts); break;
    // 15 Nov: Aria changed (or was refused) a Talk Setting via the talk_settings tool.
    case 'settings.changed': {
      const what = e.what === 'bots' ? 'chatbot' : e.what === 'mcp' ? 'MCP server' : 'test-dial';
      const body = e.what === 'test_dial' ? (e.enabled ? `ON → ${e.number || ''}` : 'OFF') : `${String(e.action || '').replace(/_.*/, '')} ${e.name || e.id || ''}`.trim();
      ev('ok', `<b>⚙ Talk Settings</b> ${esc(what)}: ${esc(body)}`, e.ts);
      toasts.show({ icon: '⚙️', title: `Talk Settings · ${what}`, body: `Aria: ${body}`, ttl: 8000 });
      break;
    }
    case 'settings.refused': ev('bad', `<b>⚙ Talk Settings refused</b> ${esc(e.action || '')} — ${esc(e.why || '')}`, e.ts); break;
    case 'agent.confirmed': ev('ok', `<b>confirmed</b> “${esc(e.label)}”`, e.ts); break;
    case 'agent.declined': ev('', `<b>declined</b> “${esc(e.label)}”`, e.ts); break;
    case 'agent.said': {
      // Harvest the running cost from EVERY agent.said that carries it — including unprompted
      // relays/team updates — so the header's call cost never misses a turn.
      if (typeof e.cost_total === 'number') { costTotal = e.cost_total; updateCallCost(); }
      if (e.unprompted) {
        const relay = e.async && e.lane === 'phone' ? 'agent relay-phone' : e.async && e.lane === 'chatbot' ? 'agent relay-bot' : e.async && e.lane === 'team' ? 'agent relay-team' : 'agent';
        const meta = e.async ? (e.lane === 'phone' ? '📞 relayed from the call' : e.lane === 'team' ? '👥 team update' : 'relayed') : 'unprompted';
        addMsg(relay, e.text, (e.agent?.name || currentAgent?.name), meta, (e.agent?.color || currentAgent?.color));
        break;
      }
      if (e.lane === 'deep') sound.work(false);
      setOrbBusy(false); // the turn's final reply is out — the spinner stops (speech hold keeps "speaking" alive)
      // 15 Nov: on an S2S call the team's written answer is handed to Aria, who says it her own way
      // (her words arrive as s2s.transcript) — label it as the team's, never as something Aria said.
      if (e.team) addMsg('agent relay-team', e.text, 'the team → Aria', `👥 found for Aria to say · ${e.worker ? 'via ' + e.worker.name + ' · ' : ''}${e.lane || ''} · ${ms(e.total_ms)}${typeof e.cost === 'number' ? ' · ' + money(e.cost) : ''}`, 'host');
      else addMsg('agent', e.text, e.agent?.name, `${e.worker ? 'via ' + e.worker.name + ' · ' : ''}${e.lane || ''} · TTFT ${ms(e.ttft_ms)} · ${ms(e.total_ms)}${typeof e.cost === 'number' ? ' · ' + money(e.cost) : ''}${e.hangup ? ' · hangup' : ''}${e.handback ? ' · hand back' : ''}`, e.agent?.color);
      $('st-total') && ($('st-total').textContent = ms(e.total_ms));
      if (typeof e.cost === 'number') $('st-cost').textContent = money(e.cost);
      if (typeof e.cost_total === 'number') $('st-cost-total').textContent = money(e.cost_total);
      break;
    }
    case 'turn.record': { const r = e.record; $('st-tools').textContent = (r.own_tools || []).map((t) => t.name).join(', ') || '–'; if (r.first_chunk_ms != null) $('st-first').textContent = ms(r.first_chunk_ms); break; }
    case 'jambonz.turn_end': ev('ok', `<b>jambonz turn_end</b> harness first chunk <b>${ms(e.harness_first_chunk_ms)}</b>${e.tts_ms != null ? ' · tts ' + ms(e.tts_ms) : ''}`, e.ts); if (e.harness_first_chunk_ms != null) $('st-first').textContent = ms(e.harness_first_chunk_ms); break;
    case 'jambonz.user_interruption': ev('you', `<b>interruption</b> heard “${esc(e.spoken)}”`, e.ts); break;
    case 'jambonz.silence': ev('', `<b>silence</b> ${e.seconds}s (streak ${e.streak})`, e.ts); break;
    case 'jambonz.error': ev('bad', `<b>jambonz error</b> ${esc(e.code)} ${esc(e.message)}`, e.ts); break;
    case 'agent.error': ev('bad', `<b>error</b> ${esc(e.error)}`, e.ts); break;
    case 'harness.command': ev('', `<b>command</b> ${esc(e.name)} ${esc(JSON.stringify(e.args))}`, e.ts); break;
    case 'harness.end': ev('', `<b>harness session end</b> ${esc(e.reason)} · ${e.turns} turns`, e.ts); break;
    case 'session.start': ev('ok', `<b>session</b> ${esc(e.channel)}${e.handoff ? ' · hand-off: “' + esc(e.handoff.question) + '”' : ''}`, e.ts); break;
    case 'session.end': ev('', `<b>session end</b> ${esc(e.reason)}`, e.ts); break;
    case 'call.status': ev('', `call status ${esc(e.status)}`, e.ts); break;
    default: break;
  }
}

function renderItems(title, items, explicit) {
  // The card can show WITHOUT the browser frame: a calendar / list the agent presents must appear
  // even when no web page is loaded (cards-live), while the blank frame stays tucked away.
  if ((items || []).length) document.body.classList.add('cards-live');
  $('items-title').firstChild.textContent = `${title || 'Options on this page'} `;
  const box = $('items'); box.innerHTML = '';
  for (const it of items || []) {
    const b = document.createElement('button'); b.className = `item ${explicit ? 'shown' : ''}`; b.type = 'button';
    b.innerHTML = `${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : ''}<span class="t">${esc(it.title)}</span>${it.price ? `<span class="p">${esc(it.price)}</span>` : ''}${it.text || it.detail ? `<span class="d">${esc(it.text || it.detail)}</span>` : ''}`;
    b.title = it.ref ? `click [${it.ref}]` : 'no clickable element';
    if (it.ref) b.addEventListener('click', () => action('click', { ref: it.ref }));
    box.appendChild(b);
  }
}

// ---------- caller-sentiment chart --------------------------------------------------
const ARROW = { improving: ['↗', 'up'], worsening: ['↘', 'down'], steady: ['→', 'flat'] };
function setMood(s) { const p = $('mood-pill'); if (!p || !s) return; p.textContent = `mood: ${s.label} ${s.score > 0 ? '+' : ''}${s.score}`; p.setAttribute('data-mood', s.label); }
function recordSentiment(turn, s, trend) {
  const i = sent.caller.findIndex((p) => p.turn === turn);
  if (i >= 0) sent.caller[i].score = s.score; else sent.caller.push({ turn: turn || sent.caller.length + 1, score: s.score });
  $('sent-now').textContent = (s.score > 0 ? '+' : '') + s.score.toFixed(2);
  const lbl = $('sent-label'); lbl.textContent = s.label; lbl.className = `sent-label ${s.label}`;
  const t = trend?.trend || 'steady'; const [g, cls] = ARROW[t]; $('sent-arrow').textContent = g; $('sent-arrow').className = `arrow ${cls}`;
  $('sent-trend').textContent = `trend: ${t}${trend ? ` (slope ${trend.slope > 0 ? '+' : ''}${trend.slope})` : ''}`;
  drawSentiment();
}
function resetSentiment() { sent.caller = []; $('sent-now').textContent = '–'; $('sent-label').textContent = 'no caller turns yet'; $('sent-label').className = 'sent-label'; $('sent-arrow').textContent = ''; $('sent-trend').textContent = 'trend: –'; drawSentiment(); }
function drawSentiment() {
  const svg = $('sent-chart'); const W = 640, H = 150, L = 34, R = 20, T = 12, B = 22;
  const pts = [...sent.caller].sort((a, b) => a.turn - b.turn);
  const maxTurn = Math.max(1, ...pts.map((p) => p.turn));
  const x = (turn) => maxTurn > 1 ? L + ((turn - 1) / (maxTurn - 1)) * (W - L - R) : L + (W - L - R) / 2;
  const y = (v) => T + (1 - (v + 1) / 2) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
  svg.replaceChildren();
  svg.appendChild(el('rect', { x: L, y: y(1), width: W - L - R, height: y(0) - y(1), fill: 'var(--ok)', opacity: '.07' }));
  svg.appendChild(el('rect', { x: L, y: y(0), width: W - L - R, height: y(-1) - y(0), fill: 'var(--bad)', opacity: '.07' }));
  for (const v of [1, 0, -1]) { svg.appendChild(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'currentColor', 'stroke-opacity': v === 0 ? '.5' : '.15' })); svg.appendChild(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': '11', fill: 'currentColor', opacity: '.7' }, (v > 0 ? '+' : '') + v)); }
  if (pts.length) {
    svg.appendChild(el('polyline', { points: pts.map((p) => `${x(p.turn)},${y(p.score)}`).join(' '), fill: 'none', stroke: 'var(--you)', 'stroke-width': '2.5', 'stroke-linejoin': 'round' }));
    pts.forEach((p, i) => svg.appendChild(el('circle', { cx: x(p.turn), cy: y(p.score), r: i === pts.length - 1 ? 5 : 3.5, fill: i === pts.length - 1 ? 'var(--you)' : 'var(--surface)', stroke: 'var(--you)', 'stroke-width': '2' })));
  } else svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'font-size': '12', fill: 'currentColor', opacity: '.55' }, 'Caller sentiment per turn appears here'));
}
drawSentiment();

// ---------- call recordings + shareable recap ------------------------------------
async function loadRecordings() {
  try {
    const w = lastCallWin || callWin;
    const recs = (await (await fetch(w ? `/api/recordings?session=${encodeURIComponent(SESSION)}&call=${encodeURIComponent(w.callSid)}&from=${w.startedAt}&to=${w.endedAt || ''}` : '/api/recordings')).json()).recordings || [];
    const box = $('recordings'), card = $('recordings-card');
    if (!recs.length) { card.hidden = true; return; }
    card.hidden = false;
    box.innerHTML = recs.filter((r) => !r.mirror_of).slice(0, 8).map((r) => {
      const when = r.at ? new Date(r.at).toLocaleTimeString([], { hour12: false }) : '';
      const label = r.role === 'owner' ? `Your call${/^app-/.test(r.to || '') ? ' (browser)' : ''}` : r.kind === 'outbound' ? `Outbound → ${esc(r.to || '')}` : 'Inbound call';
      return `<div class="rec"><div class="rh"><b>${label}</b><span class="rtag ${r.kind}">${esc(r.kind)}</span><span class="rmeta">${r.duration || 0}s · ${esc(r.termination || '')} · ${when}</span></div><audio controls preload="none" src="/api/recording/${esc(r.call_sid)}"></audio></div>`;
    }).join('');
  } catch { /* ignore */ }
}

function renderSmsLog() {
  const card = $('sms-card'), box = $('sms-list'); if (!card || !box) return;
  if (!smsLog.length) { card.hidden = true; return; }
  card.hidden = false;
  box.innerHTML = smsLog.slice(-8).reverse().map((s) => {
    const when = new Date(s.at).toLocaleTimeString([], { hour12: false });
    return `<div class="rec"><div class="rh"><b>${s.ok ? '📨' : '⚠️'} → ${esc(s.to || 'unknown number')}</b><span class="rmeta">${s.ok ? 'sent' : 'failed'} · ${when}</span></div><div class="sms-body">${esc(s.body || '(no message body)')}</div></div>`;
  }).join('');
}
function renderBotLog() {
  const card = $('botlog-card'), box = $('botlog-list'); if (!card || !box) return;
  if (!botLog.length) { card.hidden = true; return; }
  card.hidden = false;
  const byBot = new Map();
  for (const m of botLog) { const k = m.bot || 'bot'; if (!byBot.has(k)) byBot.set(k, []); byBot.get(k).push(m); }
  box.innerHTML = [...byBot.entries()].map(([bot, msgs]) =>
    `<div class="rec"><div class="rh"><b>🤖 ${esc(bot)}</b><span class="rmeta">${msgs.length} message${msgs.length === 1 ? '' : 's'}</span></div>` +
    msgs.slice(-12).map((m) => `<div class="bot-line ${m.dir}${m.error ? ' err' : ''}"><span class="bl-who">${m.dir === 'out' ? 'Aria →' : '←'}</span>${esc(m.text)}</div>`).join('') +
    '</div>').join('');
}

function transcriptData(win = null) {
  // The live view shows newest-first; a shared/exported transcript must read oldest-first.
  return [...transcript.querySelectorAll('.msg')].reverse().filter((m) => inWin(Number(m.dataset.ts) || 0, win)).map((m) => {
    const clone = m.cloneNode(true); clone.querySelectorAll('.who,.meta').forEach((x) => x.remove());
    const cls = m.classList;
    const out = cls.contains('phoneout') || cls.contains('botout');
    const role = cls.contains('caller') ? 'you'
      : (cls.contains('phonein') || cls.contains('phoneout')) ? 'phone'
      : (cls.contains('botin') || cls.contains('botout')) ? 'bot'
      : cls.contains('relay-phone') ? 'relayphone'
      : cls.contains('relay-bot') ? 'relaybot'
      : cls.contains('relay-team') ? 'team'
      : 'agent';
    const who = m.querySelector('.who')?.textContent?.trim() || (role === 'you' ? 'You' : 'Agent');
    return { role, who, out, text: clone.textContent.trim() };
  }).filter((m) => m.text);
}
const dataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
function download(name, text, type) { const b = new Blob([text], { type }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); }

function shareHtml({ msgs, team, recs, stats, sms = [], bots = [], tasks = [], screens = [], phones = [], owner = [], pins = [], arch = null }) {
  const E = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tm = (at) => (at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '');
  const chips = team.map((a) => `<span class="ag">${E(a.icon || '•')} ${E(a.name)}<i>${E(a.title)}</i></span>`).join('');
  const bubbles = msgs.map((m) => `<div class="b ${m.role}${m.out ? ' out' : ''}">${m.role !== 'you' ? `<span class="w">${E(m.who)}</span>` : ''}${E(m.text)}</div>`).join('');
  // Every leg's audio, oldest first: the caller's call AND each outbound call Aria placed.
  const audio = recs.slice().sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0)).map((r) => `<div class="rec"><div class="rh"><b>${r.role === 'owner' || (!r.role && r.kind !== 'outbound') ? (/^app-/.test(r.to || '') ? '☎️ The caller\'s call (browser)' : '☎️ The caller\'s call') : '📞 Aria → ' + E(r.to || 'outbound')}</b> <span class="rt">${r.duration || 0}s${r.termination ? ' · ' + E(r.termination) : ''}${r.at ? ' · ' + tm(r.at) : ''}</span></div><audio controls src="${r.data}"></audio></div>`).join('') || '<p class="muted">No audio captured for this call.</p>';
  // Every page the team worked through, in order, as thumbnails with where they were.
  const screenSec = screens.length
    ? '<h2>Screens the team worked through</h2><div class="shots">' + screens.map((s) => `<figure class="shot"><a href="${E(s.url)}" target="_blank" rel="noopener"><img src="data:image/jpeg;base64,${s.jpeg}" alt="${E(s.title || s.url)}" loading="lazy"></a><figcaption><b>${E(s.title || s.url)}</b><span>${E(s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))} · ${tm(s.at)}</span></figcaption></figure>`).join('') + '</div>'
    : '';
  // Pins dropped on the caller's Personal Voice Browser (the map page itself is among the screens above).
  const pinSec = pins.length
    ? '<h2>Pins dropped on the Personal Voice Browser</h2>' + pins.map((p) => `<div class="rec"><div class="rh"><b>📍 ${E(p.label)}</b><span class="rt">${tm(p.at)}</span></div><p style="margin:0">${E(p.address || '')}${p.share_link ? ` · <a href="${E(p.share_link)}" target="_blank" rel="noopener">open in maps</a>` : ''}${Number.isFinite(p.lat) ? ` <span class="muted">(${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)})</span>` : ''}</p></div>`).join('')
    : '';
  // Outbound calls Aria placed on the caller's behalf: what she was asked to do, the far-end
  // conversation (when the leg ran speech-to-speech), the relays, and the outcome.
  let phoneSec = '';
  if (phones.length) {
    phoneSec = '<h2>Calls Aria made for the caller</h2>' + phones.map((p) => {
      if (p.kind === 'request') return `<div class="rec"><div class="rh"><b>📞 Ringing ${E(p.name || 'them')}</b><span class="rt">${tm(p.at)}</span></div><p class="muted" style="margin:0">Asked to: ${E(p.text)}</p></div>`;
      if (p.kind === 'relay') return `<div class="bl${p.direction === 'answer' ? ' out' : ''}"><span class="blw">${p.direction === 'question' ? E(p.name || 'They') + ' asked' : p.direction === 'outcome' ? 'Outcome (they were still on the line)' : 'Relayed from the caller'}</span>${E(p.text)}</div>`;
      if (p.kind === 'error') return `<div class="bl err"><span class="blw">📞 ${E(p.name || 'call')}</span>${E(p.text)}</div>`;
      const conv = (p.transcript || []).map((t) => `<div class="b ${t.role === 'aria' ? 'agent' : 'phone'}"><span class="w">${t.role === 'aria' ? 'Aria' : E(p.name || 'Them')}</span>${E(t.text)}</div>`).join('');
      return `<div class="rec"><div class="rh"><b>📞 ${E(p.name || 'They')} — outcome</b><span class="rt">${tm(p.at)}</span></div><p style="margin:0 0 8px">${E(p.text || '(no answer)')}</p>${p.final ? `<p class="muted" style="margin:-4px 0 8px">After the follow-ups: ${E(p.final)}</p>` : ''}${conv ? `<div class="chat">${conv}</div>` : ''}</div>`;
    }).join('');
  }
  // WhatsApp / SMS between Aria and the owner (task threads, self-learning notices).
  const ownerSec = owner.length
    ? '<h2>WhatsApp &amp; SMS with the owner</h2><div class="rec">' + owner.map((m) => `<div class="bl${m.dir === 'in' ? ' out' : ''}"><span class="blw">${m.dir === 'in' ? 'Owner → Aria' : 'Aria → owner'} · ${E(m.channel)}${m.dry_run ? ' · dry-run' : ''} · ${tm(m.at)}</span>${E(m.body)}</div>`).join('') + '</div>'
    : '';
  // Texts the agent sent during the session, verbatim.
  const smsSec = sms.length
    ? '<h2>Texts sent</h2>' + sms.map((s) => `<div class="rec"><div class="rh"><b>📨 → ${E(s.to || 'unknown number')}</b><span class="rt">${s.ok ? 'sent' : 'failed'}${s.at ? ' · ' + new Date(s.at).toLocaleTimeString([], { hour12: false }) : ''}</span></div><p class="smsb">${E(s.body || '(no message body)')}</p></div>`).join('')
    : '';
  // Chatbot side-conversations, grouped per bot, oldest first.
  let botSec = '';
  if (bots.length) {
    const byBot = new Map();
    for (const m of bots) { const k = m.bot || 'bot'; if (!byBot.has(k)) byBot.set(k, []); byBot.get(k).push(m); }
    botSec = '<h2>Chatbot conversations</h2>' + [...byBot.entries()].map(([bot, ms2]) =>
      `<div class="rec"><div class="rh"><b>🤖 ${E(bot)}</b><span class="rt">${ms2.length} message${ms2.length === 1 ? '' : 's'}</span></div>` +
      ms2.map((m) => `<div class="bl ${m.dir}${m.error ? ' err' : ''}"><span class="blw">${m.dir === 'out' ? 'Agent →' : '←'}</span>${E(m.text)}</div>`).join('') + '</div>').join('');
  }
  // Background tasks (the async Tasks channel): each thread verbatim, oldest first, with any
  // attached screenshots/sketches inlined as data URLs so the recap stays one portable file.
  let taskSec = '';
  if (tasks.length) {
    taskSec = '<h2>Background tasks</h2>' + tasks.map((t) => {
      const thread = (t.messages || []).map((m) => {
        const imgs = (m.media || []).map((md) => md.data ? `<a href="${md.data}" target="_blank"><img class="timg" src="${md.data}" alt="${E(md.kind || 'image')}"></a>` : `<p class="muted" style="margin:4px 0 0;font-size:12px">(image not captured)</p>`).join('');
        return `<div class="bl ${m.role === 'owner' ? 'out' : ''}"><span class="blw">${m.role === 'owner' ? 'Owner →' : 'Aria'}${m.via ? ' · ' + E(m.via) : ''}</span>${E(m.text || '')}${imgs}</div>`;
      }).join('');
      return `<div class="rec"><div class="rh"><b>📋 ${t.seq ? '#' + t.seq + ' · ' : ''}${E(t.title)}</b><span class="rt">${E(t.status)}</span></div>${thread || '<p class="muted">no messages yet</p>'}</div>`;
    }).join('');
  }
  const metric = (label, v) => v ? `<div class="m"><b>${E(v)}</b><span>${E(label)}</span></div>` : '';
  // 13 Nov: the HIGH-LEVEL ARCHITECTURE summary (public/architecture.html) rides at the top of every
  // recap — collapsed, so the call itself stays the headline — and links to the standalone page.
  const archSec = arch?.html
    ? `<details class="archd"><summary><h2 style="display:inline;margin:0">How it works — architecture, features, testing</h2><span class="muted" style="font-size:12.5px;margin-left:10px">tap to expand · <a href="/architecture.html" target="_blank" rel="noopener">open as a page</a> · <a href="/architecture.pdf" target="_blank" rel="noopener">PDF</a></span></summary><div class="ax archbody">${arch.html}</div></details>`
    : '';
  // Caller-sentiment line chart (same shape as the console's Activity chart), inlined as SVG.
  let sentiment = '';
  const pts = (stats.sent || []).filter((p) => Number.isFinite(p.score));
  if (pts.length) {
    const W = 680, H = 150, L = 34, R = 16, T = 12, B = 22;
    const maxTurn = Math.max(1, ...pts.map((p) => p.turn));
    const x = (t) => maxTurn > 1 ? L + ((t - 1) / (maxTurn - 1)) * (W - L - R) : L + (W - L - R) / 2;
    const y = (v) => T + (1 - (v + 1) / 2) * (H - T - B);
    const grid = [1, 0, -1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#9aa6bf" stroke-opacity="${v === 0 ? '.5' : '.15'}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#9aa6bf">${v > 0 ? '+' : ''}${v}</text>`).join('');
    const line = pts.length > 1 ? `<polyline points="${pts.map((p) => `${x(p.turn)},${y(p.score)}`).join(' ')}" fill="none" stroke="#6fa9f2" stroke-width="2.5" stroke-linejoin="round"/>` : '';
    const dots = pts.map((p, i) => `<circle cx="${x(p.turn)}" cy="${y(p.score)}" r="${i === pts.length - 1 ? 5 : 3.5}" fill="${i === pts.length - 1 ? '#6fa9f2' : '#141a2b'}" stroke="#6fa9f2" stroke-width="2"/>`).join('');
    sentiment = `<h2>Caller sentiment</h2><div class="rec"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Caller sentiment per turn">${grid}${line}${dots}</svg><p class="muted" style="margin:6px 0 0;font-size:12.5px">${E(stats.mood ? `mood at the end: ${stats.mood}` : '')}${stats.trend ? ` · ${E(stats.trend)}` : ''}</p></div>`;
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal Voice Browser — call recap</title>
<style>
:root{--bg:#0b0f1a;--card:#141a2b;--ink:#eef2fb;--muted:#9aa6bf;--line:#243049;--accent:#6fa9f2}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(160deg,#0b0f1a,#121a30);color:var(--ink);font-family:'Segoe UI',system-ui,sans-serif;line-height:1.5}
.wrap{max-width:760px;margin:0 auto;padding:34px 20px 60px}
.head{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.orb{width:56px;height:56px;border-radius:50%;background:conic-gradient(from 0deg,#6fa9f2,#22d3ee,#8b5cf6,#ec4899,#6fa9f2);box-shadow:0 0 30px -4px #6fa9f2aa;flex:none}
h1{font-size:23px;margin:0;font-weight:700}.sub{color:var(--muted);font-size:14px;margin:2px 0 0}
.team{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}
.ag{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px}.ag i{color:var(--muted);font-style:normal;margin-left:6px;font-size:11px}
.metrics{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.m{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;min-width:92px}.m b{display:block;font-size:18px}.m span{color:var(--muted);font-size:11px}
h2{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:28px 0 10px;font-weight:600}
.chat{display:flex;flex-direction:column;gap:8px}
.b{max-width:85%;padding:9px 13px;border-radius:14px;font-size:14.5px}
.b.you{align-self:flex-end;background:#263a63;border-bottom-right-radius:4px}
.b.agent{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-bottom-left-radius:4px}
.b.phone{align-self:flex-start;background:#2a1422;border:1px solid #db2777;border-left:3px solid #db2777}
.b.phone .w{color:#f472b6}
.b.bot{align-self:flex-start;background:#201a33;border:1px solid #7c3aed;border-left:3px solid #7c3aed}
.b.bot .w{color:#b89bff}
.b.relayphone{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-left:3px solid #db2777}
.b.relayphone .w{color:#f472b6}
.b.relaybot{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-left:3px solid #7c3aed}
.b.relaybot .w{color:#b89bff}
.b.team{align-self:flex-start;background:var(--card);border:1px dashed var(--line);border-left:3px solid #E8833A;opacity:.9}
.b.team .w{color:#E8833A}
.b.out{align-self:flex-end;border-bottom-right-radius:4px}
.b .w{display:block;font-size:11px;color:var(--accent);font-weight:600;margin-bottom:2px}
.rec{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.rec .rh{display:flex;justify-content:space-between;margin-bottom:8px;font-size:14px}.rec .rt{color:var(--muted);font-size:12px}
audio{width:100%}.muted{color:var(--muted)}
.smsb{margin:0;padding:10px 13px;background:#102038;border:1px solid #2b4a74;border-radius:12px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.bl{margin:6px 0;padding:7px 11px;border-radius:10px;font-size:13.5px;background:#0f1526;border:1px solid var(--line);word-break:break-word}
.bl.out{background:#17233f;border-color:#2b4a74}
.bl.err{border-color:#b4552f}
.bl .blw{display:block;font-size:10.5px;color:var(--accent);font-weight:600;margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em}
.timg{display:block;max-width:100%;max-height:320px;border-radius:10px;margin-top:6px;background:#fff}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.shot{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.shot img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top;background:#fff}
.shot figcaption{padding:8px 10px;font-size:12px}.shot figcaption b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.shot figcaption span{color:var(--muted);font-size:11px}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.archd{margin:22px 0 6px}.archd summary{cursor:pointer;list-style:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px}.archd summary::-webkit-details-marker{display:none}.archd summary::before{content:'▸';color:var(--muted);margin-right:8px}.archd[open] summary::before{content:'▾'}
.archbody{margin-top:8px}.archd summary a{color:var(--accent)}
${arch?.css || ''}
</style></head><body><div class="wrap">
<div class="head"><div class="orb"></div><div><h1>Personal Voice Browser</h1><p class="sub">One call, a team of AI agents — voice &amp; web, over a jambonz custom harness</p></div></div>
<div class="metrics">${metric('turns', stats.turns)}${metric('model', stats.model)}${metric('call cost', stats.cost)}${metric('mood', stats.mood)}${metric('knowledge', stats.kb)}${metric('captured', new Date().toLocaleDateString())}</div>
${archSec}
<h2>The team on the call</h2><div class="team">${chips}</div>
<h2>What was said</h2><div class="chat">${bubbles || '<p class="muted">No transcript captured.</p>'}</div>
${sentiment}
<h2>Listen to the calls</h2>${audio}
${phoneSec}
${screenSec}
${pinSec}
${smsSec}
${ownerSec}
${botSec}
${taskSec}
<div class="foot">Recorded with the Personal Voice Browser — a voice-or-text agent that browses the web, consults chatbots, remembers you, phones people for answers, and keeps working on background tasks after the call ends.</div>
</div></body></html>`;
}

// 13 Nov: every recap is also UPLOADED (POST /api/recaps) — the server hosts it on the tunnel and
// posts the link into the Tasks thread (which forwards to WhatsApp). After a call ends the console
// builds one automatically; the ★ button still downloads a copy as well.
let autoRecapTimer = null;
function scheduleAutoRecap() {
  clearTimeout(autoRecapTimer);
  autoRecapTimer = setTimeout(() => { autoRecapTimer = null; buildShareable({ auto: true }); }, 25000);
}
async function buildShareable(opts = {}) {
  const auto = opts && opts.auto === true;
  const btn = $('make-share'), status = $('share-status');
  btn.disabled = true; const prev = status.textContent; status.textContent = auto ? 'auto-building recap…' : 'building recap…';
  try {
    // The call this recap is about: the one that just ended (frozen at call.end), else the live one.
    // With no call at all (a text-only session) there is no window and nothing is cut.
    const win = lastCallWin || callWin || null;
    let recs = [];
    // 14 Nov pm: ONLY this call's legs — the caller's leg plus the outbound calls it spawned (by call
    // sid, server-side ledger). A text-only session gets no recordings rather than the account's.
    try { recs = (await (await fetch(win ? `/api/recordings?session=${encodeURIComponent(SESSION)}&call=${encodeURIComponent(win.callSid)}&from=${win.startedAt}&to=${win.endedAt || ''}&strict=1` : `/api/recordings?session=${encodeURIComponent(SESSION)}&strict=1`)).json()).recordings || []; } catch {}
    const withAudio = [];
    for (const r of recs.filter((x) => !x.mirror_of).slice(0, 8)) { try { withAudio.push({ ...r, data: await dataUrl(await (await fetch('/api/recording/' + r.call_sid)).blob()) }); } catch {} }
    // Every page the team worked through DURING THIS CALL (server keeps one jpeg per page visited).
    let screens = [];
    try { screens = ((await (await fetch(`/api/sessions/${encodeURIComponent(SESSION)}/screens`)).json()).screens || []).filter((s) => inWin(s.at, win)).slice(-24); } catch {}
    // Background tasks THIS CALL started (13 Nov: was "anything touched in the last 12 h", which
    // dragged unrelated threads into the recap): full thread, with attached screenshots/sketches
    // inlined so the recap is one portable file.
    const shareTasks = [];
    try {
      const all = (await (await fetch('/api/tasks')).json()).tasks || [];
      let imgBudget = 12; // keep the file sane — recordings already weigh a few MB
      const taskIds = win?.tasks || callTasks;
      for (const row of all.filter((t) => taskIds.has(t.id)).slice(0, 8)) {
        try {
          const full = await (await fetch('/api/tasks/' + encodeURIComponent(row.id))).json();
          if (full.error) continue;
          const msgs = (full.messages || []).slice(-30).map((m) => ({ ...m, media: (m.media || []).map((md) => ({ ...md })) }));
          for (const m of msgs) for (const md of m.media) {
            if (imgBudget <= 0) continue;
            try { md.data = await dataUrl(await (await fetch(md.url)).blob()); imgBudget--; } catch {}
          }
          shareTasks.push({ seq: full.seq, title: full.title, status: full.status, messages: msgs });
        } catch {}
      }
    } catch {}
    // The architecture summary (public/architecture.html): its <main> + scoped <style> are inlined so
    // the recap explains itself to someone who has never seen the harness.
    let arch = null;
    try {
      const src = await (await fetch('/architecture.html', { cache: 'no-cache' })).text();
      const doc = new DOMParser().parseFromString(src, 'text/html');
      const main = doc.getElementById('arch'), style = doc.getElementById('arch-style');
      if (main) arch = { html: main.innerHTML, css: style ? style.textContent : '' };
    } catch {}
    const callCost = Math.max(0, costTotal - callCostBase) + s2sCostCall;
    const html = shareHtml({
      msgs: transcriptData(win), team: TEAM, recs: withAudio, sms: smsLog.filter((x) => inWin(x.at, win)), bots: botLog.filter((x) => inWin(x.at, win)), tasks: shareTasks,
      screens, phones: phoneLog.filter((x) => inWin(x.at, win)), owner: ownerLog.filter((x) => inWin(x.at, win)), pins: pinLog.filter((x) => inWin(x.at, win)), arch,
      stats: {
        turns: turns || $('st-turns')?.textContent,
        model: $('st-model')?.textContent?.replace(/[–-]/g, '').trim(),
        kb: ($('kb-pill')?.textContent || '').replace('kb:', '').trim(),
        cost: callCost > 0 ? '$' + callCost.toFixed(4) : '',
        mood: (($('mood-pill')?.textContent || '').replace(/^mood:\s*/, '').trim() === '–' ? '' : ($('mood-pill')?.textContent || '').replace(/^mood:\s*/, '').trim()),
        trend: ($('sent-trend')?.textContent || '').replace(/^trend:\s*–?$/, '').trim(),
        sent: sent.caller.slice()
      }
    });
    if (!auto) download('agentic-browser-recap-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.html', html, 'text/html');
    let up = null;
    try { up = await (await fetch('/api/recaps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html, title: 'the call' }) })).json(); } catch {}
    if (up?.url) {
      status.innerHTML = `${auto ? 'recap auto-built' : 'saved'} ✓ — <a href="${up.url}" target="_blank" rel="noopener">open the shared link</a>${up.seq ? ` · posted to task #${up.seq}` : ''}`;
      toasts.show({ icon: '📎', title: 'Shareable recap ready', body: `Link posted to Tasks${up.seq ? ' #' + up.seq : ''} (and WhatsApp)`, ttl: 9000, onClick: () => window.open(up.url, '_blank') });
    } else status.textContent = auto ? 'recap built (upload failed)' : 'saved ✓ — open or attach the .html file';
    setTimeout(() => { if (!up?.url) status.textContent = prev; }, 6000);
  } catch (e) { status.textContent = 'failed: ' + (e.message || e); }
  finally { btn.disabled = false; }
}
$('make-share').addEventListener('click', buildShareable);

