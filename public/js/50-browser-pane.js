// 50-browser-pane.js — Personal Voice Browser console: tab strip, scroll rail, Take control, Clear, health pills.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
