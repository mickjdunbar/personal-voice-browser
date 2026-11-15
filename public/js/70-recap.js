// 70-recap.js — Personal Voice Browser console: recordings, SMS/chatbot logs, the shareable recap builder.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
      : cls.contains('note') ? 'note'
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
.b.note{align-self:center;background:var(--card);border:1px dashed var(--line);font-size:12px;opacity:.85}
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
    try { recs = (await (await fetch(win ? `/api/recordings?session=${encodeURIComponent(SESSION)}&call=${encodeURIComponent(win.callSid)}&from=${win.startedAt}&to=${win.endedAt || ''}&strict=1` : `/api/recordings?session=${encodeURIComponent(SESSION)}&strict=1`)).json()).recordings || []; } catch (err) { warn('loading recordings for the recap', err); }
    const withAudio = [];
    for (const r of recs.filter((x) => !x.mirror_of).slice(0, 8)) { try { withAudio.push({ ...r, data: await dataUrl(await (await fetch('/api/recording/' + r.call_sid)).blob()) }); } catch (err) { warn(`fetching recording ${r.call_sid}`, err); } }
    // Every page the team worked through DURING THIS CALL (server keeps one jpeg per page visited).
    let screens = [];
    try { screens = ((await (await fetch(`/api/sessions/${encodeURIComponent(SESSION)}/screens`)).json()).screens || []).filter((s) => inWin(s.at, win)).slice(-24); } catch (err) { warn('loading the pages visited for the recap', err); }
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
            try { md.data = await dataUrl(await (await fetch(md.url)).blob()); imgBudget--; } catch (err) { warn('fetching a task image for the recap', err); }
          }
          shareTasks.push({ seq: full.seq, title: full.title, status: full.status, messages: msgs });
        } catch (err) { warn(`loading task ${row.id} for the recap`, err); }
      }
    } catch (err) { warn('loading the task list for the recap', err); }
    // The architecture summary (public/architecture.html): its <main> + scoped <style> are inlined so
    // the recap explains itself to someone who has never seen the harness.
    let arch = null;
    try {
      const src = await (await fetch('/architecture.html', { cache: 'no-cache' })).text();
      const doc = new DOMParser().parseFromString(src, 'text/html');
      const main = doc.getElementById('arch'), style = doc.getElementById('arch-style');
      if (main) arch = { html: main.innerHTML, css: style ? style.textContent : '' };
    } catch (err) { warn('loading the architecture summary for the recap', err); }
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
    try { up = await (await fetch('/api/recaps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html, title: 'the call' }) })).json(); } catch (err) { warn('saving the recap', err); }
    if (up?.url) {
      status.innerHTML = `${auto ? 'recap auto-built' : 'saved'} ✓ — <a href="${up.url}" target="_blank" rel="noopener">open the shared link</a>${up.seq ? ` · posted to task #${up.seq}` : ''}`;
      toasts.show({ icon: '📎', title: 'Shareable recap ready', body: `Link posted to Tasks${up.seq ? ' #' + up.seq : ''} (and WhatsApp)`, ttl: 9000, onClick: () => window.open(up.url, '_blank') });
    } else status.textContent = auto ? 'recap built (upload failed)' : 'saved ✓ — open or attach the .html file';
    setTimeout(() => { if (!up?.url) status.textContent = prev; }, 6000);
  } catch (e) { status.textContent = 'failed: ' + (e.message || e); }
  finally { btn.disabled = false; }
}
$('make-share').addEventListener('click', buildShareable);
