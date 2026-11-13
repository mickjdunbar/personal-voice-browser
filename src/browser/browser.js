// 2026-11-03 (mick-agentic-browser): Playwright-driven Chromium behind the
// agent. One persistent profile (log in to sites yourself in that window
// once; the agent reuses the cookies) and one tab per agent session.
//
// Every action ends with a fresh snapshot (numbered refs for the model) and a
// JPEG frame for the console, so what the caller hears, what the model sees
// and what the screen shows are the same thing at the same moment.
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { SNAPSHOT_SCRIPT, DISMISS_SCRIPT } from './snapshot.js';
import { emitEvent } from '../events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Browser');
const execFileP = promisify(execFile);

// A persistent profile can only be opened by ONE Chromium at a time. `node --watch` restarts
// (and on Windows a force-kill that no exit handler can catch) can leave the previous Chromium
// alive, holding the profile — the next launch then fails with "database is locked" / "cache
// Access is denied". This clears the stale singleton lock files and stops ONLY the Chromium still
// holding THIS profile dir (matched by the exact path, which the user's own Chrome never carries).
async function clearProfileLock(dir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
  try {
    if (process.platform === 'win32') {
      const like = dir.replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${like}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 });
    } else {
      await execFileP('pkill', ['-f', dir], { timeout: 8000 }).catch(() => {});
    }
  } catch (err) { logger.warn(`profile-lock cleanup: ${err.message.split('\n')[0]}`); }
}
// The in-page scripts are kept as source strings; Playwright needs real functions
// (a string is evaluated as an expression and a function is not serialisable).
const snapshotFn = new Function(`return (${SNAPSHOT_SCRIPT})`)();
const dismissFn = new Function(`return (${DISMISS_SCRIPT})`)();

let playwright = null;
async function pw() {
  if (!playwright) playwright = await import('playwright');
  return playwright;
}

export class Browser {
  constructor(opts = {}) {
    this.opts = { ...config.browser, ...opts };
    this.context = null;
    // 11 Nov: a session owns a GROUP of tabs (real multi-tab browsing), not one tab.
    // Exactly one tab per group is ACTIVE: it is what the console pane shows, what the
    // model's page state describes, and what every browsing tool acts on.
    this.groups = new Map(); // sessionId -> { tabs: [BrowserTab], active, listeners:Set, lastEmit }
    this.launching = null;
  }

  group(sessionId, create = true) {
    let g = this.groups.get(sessionId);
    if (!g && create) { g = { tabs: [], active: 0, listeners: new Set(), lastEmit: '' }; this.groups.set(sessionId, g); }
    return g || null;
  }

