// 2026-11-06 (mick-agentic-browser): a minimal MCP (Model Context Protocol) client over the
// Streamable-HTTP transport — just enough to initialise a session, list a server's tools and
// call one. It mirrors the chatbot bridge (chat/bots.js): the team gains an external server's
// tools without a code change, configured from the console (Talk Settings → MCP connections).
//
// Transport notes: we POST JSON-RPC 2.0 to the server's single endpoint with
// Accept: application/json, text/event-stream. The server may answer with a plain JSON body or
// an SSE stream; both are parsed. An `Mcp-Session-Id` returned on `initialize` is echoed on every
// later request. Sessions are cached per server id and torn down on any error so the next call
// re-initialises cleanly.
import { createLogger } from '../logger.js';
import { findServer, rememberTools, rememberGateway, cachedGateway } from './servers.js';

const logger = createLogger('MCP');
const PROTOCOL = '2025-06-18';
const REDACTED = '••••••';
const sessions = new Map(); // serverId -> { sessionId?, initialized? }
let idSeq = 0;

function authHeaders(server) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (server.auth === 'bearer' && server.apiKey && server.apiKey !== REDACTED) h.authorization = `Bearer ${server.apiKey}`;
  else if (server.auth === 'key' && server.apiKey && server.apiKey !== REDACTED) h[(server.headerName || 'x-api-key').toLowerCase()] = server.apiKey;
  return { ...h, ...(server.headers || {}) };
}

