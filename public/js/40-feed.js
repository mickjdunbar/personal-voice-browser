// 40-feed.js — Personal Voice Browser console: team roster, the /ui feed socket, chatbot + MCP admin, send/sendText, boot.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
  ws.onerror = () => warn('feed socket', 'the /ui websocket errored — reconnecting');
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === 'event') render(msg.event);
    else if (msg.kind === 'reply' || msg.kind === 'error') { const p = pending.get(msg.turnId); if (p) { pending.delete(msg.turnId); p(msg); } }
    else if (msg.kind === 'hello') { if (msg.team) { TEAM = msg.team; renderTeam(null); } if (msg.bots) { BOTS = msg.bots; renderBots(); } testCalls.adopt(msg.test_dial); talkSettingsUi.adopt(msg.settings); log('feed session', msg.sessionId); }
    else if (msg.kind === 'settings') { talkSettingsUi.adopt(msg); } // 16 Nov: Aria (or another console) changed ambience / language
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
async function loadTeam() { try { const j = await (await fetch('/api/team')).json(); TEAM = j.agents; renderTeam(null); } catch (err) { warn('loading the team roster', err); } }
async function loadBots() {
  try {
    const j = await (await fetch('/api/bots')).json();
    BOTS_FULL = j.bots || []; BOTS = BOTS_FULL; PROVIDERS = j.providers || [];
    renderBots(); botsAdmin.fillProviders(); botsAdmin.render();
  } catch (err) { warn('loading the chatbot list', err); }
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
  try { const j = await (await fetch('/api/mcp')).json(); MCP_SERVERS = j.servers || []; MCP_PRESETS = j.presets || []; mcpAdmin.fillPresets(); mcpAdmin.render(); } catch (err) { warn('loading the MCP server list', err); }
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

loadTeam(); loadBots(); loadMcp(); talkSettingsUi.load(); connectFeed(); maybeAutoRegister();
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
