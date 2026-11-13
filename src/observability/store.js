// 2026-11-03 (mick-agentic-browser): observability sink. Every turn record
// (lane, models, TTFT, tokens, tools, SOPs, knowledge hits, sentiment,
// harness_first_chunk_ms) and every session summary is written to Upstash
// Redis over its REST API (UPSTASH_REDIS_REST_URL + _TOKEN) so the numbers
// survive restarts and can be read by anything else (Huey, a dashboard).
// Without Upstash the same records are kept in memory (last 200 sessions).
//
// Keys:  mab:sessions            ZSET  sessionId -> startedAt (ms)
//        mab:session:{id}        HASH  summary fields (json values)
//        mab:turns:{id}          LIST  turn records (json), RPUSH
//        mab:metrics:daily:{day} HASH  counters (turns, deep, fast, s2s_swaps, tool_calls, errors), ttft_sum/n
import { createLogger } from '../logger.js';

const logger = createLogger('Observability');
const TTL_SECONDS = Number(process.env.OBS_TTL_SECONDS || 60 * 60 * 24 * 14);

export class UpstashRedis {
  constructor({ url = process.env.UPSTASH_REDIS_REST_URL || '', token = process.env.UPSTASH_REDIS_REST_TOKEN || '', timeoutMs = 4000 } = {}) {
    this.base = String(url).replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  get configured() { return Boolean(this.base && this.token); }
  /** One command: ['SET','k','v'] -> result. */
  async cmd(...args) { return (await this.pipeline([args]))[0]; }
  /** Many commands in one HTTP round trip. */
  async pipeline(cmds) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))),
        signal: ctl.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`upstash HTTP ${res.status} ${text.slice(0, 200)}`);
      const arr = JSON.parse(text);
      return arr.map((r) => { if (r.error) throw new Error(`upstash: ${r.error}`); return r.result; });
    } finally { clearTimeout(t); }
  }
}

export class ObservabilityStore {
  constructor({ redis = new UpstashRedis() } = {}) {
    this.redis = redis;
    this.mem = { sessions: new Map(), turns: new Map(), daily: new Map() };
    this.backend = redis.configured ? 'upstash' : 'memory';
    this.lastError = null;
  }

