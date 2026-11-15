// node --test test/e2e/transcriptOrder.e2e.test.mjs — the console's Live transcript keeps SPOKEN order.
// Needs the server on :3005 (skipped otherwise) and Playwright's Chromium. Replays the exact event
// shape of a real call (late caller transcription, two Aria responses, the team's hand-off) through
// a shimmed WebSocket on a real timeline. No call is placed; the orb is never tapped.
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.PVB_URL || 'http://localhost:3005';
const up = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);

test('Live transcript: team → Aria (2nd) → caller → greeting, nothing glued, one caller bubble', { skip: !up && `no server at ${BASE}`, timeout: 60_000 }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.__sockets = [];
      const Shim = function (url, protos) { const ws = protos ? new Orig(url, protos) : new Orig(url); window.__sockets.push(ws); return ws; };
      Shim.prototype = Orig.prototype;
      Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      window.WebSocket = Shim;
      window.__fakeSeq = 9e8;
      window.__fake = (ev, lagMs = 0) => { const now = Date.now(); const ws = window.__sockets[0]; ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event: { seq: ++window.__fakeSeq, ts: new Date(now).toISOString(), at: now - lagMs, ...ev } }) })); };
    });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__sockets?.[0]?.readyState === 1, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    const callSid = 'e2e-' + Date.now();
    const result = await page.evaluate(async ({ callSid }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const HOST = { id: 'host', name: 'Aria', color: 'host' };
      const sid = 'main';
      window.__fake({ type: 's2s.transcript', sessionId: sid, callSid, role: 'assistant', delta: 'Hey hey! Aria here—what\'s the plan, mate?', text: 'Hey hey! Aria here—what\'s the plan, mate?', item: 'itemA', line: 0, agent: HOST });
      await sleep(2500);
      window.__fake({ type: 's2s.transcript', sessionId: sid, callSid, role: 'assistant', delta: 'Sure thing, let me check the storm situation for this arvo.', text: 'Sure thing, let me check the storm situation for this arvo.', item: 'itemB', line: 1, agent: HOST });
      await sleep(400);
      window.__fake({ type: 's2s.transcript', sessionId: sid, callSid, role: 'user', delta: 'Hey, can you check to see if there are any storms this afternoon?', text: 'Hey, can you check to see if there are any storms this afternoon?', item: 'itemU', line: 2, agent: null }, 1800);
      window.__fake({ type: 'caller.said', sessionId: sid, callSid, turn: 1, text: 'Hey, can you check to see if there are any storms this afternoon?', sentiment: { label: 'neutral', score: 0 }, via: 's2s' }, 1800);
      await sleep(200);
      window.__fake({ type: 's2s.transcript', sessionId: sid, callSid, role: 'assistant', delta: ' Give me a sec.', text: 'Sure thing, let me check the storm situation for this arvo. Give me a sec.', item: 'itemB', line: 1, agent: HOST }, 600);
      await sleep(200);
      window.__fake({ type: 'agent.said', sessionId: sid, turn: 2, text: 'BOM has no storm warnings for the area this afternoon.', lane: 'fast', team: true, agent: HOST, ttft_ms: 1782, total_ms: 7399, cost: 0.0043, cost_total: 0.06 });
      await sleep(150);
      const msgs = [...document.querySelectorAll('#transcript .msg')].slice(0, 4).map((m) => ({ cls: m.className, who: m.querySelector('.who')?.textContent || '', text: (m.querySelector('.bubble-text')?.textContent || '').slice(0, 80) }));
      return { msgs, callerBubbles: [...document.querySelectorAll('#transcript .msg.caller')].filter((m) => (m.dataset.line || '').startsWith(callSid)).length };
    }, { callSid });
    const [a, b, c, d] = result.msgs;
    assert.ok(a?.cls.includes('relay-team') && a.who === 'the team → Aria', `top should be the team hand-off: ${JSON.stringify(a)}`);
    assert.ok(b?.text.startsWith('Sure thing') && b.text.endsWith('Give me a sec.'), `2nd should be Aria's grown line: ${JSON.stringify(b)}`);
    assert.ok(c?.cls.includes('caller') && c.text.startsWith('Hey, can you check'), `3rd should be the caller: ${JSON.stringify(c)}`);
    assert.ok(d?.text.startsWith('Hey hey! Aria here') && !d.text.includes('Sure thing'), `4th should be the greeting alone: ${JSON.stringify(d)}`);
    assert.equal(result.callerBubbles, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
