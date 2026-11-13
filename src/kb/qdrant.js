// 2026-11-03 (mick-agentic-browser): minimal Qdrant REST client (no SDK).
// Works against Qdrant Cloud (QDRANT_URL + QDRANT_API_KEY) or a local
// `docker run -p 6333:6333 qdrant/qdrant`. Collections hold one point per
// chunk with the text and document metadata in the payload, so a hit is
// self-describing.
import { createLogger } from '../logger.js';

const logger = createLogger('Qdrant');

export class QdrantClient {
  constructor({ url, apiKey = '', timeoutMs = 8000 }) {
    this.base = String(url || '').replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.base); }

  async req(method, path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'api-key': this.apiKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) throw new Error(`qdrant ${method} ${path} -> ${res.status} ${(json && JSON.stringify(json.status || json)) || text.slice(0, 200)}`);
      return json?.result ?? json;
    } finally {
      clearTimeout(t);
    }
  }

  async health() {
    const r = await this.req('GET', '/collections');
    return { ok: true, collections: (r?.collections || []).map((c) => c.name) };
  }

  async ensureCollection(name, { dim, distance = 'Cosine' }) {
    try {
      const info = await this.req('GET', `/collections/${name}`);
      const have = info?.config?.params?.vectors?.size;
      if (have && have !== dim) {
        logger.warn(`collection ${name} has dim ${have}, want ${dim}: recreating`);
        await this.req('DELETE', `/collections/${name}`);
      } else return { created: false };
    } catch (err) {
      if (!/404|Not found|doesn't exist/i.test(err.message)) throw err;
    }
    await this.req('PUT', `/collections/${name}`, { vectors: { size: dim, distance } });
    return { created: true };
  }

  async upsert(name, points) {
    // Qdrant ids must be unsigned ints or UUIDs; derive a stable UUID-ish id from the chunk id.
    const body = { points: points.map((p) => ({ id: uuidFrom(p.id), vector: p.vector, payload: { chunk_id: p.id, ...p.payload } })) };
    return this.req('PUT', `/collections/${name}/points?wait=true`, body);
  }

  async search(name, vector, { limit = 5, filter } = {}) {
    const r = await this.req('POST', `/collections/${name}/points/search`, { vector, limit, with_payload: true, ...(filter ? { filter } : {}) });
    return (r || []).map((h) => ({ id: h.payload?.chunk_id, score: h.score, payload: h.payload }));
  }

  async count(name) {
    const r = await this.req('POST', `/collections/${name}/points/count`, { exact: true });
    return r?.count ?? 0;
  }

  /** Remove every chunk point of one document (edits change chunk counts, so upserts alone
   * would leave stale trailing chunks behind). */
  async deleteByDoc(name, docId) {
    return this.req('POST', `/collections/${name}/points/delete?wait=true`, { filter: { must: [{ key: 'doc_id', match: { value: docId } }] } });
  }
}

/** Deterministic UUID (v5-style layout, not RFC-exact) from any string. */
export function uuidFrom(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0xdeadbeef, h4 = 0x12345678;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ (c << 5), 3266489917) >>> 0;
    h4 = Math.imul(h4 + (c << 3), 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
