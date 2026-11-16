// 00-core.js — Personal Voice Browser console: helpers, shared state, warn(), browser-local SIP settings, sound, theme.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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
// 16 Nov: errors the console used to swallow (`catch {}` around the feed and fetch paths) now surface
// as a row in the Activity feed and in the browser console: `warn('loading the team', err)`. Rows
// raised before the feed list exists are queued and flushed once it does.
const warnQueue = [];
let warnSink = null;
function warn(where, err) {
  const detail = (err && (err.message || (typeof err === 'string' ? err : ''))) || '';
  console.warn(`[pvb] ${where}`, err);
  const row = { where, detail, at: Date.now() };
  if (warnSink) warnSink(row); else warnQueue.push(row);
}
// 11 Nov: the Android Capacitor shell is RETIRED — SMS/WhatsApp are the phone surface now and the
// web console (this page) is the only UI. All IS_APP / body.app branches are gone with it.
document.title = 'Personal Voice Browser';
// Session id: an explicit ?session= wins; otherwise the web console lives on 'main'
// (inbound PSTN calls surface there).
const SESSION = new URLSearchParams(location.search).get('session') || 'main';
const AGENT_COLORS = { host: 'host', concierge: 'concierge', shopper: 'shopper', scout: 'scout', local: 'local' };
const colorVar = (key) => `var(--${AGENT_COLORS[key] ? 'ag-' + key : key})`;
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`);
// 17 Nov: phone numbers as people read them (+61 412 345 678 · +61 2 7230 5100 · +61 13 23 34); other countries in threes.
const fmtPhone = (n) => {
  const s = String(n || '').replace(/[^\d+]/g, ''); if (!s) return '';
  const d = s.replace(/^\+/, '');
  if (d.startsWith('61')) { const r = d.slice(2); if (/^4\d{8}$/.test(r)) return `+61 ${r.slice(0, 3)} ${r.slice(3, 6)} ${r.slice(6)}`; if (/^[2378]\d{8}$/.test(r)) return `+61 ${r[0]} ${r.slice(1, 5)} ${r.slice(5)}`; if (/^13\d{4}$/.test(r)) return `+61 13 ${r.slice(2, 4)} ${r.slice(4)}`; if (/^1[38]00\d{6}$/.test(r)) return `+61 ${r.slice(0, 4)} ${r.slice(4, 7)} ${r.slice(7)}`; }
  if (d.startsWith('1') && d.length === 11) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return `+${d.slice(0, 2)} ${d.slice(2).replace(/(\d)(?=(\d{3})+$)/g, '$1 ')}`; // +44 7 911 123 456
};
// "+61 412 345 678" or, with the test-dial redirect on, "TEST +61 340 621 105 (for +61 412 345 678)".
const dialLine = (e) => { const d = fmtPhone(e.dialed || e.to); if (!d) return ''; return e.redirected ? `TEST-DIAL → ${d}${e.real ? ` (for ${fmtPhone(e.real)})` : ''}` : d; };
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
