// Imports Google Contacts (via the Zapier gateway's raw People-API GET) into the FAQ
// knowledge base as one document, so the agent knows everyone's number/email instantly —
// no tool round-trips, works on every lane. Re-run any time to refresh:
//
//   node scripts/import-contacts.mjs
//
// Notes: pages of 25 keep each MCP result under the client's 12 KB content cap; the doc
// is saved through POST /api/kb/docs so Qdrant re-indexes immediately (server must be up).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
const { callMcpTool } = await import(new URL('../src/mcp/client.js', import.meta.url).href);

const FIELDS = 'names,phoneNumbers,emailAddresses,organizations';

async function rawGet(connectionId, querystring) {
  const r = await callMcpTool('zapier', 'execute_zapier_read_action', {
    selected_api: 'GoogleContactsCLIAPI',
    action: '_zap_raw_request',
    tool_name: 'google_contacts_make_api_get_request',
    ...(connectionId ? { connection_id: connectionId } : {}),
    params: { url: 'https://people.googleapis.com/v1/people/me/connections', querystring, fail_on_errors: 'true' }
  });
  if (r.error || r.isError) throw new Error(String(r.error || r.result).slice(0, 300));
  const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  return JSON.parse(raw).results?.[0]?.body || {}; // Zapier raw-request envelope: {results:[{status,headers,body}]}
}

// The gateway has several Google accounts connected; contacts usually live in ONE of them
// (the owner may have several Google accounts connected and only one holds the list). Probe each.
const list = await callMcpTool('zapier', 'list_zapier_connections', { selected_api: 'GoogleContactsCLIAPI' });
const conns = JSON.parse(typeof list.result === 'string' ? list.result : JSON.stringify(list.result)).connections || [];
let conn = null;
for (const c of conns) {
  const probe = await rawGet(c.id, { personFields: 'names', pageSize: '1' }).catch(() => ({}));
  const n = probe.totalItems ?? (probe.connections ? probe.connections.length : 0);
  console.log('probe', c.title, '→', n, 'contacts');
  if (n > 0 && !conn) conn = c;
}
if (!conn) { console.error('no Google account with contacts found'); process.exit(1); }
console.log('importing from', conn.title);

// One call, no pagination: Zapier's proxy mangles People-API page tokens ("Page token is
// invalid") and full responses blow the MCP client's 12 KB result cap — but Google's
// partial-response `fields` mask strips the per-person metadata, so hundreds of slim
// contact rows fit in a single page.
const SLIM = 'connections(names/displayName,phoneNumbers/canonicalForm,phoneNumbers/value,emailAddresses/value,organizations/name),totalItems';
const data = await rawGet(conn.id, { personFields: FIELDS, pageSize: '400', sortOrder: 'FIRST_NAME_ASCENDING', fields: SLIM });
const people = data.connections || [];
console.log(`fetched ${people.length} of ${data.totalItems ?? '?'} contacts in one page`);

const line = (p) => {
  const name = p.names?.[0]?.displayName || '';
  const phones = (p.phoneNumbers || []).map((x) => x.canonicalForm || x.value).filter(Boolean);
  const emails = (p.emailAddresses || []).map((x) => x.value).filter(Boolean);
  const org = p.organizations?.[0]?.name || '';
  if (!name || (!phones.length && !emails.length)) return null;
  const bits = [];
  if (phones.length) bits.push('phone ' + phones.join(' / '));
  if (emails.length) bits.push('email ' + emails.join(' / '));
  if (org) bits.push(org);
  return `- **${name}** — ${bits.join(' · ')}`;
};
const rows = people.map(line).filter(Boolean).sort((a, b) => a.localeCompare(b));
console.log(`contacts with a name + reachable detail: ${rows.length} of ${people.length}`);

const body = [
  '# Mick\'s contacts (imported from Google Contacts)',
  '',
  'When the caller asks to call, text, or email someone by name, use the number or email here',
  'directly — no lookup needed. Numbers are E.164 where Google had them. Re-import with',
  '`node scripts/import-contacts.mjs`.',
  '',
  ...rows,
  ''
].join('\n');

const res = await fetch('http://127.0.0.1:3005/api/kb/docs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'knowledge', id: 'KB-contacts', title: "Mick's contacts — who to call, text, email", tags: 'contacts, phone numbers, email, people, call, text', body })
}).then((x) => x.json());
console.log('KB save:', JSON.stringify(res));
process.exit(res.error ? 1 : 0);
