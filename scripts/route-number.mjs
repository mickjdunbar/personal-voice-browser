#!/usr/bin/env node
// 2026-11-03 (mick-agentic-browser): route a jambonz phone number to an
// application (default: the conductor app in .env), or print the routing.
//
//   node scripts/route-number.mjs                       # list numbers + apps
//   node scripts/route-number.mjs --number 61745188002 [--sid <application_sid>]
import 'dotenv/config';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = (process.env.JAMBONZ_API_BASE || 'https://api.jambonz.cloud').replace(/\/$/, '');
const H = { Authorization: `Bearer ${process.env.JAMBONZ_API_KEY}`, 'Content-Type': 'application/json' };
const api = async (method, path, body) => {
  const r = await fetch(`${base}/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};
const apps = await api('GET', `/Accounts/${process.env.JAMBONZ_ACCOUNT_SID}/Applications`);
const nums = await api('GET', '/PhoneNumbers');
const number = opt('number', '');
if (!number) {
  for (const n of nums) console.log(`+${n.number}  ->  ${apps.find((a) => a.application_sid === n.application_sid)?.name || '(unrouted)'}`);
  process.exit(0);
}
const sid = opt('sid', process.env.JAMBONZ_APPLICATION_SID);
const n = nums.find((x) => x.number === number.replace(/^\+/, ''));
if (!n) { console.error(`number ${number} not on this account`); process.exit(1); }
const before = apps.find((a) => a.application_sid === n.application_sid)?.name || '(unrouted)';
await api('PUT', `/PhoneNumbers/${n.phone_number_sid}`, { application_sid: sid });
console.log(`+${n.number}: ${before} -> ${apps.find((a) => a.application_sid === sid)?.name || sid}`);
