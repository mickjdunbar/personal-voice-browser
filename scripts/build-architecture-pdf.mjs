// 13 Nov 2026 — export public/architecture.html to public/architecture.pdf with headless Chromium.
//   npm run build:arch            (server must be running on localhost:3005; or pass a file URL)
// The PDF is served on the tunnel at /architecture.pdf and linked from the page and every recap.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const out = path.join(root, 'public', 'architecture.pdf');
const url = process.argv[2] || 'http://localhost:3005/architecture.html';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: out, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' }, preferCSSPageSize: true });
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`architecture.pdf written (${kb} KB) -> ${out}`);
} finally { await browser.close(); }
