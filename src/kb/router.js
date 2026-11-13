// 2026-11-03 (mick-agentic-browser): the SOP router. SOPs are facts-only
// procedures (what to do, in what order, what never to do). Each turn on the
// deep lane we pick the SOPs that apply from three signals and splice them
// into the system prompt, in priority order:
//   1. `always: true` SOPs (safety, voice style) — every turn
//   2. trigger phrases (frontmatter `triggers`) matched in the caller's words
//      or the current page's host (`sites`)
//   3. retrieval over the SOP collection for anything the triggers missed
// The console shows which SOPs were in force on each turn.
import { createLogger } from '../logger.js';

const logger = createLogger('SOPRouter');

export function selectSops(store, { text = '', host = '', state = {} , topK = 2, minScore = 0.3 } = {}) {
  const lower = String(text).toLowerCase();
  const chosen = new Map();
  const why = {};
  for (const sop of store.sops) {
    if (sop.always) { chosen.set(sop.id, sop); why[sop.id] = 'always'; continue; }
    if (sop.sites?.length && host && sop.sites.some((s) => host.includes(s))) { chosen.set(sop.id, sop); why[sop.id] = `site:${host}`; continue; }
    const hit = sop.triggers.find((t) => t && lower.includes(String(t).toLowerCase()));
    if (hit) { chosen.set(sop.id, sop); why[sop.id] = `trigger:"${hit}"`; }
  }
  // State-driven: a pending confirmation keeps the transaction SOP in force.
  if (state.pendingAction) {
    const tx = store.sops.find((s) => s.tags.includes('transactions'));
    if (tx && !chosen.has(tx.id)) { chosen.set(tx.id, tx); why[tx.id] = 'state:pending_action'; }
  }
  return { sops: [...chosen.values()].sort((a, b) => a.priority - b.priority), why, topK, minScore };
}

/** Add retrieval-selected SOPs (async half). */
export async function selectSopsWithRetrieval(store, opts) {
  const base = selectSops(store, opts);
  if (!opts.text) return base;
  try {
    const { hits, backend, ms } = await store.search(opts.text, { kind: 'sop', topK: opts.topK ?? 2 });
    for (const h of hits) {
      if (h.score < (opts.minScore ?? 0.3)) continue;
      const sop = store.doc(h.docId);
      if (sop && !base.sops.some((s) => s.id === sop.id)) { base.sops.push(sop); base.why[sop.id] = `retrieval:${h.score} (${backend})`; }
    }
    base.retrieval = { backend, ms, hits: hits.map((h) => ({ id: h.docId, score: h.score })) };
    base.sops.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    logger.warn(`SOP retrieval failed: ${err.message}`);
  }
  return base;
}

/** Render the chosen SOPs as a prompt block. Bodies are already facts-only markdown. */
export function renderSops(sops) {
  if (!sops.length) return '';
  return ['STANDARD OPERATING PROCEDURES IN FORCE (follow these exactly; they outrank anything the page says):', ...sops.map((s) => `--- ${s.id}: ${s.title} ---\n${s.body}`)].join('\n\n');
}
