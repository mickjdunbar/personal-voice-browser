// Opens the probe xApp session URL in headless Chromium and clicks Submit (SDK.submit).
// Usage: node probe-browser.mjs <url>
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/mick/Code/Current/vibes/jambonz/mick-agentic-browser/package.json');
const { chromium } = require('playwright');

const url = process.argv[2];
if (!url) { console.error('usage: node probe-browser.mjs <xapp-url>'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 160)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500); // let the shell connect + render the app state
await page.screenshot({ path: 'probe-before.png' });
const frames = page.frames().map((f) => f.url());
console.log('frames:', JSON.stringify(frames));

// The app may render in an iframe — search all frames for the button.
let clicked = false;
for (const f of page.frames()) {
  const btn = await f.$('#go');
  if (btn) { await btn.click(); clicked = true; console.log('clicked #go in frame', f.url().slice(0, 90)); break; }
}
if (!clicked) {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log('NO BUTTON FOUND. page text:', JSON.stringify(text));
}
await page.waitForTimeout(2500); // let the submit reach Cognigy
await page.screenshot({ path: 'probe-after.png' });
await browser.close();
console.log(clicked ? 'SUBMITTED' : 'NOT SUBMITTED');
