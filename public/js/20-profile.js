// 20-profile.js — Personal Voice Browser console: caller context + identity, test-dial switch, ambience & language card, resizable dividers.
// 16 Nov 2026: app.js (2,200 lines) was split into these ordered classic scripts. They share ONE scope
// (loaded in order by index.html with defer) — a name declared here is visible to the files after it.
'use strict';

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

// ---------- ambience + language: SERVER-owned runtime settings (Aria edits them too, via talk_settings) ----
// 16 Nov: the mix levels and the call language used to be .env-only. They now live in /api/settings —
// this card shows and edits them, the server pushes `settings` whenever Aria changes one.
const talkSettingsUi = (() => {
  const on = $('amb-enabled'), bed = $('amb-bed'), typing = $('amb-typing'), hold = $('amb-hold'), trim = $('amb-trim'), lang = $('call-lang'), status = $('settings-status'), reset = $('settings-reset');
  if (!on || !lang) return { adopt() {}, load() {} };
  let langs = null, t = null, painting = false;
  const paint = (s) => {
    painting = true;
    on.checked = Boolean(s.ambience.enabled); bed.value = s.ambience.bedDb; typing.value = s.ambience.typingDb; hold.value = s.ambience.holdDb; trim.value = s.ambience.webrtcTrimDb;
    if (s.languages && !langs) { langs = s.languages; lang.innerHTML = Object.entries(langs).map(([c, n]) => `<option value="${esc(c)}">${esc(n)} (${esc(c)})</option>`).join(''); }
    if (![...lang.options].some((o) => o.value === s.language.code)) lang.insertAdjacentHTML('beforeend', `<option value="${esc(s.language.code)}">${esc(s.language.code)}</option>`);
    lang.value = s.language.code;
    const over = [...(s.overridden?.ambience || []), ...(s.overridden?.language || [])];
    status.textContent = over.length ? `overriding .env: ${over.join(', ')} · applies from the next call` : 'defaults from .env · applies from the next call';
    status.className = 'hint';
    painting = false;
  };
  const push = async () => {
    if (painting) return;
    const body = { ambience: { enabled: on.checked, bedDb: bed.value, typingDb: typing.value, holdDb: hold.value, webrtcTrimDb: trim.value }, language: { code: lang.value } };
    try {
      const j = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (j.error) { status.textContent = j.error; status.className = 'hint warn'; return; }
      paint(j);
    } catch (err) { warn('saving Talk Settings', err); }
  };
  const later = () => { clearTimeout(t); t = setTimeout(push, 500); };
  for (const el of [bed, typing, hold, trim]) el.addEventListener('input', later);
  on.addEventListener('change', push); lang.addEventListener('change', push);
  reset?.addEventListener('click', async () => { try { paint(await (await fetch('/api/settings', { method: 'DELETE' })).json()); } catch (err) { warn('resetting Talk Settings', err); } });
  return {
    adopt(s) { if (s && s.ambience && s.language) paint(s); },
    async load() { try { paint(await (await fetch('/api/settings')).json()); } catch (err) { warn('loading Talk Settings', err); } }
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