  async health() {
    if (!this.redis.configured) return { backend: 'memory', sessions: this.mem.sessions.size };
    try {
      const n = await this.redis.cmd('ZCARD', 'mab:sessions');
      this.backend = 'upstash';
      return { backend: 'upstash', sessions: n, host: this.redis.base.replace(/^https?:\/\//, '') };
    } catch (err) {
      this.lastError = err.message;
      this.backend = 'memory (upstash down)';
      return { backend: this.backend, error: err.message, sessions: this.mem.sessions.size };
    }
  }

  async sessionStart(id, summary) {
    const rec = { id, started_at: Date.now(), ...summary };
    this.mem.sessions.set(id, rec);
    this.mem.turns.set(id, []);
    if (this.mem.sessions.size > 200) this.mem.sessions.delete(this.mem.sessions.keys().next().value);
    await this.write([
      ['ZADD', 'mab:sessions', String(rec.started_at), id],
      ['HSET', `mab:session:${id}`, ...flat(rec)],
      ['EXPIRE', `mab:session:${id}`, String(TTL_SECONDS)]
    ]);
    return rec;
  }

  async sessionEnd(id, summary) {
    const rec = { ...(this.mem.sessions.get(id) || { id }), ended_at: Date.now(), ...summary };
    this.mem.sessions.set(id, rec);
    await this.write([['HSET', `mab:session:${id}`, ...flat(rec)]]);
    return rec;
  }

  async turn(id, record) {
    const rec = { at: Date.now(), ...record };
    const list = this.mem.turns.get(id) || [];
    list.push(rec);
    this.mem.turns.set(id, list);
    const day = new Date().toISOString().slice(0, 10);
    const incr = [['HINCRBY', `mab:metrics:daily:${day}`, 'turns', '1'], ['EXPIRE', `mab:metrics:daily:${day}`, String(TTL_SECONDS)]];
    if (rec.lane) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, `lane_${rec.lane}`, '1']);
    for (const mc of rec.model_calls || []) {
      if (Number.isFinite(mc.first_token_ms)) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, 'ttft_sum_ms', String(mc.first_token_ms)], ['HINCRBY', `mab:metrics:daily:${day}`, 'ttft_n', '1']);
      if (Number.isFinite(mc.input_tokens)) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, 'input_tokens', String(mc.input_tokens)]);
      if (Number.isFinite(mc.output_tokens)) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, 'output_tokens', String(mc.output_tokens)]);
    }
    if (rec.own_tools?.length) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, 'tool_calls', String(rec.own_tools.length)]);
    if (rec.flags?.includes('error')) incr.push(['HINCRBY', `mab:metrics:daily:${day}`, 'errors', '1']);
    const d = this.mem.daily.get(day) || {};
    d.turns = (d.turns || 0) + 1;
    this.mem.daily.set(day, d);
    await this.write([['RPUSH', `mab:turns:${id}`, JSON.stringify(rec)], ['EXPIRE', `mab:turns:${id}`, String(TTL_SECONDS)], ...incr]);
    return rec;
  }

  async event(id, type, data) {
    // Lightweight stream of notable events (lane swaps, errors) per session.
    await this.write([['RPUSH', `mab:events:${id}`, JSON.stringify({ at: Date.now(), type, ...data })], ['LTRIM', `mab:events:${id}`, '-300', '-1'], ['EXPIRE', `mab:events:${id}`, String(TTL_SECONDS)]]);
  }

  async recentSessions(limit = 20) {
    if (this.redis.configured && !this.lastError) {
      try {
        const ids = await this.redis.cmd('ZREVRANGE', 'mab:sessions', '0', String(limit - 1));
        if (!ids.length) return [];
        const rows = await this.redis.pipeline(ids.map((i) => ['HGETALL', `mab:session:${i}`]));
        return rows.map(unflat);
      } catch (err) { this.lastError = err.message; }
    }
    return [...this.mem.sessions.values()].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
  }

  async turns(id) {
    if (this.redis.configured && !this.lastError) {
      try { return (await this.redis.cmd('LRANGE', `mab:turns:${id}`, '0', '-1')).map((s) => JSON.parse(s)); } catch (err) { this.lastError = err.message; }
    }
    return this.mem.turns.get(id) || [];
  }

  async daily(day = new Date().toISOString().slice(0, 10)) {
    if (this.redis.configured && !this.lastError) {
      try { const h = unflat(await this.redis.cmd('HGETALL', `mab:metrics:daily:${day}`)); if (h.ttft_n) h.ttft_avg_ms = Math.round(h.ttft_sum_ms / h.ttft_n); return h; } catch (err) { this.lastError = err.message; }
    }
    return this.mem.daily.get(day) || {};
  }

  async write(cmds) {
    if (!this.redis.configured) return;
    try { await this.redis.pipeline(cmds); this.lastError = null; }
    catch (err) {
      if (this.lastError !== err.message) logger.warn(`upstash write failed (memory only until it recovers): ${err.message}`);
      this.lastError = err.message;
    }
  }
}

function flat(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) { if (v === undefined) continue; out.push(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  return out;
}
function unflat(h) {
  // Upstash returns HGETALL as a flat array [k, v, k, v] or an object depending on the client; handle both.
  const obj = Array.isArray(h) ? Object.fromEntries(h.reduce((acc, x, i, a) => (i % 2 === 0 ? [...acc, [x, a[i + 1]]] : acc), [])) : (h || {});
  const out = {};
  for (const [k, v] of Object.entries(obj)) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
  return out;
}

let shared = null;
export function getObservability() {
  if (!shared) shared = new ObservabilityStore();
  return shared;
}
