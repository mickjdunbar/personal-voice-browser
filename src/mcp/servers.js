// 2026-11-06 (mick-agentic-browser): the MCP SERVER REGISTRY — the same shape as the chatbot
// registry (chat/bots.js). A configured server is a Streamable-HTTP MCP endpoint whose tools the
// team can call via the `use_mcp_tool` tool. Configured from the console (Talk Settings → MCP
// connections), persisted to .mcp-servers.json so it survives a restart. Secrets (bearer tokens /
// header keys) live only server-side; the console sees a redacted list with a `hasKey` flag.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('MCP');
const STORE = path.resolve(process.cwd(), '.mcp-servers.json');
const REDACTED = '••••••';

// Quick-add presets for the Add form (name + URL + auth), like the chatbot providers. These are
// not auto-enabled — the user picks one to pre-fill the form.
export const MCP_PRESETS = [
  { id: '', label: '— pick a preset, or enter your own below —' },
  { id: 'deepwiki', label: 'DeepWiki — ask questions about any public GitHub repo', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', note: 'Public, no key. Read docs for and ask questions about any public GitHub repository.' },
  // Messaging (#3 / #3b): the realistic way to reach Gmail, Outlook, Slack, Teams AND SMS from one
  // MCP server is a hosted aggregator that handles the per-app sign-ins for you — you connect the
  // apps once on their site, then paste the single personal MCP URL + token it gives you here.
  { id: 'zapier', label: 'Zapier MCP — Gmail, Outlook, Slack, Teams, SMS, Maps', url: '', auth: 'none', note: 'At mcp.zapier.com create a server and ADD ACTIONS for: Gmail (find/send/reply/draft), Outlook (find/send/reply), Microsoft Teams (send message), Slack (find/send message), Twilio or Zapier SMS (send text), and Google Maps (search places / directions). Zapier handles the sign-ins. Then paste the personal MCP URL it gives you. If the key is baked into the URL leave Auth = None; if Zapier shows a separate API key, switch Auth to Bearer and paste it. Hit Test — you should see the actions listed.' },
  { id: 'composio', label: 'Composio / Rube MCP — Gmail, Outlook, Slack, Teams, SMS', url: '', auth: 'bearer', note: 'Sign in at rube.app (Composio), connect Gmail / Outlook / Slack / Teams / Twilio, and paste the MCP URL + key it gives you. Alternative to Zapier.' },
  { id: 'twilio_sms', label: 'SMS / texts (Twilio) MCP', url: '', auth: 'bearer', note: 'For reading and sending text messages. Use a Twilio MCP server URL + token, or just enable SMS inside the Zapier/Composio preset above (simpler).' },
  { id: 'maps', label: 'Location / maps MCP (places, directions, “near me”)', url: '', auth: 'bearer', note: 'For places, directions and local lookups. Paste a maps/geolocation MCP URL (e.g. a Google Maps MCP) + key. Note: a server cannot read your phone’s GPS — this provides place/geo lookups, not live device location.' },
  { id: 'custom', label: 'Custom MCP server', url: '', auth: 'none', note: 'Any Streamable-HTTP MCP endpoint — the URL you would give an MCP client.' }
];

let registry = load();

// Cache of each server's advertised tool NAMES (filled by the client on first list/warm) so the
// agent's prompt can say what a server actually offers — e.g. that "zapier" can do Gmail — instead
// of the model guessing (and wrongly claiming it can't access email).
const toolNameCache = new Map(); // serverId -> { names: string[], at: number }
export function rememberTools(serverId, names) { if (serverId && Array.isArray(names)) toolNameCache.set(serverId, { names, at: Date.now() }); }
export function cachedToolNames(serverId) { const c = toolNameCache.get(serverId); return c ? c.names : null; }

// Some MCP servers are GATEWAYS: they don't expose one tool per capability, they expose a few
// meta-tools that reach a catalogue of the user's connected apps (Zapier is the prime example —
// inspect_zapier_actions / execute_zapier_write_action reach Gmail, Calendar, Twilio, …). For those
// the raw tool names are useless to the agent, so we cache the ENABLED APP NAMES instead and tell
// the model the right calling pattern.
const gatewayCache = new Map(); // serverId -> { kind: 'zapier', apps: string[], at: number }
export function rememberGateway(serverId, info) { if (serverId && info && info.kind) gatewayCache.set(serverId, { ...info, at: Date.now() }); }
export function cachedGateway(serverId) { return gatewayCache.get(serverId) || null; }
/** Is any connected server a Zapier-style gateway (by cached tool names or cached gateway info)? */
export function zapierGatewayPresent() {
  for (const s of registry) {
    if (cachedGateway(s.id)?.kind === 'zapier') return true;
    const names = cachedToolNames(s.id);
    if (names && names.includes('inspect_zapier_actions')) return true;
  }
  return false;
}

/** A plain-language line of connected servers and (if known) their tools/apps, for the agent prompt. */
export function mcpCapabilityText() {
  if (!registry.length) return '';
  return registry.map((s) => {
    const gw = cachedGateway(s.id);
    if (gw?.kind === 'zapier' && gw.apps?.length) return `${s.name || s.id} (Zapier gateway → reaches: ${gw.apps.slice(0, 20).join(', ')})`;
    const names = cachedToolNames(s.id);
    if (names && names.includes('inspect_zapier_actions')) return `${s.name || s.id} (Zapier gateway — call inspect_zapier_actions to see the connected apps)`;
    return names && names.length ? `${s.name || s.id} → ${names.slice(0, 30).join(', ')}` : `${s.name || s.id} (its tools load on first use — call list_mcp_tools)`;
  }).join('; ');
}

/** The calling recipe for Zapier-style gateways, appended to the MCP instruction when one is live. */
export const ZAPIER_RECIPE = [
  'A Zapier gateway is connected — it reaches the caller\'s real Gmail, Outlook, Google/Outlook Calendar, Google/Outlook Contacts, Slack, Teams and Twilio/SMS, but NOT as one tool each. It exposes meta-tools. To actually do email / SMS / calendar / contacts you MUST use this two-step pattern via use_mcp_tool on the zapier server:',
  '  1. DISCOVER: call tool "inspect_zapier_actions" (optionally arguments { "selected_api": "<app api id>" } or { "tool_name": "<action>" }) to get the exact action `key`, its `selected_api`, its `tool_name`, and the parameter schema. NEVER guess action keys — they are not intuitive and will fail.',
  '  2. EXECUTE: call tool "execute_zapier_read_action" for searches/lookups (find email, find event, find contact) or "execute_zapier_write_action" for sends/creates (send email, send SMS, create event), with arguments { "selected_api": "<from step 1>", "action": "<key from step 1>", "tool_name": "<from step 1>", "params": { …the action\'s fields… } }.',
  '  Example — text yourself: inspect_zapier_actions {selected_api:"TwilioCLIAPI"} → find the send-SMS action → execute_zapier_write_action {selected_api:"TwilioCLIAPI", action:"<key>", tool_name:"<tool_name>", params:{to, body}}. SMS always sends from +18558713724 (the server sets from_number itself — never pick a different sender, and never spend a round resolving the from_number enum).',
  '  SELF-CORRECT: if an execute call comes back with an error that includes a `params_schema`, a required field, or mentions a "dynamic enum" (e.g. a Calendar picker), the message tells you exactly what to add and how to resolve it — call inspect_zapier_actions again as it instructs, fill the fields, and retry. Do not give up after one error.',
  '  CONTACTS: the caller\'s full contact list (names, numbers, emails) is already in the knowledge base (doc KB-contacts) — when a contact appears in your REFERENCE KNOWLEDGE, use that number/email directly, no tool call. Never claim you have no contact list. Only if a name is missing there, use google_contacts_find_contact (params: search_by "Full Name", name) — and pass the connection_id of the owner\'s personal Google Contacts connection (get it via list_zapier_connections; the DEFAULT Google Contacts connection may be an empty account).',
  '  To resolve a person\'s number/email from a name, prefer the knowledge base as above. Never say you can\'t email/text/check the calendar when the Zapier gateway is connected — inspect first. Do not read internal selected_api values aloud to the caller.'
].join('\n');

function slug(s, i) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `mcp-${i}`; }

