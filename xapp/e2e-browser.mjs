// Drives the PVB map xApp page: open, wait for the map, tap the centre, wait for the
// address lookup, press Confirm. Usage: node e2e-browser.mjs <xapp-url>
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/mick/Code/Current/vibes/jambonz/mick-agentic-browser/package.json');
const { chromium } = require('playwright');

const url = process.argv[2];
if (!url) { console.error('usage: node e2e-browser.mjs <xapp-url>'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 414, height: 820 } });
page.on('console', (m) => { const t = m.text(); if (!/tile|favicon/i.test(t)) console.log('[page]', m.type(), t.slice(0, 140)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500); // shell connect + app render + opened ping

// the app renders in the shell's srcdoc iframe — find the frame that has our #map
let frame = null;
for (let i = 0; i < 20 && !frame; i++) {
  for (const f of page.frames()) {
    if (await f.$('#map').catch(() => null)) { frame = f; break; }
  }
  if (!frame) await page.waitForTimeout(500);
}
if (!frame) {
  console.log('NO APP FRAME. frames:', JSON.stringify(page.frames().map((f) => f.url())));
  await page.screenshot({ path: 'e2e-noframe.png' });
  process.exit(1);
}

await frame.waitForSelector('#map .leaflet-container, #map', { timeout: 15000 });
await page.waitForTimeout(2500); // tiles + leaflet init
await page.screenshot({ path: 'e2e-1-open.png' });
console.log('OPENED (screenshot e2e-1-open.png)');

// tap the middle of the map
const box = await (await frame.$('#map')).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
console.log('tapped map at centre');

// wait for the reverse geocode to land (addr gets .ready)
await frame.waitForSelector('.addr.ready', { timeout: 15000 }).catch(() => console.log('address lookup slow — continuing'));
const addr = await frame.$eval('#addr-text', (el) => el.textContent).catch(() => '');
console.log('address shown:', (addr || '').slice(0, 110));
await page.screenshot({ path: 'e2e-2-pinned.png' });

await frame.click('#go');
await page.waitForTimeout(3500); // submit reaches Cognigy; the flow re-renders the done page (old frame detaches)
let doneText = '';
for (const f of page.frames()) {
  doneText = await f.evaluate(() => document.body && document.body.innerText).catch(() => '') || doneText;
}
console.log(/got it/i.test(doneText) ? 'CONFIRMED (done page shown)' : `WARNING: done page not seen (text: ${JSON.stringify(doneText.slice(0, 80))})`);
await page.screenshot({ path: 'e2e-3-done.png' });
await browser.close();
