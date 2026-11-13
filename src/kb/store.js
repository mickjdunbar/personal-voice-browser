// 2026-11-03 (mick-agentic-browser): the knowledge store behind the harness.
//
//   documents  — sops/*.md (how the agent behaves) + knowledge/*.md (site
//                playbooks, FAQ, voice style), loaded and chunked at boot
//   vectors    — Qdrant (Cloud or local docker) when QDRANT_URL is set and
//                reachable, embeddings from Gemini via the OpenAI-compatible
//                /embeddings endpoint; one collection per kind
//   fallback   — an in-process index (BM25 lexical + cosine over the same
//                embeddings when available) so the agent still retrieves when
//                Qdrant is down or unconfigured
//
// search(query, {kind, topK, site}) returns ranked chunks with scores and the
// backend that answered, which the console shows under "Knowledge".
import fs from 'node:fs';
import { config } from '../config.js';
import { loadDocs } from './docs.js';
import { QdrantClient } from './qdrant.js';
import { embed } from '../llm/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('KB');
const EMBED_DIM = Number(process.env.KB_EMBEDDING_DIM || 768);

// --- BM25 ------------------------------------------------------------------
const STOP = new Set('a an the and or of to in on for with is are be this that it as at by from your you i me my we our they them do does how what which when where can will should would could please'.split(' '));
export const tokenize = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && w.length > 1);

class Bm25 {
  constructor(chunks) {
    this.chunks = chunks;
    this.docs = chunks.map((c) => tokenize(`${c.title} ${c.text}`));
    this.df = new Map();
    for (const d of this.docs) for (const w of new Set(d)) this.df.set(w, (this.df.get(w) || 0) + 1);
    this.avgLen = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
  }
  score(query, { k1 = 1.4, b = 0.75 } = {}) {
    const q = tokenize(query);
    const N = this.docs.length;
    const out = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const d = this.docs[i];
      const tf = new Map();
      for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
      let s = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(w) + 0.5) / (this.df.get(w) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avgLen));
      }
      out[i] = s;
    }
    return out;
  }
}

// --- embedding cache (.kb-cache.json, git-ignored) --------------------------
const CACHE_FILE = process.env.KB_CACHE_FILE || '.kb-cache.json';
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}
function loadCache() {
  try { const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); return { vectors: j.vectors || {} }; } catch { return { vectors: {} }; }
}
function saveCache(cache, liveKeys) {
  // Keep only vectors for chunks that still exist, so edits do not grow the file forever.
  const keep = new Set(liveKeys);
  const vectors = Object.fromEntries(Object.entries(cache.vectors).filter(([k]) => keep.has(k)));
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ saved_at: new Date().toISOString(), vectors })); } catch (err) { logger.debug(`cache not saved: ${err.message}`); }
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

export class KnowledgeStore {
  constructor({ sopsDir = config.kb.sopsDir, knowledgeDir = config.kb.knowledgeDir, memoryDir = config.kb.memoryDir, qdrant = null, useEmbeddings = config.kb.embeddings } = {}) {
    this.dirs = { sop: sopsDir, knowledge: knowledgeDir, memory: memoryDir };
    try { fs.mkdirSync(memoryDir, { recursive: true }); } catch { /* exists */ }
    this.sops = loadDocs(sopsDir, 'sop');
    this.knowledge = loadDocs(knowledgeDir, 'knowledge');
    this.memory = loadDocs(memoryDir, 'memory'); // long-term memory: self-learned + hand-edited
    this.docs = [...this.sops, ...this.knowledge, ...this.memory];
    this.chunks = this.docs.flatMap((d) => d.chunks);
    this.bm25 = new Bm25(this.chunks);
    this.vectors = new Map(); // chunk id -> embedding (fallback cosine)
    this.qdrant = qdrant || new QdrantClient({ url: process.env.QDRANT_URL || '', apiKey: process.env.QDRANT_API_KEY || '' });
    this.collections = { sop: process.env.QDRANT_SOPS_COLLECTION || 'mab_sops', knowledge: process.env.QDRANT_KNOWLEDGE_COLLECTION || 'mab_knowledge', memory: process.env.QDRANT_MEMORY_COLLECTION || 'mab_memory' };
    this.useEmbeddings = useEmbeddings;
    this.backend = 'bm25';
    this.ready = null;
    this.status = { qdrant: this.qdrant.configured ? 'connecting' : 'unconfigured', embeddings: useEmbeddings ? 'pending' : 'off', chunks: this.chunks.length, docs: this.docs.length };
  }

