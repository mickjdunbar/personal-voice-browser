// 30-softphone.js — Personal Voice Browser console: jambonz WebRTC softphone: SDK, call audio, register / call / hang up, the floating orb.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
    const opts = { headers: { 'X-Session': SESSION, 'X-Client': 'pvb-web' }, mediaConstraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false } };
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
