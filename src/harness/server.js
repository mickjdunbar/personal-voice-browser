// 2026-11-03 (mick-agentic-browser): WebSocket server for the jambonz
// custom-harness protocol, mounted on the shared HTTP server at /harness.
// One socket per call. Agent Studio custom-harness agents and our own
// conductor's agent verbs both land here.
import { WebSocketServer } from 'ws';
import { HarnessCall } from './call.js';
import { pickRole } from './roles/index.js';
import { config } from '../config.js';
import { bearerMatches, rejectUpgrade } from '../wsAuth.js';
import { createLogger } from '../logger.js';

export const HARNESS_SUBPROTOCOL = 'harness.jambonz.org';
export const HARNESS_PROTOCOL_VERSION = 1;
const logger = createLogger('HarnessServer');

export function createHarnessServer({ path = '/harness' } = {}) {
  const calls = new Map();
  const recent = [];
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(HARNESS_SUBPROTOCOL) ? HARNESS_SUBPROTOCOL : false) });

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) return false;
    if (config.harnessSecret && !bearerMatches(req.headers.authorization, config.harnessSecret)) {
      logger.warn(`harness connection rejected: bad or missing secret (has_auth=${Boolean(req.headers.authorization)})`);
      rejectUpgrade(socket, 401, 'Unauthorized');
      return true;
    }
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    if (!offered.includes(HARNESS_SUBPROTOCOL)) {
      logger.warn(`harness connection rejected: subprotocol not offered (${offered.join(',') || 'none'})`);
      rejectUpgrade(socket, 400, 'Bad Request');
      return true;
    }
    const hints = { role: url.searchParams.get('role') || '', session: url.searchParams.get('session') || '' };
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, hints));
    return true;
  }

  function onConnection(ws, hints) {
    let call = null;
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'session:start') {
        if (msg.protocol !== HARNESS_PROTOCOL_VERSION) { logger.warn(`unsupported protocol ${msg.protocol}; closing`); ws.close(4000, 'unsupported protocol'); return; }
        if (msg.resumed && calls.has(msg.call_sid)) { call = calls.get(msg.call_sid); call.ws = ws; call.log.info(`session resumed (last turn ${msg.last_turn_id ?? msg.turn_id})`); return; }
        const role = pickRole(msg, hints.role);
        const md = msg.metadata || {};
        const sessionId = hints.session || md.session || md.env_vars?.session || (md.mode === 'specialist' ? md.session || 'main' : 'main');
        call = new HarnessCall(ws, msg, role, { sessionId });
        calls.set(msg.call_sid, call);
        call.diag = { call_sid: msg.call_sid, role: role.name, session: sessionId, direction: msg.direction, from: msg.from, to: msg.to, started_at: new Date().toISOString(), startedMs: Date.now(), messages: [] };
        const toolNames = (msg.tools || []).map((t) => t.function?.name).filter(Boolean).join(',') || 'none';
        logger.info(`session start ${msg.call_sid} role=${role.name} session=${sessionId} dir=${msg.direction} from=${msg.from} to=${msg.to} studio_tools=${toolNames}`);
        try { await call.handlers.start?.(); } catch (err) { call.log.error(`start handler threw: ${err.message}`); }
        return;
      }
      if (!call) return;
      if (call.diag) {
        const d = { at: Date.now() - call.diag.startedMs, type: msg.type };
        if (msg.input) d.input = msg.input.type + (msg.input.text ? `: ${String(msg.input.text).slice(0, 80)}` : '');
        if (msg.name) d.name = msg.name;
        if (msg.reason) d.reason = msg.reason;
        call.diag.messages.push(d);
        if (call.diag.messages.length > 40) call.diag.messages.shift();
      }
      try { await call.handle(msg); } catch (err) { call.log.error(`handling ${msg.type} failed: ${err.stack || err.message}`); }
    });
    ws.on('close', (code, reason) => {
      if (!call) return;
      const mine = call;
      if (mine.diag) {
        recent.unshift({ ...mine.diag, closed: { code, reason: reason?.toString?.() || '' }, turns: mine.turns, ended_after_ms: Date.now() - mine.diag.startedMs });
        if (recent.length > 20) recent.length = 20;
        mine.diag = null;
      }
      setTimeout(() => {
        if (calls.get(mine.callSid) === mine && mine.ws === ws) { if (!mine.ended) mine.end({ reason: 'socket_closed' }); calls.delete(mine.callSid); }
      }, 10000).unref();
    });
    ws.on('error', (err) => logger.warn(`socket error: ${err.message}`));
  }

  const live = () => [...calls.values()].map((c) => ({ call_sid: c.callSid, role: c.roleName, session: c.sessionId, from: c.start.from, to: c.start.to, direction: c.start.direction, turns: c.turns, started_at: new Date(c.startedAt).toISOString() }));
  // Feed typed text into the live harness leg for a session as if the caller spoke it (reply spoken).
  const liveCallForSession = (sessionId) => [...calls.values()].find((c) => c.sessionId === sessionId && !c.ended) || null;
  const injectText = async (sessionId, text) => { const c = liveCallForSession(sessionId); return c ? c.injectText(text) : { ok: false, error: 'no live harness leg' }; };
  return { handleUpgrade, calls, live, recent: () => [...recent], liveCallForSession, injectText };
}
