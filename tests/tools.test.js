// Browser tools against a fake tab: confirmation gate, password block, page-state rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBrowserTool, renderPageState, SENSITIVE_RX, TOOL_DECLARATIONS } from '../src/browser/tools.js';

function fakeTab(snap) {
  const calls = [];
  return {
    calls,
    url: snap.url, host: snap.host, last: snap,
    async snapshot() { return snap; },
    async frame() { return null; },
    async elementByRef(ref) { return snap.elements.find((e) => e.ref === ref) || null; },
    async click(ref) { calls.push(['click', ref]); return { ok: true, clicked: `ref ${ref}`, url: snap.url }; },
    async type(ref, text, o) { calls.push(['type', ref, text, o]); return { ok: true }; },
    async navigate(u) { calls.push(['navigate', u]); return { ok: true, url: u }; },
    page: { waitForTimeout: async () => {} }
  };
}
const snap = {
  url: 'https://www.ubereats.com/au/checkout', host: 'ubereats.com', title: 'Checkout', headings: [{ level: 1, text: 'Checkout' }],
  elements: [{ ref: 1, type: 'button', name: 'Place order', inView: true }, { ref: 2, type: 'password', name: 'Password', inView: true }, { ref: 3, type: 'link', name: 'Add more items', inView: true, href: 'ubereats.com/store' }],
  text: 'Subtotal $24.00 Delivery fee $4.99 Total $28.99', textTotal: 48, textOffset: 0, items: [{ ref: 3, title: 'Margherita', price: '$18.00', text: 'tomato, mozzarella' }], scrollY: 0, scrollMax: 0
};

test('sensitive click needs a confirmation first, then goes through once approved', async () => {
  const tab = fakeTab(snap); const state = new Map(); const events = [];
  const ctx = { tab, state, emit: (t, d) => events.push([t, d]) };
  const first = await executeBrowserTool('click', { ref: 1 }, ctx);
  assert.equal(first.needs_confirmation, true);
  assert.deepEqual(tab.calls, []);
  assert.equal(state.get('pendingAction').ref, 1);
  assert.ok(events.some(([t]) => t === 'agent.confirmation'));
  // model retries without the caller having said yes: still blocked
  const again = await executeBrowserTool('click', { ref: 1, confirmed: true }, ctx);
  assert.equal(again.needs_confirmation, true);
  // navigator marks approval after a "yes" turn
  state.set('approvedAction', state.get('pendingAction'));
  const ok = await executeBrowserTool('click', { ref: 1, confirmed: true }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(tab.calls, [['click', 1]]);
  assert.equal(state.has('pendingAction'), false);
  assert.ok(ok.page_state.includes('PAGE STATE: Checkout'));
});

test('non-sensitive click just clicks; password fields are never typed into', async () => {
  const tab = fakeTab(snap); const state = new Map();
  const r = await executeBrowserTool('click', { ref: 3 }, { tab, state, emit() {} });
  assert.equal(r.ok, true);
  const p = await executeBrowserTool('type_text', { ref: 2, text: 'hunter2' }, { tab, state, emit() {} });
  assert.equal(p.blocked, true);
  assert.ok(!tab.calls.some((c) => c[0] === 'type'));
});

test('renderPageState lists refs, items and text within budget', () => {
  const s = renderPageState(snap, { maxChars: 2000 });
  assert.ok(s.includes('[1] button "Place order"'));
  assert.ok(s.includes('ITEMS/CARDS: [3] Margherita $18.00'));
  assert.ok(s.includes('Total $28.99'));
  assert.ok(renderPageState(null).includes('no page open'));
});

test('SENSITIVE_RX and tool manifest', () => {
  assert.ok(SENSITIVE_RX.test('Place order'));
  assert.ok(SENSITIVE_RX.test('Buy now'));
  assert.ok(!SENSITIVE_RX.test('Add to cart'));
  assert.ok(TOOL_DECLARATIONS.every((t) => t.type === 'function' && /^[a-z_]+$/.test(t.function.name)));
});
