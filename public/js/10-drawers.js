// 10-drawers.js — Personal Voice Browser console: edge-tab drawers: Activity, Talk Settings, This turn, Live, Async (tasks UI), Knowledge, Harness, toasts.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
