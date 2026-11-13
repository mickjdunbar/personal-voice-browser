// 2026-11-04 / 2026-11-06 (mick-agentic-browser): a bridge to EXTERNAL chatbots over
// REST, so the one browser can test a webchat/REST assistant (e.g. a Cognigy bot like the
// HIA helper, an ElevenLabs agent, a Vertex / CX Agent Studio agent) from a voice or text
// call, and carry information between channels — search something on the web, then put the
// answer to the bot, all in one call.
//
// The bot list is now configured from the console (Talk Settings → Chatbots), NOT the env.
// It is held in a runtime REGISTRY, persisted locally to .chatbots.json so it survives a
// restart. Secrets (api keys / bearer tokens) live only server-side and are never sent back
// to the browser — the console sees a redacted list and a `hasKey` flag. Each turn keeps a
// stable conversation id per (session, bot) so the bot holds its own state. How to talk to a
// given endpoint comes from its PROVIDER preset (providers.js).
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { getProvider, DEFAULT_PROVIDER, genericParts } from './providers.js';

const logger = createLogger('ChatBots');
const bySession = new Map(); // `${sessionId}:${botId}` -> conversationId
const STORE = path.resolve(process.cwd(), '.chatbots.json');
const REDACTED = '••••••';

let registry = load(); // [{ id, name, provider, url, apiKey, model?, headers?, bodyTemplate?, replyPath?, dropPattern?, textKey?, sessionKey?, userKey?, method?, languageCode?, classMethod? }]

function slug(s, i) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `bot-${i}`;
}

function normalize(b, i, existing = []) {
  if (!b || !b.url) return null;
  const id = b.id && String(b.id).trim() ? String(b.id).trim() : slug(b.name, i);
  const out = {
    id, name: b.name || id, provider: (b.provider && getProvider(b.provider) ? b.provider : DEFAULT_PROVIDER),
    url: String(b.url).trim(), apiKey: b.apiKey || '', method: b.method || undefined,
    model: b.model || undefined, headers: b.headers || undefined, bodyTemplate: b.bodyTemplate || undefined,
    replyPath: b.replyPath || undefined, dropPattern: b.dropPattern || undefined,
    textKey: b.textKey || undefined, sessionKey: b.sessionKey || undefined, userKey: b.userKey || undefined,
    languageCode: b.languageCode || undefined, classMethod: b.classMethod || undefined
  };
  // Keep an existing secret when the console sends the redaction placeholder (edit without re-typing the key).
  if (!out.apiKey || out.apiKey === REDACTED) { const prev = existing.find((e) => e.id === id); out.apiKey = prev ? prev.apiKey : ''; }
  return out;
}

function load() {
  // 1) a persisted store wins. 2) else a one-time migration from the legacy CHAT_BOTS env var
  // (older deployments) so nothing breaks the first time. We write the store either way.
  try {
    if (fs.existsSync(STORE)) {
      const arr = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      if (Array.isArray(arr)) {
        const bots = arr.map((b, i) => normalize(b, i)).filter(Boolean);
        logger.info(`loaded ${bots.length} chatbot(s) from ${path.basename(STORE)}: ${bots.map((b) => `${b.id}(${b.provider})`).join(', ') || 'none'}`);
        return bots;
      }
    }
  } catch (err) { logger.warn(`could not read ${STORE}: ${err.message}`); }
  let seeded = [];
  try {
    const env = JSON.parse(process.env.CHAT_BOTS || '[]');
    if (Array.isArray(env) && env.length) {
      // Legacy env bots had no `provider`; they were all Cognigy REST endpoints.
      seeded = env.map((b, i) => normalize({ provider: 'cognigy', ...b }, i)).filter(Boolean);
      logger.info(`migrated ${seeded.length} chatbot(s) from CHAT_BOTS env into ${path.basename(STORE)}`);
    }
  } catch { /* ignore bad env */ }
  if (seeded.length) persist(seeded);
  return seeded;
}

function persist(list) {
  try { fs.writeFileSync(STORE, JSON.stringify(list, null, 2)); }
  catch (err) { logger.warn(`could not write ${STORE}: ${err.message}`); }
}

export function listBots() {
  return registry.map((b) => ({ id: b.id, name: b.name || b.id, provider: b.provider }));
}
/** The list for the console — same as listBots but with a redacted secret so the UI can show "key set". */
export function publicBots() {
  return registry.map((b) => ({
    id: b.id, name: b.name || b.id, provider: b.provider, url: b.url, model: b.model || '',
    hasKey: !!b.apiKey, apiKey: b.apiKey ? REDACTED : '',
    headers: b.headers || undefined, bodyTemplate: b.bodyTemplate || undefined, replyPath: b.replyPath || undefined,
    dropPattern: b.dropPattern || undefined, textKey: b.textKey || undefined, sessionKey: b.sessionKey || undefined,
    userKey: b.userKey || undefined, method: b.method || undefined, languageCode: b.languageCode || undefined, classMethod: b.classMethod || undefined
  }));
}
export function findBot(id) {
  return registry.find((b) => b.id === id || (b.name || '').toLowerCase() === String(id).toLowerCase()) || null;
}