function normalize(s, i, existing = []) {
  if (!s || !s.url) return null;
  const id = s.id && String(s.id).trim() ? String(s.id).trim() : slug(s.name, i);
  const auth = ['none', 'bearer', 'key'].includes(s.auth) ? s.auth : 'none';
  const allow = Array.isArray(s.allow) ? s.allow.filter(Boolean)
    : (typeof s.allow === 'string' && s.allow.trim() ? s.allow.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const out = {
    id, name: s.name || id, url: String(s.url).trim(), auth,
    apiKey: s.apiKey || '', headerName: s.headerName || undefined,
    headers: (s.headers && typeof s.headers === 'object') ? s.headers : undefined,
    allow: allow && allow.length ? allow : undefined
  };
  if (!out.apiKey || out.apiKey === REDACTED) { const prev = existing.find((e) => e.id === id); out.apiKey = prev ? prev.apiKey : ''; }
  return out;
}

function load() {
  try {
    if (fs.existsSync(STORE)) {
      const arr = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      if (Array.isArray(arr)) return arr.map((s, i) => normalize(s, i)).filter(Boolean);
    }
  } catch (err) { logger.warn(`could not read ${STORE}: ${err.message}`); }
  // Seed one safe public default the first time, so there's a working example out of the box.
  if (process.env.MCP_SEED_DEFAULTS === '0') return [];
  const seed = [normalize({ id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' }, 0)].filter(Boolean);
  if (seed.length) { persist(seed); logger.info('seeded default MCP server: deepwiki'); }
  return seed;
}

function persist(list) {
  try { if (fs.existsSync(STORE)) fs.copyFileSync(STORE, STORE + '.bak'); } catch { /* best effort — the previous registry, for a manual undo */ }
  try { fs.writeFileSync(STORE, JSON.stringify(list, null, 2)); }
  catch (err) { logger.warn(`could not write ${STORE}: ${err.message}`); }
}

/** 16 Nov: raw copy of the registry (secrets included — in-memory only) so talk_settings can undo a change. */
export function snapshotServers() { return registry.map((x) => ({ ...x })); }
export function restoreServers(snap) { registry = Array.isArray(snap) ? snap.map((x) => ({ ...x })) : []; persist(registry); return listServers(); }

export function listServers() { return registry.map((s) => ({ id: s.id, name: s.name || s.id, url: s.url })); }
/** The list for the console — redacted secret, `hasKey` flag. */
export function publicServers() {
  return registry.map((s) => {
    const gw = cachedGateway(s.id);
    const names = cachedToolNames(s.id);
    return {
      id: s.id, name: s.name || s.id, url: s.url, auth: s.auth,
      hasKey: !!s.apiKey, apiKey: s.apiKey ? REDACTED : '', headerName: s.headerName || '',
      headers: s.headers || undefined, allow: s.allow || undefined,
      apps: gw?.apps || undefined, // Zapier-style gateway: the connected apps it reaches
      toolCount: names ? names.length : undefined
    };
  });
}
export function findServer(id) {
  return registry.find((s) => s.id === id || (s.name || '').toLowerCase() === String(id).toLowerCase()) || null;
}
export function setServers(list) {
  const prev = registry;
  const next = Array.isArray(list) ? list.map((s, i) => normalize(s, i, prev)).filter(Boolean) : [];
  const seen = new Map();
  for (const s of next) seen.set(s.id, s);
  registry = [...seen.values()];
  persist(registry);
  logger.info(`MCP servers updated from console: ${registry.map((s) => s.id).join(', ') || 'none'}`);
  return listServers();
}
export function presetMeta() { return MCP_PRESETS; }

/** The OpenAI-style tool declarations the agent gets when any MCP server is configured. */
export function mcpTools() {
  if (!registry.length) return [];
  const names = registry.map((s) => {
    const tn = cachedToolNames(s.id);
    return tn && tn.length ? `"${s.id}" (${s.name || s.id} — tools: ${tn.slice(0, 30).join(', ')})` : `"${s.id}" (${s.name || s.id})`;
  }).join('; ');
  const ids = registry.map((s) => s.id);
  return [
    {
      type: 'function',
      function: {
        name: 'list_mcp_tools',
        description: `List the tools an external MCP server offers, with their input schemas — call this BEFORE use_mcp_tool so you know the exact tool name and arguments. Configured MCP servers: ${names}.`,
        parameters: { type: 'object', properties: { server: { type: 'string', enum: ids, description: 'Which MCP server to inspect.' } }, required: ['server'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'use_mcp_tool',
        description: `Call a tool on an external MCP (Model Context Protocol) server and get its result back. Use list_mcp_tools first to discover the tool name and the arguments it expects. Configured MCP servers: ${names}.`,
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', enum: ids, description: 'Which MCP server.' },
            tool: { type: 'string', description: 'The tool name, exactly as list_mcp_tools reported it.' },
            arguments: { type: 'object', description: 'Arguments object for the tool, matching its input schema.' }
          },
          required: ['server', 'tool']
        }
      }
    }
  ];
}
