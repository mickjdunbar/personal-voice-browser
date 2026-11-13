// Knowledge store: frontmatter parsing, chunking, BM25 search, SOP routing (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, chunkMarkdown, loadDocs } from '../src/kb/docs.js';
import { KnowledgeStore, tokenize } from '../src/kb/store.js';
import { selectSops, renderSops } from '../src/kb/router.js';
import { uuidFrom } from '../src/kb/qdrant.js';

test('frontmatter: scalars, lists, booleans, numbers', () => {
  const { meta, body } = parseFrontmatter('---\nid: SOP-1\ntitle: Hello there\nalways: true\npriority: 2\ntriggers: [open, "go to", visit]\n---\n# Hello\nbody');
  assert.equal(meta.id, 'SOP-1');
  assert.equal(meta.title, 'Hello there');
  assert.equal(meta.always, true);
  assert.equal(meta.priority, 2);
  assert.deepEqual(meta.triggers, ['open', 'go to', 'visit']);
  assert.equal(body.trim(), '# Hello\nbody');
});

test('chunking splits on headings and caps long sections', () => {
  const long = '# A\n' + 'para one. '.repeat(80) + '\n\n' + 'para two. '.repeat(80) + '\n## B\nshort';
  const chunks = chunkMarkdown(long, { maxChars: 500 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 900));
  assert.ok(chunks.at(-1).startsWith('## B'));
});

test('repo SOPs load with ids, always flags and triggers', () => {
  const sops = loadDocs('sops', 'sop');
  assert.ok(sops.length >= 10);
  assert.ok(sops.some((s) => s.always));
  assert.ok(sops.find((s) => s.id === 'SOP-002').triggers.includes('checkout'));
});

test('BM25 finds the food-ordering SOP for an Uber Eats request', async () => {
  const store = new KnowledgeStore({ useEmbeddings: false });
  const { hits, backend } = await store.search('order a pizza from uber eats', { kind: 'sop', topK: 3 });
  assert.equal(backend, 'bm25');
  assert.equal(hits[0].docId, 'SOP-006');
});

test('SOP router: always + triggers + site + pending state', () => {
  const store = new KnowledgeStore({ useEmbeddings: false });
  const a = selectSops(store, { text: 'can you open uber eats and order me a pizza' });
  const ids = a.sops.map((s) => s.id);
  assert.ok(ids.includes('SOP-000') && ids.includes('SOP-009'), 'always SOPs');
  assert.ok(ids.includes('SOP-006'), 'trigger uber eats');
  assert.ok(ids.includes('SOP-002'), 'trigger order');
  assert.equal(a.why['SOP-000'], 'always');
  const b = selectSops(store, { text: 'what is on this page', host: 'www.ubereats.com' });
  assert.ok(b.sops.some((s) => s.id === 'SOP-006'), 'site match');
  const c = selectSops(store, { text: 'yes', state: { pendingAction: { ref: 3 } } });
  assert.ok(c.sops.some((s) => s.tags.includes('transactions')), 'pending confirmation keeps the transaction SOP');
  assert.ok(renderSops(c.sops).startsWith('STANDARD OPERATING PROCEDURES'));
});

test('tokenize drops stop words; uuidFrom is stable and uuid-shaped', () => {
  assert.deepEqual(tokenize('Open the Uber Eats site'), ['open', 'uber', 'eats', 'site']);
  assert.equal(uuidFrom('SOP-001#0'), uuidFrom('SOP-001#0'));
  assert.notEqual(uuidFrom('SOP-001#0'), uuidFrom('SOP-001#1'));
  assert.match(uuidFrom('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});