/** Replace the whole registry from the console. Preserves a secret when the placeholder is sent back. */
export function setBots(list) {
  const prev = registry;
  const next = Array.isArray(list) ? list.map((b, i) => normalize(b, i, prev)).filter(Boolean) : [];
  // Drop duplicate ids (last wins).
  const seen = new Map();
  for (const b of next) seen.set(b.id, b);
  registry = [...seen.values()];
  persist(registry);
  logger.info(`chatbots updated from console: ${registry.map((b) => `${b.id}(${b.provider})`).join(', ') || 'none'}`);
  return listBots();
}

/** The OpenAI-style tool declaration the agent gets when any bot is configured. */
export function chatBotTools() {
  const bots = registry;
  if (!bots.length) return [];
  return [{
    type: 'function',
    function: {
      name: 'ask_chatbot',
      description: `Send a message to an external chatbot/assistant and get its reply. Use it to answer the caller from that bot, or to carry something you found on the web INTO the bot (e.g. search a rule on the web, then ask the bot about it). Configured bots: ${bots.map((b) => `"${b.id}" (${b.name || b.id})`).join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          bot: { type: 'string', enum: bots.map((b) => b.id), description: 'Which bot to message.' },
          message: { type: 'string', description: 'The full message to send to the bot.' }
        },
        required: ['bot', 'message']
      }
    }
  }];
}

function fill(obj, vars) {
  if (typeof obj === 'string') return obj.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
  if (Array.isArray(obj)) return obj.map((v) => fill(v, vars));
  if (obj && typeof obj === 'object') { const o = {}; for (const k of Object.keys(obj)) o[k] = fill(obj[k], vars); return o; }
  return obj;
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Pull the reply out as an ORDERED list of text parts (every output of a multi-output bot). */
export function extractReplyParts(data, replyPath) {
  if (replyPath) { const v = get(data, replyPath); if (v != null) return (Array.isArray(v) ? v : [v]).map(String).filter((s) => s.trim()); }
  return genericParts(data);
}

/** A single reply string, dropping lines matched by `drop` (e.g. a bot's dev/debug output). */
export function extractReply(data, replyPath, drop) {
  let parts = extractReplyParts(data, replyPath);
  if (drop) { const re = drop instanceof RegExp ? drop : new RegExp(drop, 'i'); parts = parts.filter((p) => !re.test(p)); }
  return parts.join(' ').slice(0, 2000) || '(the bot returned no readable text)';
}

function buildHeaders(bot, provider) {
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  if (provider.auth === 'bearer' && bot.apiKey) h.authorization = `Bearer ${bot.apiKey}`;
  else if (provider.auth === 'key' && bot.apiKey && provider.authHeader) h[provider.authHeader.toLowerCase()] = bot.apiKey;
  return { ...h, ...(bot.headers || {}) };
}

export async function askChatBot(botId, sessionId, message) {
  const bot = findBot(botId);
  if (!bot) return { error: `no bot named "${botId}" is configured` };
  const provider = getProvider(bot.provider);
  const key = `${sessionId}:${bot.id}`;
  let convId = bySession.get(key);
  if (!convId) { convId = `mab-${sessionId}-${Math.random().toString(36).slice(2, 8)}`; bySession.set(key, convId); }
  const method = (bot.method || provider.method || 'POST').toUpperCase();
  const vars = { message, session: convId, user: convId };
  const url = fill(bot.url, vars);
  // A per-bot bodyTemplate always overrides the provider's body shape.
  const bodyObj = bot.bodyTemplate ? fill(bot.bodyTemplate, vars) : provider.body(bot, vars);
  const body = JSON.stringify(bodyObj);
  const headers = buildHeaders(bot, provider);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
    const raw = await res.text();
    let data; try { data = JSON.parse(raw); } catch { data = raw; }
    if (!res.ok) { logger.warn(`bot ${bot.id} (${bot.provider}) HTTP ${res.status}`); return { error: `bot "${bot.name || bot.id}" returned HTTP ${res.status}`, ms: Date.now() - t0 }; }
    // Provider-specific extraction, then the per-bot replyPath/drop overrides on top.
    let parts = bot.replyPath ? extractReplyParts(data, bot.replyPath) : provider.extract(data, bot);
    if (bot.dropPattern) { const re = new RegExp(bot.dropPattern, 'i'); parts = parts.filter((p) => !re.test(p)); }
    const reply = parts.join(' ').slice(0, 2000) || '(the bot returned no readable text)';
    return { bot: bot.id, name: bot.name || bot.id, reply, conversation_id: convId, ms: Date.now() - t0 };
  } catch (err) {
    logger.warn(`bot ${bot.id} failed: ${err.message}`);
    return { error: `could not reach bot "${bot.name || bot.id}": ${err.message}`, ms: Date.now() - t0 };
  }
}
