#!/usr/bin/env node
// 2026-11-03 (mick-agentic-browser): ring a phone through the running server.
//   node scripts/call.mjs --to +61XXXXXXXXX [--mode hybrid|cascaded] [--session main] [--base http://localhost:3005]
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = opt('base', `http://localhost:${process.env.PORT || 3005}`);
const to = opt('to');
if (!to) { console.error('--to +E164 required'); process.exit(1); }
const r = await fetch(`${base}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, mode: opt('mode', 'hybrid'), session: opt('session', 'main') }) });
console.log(r.status, await r.text());
