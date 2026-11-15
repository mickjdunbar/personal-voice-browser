#!/usr/bin/env node
// 16 Nov 2026 (mick-agentic-browser): the restart-safe dev runner — `npm run dev`.
//
// `node --watch` restarted the server the instant a file under src/ changed, which killed every
// live call, the IVR mapper and all task sessions mid-turn (15 Nov, several times). This runner
// watches the same files but asks the server first: while GET /api/busy says something is live,
// the restart is DEFERRED and retried every 5 s until the line is quiet. A crash still restarts
// after 1 s. Typing `rs` + Enter restarts now (if quiet); `rs!` restarts even when busy.
//
//   PORT          the server's port (default 3005)
//   DEV_WATCH     comma-separated dirs/files to watch (default src,.env)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PORT = process.env.PORT || 3005;
const WATCH = (process.env.DEV_WATCH || 'src,.env').split(',').map((s) => s.trim()).filter(Boolean);
const say = (m) => console.log(`\x1b[36m[dev]\x1b[0m ${m}`);

let child = null, exiting = false, restartWanted = false, debounce = null, deferTimer = null, lastWhy = '';

function start() {
  child = spawn(process.execPath, ['src/app.js'], { stdio: 'inherit', env: process.env });
  const pid = child.pid;
  say(`server started (pid ${pid})`);
  child.on('exit', (code, sig) => {
    child = null;
    if (exiting) return;
    if (restartWanted) { restartWanted = false; start(); return; }
    say(`server exited (${code ?? sig}) — restarting in 1 s`);
    setTimeout(start, 1000);
  });
}

async function busyReasons() {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/busy`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.busy ? j.reasons : null;
  } catch { return null; } // not up yet, or an older build without /api/busy: nothing to protect
}

async function restart(why, { force = false } = {}) {
  clearTimeout(deferTimer);
  const reasons = force ? null : await busyReasons();
  if (reasons) {
    if (why !== lastWhy) say(`change in ${why} — restart DEFERRED while: ${reasons.join(', ')} (type rs! to force)`);
    lastWhy = why;
    deferTimer = setTimeout(() => restart(why), 5000);
    return;
  }
  lastWhy = '';
  say(`${why} — restarting`);
  if (child) { restartWanted = true; child.kill(); } else start();
}

for (const target of WATCH) {
  if (!fs.existsSync(target)) continue;
  const dir = fs.statSync(target).isDirectory();
  try {
    fs.watch(target, { recursive: dir }, (_ev, file) => {
      const f = String(file || target);
      if (dir && !/\.(m?js|json)$/.test(f)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => restart(`change in ${dir ? path.join(target, f) : target}`), 300);
    });
    say(`watching ${target}${dir ? '/' : ''}`);
  } catch (err) { say(`cannot watch ${target}: ${err.message}`); }
}

if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd === 'rs') restart('manual restart');
    else if (cmd === 'rs!') restart('forced restart', { force: true });
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { exiting = true; child?.kill(); setTimeout(() => process.exit(0), 300); });

start();
