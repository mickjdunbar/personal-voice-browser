#!/usr/bin/env node
// 2026-11-03 (mick-agentic-browser): export the SOPs + knowledge docs for the
// jambonz Agent Studio Knowledge page (Knowledge → <base> → Documents → Upload
// files: Markdown is accepted, 20 MB each). Studio's Knowledge is used by
// cascaded-pipeline / realtime agents (search_knowledge_base); a custom
// harness does its own retrieval (this app: Qdrant + BM25 over the same files),
// so the export keeps the two in step from one source.
//
//   node scripts/export-kb.mjs [--out dist/kb]
import fs from 'node:fs';
import path from 'node:path';
import { loadDocs } from '../src/kb/docs.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = path.resolve(opt('out', 'dist/kb'));
fs.mkdirSync(path.join(out, 'sops'), { recursive: true });
fs.mkdirSync(path.join(out, 'knowledge'), { recursive: true });
const sops = loadDocs('sops', 'sop');
const knowledge = loadDocs('knowledge', 'knowledge');
let facts = [];
for (const d of sops) {
  // Strip frontmatter; Studio indexes the body. Title line first so chunks carry it.
  fs.writeFileSync(path.join(out, 'sops', `${d.id}.md`), `# ${d.title}\n\n${d.body.replace(/^#\s.+\n/, '')}\n`);
  if (d.always) facts.push(`${d.id} ${d.title}: ${d.body.replace(/^#\s.+\n/, '').replace(/\s+/g, ' ').trim()}`);
}
for (const d of knowledge) fs.writeFileSync(path.join(out, 'knowledge', `${d.id}.md`), `# ${d.title}\n\n${d.body.replace(/^#\s.+\n/, '')}\n`);
// "Always-known facts" (≤ 4,000 chars) for the Studio pinned-facts box.
const pinned = facts.join('\n\n').slice(0, 3900);
fs.writeFileSync(path.join(out, 'always-known-facts.txt'), pinned);
fs.writeFileSync(path.join(out, 'README.md'), `# Knowledge export (${new Date().toISOString().slice(0, 10)})\n\n1. studio.jambonz.org → Knowledge → Create knowledge base (name: mick-agentic-browser, language English, an embedding key).\n2. Documents → Upload files → select everything in sops/ and knowledge/ (${sops.length + knowledge.length} markdown files).\n3. Always-known facts → paste always-known-facts.txt (${pinned.length} chars).\n4. Attach the knowledge base to any cascaded-pipeline agent. Custom-harness agents retrieve from this app's own index (Qdrant) instead.\n`);
console.log(`exported ${sops.length} SOPs + ${knowledge.length} knowledge docs to ${out} (pinned facts ${pinned.length} chars)`);