/** Parse a response that may be plain JSON or an SSE stream; return the JSON-RPC message. */
async function parseResponse(res) {
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (ct.includes('text/event-stream')) {
    const msgs = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m && m[1].trim()) { try { msgs.push(JSON.parse(m[1])); } catch { /* ignore keep-alives */ } }
    }
    return msgs.find((m) => m && (m.result !== undefined || m.error !== undefined)) || msgs.at(-1) || null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function send(server, sess, method, params, { notification = false } = {}) {
  const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  if (!notification) body.id = ++idSeq;
  const headers = authHeaders(server);
  if (sess.sessionId) headers['mcp-session-id'] = sess.sessionId;
  const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id'); if (sid) sess.sessionId = sid;
  if (notification) return null;
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}${t ? ` — ${t.slice(0, 160)}` : ''}`); }
  const msg = await parseResponse(res);
  if (msg && msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg ? msg.result : null;
}

async function ensureInit(server) {
  let sess = sessions.get(server.id);
  if (sess && sess.initialized) return sess;
  sess = sess || {}; sessions.set(server.id, sess);
  const result = await send(server, sess, 'initialize', {
    protocolVersion: PROTOCOL, capabilities: {},
    clientInfo: { name: 'mick-agentic-browser', version: '0.1.0' }
  });
  sess.initialized = true; sess.serverInfo = result?.serverInfo || null;
  try { await send(server, sess, 'notifications/initialized', {}, { notification: true }); } catch { /* best effort */ }
  return sess;
}

/** Flatten an MCP tool result's `content` array into a single string for the LLM. */
const MAX_CONTENT = 12000; // gateway catalogues (inspect_zapier_actions) and doc reads run long; keep enough for the model to use.
function flattenContent(r) {
  if (!r) return '';
  if (Array.isArray(r.content)) {
    return r.content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'resource' ? JSON.stringify(c.resource) : JSON.stringify(c)))
      .filter(Boolean).join('\n').slice(0, MAX_CONTENT);
  }
  if (r.structuredContent) return JSON.stringify(r.structuredContent).slice(0, MAX_CONTENT);
  return JSON.stringify(r).slice(0, MAX_CONTENT);
}

/** Best-effort: ask a Zapier gateway which apps the user has enabled, return their names. */
async function zapierApps(server, sess) {
  const r = await send(server, sess, 'tools/call', { name: 'inspect_zapier_actions', arguments: {} });
  const text = flattenContent(r);
  let data; try { data = JSON.parse(text); } catch { return null; }
  const apps = Array.isArray(data?.apps) ? data.apps.map((a) => a?.app).filter(Boolean) : [];
  return apps.length ? apps : null;
}

// --- core (take a resolved server object) -----------------------------------------
export async function listToolsFor(server) {
  if (!server?.url) return { error: 'this MCP server has no URL' };
  try {
    const sess = await ensureInit(server);
    const r = await send(server, sess, 'tools/list', {});
    let tools = (r?.tools || []).map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || t.input_schema || {} }));
    if (server.allow?.length) tools = tools.filter((t) => server.allow.includes(t.name));
    if (server.id && !/^probe-/.test(server.id)) rememberTools(server.id, tools.map((t) => t.name));
    // Zapier-style gateway: resolve the actual connected apps once, so the agent's prompt can say
    // "reaches Gmail, Calendar, Twilio…" instead of listing opaque meta-tools.
    let gateway = null;
    if (tools.some((t) => t.name === 'inspect_zapier_actions') && !cachedGateway(server.id)) {
      const apps = await zapierApps(server, sess).catch(() => null);
      if (apps) { gateway = { kind: 'zapier', apps }; if (server.id) rememberGateway(server.id, gateway); }
    } else if (cachedGateway(server.id)) gateway = cachedGateway(server.id);
    return { tools, serverInfo: sess.serverInfo, gateway };
  } catch (e) { sessions.delete(server.id); logger.warn(`${server.id} tools/list failed: ${e.message}`); return { error: e.message }; }
}

// The only SMS-capable sender on the Twilio account (the AU number +61341602511 is a landline
// range — Twilio refuses it, and the model kept picking it as the "local" choice). Enforced
// server-side so no model decision can route an SMS from a dead number.
const SMS_FROM = process.env.SMS_FROM || '+18558713724';

export async function callToolFor(server, toolName, args) {
  if (!server?.url) return { error: 'this MCP server has no URL' };
  if (server.allow?.length && !server.allow.includes(toolName)) return { error: `tool "${toolName}" is not allowed on this server` };
  if (toolName === 'execute_zapier_write_action' && args && (args.tool_name === 'twilio_send_sms' || (args.selected_api === 'TwilioCLIAPI' && /sms/i.test(String(args.action || ''))))) {
    args = { ...args, params: { ...(args.params || {}), from_number: SMS_FROM } };
    logger.info(`twilio SMS send: from_number forced to ${SMS_FROM}`);
  }
  try {
    const sess = await ensureInit(server);
    const r = await send(server, sess, 'tools/call', { name: toolName, arguments: args || {} });
    const result = flattenContent(r);
    logger.info(`${server.id} tools/call ${toolName}(${JSON.stringify(args || {}).slice(0, 160)}) -> ${r?.isError ? 'isError ' : ''}${String(result).slice(0, 200)}`);
    return { result, isError: !!r?.isError };
  } catch (e) { sessions.delete(server.id); logger.warn(`${server.id} tools/call ${toolName} failed: ${e.message}`); return { error: e.message }; }
}

// --- by id (resolve from the registry) --------------------------------------------
export async function listMcpTools(serverId) {
  const server = findServer(serverId);
  if (!server) return { error: `no MCP server named "${serverId}" is configured` };
  return listToolsFor(server);
}
export async function callMcpTool(serverId, toolName, args) {
  const server = findServer(serverId);
  if (!server) return { error: `no MCP server named "${serverId}" is configured` };
  return callToolFor(server, toolName, args);
}

/** Probe for the console's "Test" button: merge a typed config with any saved secret, then list. */
export async function probeServer(serverObj) {
  const saved = serverObj?.id ? findServer(serverObj.id) : null;
  const merged = { ...serverObj, id: serverObj?.id || `probe-${Date.now()}` };
  if ((!merged.apiKey || merged.apiKey === REDACTED) && saved) merged.apiKey = saved.apiKey;
  const r = await listToolsFor(merged);
  sessions.delete(merged.id);
  return r;
}