  doc(id) { return this.docs.find((d) => d.id === id) || null; }

  /** Index into Qdrant (and keep vectors locally for the fallback). Safe to call once at boot. */
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.useEmbeddings || !config.llm.apiKey) {
        this.status.embeddings = this.useEmbeddings ? 'no api key' : 'off';
        if (this.qdrant.configured) this.status.qdrant = 'skipped (embeddings off)';
        return this;
      }
      try {
        const t0 = Date.now();
        // On-disk cache keyed by chunk content: watch-mode restarts embed only what changed.
        const cache = loadCache();
        const keyOf = (c) => `${c.id}|${config.kb.embeddingModel}|${EMBED_DIM}|${hashText(`${c.title}\n${c.text}`)}`;
        const missing = this.chunks.filter((c) => !cache.vectors[keyOf(c)]);
        for (let i = 0; i < missing.length; i += 32) {
          const batch = missing.slice(i, i + 32);
          const e = await embed(batch.map((c) => `${c.title}\n${c.text}`), { dimensions: EMBED_DIM });
          batch.forEach((c, j) => { cache.vectors[keyOf(c)] = e[j]; });
        }
        for (const c of this.chunks) this.vectors.set(c.id, cache.vectors[keyOf(c)]);
        if (missing.length) saveCache(cache, this.chunks.map(keyOf));
        this.status.embeddings = `ok (${this.vectors.values().next().value?.length || 0}d, ${Date.now() - t0} ms, ${missing.length} embedded, ${this.chunks.length - missing.length} cached)`;
        this.backend = 'hybrid-local';
      } catch (err) {
        this.status.embeddings = `failed: ${err.message}`;
        logger.warn(`embeddings unavailable, lexical only: ${err.message}`);
        return this;
      }
      if (!this.qdrant.configured) { this.status.qdrant = 'unconfigured'; return this; }
      try {
        const dim = this.vectors.values().next().value.length;
        for (const kind of ['sop', 'knowledge', 'memory']) {
          const name = this.collections[kind];
          await this.qdrant.ensureCollection(name, { dim });
          const pts = this.chunks.filter((c) => c.kind === kind).map((c) => ({ id: c.id, vector: this.vectors.get(c.id), payload: { doc_id: c.docId, title: c.title, kind: c.kind, idx: c.idx, text: c.text } }));
          if (pts.length) await this.qdrant.upsert(name, pts);
        }
        const h = await this.qdrant.health();
        this.status.qdrant = `ok (${this.qdrant.base.replace(/^https?:\/\//, '')}; ${h.collections.filter((c) => Object.values(this.collections).includes(c)).join(', ')})`;
        this.backend = 'qdrant';
        logger.info(`Qdrant indexed ${this.chunks.length} chunks into ${Object.values(this.collections).join(' + ')}`);
      } catch (err) {
        this.status.qdrant = `unreachable: ${err.message.slice(0, 120)}`;
        logger.warn(`Qdrant unavailable, using the in-process index: ${err.message}`);
      }
      return this;
    })();
    return this.ready;
  }

  /**
   * Hybrid search. Lexical always runs (it is free); vectors are fused in when
   * present. Qdrant answers the vector half when it is the backend.
   * @returns {Promise<{hits:Array<{id, docId, title, kind, text, score, lexical, semantic}>, backend:string, ms:number}>}
   */
  async search(query, { kind, topK = config.kb.topK, site } = {}) {
    const t0 = Date.now();
    const lex = this.bm25.score(query);
    const maxLex = Math.max(1e-9, ...lex);
    const scores = new Map();
    this.chunks.forEach((c, i) => { if (!kind || c.kind === kind) scores.set(c.id, { lexical: lex[i] / maxLex, semantic: 0 }); });
    let backend = 'bm25';
    if (this.vectors.size) {
      let qv = null;
      try { qv = (await embed([query], { dimensions: EMBED_DIM }))[0]; } catch (err) { logger.debug(`query embedding failed: ${err.message}`); }
      if (qv) {
        if (this.backend === 'qdrant') {
          try {
            const kinds = kind ? [kind] : ['sop', 'knowledge', 'memory'];
            for (const k of kinds) {
              const hits = await this.qdrant.search(this.collections[k], qv, { limit: Math.max(topK * 2, 6) });
              for (const h of hits) { const s = scores.get(h.id); if (s) s.semantic = h.score; }
            }
            backend = 'qdrant+bm25';
          } catch (err) {
            logger.warn(`Qdrant search failed, local cosine: ${err.message}`);
            backend = 'local-cosine+bm25';
            for (const [id, s] of scores) s.semantic = cosine(qv, this.vectors.get(id));
          }
        } else {
          backend = 'local-cosine+bm25';
          for (const [id, s] of scores) s.semantic = cosine(qv, this.vectors.get(id));
        }
      }
    }
    const byId = new Map(this.chunks.map((c) => [c.id, c]));
    const hits = [...scores.entries()].map(([id, s]) => {
      const c = byId.get(id);
      const doc = this.doc(c.docId);
      let bonus = 0;
      if (site && doc?.sites?.some((h) => site.includes(h))) bonus += 0.25;
      const fused = (s.semantic ? 0.6 * s.semantic + 0.4 * s.lexical : s.lexical) + bonus;
      return { id, docId: c.docId, title: c.title, kind: c.kind, text: c.text, score: Math.round(fused * 1000) / 1000, lexical: Math.round(s.lexical * 100) / 100, semantic: Math.round(s.semantic * 100) / 100 };
    }).filter((h) => h.score > 0.05).sort((a, b) => b.score - a.score).slice(0, topK);
    return { hits, backend, ms: Date.now() - t0 };
  }

  /** Re-read the doc folders IN PLACE (every session holds this same instance) and re-index.
   * The on-disk embedding cache means only changed chunks are re-embedded. */
  async reload() {
    this.sops = loadDocs(this.dirs.sop, 'sop');
    this.knowledge = loadDocs(this.dirs.knowledge, 'knowledge');
    this.memory = loadDocs(this.dirs.memory, 'memory');
    this.docs = [...this.sops, ...this.knowledge, ...this.memory];
    this.chunks = this.docs.flatMap((d) => d.chunks);
    this.bm25 = new Bm25(this.chunks);
    this.vectors = new Map();
    this.status = { ...this.status, chunks: this.chunks.length, docs: this.docs.length };
    this.ready = null; // init() re-runs embedding + Qdrant upsert
    await this.init();
    return this;
  }

  /** Create or update one document: write the markdown file, clear its old Qdrant points
   * (chunk counts change on edit), reload. Returns {ok, doc} or {error}. */
  async saveDoc({ kind, id, title, body, triggers = [], tags = [], sites = [], priority, always = false, meta = null, by = 'api' } = {}) {
    if (!this.dirs[kind]) return { error: `kind must be "sop", "knowledge" or "memory", got "${kind}"` };
    id = String(id || '').trim();
    if (!/^[A-Za-z0-9][\w-]{1,48}$/.test(id)) return { error: 'id must be 2-49 letters/digits/dashes (e.g. SOP-012, KB-shipping)' };
    if (!String(title || '').trim()) return { error: 'title is required' };
    if (!String(body || '').trim()) return { error: 'body is required' };
    const existing = this.docs.find((d) => d.id === id);
    if (existing && existing.kind !== kind) return { error: `id ${id} already exists in the other knowledge base` };
    const list = (a) => (Array.isArray(a) ? a : String(a || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    const fm = [`id: ${id}`, `title: ${String(title).trim()}`, `kind: ${kind}`];
    if (kind === 'sop') fm.push(`priority: ${Number.isFinite(Number(priority)) ? Number(priority) : 5}`);
    if (always) fm.push('always: true');
    if (list(tags).length) fm.push(`tags: [${list(tags).join(', ')}]`);
    if (kind === 'sop' && list(triggers).length) fm.push(`triggers: [${list(triggers).join(', ')}]`);
    if (list(sites).length) fm.push(`sites: [${list(sites).join(', ')}]`);
    // METADATA (13 Nov): every saved doc carries a one-line JSON `meta:` — version (bumps on every
    // save), created_at / updated_at, who created / last edited it (memorist | console | api), and a
    // revision history; memory docs keep their self-learning scorecard inside the same object (hand
    // edits in the drawer never lose it).
    const now = new Date().toISOString();
    const prev = existing?.meta || null;
    const changed = Boolean(existing) && (existing.body !== String(body).trim() || existing.title !== String(title).trim() || (existing.tags || []).join(',') !== list(tags).join(','));
    const history = [...(prev?.history || []), { version: (Number(prev?.version) || 0) + 1, at: now, by, change: existing ? (changed ? 'edited' : 'resaved') : 'created' }].slice(-20);
    const merged = {
      ...(prev || {}), ...(meta || {}),
      version: (Number(prev?.version) || 0) + 1,
      created_at: prev?.created_at || (existing ? fileBirth(`${this.dirs[kind]}/${existing.file}`) : null) || now,
      updated_at: now,
      created_by: prev?.created_by || (existing ? 'unknown' : by),
      updated_by: by,
      history
    };
    fm.push(`meta: ${JSON.stringify(merged)}`);
    const file = existing?.file || `${id}.md`;
    const full = `---\n${fm.join('\n')}\n---\n${String(body).trim()}\n`;
    fs.writeFileSync(`${this.dirs[kind]}/${file}`, full, 'utf8');
    if (this.backend === 'qdrant') await this.qdrant.deleteByDoc(this.collections[kind], id).catch((err) => logger.warn(`qdrant delete before upsert failed: ${err.message}`));
    await this.reload();
    logger.info(`KB ${existing ? 'updated' : 'created'} ${kind} ${id} (${file})`);
    return { ok: true, id, kind, file, created: !existing };
  }

  /** A memory was ARMED into a prompt / retrieved for a turn: bump used_count + last_used_at in place
   *  (file rewritten, no re-index — the chunks are unchanged). Debounced per doc so a busy session
   *  does not thrash the disk. */
  markUsed(ids = [], { session = '' } = {}) {
    for (const id of new Set(ids)) {
      const d = this.docs.find((x) => x.id === id && x.kind === 'memory');
      if (!d) continue;
      if (!d.meta) d.meta = {};
      d.meta.used_count = (Number(d.meta.used_count) || 0) + 1;
      d.meta.last_used_at = new Date().toISOString();
      if (session) d.meta.last_used_in = session;
      clearTimeout(this._usedTimers?.get(id));
      if (!this._usedTimers) this._usedTimers = new Map();
      this._usedTimers.set(id, setTimeout(() => this.rewriteFrontmatter(d).catch((err) => logger.debug(`markUsed write failed: ${err.message}`)), 3000));
    }
  }

  /** Rewrite a doc's file from its in-memory fields (frontmatter + body) without touching the index. */
  async rewriteFrontmatter(d) {
    const fm = [`id: ${d.id}`, `title: ${d.title}`, `kind: ${d.kind}`];
    if (d.kind === 'sop') fm.push(`priority: ${d.priority ?? 5}`);
    if (d.always) fm.push('always: true');
    if (d.tags?.length) fm.push(`tags: [${d.tags.join(', ')}]`);
    if (d.kind === 'sop' && d.triggers?.length) fm.push(`triggers: [${d.triggers.join(', ')}]`);
    if (d.sites?.length) fm.push(`sites: [${d.sites.join(', ')}]`);
    if (d.meta) fm.push(`meta: ${JSON.stringify(d.meta)}`);
    fs.writeFileSync(`${this.dirs[d.kind]}/${d.file}`, `---\n${fm.join('\n')}\n---\n${String(d.body).trim()}\n`, 'utf8');
  }

  /** Delete one document: remove the file and its Qdrant points, reload. */
  async removeDoc(kind, id) {
    const doc = this.docs.find((d) => d.id === id && (!kind || d.kind === kind));
    if (!doc) return { error: `no ${kind || ''} document with id ${id}` };
    try { fs.unlinkSync(`${this.dirs[doc.kind]}/${doc.file}`); } catch (err) { return { error: `could not delete file: ${err.message}` }; }
    if (this.backend === 'qdrant') await this.qdrant.deleteByDoc(this.collections[doc.kind], id).catch((err) => logger.warn(`qdrant delete failed: ${err.message}`));
    await this.reload();
    logger.info(`KB deleted ${doc.kind} ${id} (${doc.file})`);
    return { ok: true, id, kind: doc.kind };
  }
}

/** File creation time as ISO (for docs that predate the metadata block), or null. */
function fileBirth(file) {
  try { const st = fs.statSync(file); const t = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtime : st.mtime; return new Date(t).toISOString(); } catch { return null; }
}

let shared = null;
export function getStore() {
  if (!shared) shared = new KnowledgeStore();
  return shared;
}