  async launch() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const { chromium } = await pw();
      const dir = path.resolve(this.opts.profileDir);
      // Hidden mode only applies to a headed browser (headless has no window to hide).
      const hidden = !this.opts.headless && this.opts.hidden;
      logger.info(`launching chromium (headless=${this.opts.headless}${hidden ? ', window hidden off-screen' : ''}) profile=${dir}`);
      // A headed window that is behind the console — or parked off-screen in hidden mode — returns
      // BLACK screenshots unless background throttling and occlusion handling are disabled. The
      // console IS the view, so keep the page rendering at full rate wherever its window sits.
      const args = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'];
      if (hidden) {
        const wx = process.env.BROWSER_WINDOW_X ? Number(process.env.BROWSER_WINDOW_X) : -32000;
        const wy = process.env.BROWSER_WINDOW_Y ? Number(process.env.BROWSER_WINDOW_Y) : -32000;
        args.push(`--window-position=${wx},${wy}`, `--window-size=${this.opts.viewport.width},${this.opts.viewport.height}`);
      }
      const options = { headless: this.opts.headless, viewport: this.opts.viewport, locale: 'en-AU', timezoneId: 'Australia/Melbourne', args, ignoreDefaultArgs: ['--enable-automation'] };
      // Retry past a profile left locked by an orphaned Chromium: clear it, then try again.
      for (let attempt = 1; ; attempt++) {
        try { this.context = await chromium.launchPersistentContext(dir, options); break; }
        catch (err) {
          if (attempt >= 3) { logger.error(`chromium launch failed after ${attempt} attempts: ${err.message.split('\n')[0]}`); throw err; }
          logger.warn(`chromium launch attempt ${attempt} failed (${err.message.split('\n')[0]}); clearing the profile lock and retrying`);
          await clearProfileLock(dir);
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      this.context.setDefaultTimeout(this.opts.navTimeoutMs);
      this.context.on('close', () => { logger.warn('browser context closed'); this.context = null; for (const g of this.groups.values()) { g.tabs = []; g.active = 0; } });
      return this.context;
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }

  /** The session's ACTIVE tab (created on first use — the old one-tab-per-session entry point). */
  async tab(sessionId = 'main') {
    const g = this.group(sessionId);
    const t = g.tabs[g.active];
    if (t && !t.page.isClosed()) return t;
    return this.newTab(sessionId, { reuseSpare: true });
  }

  /** Sync peek at the session's active tab (null when none is open yet). */
  activeTab(sessionId = 'main') {
    const g = this.groups.get(sessionId);
    const t = g?.tabs[g.active];
    return t && !t.page.isClosed() ? t : null;
  }

  /** Open another tab in the session's group and make it the active one. */
  async newTab(sessionId = 'main', { url = '', reuseSpare = false } = {}) {
    const g = this.group(sessionId);
    const ctx = await this.launch();
    // Reuse the profile's initial blank page for the very first tab; new pages after that.
    const spare = reuseSpare ? ctx.pages().find((p) => !p.__mabOwned && !p.isClosed()) : null;
    const page = spare || await ctx.newPage();
    page.__mabOwned = sessionId;
    const t = new BrowserTab(page, sessionId, this.opts);
    // Frames fan out to the group's listeners only while this tab is ACTIVE — the console pane
    // shows one view, and a background tab must never paint over it.
    t.onFrame((f) => { if (g.tabs[g.active] === t) for (const fn of g.listeners) { try { fn(f); } catch { /* ignore */ } } });
    page.on('close', () => this._detach(sessionId, t));
    g.tabs.push(t);
    g.active = g.tabs.length - 1;
    if (url) await t.navigate(String(url)).catch((err) => logger.warn(`new tab navigate failed: ${err.message.split('\n')[0]}`));
    this.emitTabs(sessionId);
    t.frame().catch(() => {});
    return t;
  }

  /** Make tab `index` (1-based) the active one. Throws when there is no such tab. */
  switchTab(sessionId, index) {
    const g = this.groups.get(sessionId);
    const i = Number(index) - 1;
    if (!g || !g.tabs[i]) throw new Error(`no tab ${index} (open tabs: 1-${g?.tabs.length || 0})`);
    g.active = i;
    this.emitTabs(sessionId);
    g.tabs[i].frame().catch(() => {});
    return g.tabs[i];
  }

  /** Close tab `index` (1-based; the active tab when omitted). The group always keeps at least
   *  one tab: closing the last one blanks it instead. Returns the tab now active. */
  async closeTabAt(sessionId, index) {
    const g = this.groups.get(sessionId);
    if (!g || !g.tabs.length) throw new Error('no tabs open');
    const i = index == null ? g.active : Number(index) - 1;
    const t = g.tabs[i];
    if (!t) throw new Error(`no tab ${index} (open tabs: 1-${g.tabs.length})`);
    if (g.tabs.length === 1) { await t.blank(); this.emitTabs(sessionId); return t; }
    await this._closePage(sessionId, t); // page 'close' → _detach fixes the active index + emits
    const active = g.tabs[g.active];
    active?.frame().catch(() => {});
    return active || null;
  }

  /** Drop a closed/closing tab out of its group and keep the active index sane. */
  _detach(sessionId, t) {
    const g = this.groups.get(sessionId);
    if (!g) return;
    const i = g.tabs.indexOf(t);
    if (i === -1) return;
    g.tabs.splice(i, 1);
    if (i < g.active) g.active -= 1;
    if (g.active >= g.tabs.length) g.active = Math.max(0, g.tabs.length - 1);
    this.emitTabs(sessionId);
  }

  /** Close one page — but never the LAST page of the persistent context (that can take Chromium
   *  down with it): the overall-last page is blanked and released for reuse instead. */
  async _closePage(sessionId, t) {
    try {
      if (t.page.isClosed()) { this._detach(sessionId, t); return; }
      const open = this.context?.pages().filter((p) => !p.isClosed()).length ?? 0;
      if (open <= 1) {
        t.page.__mabOwned = null;
        await t.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
        this._detach(sessionId, t);
      } else await t.page.close();
    } catch { /* ignore */ }
  }

  /** Close ALL of a session's tabs (worker/task cleanup — the session is gone). */
  async closeTab(sessionId) {
    const g = this.groups.get(sessionId);
    if (!g) return;
    this.groups.delete(sessionId);
    for (const t of [...g.tabs]) await this._closePage(sessionId, t);
  }

  /** Console Clear: back to ONE fresh blank tab. */
  async resetTabs(sessionId) {
    const g = this.groups.get(sessionId);
    if (!g || !g.tabs.length) return;
    const keep = g.tabs[g.active] || g.tabs[0];
    for (const t of [...g.tabs]) if (t !== keep) await this._closePage(sessionId, t);
    await keep.blank();
    this.emitTabs(sessionId);
  }

  /** Subscribe to the session's browser frames (only the ACTIVE tab's frames come through). */
  onFrame(sessionId, fn) {
    const g = this.group(sessionId);
    g.listeners.add(fn);
    return () => g.listeners.delete(fn);
  }

  /** The session's open tabs, 1-based, for the console strip and the model's page state. */
  tabList(sessionId) {
    const g = this.groups.get(sessionId);
    if (!g) return [];
    return g.tabs.map((t, i) => ({ index: i + 1, url: t.url, title: t.last?.title || '', active: i === g.active }));
  }

  /** Broadcast the tab list when it actually changed (titles fill in as pages are snapshotted). */
  emitTabs(sessionId) {
    const g = this.groups.get(sessionId);
    if (!g) return;
    const tabs = this.tabList(sessionId);
    const key = JSON.stringify(tabs);
    if (key === g.lastEmit) return;
    g.lastEmit = key;
    emitEvent('browser.tabs', sessionId, { tabs });
  }

  /** One line for the model: which tabs are open and which one it is on ('' with 0-1 tabs). */
  tabStateLine(sessionId) {
    const tabs = this.tabList(sessionId);
    if (tabs.length <= 1) return '';
    const row = tabs.map((t) => `[${t.index}]${t.active ? '*' : ''} ${t.title || (t.url && t.url !== 'about:blank' ? t.url : 'blank')}`).join(' | ');
    return `OPEN TABS: ${row}\n(* = the tab you are on; the page state below is THAT tab. Use switch_tab to work in another, close_tab when finished with one.)`;
  }

  async close() {
    try { await this.context?.close(); } catch { /* ignore */ }
    this.context = null;
    this.groups.clear();
  }

  get status() {
    return { running: Boolean(this.context), headless: this.opts.headless, hidden: !this.opts.headless && this.opts.hidden, tabs: [...this.groups.entries()].map(([id, g]) => (g.tabs.length > 1 ? `${id} (${g.tabs.length} tabs)` : id)), profile: path.resolve(this.opts.profileDir) };
  }
}

export class BrowserTab {
  constructor(page, sessionId, opts) {
    this.page = page;
    this.sessionId = sessionId;
    this.opts = opts;
    this.last = null; // last snapshot
    this.textOffset = 0;
    this.listeners = new Set(); // frame listeners
    this.busy = false;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) this.textOffset = 0; });
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get url() { try { return this.page.url(); } catch { return ''; } }
  get host() { try { return new URL(this.url).hostname.replace(/^www\./, ''); } catch { return ''; } }

  async settle(ms = 600) {
    try { await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* keep going */ }
    await this.page.waitForTimeout(ms);
  }

  async dismissOverlays() {
    try {
      const clicked = await this.page.evaluate(dismissFn);
      if (clicked.length) { logger.debug(`dismissed overlays: ${clicked.join(', ')}`); await this.page.waitForTimeout(300); }
      return clicked;
    } catch { return []; }
  }

  /** Fresh snapshot of the page for the model. */
  async snapshot({ textOffset = this.textOffset, maxChars = this.opts.maxSnapshotChars } = {}) {
    if (this.url === 'about:blank' || !this.url) {
      this.last = { url: 'about:blank', host: '', title: 'New tab', headings: [], elements: [], text: '', textTotal: 0, textOffset: 0, items: [], scrollY: 0, scrollMax: 0 };
      return this.last;
    }
    try {
      this.last = await this.page.evaluate(snapshotFn, { maxChars, textOffset, maxElements: 160, maxItems: 24 });
    } catch (err) {
      // Navigation mid-evaluate: wait and retry once.
      await this.settle(400);
      this.last = await this.page.evaluate(snapshotFn, { maxChars, textOffset, maxElements: 160, maxItems: 24 });
    }
    return this.last;
  }

  /** JPEG frame for the console (base64) — carries the page's scroll position so the console's
   *  scroll rail mirrors the REAL page (11 Nov: the rail replaced the scroll buttons). */
  async frame({ quality = this.opts.screenshotQuality } = {}) {
    try {
      const buf = await this.page.screenshot({ type: 'jpeg', quality, timeout: 4000 });
      const b64 = buf.toString('base64');
      const scroll = await this.page.evaluate(() => ({ y: window.scrollY || 0, max: Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight), vh: window.innerHeight || 1 })).catch(() => null);
      for (const fn of this.listeners) { try { fn({ sessionId: this.sessionId, url: this.url, title: this.last?.title || '', jpeg: b64, bytes: buf.length, scroll }); } catch { /* ignore */ } }
      return b64;
    } catch (err) {
      logger.debug(`screenshot failed: ${err.message}`);
      return null;
    }
  }

  // --- direct user control (console "Take control": the caller drives the real page themselves) ------
  // Coords arrive NORMALISED (0..1) from the console frame so they're resolution-independent; we scale
  // to the viewport. Lets the caller finish something the agent can't nail (e.g. a fiddly date picker).
  _px(nx, ny) {
    const { width = 1280, height = 800 } = this.opts.viewport || {};
    return { x: Math.max(0, Math.min(width - 1, Math.round(nx * width))), y: Math.max(0, Math.min(height - 1, Math.round(ny * height))) };
  }
  async userClick(nx, ny, { button = 'left', clicks = 1 } = {}) { const { x, y } = this._px(nx, ny); await this.page.mouse.click(x, y, { button, clickCount: clicks }); }
  async userMove(nx, ny) { const { x, y } = this._px(nx, ny); await this.page.mouse.move(x, y); }
  async userScroll(dy = 0) { await this.page.mouse.wheel(0, dy); }
  /** Jump to a fraction (0..1) of the page — the console's scroll rail. */
  async userScrollTo(frac = 0) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    await this.page.evaluate((fr) => window.scrollTo({ top: fr * Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight), behavior: 'instant' }), f);
  }
  async userType(text) { if (text) await this.page.keyboard.type(String(text), { delay: 8 }); }
  async userKey(key) { if (key) await this.page.keyboard.press(String(key)); }

  locator(ref) { return this.page.locator(`[data-mab-ref="${Number(ref)}"]`).first(); }

  async elementByRef(ref) {
    return (this.last?.elements || []).find((e) => e.ref === Number(ref)) || (this.last?.items || []).find((i) => i.ref === Number(ref)) || null;
  }

  // --- actions ---------------------------------------------------------------
  async navigate(url) {
    let u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`;
    const t0 = Date.now();
    try {
      await this.page.goto(u, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
    } catch (err) {
      if (!/Timeout/i.test(err.message)) throw err;
      logger.warn(`navigate ${u} timed out at domcontentloaded; continuing with what loaded`);
    }
    await this.settle(700);
    await this.dismissOverlays();
    // SPAs (SevenRooms, Squarespace menus…) paint well AFTER domcontentloaded: the frame taken
    // right after this return is often still white, and nothing refreshed it between tool calls —
    // the console stared at a blank pane while the page was actually fine (9 Nov). Catch the late
    // paint with a couple of trailing frames.
    for (const delay of [1500, 3500]) setTimeout(() => { this.frame().catch(() => {}); }, delay);
    return { ok: true, url: this.url, ms: Date.now() - t0 };
  }

  /** Back to a fresh tab (console Clear): drop the page AND the cached snapshot, then push a
   *  blank frame so every console watching this session sees the view reset too. */
  async blank() {
    try { await this.page.goto('about:blank', { timeout: 5000 }); } catch { /* ignore */ }
    this.textOffset = 0;
    this.last = null;
    this.frame().catch(() => {});
    return { ok: true, url: this.url };
  }

  async search(query) {
    const url = this.opts.searchUrl.replace('{q}', encodeURIComponent(query));
    return this.navigate(url);
  }

  async click(ref) {
    const el = await this.elementByRef(ref);
    const loc = this.locator(ref);
    if (!(await loc.count())) throw new Error(`no element with ref ${ref} on the current page (take a fresh look first)`);
    const t0 = Date.now();
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const popupP = this.page.context().waitForEvent('page', { timeout: 1500 }).catch(() => null);
    try {
      await loc.click({ timeout: 6000 });
    } catch (err) {
      // Overlays, sticky headers: fall back to a JS click.
      await loc.evaluate((e) => e.click()).catch(() => { throw err; });
    }
    const popup = await popupP;
    if (popup) {
      // A link opened a new tab: follow it in this session (one tab per session).
      await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      const url = popup.url();
      await popup.close().catch(() => {});
      if (url && url !== 'about:blank') await this.navigate(url);
    } else {
      await this.settle(700);
      await this.dismissOverlays();
    }
    return { ok: true, clicked: el ? `${el.type} "${el.name || el.title || ''}"` : `ref ${ref}`, url: this.url, ms: Date.now() - t0 };
  }

  async type(ref, text, { submit = false, clear = true } = {}) {
    const loc = this.locator(ref);
    if (!(await loc.count())) throw new Error(`no element with ref ${ref} on the current page`);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await loc.click({ timeout: 4000 }).catch(() => {});
    // fill() is instant and fires input events; pressSequentially only when a site needs real keystrokes.
    if (clear) await loc.fill(String(text), { timeout: 4000 }).catch(async () => { await loc.pressSequentially(String(text), { delay: 10, timeout: 8000 }); });
    else await loc.pressSequentially(String(text), { delay: 10, timeout: 8000 });
    if (submit) {
      await loc.press('Enter');
      await this.settle(900);
      await this.dismissOverlays();
    }
    return { ok: true, typed: String(text).slice(0, 80), submitted: submit, url: this.url };
  }

  async select(ref, value) {
    const loc = this.locator(ref);
    if (!(await loc.count())) throw new Error(`no element with ref ${ref} on the current page`);
    const v = String(value);
    try { await loc.selectOption({ label: v }, { timeout: 4000 }); }
    catch { await loc.selectOption(v, { timeout: 4000 }); }
    await this.settle(400);
    return { ok: true, selected: v };
  }

  async scroll(direction = 'down') {
    const h = this.last?.viewport?.h || this.opts.viewport.height;
    const map = { down: h * 0.8, up: -h * 0.8, top: -1e9, bottom: 1e9 };
    const dy = map[direction] ?? h * 0.8;
    const before = await this.page.evaluate(() => window.scrollY).catch(() => 0);
    await this.page.evaluate((d) => window.scrollBy({ top: d, behavior: 'instant' }), dy);
    const after = await this.page.evaluate(() => window.scrollY).catch(() => 0);
    if (after === before) {
      // The window didn't move — a PDF viewer or a page that scrolls an inner container, which
      // window.scrollBy can't reach. A wheel gesture at the viewport centre scrolls both.
      const vp = this.page.viewportSize() || this.opts.viewport;
      await this.page.mouse.move(vp.width / 2, vp.height / 2);
      await this.page.mouse.wheel(0, Math.max(-h, Math.min(h, dy))).catch(() => {});
    }
    await this.page.waitForTimeout(350);
    return { ok: true, direction };
  }

  async back() {
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs }).catch(() => {});
    await this.settle(500);
    return { ok: true, url: this.url };
  }

  async press(key) {
    await this.page.keyboard.press(String(key));
    await this.settle(400);
    return { ok: true, key };
  }

  async find(text) {
    const found = await this.page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const n = needle.toLowerCase();
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.toLowerCase().includes(n)) {
          const el = node.parentElement;
          el.scrollIntoView({ block: 'center' });
          return { found: true, context: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) };
        }
      }
      return { found: false };
    }, String(text));
    await this.page.waitForTimeout(300);
    return found;
  }

  /** Read on through a long page: advance the text window. */
  async readMore() {
    const total = this.last?.textTotal || 0;
    const next = (this.last?.textOffset || 0) + (this.last?.text?.length || 0);
    this.textOffset = next < total ? next : 0;
    return this.snapshot({ textOffset: this.textOffset });
  }
}

let shared = null;
export function getBrowser() {
  if (!shared) shared = new Browser();
  return shared;
}
