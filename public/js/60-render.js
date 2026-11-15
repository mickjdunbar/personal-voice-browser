// 60-render.js — Personal Voice Browser console: the Live transcript + Activity feed renderer, orb/speaker state, sentiment chart.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
warnSink = (r) => ev('bad', `<b>⚠ ${esc(r.where)}</b> ${esc(r.detail)}`, r.at);
while (warnQueue.length) warnSink(warnQueue.shift());
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
    case 'settings.since_last_call': { // 16 Nov: a call opens with what changed in Talk Settings since the last one
      const list = (e.changes || []);
      addMsg('note', `⚙ Since your last call, Talk Settings changed: ${list.map((c) => c.label + (c.by ? ` (${c.by})` : '')).join(' · ')}`, 'what changed', `${list.length} change(s) · ask Aria to list or undo`);
      ev('ok', `<b>⚙ since last call</b> ${esc(list.map((c) => c.label).join(' · '))}`, e.ts);
      break;
    }
    case 'call.recap': ev('ok', `<b>📞 call recap</b> posted to the Async drawer (${e.lines} lines)`, e.ts); toasts.show({ icon: '📞', title: 'Call recap', body: 'The transcript and a summary are in a new Async thread — reply there to follow up.', ttl: 9000 }); tasksUi.bump?.(); break;
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
