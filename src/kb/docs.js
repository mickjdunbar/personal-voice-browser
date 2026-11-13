// 2026-11-03 (mick-agentic-browser): SOP and knowledge documents are markdown
// files with YAML-ish frontmatter (id, title, kind, triggers, tags, priority).
// This module loads and chunks them. The same files are what the Studio
// Knowledge page would ingest (scripts/export-kb.mjs), so one source feeds
// both the harness's own retrieval and jambonz's.
import fs from 'node:fs';
import path from 'node:path';

/** Parse a tiny frontmatter block: key: value, and key: [a, b] lists. */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const t = v.trim();
    if (/^\[.*\]$/.test(t)) meta[k] = t.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (/^\d+(\.\d+)?$/.test(t)) meta[k] = Number(t);
    else if (/^(true|false)$/i.test(t)) meta[k] = /^true$/i.test(t);
    else meta[k] = t.replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

/** Split a markdown body into chunks by heading, keeping each under ~maxChars. */
export function chunkMarkdown(body, { maxChars = 1200 } = {}) {
  const sections = body.split(/\n(?=#{1,3}\s)/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sections) {
    if (s.length <= maxChars) { out.push(s); continue; }
    const paras = s.split(/\n\s*\n/);
    let cur = '';
    for (const p of paras) {
      if ((cur + '\n\n' + p).length > maxChars && cur) { out.push(cur.trim()); cur = p; }
      else cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/**
 * Load every *.md in a directory.
 * @returns {Array<{id, title, kind, triggers, tags, priority, body, file, chunks:[{id, text, idx}]}>}
 */
export function loadDocs(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const id = String(meta.id || path.basename(file, '.md'));
    const title = String(meta.title || (body.match(/^#\s+(.+)$/m) || [])[1] || id);
    const doc = {
      id,
      title,
      kind: meta.kind || kind,
      triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      priority: Number.isFinite(meta.priority) ? meta.priority : 5,
      always: Boolean(meta.always),
      sites: Array.isArray(meta.sites) ? meta.sites : [],
      // Long-term-memory scorecard: a one-line JSON object under the `meta:` frontmatter key
      // (learned_at, source, kind, novelty/utility/confidence, score, updates[]).
      meta: (() => { if (typeof meta.meta !== 'string' || !meta.meta.startsWith('{')) return null; try { return JSON.parse(meta.meta); } catch { return null; } })(),
      body: body.trim(),
      file
    };
    // 13 Nov: every MEMORY doc must carry metadata (version, timestamps, who). A doc written before
    // the block existed (or hand-dropped into memory/) gets defaults from the file's own timestamps —
    // in memory only; the next save persists them.
    if (doc.kind === 'memory') {
      let st = null; try { st = fs.statSync(path.join(dir, file)); } catch { /* fine */ }
      const birth = st ? new Date(st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString() : new Date().toISOString();
      const m = doc.meta || {};
      doc.meta = {
        ...m,
        version: Number.isFinite(Number(m.version)) && Number(m.version) > 0 ? Number(m.version) : Math.max(1, (m.updates?.length || 0)),
        created_at: m.created_at || m.learned_at || birth,
        updated_at: m.updated_at || m.updates?.at(-1)?.at || (st ? st.mtime.toISOString() : birth),
        created_by: m.created_by || (m.learned_at ? 'memorist' : 'unknown'),
        updated_by: m.updated_by || (m.updates?.length ? 'memorist' : 'unknown'),
        used_count: Number(m.used_count) || 0,
        history: Array.isArray(m.history) ? m.history : []
      };
    }
    doc.chunks = chunkMarkdown(doc.body).map((text, idx) => ({ id: `${id}#${idx}`, idx, text, docId: id, title, kind: doc.kind }));
    return doc;
  });
}
