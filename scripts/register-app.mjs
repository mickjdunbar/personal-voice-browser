#!/usr/bin/env node
// 2026-11-03 (mick-agentic-browser): create or update the jambonz application
// that points at the conductor (wss://<PUBLIC_HOST>/ws?token=WS_SECRET).
// Idempotent on name. Prints the application_sid for .env JAMBONZ_APPLICATION_SID.
//
//   node scripts/register-app.mjs [--name mick-agentic-browser] [--host mick.au.ngrok.io]
//   node scripts/register-app.mjs --sid <application_sid> --host <host>     (hooks only)
import 'dotenv/config';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const name = opt('name', 'mick-agentic-browser');
const host = opt('host', process.env.PUBLIC_HOST);
const base = (process.env.JAMBONZ_API_BASE || 'https://api.jambonz.cloud').replace(/\/$/, '');
const key = process.env.JAMBONZ_API_KEY;
const acct = process.env.JAMBONZ_ACCOUNT_SID;
if (!key || !acct || !host) { console.error('need JAMBONZ_API_KEY, JAMBONZ_ACCOUNT_SID and PUBLIC_HOST (or --host)'); process.exit(1); }

const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const api = async (method, path, body) => {
  const r = await fetch(`${base}/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};

const token = opt('token', process.env.WS_SECRET || '');
const wsUrl = `wss://${host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
const sidOnly = opt('sid', '');
if (sidOnly) {
  const before = await api('GET', `/Applications/${sidOnly}`);
  await api('PUT', `/Applications/${sidOnly}`, { call_hook: { url: wsUrl, method: 'POST' }, call_status_hook: { url: wsUrl, method: 'POST' } });
  console.log(`updated application ${sidOnly} (${before?.name}) hooks -> ${wsUrl.replace(/token=.*/, 'token=…')}`);
  process.exit(0);
}
const apps = await api('GET', `/Accounts/${acct}/Applications`);
const existing = apps.find((a) => a.name === name);
const body = {
  name, account_sid: acct,
  call_hook: { url: wsUrl, method: 'POST' }, call_status_hook: { url: wsUrl, method: 'POST' },
  speech_synthesis_vendor: process.env.TTS_VENDOR || 'google', speech_synthesis_language: process.env.TTS_LANGUAGE || 'en-AU', speech_synthesis_voice: process.env.TTS_VOICE || 'en-AU-Chirp3-HD-Aoede',
  speech_recognizer_vendor: process.env.STT_VENDOR || 'google', speech_recognizer_language: process.env.STT_LANGUAGE || 'en-AU'
};
if (existing) {
  await api('PUT', `/Applications/${existing.application_sid}`, body);
  console.log(`updated application ${existing.application_sid} (${name}) -> ${wsUrl.replace(/token=.*/, 'token=…')}`);
  console.log(`JAMBONZ_APPLICATION_SID=${existing.application_sid}`);
} else {
  const created = await api('POST', '/Applications', body);
  console.log(`created application ${created.sid} (${name}) -> ${wsUrl.replace(/token=.*/, 'token=…')}`);
  console.log(`JAMBONZ_APPLICATION_SID=${created.sid}`);
}
