// 2026-11-03 (mick-agentic-browser): the browsing tools the deep lane can
// call, in OpenAI function shape, and the executor that runs them against a
// BrowserTab. Every tool returns a compact result plus the fresh page state,
// so the model never acts on a stale view.
//
// Sensitive clicks (place order, pay, send, delete…) are gated: the first
// attempt returns needs_confirmation and the navigator asks the caller; the
// same click goes through only after the caller said yes (SOP-002).
import { config } from '../config.js';
import { getBrowser } from './browser.js';
import { geocode, pinUrls } from './geocode.js';

export const SENSITIVE_RX = /\b(place (your )?order|pay now|pay\b|buy now|complete (purchase|order|booking)|confirm (order|purchase|booking|payment)|checkout|check out|submit (order|payment)|book now|reserve|send|post|publish|delete|remove account|transfer|subscribe|sign up|create account)\b/i;

export const TOOL_DECLARATIONS = [
  tool('navigate', 'Open a web page by URL or domain (e.g. "ubereats.com", "https://www.abc.net.au/news"). Use this first when the caller names a site.', { url: { type: 'string', description: 'URL or bare domain' } }, ['url']),
  tool('web_search', 'Search the web for something the caller asked about when no site was named. Returns the results page.', { query: { type: 'string' } }, ['query']),
  tool('click', 'Click an element by its [ref] number from the current page state (links, buttons, tabs, menu items, result cards).', { ref: { type: 'integer', description: 'The [ref] number shown in the page state' }, confirmed: { type: 'boolean', description: 'true ONLY after the caller explicitly said yes to this exact action in their last turn' } }, ['ref']),
  tool('type_text', 'Type into an input, search box or text area by its [ref]; set submit true to press Enter afterwards (search boxes, forms).', { ref: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
  tool('select_option', 'Choose an option in a <select> dropdown by its visible label.', { ref: { type: 'integer' }, value: { type: 'string' } }, ['ref', 'value']),
  tool('scroll', 'Scroll the page to reveal more (down, up, top, bottom). The page state after scrolling shows what is now visible.', { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, ['direction']),
  tool('go_back', 'Go back to the previous page.', {}),
  tool('open_tab', 'Open a NEW browser tab (the current page stays open in its own tab) and switch to it. Give a URL to open there, or leave it out for a blank tab. Use when you need two pages at once — comparing sites side by side, keeping a cart/form/booking open while you check something else.', { url: { type: 'string', description: 'Optional URL or bare domain to open in the new tab' } }),
  tool('switch_tab', 'Switch to another open tab by its number from the OPEN TABS line in the page state. Everything you do next happens in that tab; the others stay as they are.', { tab: { type: 'integer', description: 'The tab number shown in OPEN TABS, e.g. 1' } }, ['tab']),
  tool('close_tab', 'Close an open tab by its number (the tab you are on when omitted). The view switches to a remaining tab.', { tab: { type: 'integer', description: 'The tab number to close; omit for the current tab' } }),
  tool('read_page', 'Read the main text of the current page. Call again to read the next part of a long page. Use for articles, descriptions, policies, prices.', { mode: { type: 'string', enum: ['current', 'next'], description: '"next" reads on from where the last read_page stopped' } }),
  tool('find_on_page', 'Scroll to the first occurrence of some text on the page (e.g. a dish name, "delivery fee", a heading).', { text: { type: 'string' } }, ['text']),
  tool('list_options', 'List the choices visible on the page (products, dishes, restaurants, search results, menu items) as cards, and show them on the caller\'s screen. Use before describing what is available.', { filter: { type: 'string', description: 'Optional word to filter the cards by' } }),
  tool('show_to_user', 'Put a short list of options or facts you worked out on the caller\'s screen (title + items). Use when summarising choices or a comparison, so they can see while you talk.', { title: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, price: { type: 'string' }, ref: { type: 'integer' } }, required: ['title'] } } }, ['title', 'items']),
  // 13 Nov: DROP A PIN — the screen half of "where is it". Geocodes the place, opens a map with a
  // marker on the caller's Personal Voice Browser, and hands back a share link for texting.
  tool('drop_pin', 'DROP A PIN ON A MAP on the caller\'s Personal Voice Browser screen: put a marker on a place (a bar, venue, address, meeting point) so they can SEE where it is. Use it whenever a WHERE comes up — "where is it", "drop a pin", "show me on the map", a meeting spot, an address to share. Pass the place by name plus suburb/city (e.g. "Alfred & Constance, Fortitude Valley Brisbane"). The result includes a share_link (Google Maps) to send by text if the caller wants the location on their phone. After it succeeds, tell the caller ONCE that you have pulled it up on their Personal Voice Browser.', { place: { type: 'string', description: 'The place to pin: name and/or street address, with suburb and city' }, label: { type: 'string', description: 'Short label for the pin, e.g. the venue name (defaults to the place)' }, near: { type: 'string', description: 'Optional context to disambiguate, e.g. "Brisbane" or "near Rogue Bistro Newstead"' } }, ['place']),
  tool('press_key', 'Press a keyboard key (Enter, Escape, Tab, ArrowDown…).', { key: { type: 'string' } }, ['key']),
  tool('wait', 'Wait a moment for the page to finish loading or updating (1-5 seconds), then look again.', { seconds: { type: 'number' } }),
  tool('look', 'Take a fresh look at the current page state without acting (after the caller changed something themselves, or a page kept loading).', {})
];

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } } };
}

export const TOOL_NAMES = new Set(TOOL_DECLARATIONS.map((t) => t.function.name));

/** Spoken beat before a tool runs (the first in a turn), so the line never goes quiet. */
export const TOOL_FILLERS = {
  navigate: 'Opening that now.',
  web_search: 'Searching for that.',
  click: null,
  type_text: null,
  read_page: 'Let me read that.',
  list_options: 'Let me see what is here.',
  scroll: null,
  go_back: null
};

/**
 * Render a snapshot as the compact page state the model reads.
 * Kept under ~maxChars; elements first (that is what it acts on), then
 * headings, then a text excerpt.
 */
export function renderPageState(snap, { maxChars = config.browser.maxSnapshotChars } = {}) {
  if (!snap || snap.url === 'about:blank') return 'PAGE STATE: no page open yet (use navigate or web_search).';
  const lines = [`PAGE STATE: ${snap.title} — ${snap.url}`];
  if (snap.scrollMax > 0) lines.push(`scroll: ${Math.round((snap.scrollY / Math.max(1, snap.scrollMax)) * 100)}% of page`);
  if (snap.headings?.length) lines.push('HEADINGS: ' + snap.headings.slice(0, 20).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join(' | '));
  const els = (snap.elements || []);
  const vis = els.filter((e) => e.inView);
  const off = els.filter((e) => !e.inView);
  const fmt = (e) => {
    let s = `[${e.ref}] ${e.type}`;
    if (e.name) s += ` "${e.name}"`;
    if (e.href) s += ` → ${e.href}`;
    if (e.value) s += ` (value: ${e.value})`;
    if (e.checked !== undefined) s += e.checked ? ' [checked]' : ' [unchecked]';
    if (e.options) s += ` options: ${e.options.join('/')}`;
    if (e.disabled) s += ' (disabled)';
    return s;
  };
  lines.push('INTERACTIVE ELEMENTS (visible):', ...vis.map(fmt));
  if (off.length) lines.push(`BELOW THE FOLD (scroll to reach): ${off.slice(0, 40).map(fmt).join(' ; ')}`);
  if (snap.items?.length) lines.push('ITEMS/CARDS: ' + snap.items.slice(0, 16).map((i) => `${i.ref ? `[${i.ref}] ` : ''}${i.title}${i.price ? ` ${i.price}` : ''}`).join(' | '));
  let out = lines.join('\n');
  const room = maxChars - out.length - 20;
  if (room > 300 && snap.text) out += `\nTEXT (${snap.textOffset}-${snap.textOffset + Math.min(room, snap.text.length)} of ${snap.textTotal} chars):\n${snap.text.slice(0, room)}`;
  return out;
}

/**
 * Execute one tool against a tab.
 * @param {object} ctx { tab, state (Map), emit(type, data), log }
 * @returns {Promise<object>} JSON-able result incl. page_state text
 */
export async function executeBrowserTool(name, args = {}, ctx) {
  const { state, emit } = ctx;
  // `tab` is reassigned by the tab-management tools (open/switch/close), so the closing refresh
  // reports the page state of the tab the session is NOW on. The session id rides on the tab.
  let tab = ctx.tab;
  const session = ctx.session || tab?.sessionId || 'main';
  const t0 = Date.now();
  let result;
  const refresh = async () => {
    const snap = await tab.snapshot();
    tab.frame().catch(() => {});
    if (snap.items?.length) emit?.('browser.items', { url: snap.url, title: snap.title, items: snap.items.slice(0, 24) });
    return snap;
  };
  switch (name) {
    case 'navigate': result = await tab.navigate(args.url); break;
    case 'web_search': result = await tab.search(args.query); break;
    case 'click': {
      const el = await tab.elementByRef(args.ref);
      const label = el?.name || el?.title || '';
      const host = tab.host;
      const sensitive = SENSITIVE_RX.test(label) || (config.browser.blockedHosts.some((h) => host.includes(h)));
      if (sensitive) {
        const pending = state.get('pendingAction');
        const approved = state.get('approvedAction');
        const same = (a) => a && Number(a.ref) === Number(args.ref) && a.host === host;
        if (!same(approved)) {
          state.set('pendingAction', { ref: Number(args.ref), label, host, url: tab.url, at: Date.now() });
          emit?.('agent.confirmation', { label, host, ref: Number(args.ref) });
          result = { needs_confirmation: true, action: `click "${label}" on ${host}`, instruction: 'Read the caller exactly what you are about to do (item, amount, destination) and ask for a clear yes. Only after they say yes in their NEXT turn may you call click again with confirmed:true.' };
          break;
        }
        state.delete('approvedAction');
        state.delete('pendingAction');
        if (pending) emit?.('agent.confirmed', { label, host });
      }
      result = await tab.click(args.ref);
      break;
    }
    case 'type_text': {
      const el = await tab.elementByRef(args.ref);
      if (el && /password/i.test(el.type || '') ) { result = { blocked: true, reason: 'SOP-005: never type passwords. Ask the caller to sign in themselves in the browser window, then call look.' }; break; }
      result = await tab.type(args.ref, args.text, { submit: Boolean(args.submit) });
      break;
    }
    case 'select_option': result = await tab.select(args.ref, args.value); break;
    case 'scroll': result = await tab.scroll(args.direction || 'down'); break;
    case 'go_back': result = await tab.back(); break;
    case 'open_tab': {
      tab = await getBrowser().newTab(session, { url: args.url || '' });
      result = { ok: true, opened: tab.url && tab.url !== 'about:blank' ? tab.url : 'a blank tab', open_tabs: getBrowser().tabList(session).length };
      break;
    }
    case 'switch_tab': {
      tab = getBrowser().switchTab(session, args.tab);
      result = { ok: true, now_on: `tab ${Number(args.tab)}`, url: tab.url };
      break;
    }
    case 'close_tab': {
      tab = await getBrowser().closeTabAt(session, args.tab ?? null);
      if (!tab) return { ok: true, note: 'tab closed; no tab is open now', ms: Date.now() - t0 };
      result = { ok: true, closed: true, now_on: tab.url || 'a blank tab', open_tabs: getBrowser().tabList(session).length };
      break;
    }
    case 'press_key': result = await tab.press(args.key || 'Enter'); break;
    case 'wait': await tab.page.waitForTimeout(Math.min(5, Math.max(0.5, Number(args.seconds) || 1.5)) * 1000); result = { ok: true }; break;
    case 'find_on_page': result = await tab.find(args.text); break;
    case 'read_page': {
      const snap = args.mode === 'next' ? await tab.readMore() : await tab.snapshot({ textOffset: 0, maxChars: 6000 });
      tab.frame().catch(() => {});
      return { ok: true, title: snap.title, url: snap.url, text: snap.text, range: `${snap.textOffset}-${snap.textOffset + snap.text.length} of ${snap.textTotal}`, more: snap.textOffset + snap.text.length < snap.textTotal, ms: Date.now() - t0 };
    }
    case 'list_options': {
      const snap = await refresh();
      let items = snap.items || [];
      if (args.filter) { const f = String(args.filter).toLowerCase(); items = items.filter((i) => `${i.title} ${i.text}`.toLowerCase().includes(f)); }
      // Fallback when the card heuristic finds nothing: named links AND buttons — SPAs like
      // SevenRooms render their real choices (time slots, areas) as <button>s, not links.
      if (!items.length) items = (snap.elements || []).filter((e) => (e.type === 'link' || e.type === 'button') && e.name && e.name.length > 3).slice(0, 16).map((e) => ({ ref: e.ref, title: e.name, price: null, text: e.href || '' }));
      emit?.('browser.items', { url: snap.url, title: args.filter ? `${snap.title} (${args.filter})` : snap.title, items: items.slice(0, 24), explicit: true });
      return { ok: true, count: items.length, items: items.slice(0, 20).map((i) => ({ ref: i.ref, title: i.title, price: i.price, detail: i.text?.slice(0, 100) })), page_state: renderPageState(snap, { maxChars: 2500 }), ms: Date.now() - t0 };
    }
    case 'show_to_user': {
      const items = Array.isArray(args.items) ? args.items.slice(0, 24) : [];
      emit?.('agent.show', { title: args.title || 'Options', items });
      return { ok: true, shown: items.length, ms: Date.now() - t0 };
    }
    case 'look': result = { ok: true }; break;
    case 'drop_pin': {
      const place = String(args.place || '').trim();
      if (!place) return { error: 'place is required — the name and/or address to pin, with suburb and city' };
      const hit = await geocode(place, args.near || '');
      if (!hit) return { error: `could not find "${place}" on the map — try the street address, or the name plus suburb and city`, ms: Date.now() - t0 };
      const label = String(args.label || hit.name || place).trim().slice(0, 80);
      const urls = pinUrls(hit.lat, hit.lon);
      await tab.navigate(urls.osm);
      // OpenStreetMap paints its tiles after load and greets first-time visitors with a welcome
      // panel over the map: give the tiles a beat and clear the panel so the pin is what's seen.
      await tab.page.waitForTimeout(1800).catch(() => {});
      await tab.page.evaluate(() => { for (const sel of ['.welcome', '#banner', '.donate-attr', '.sidebar-close-controls']) document.querySelectorAll(sel).forEach((el) => el.remove()); }).catch(() => {});
      tab.frame().catch(() => {});
      emit?.('map.pin', { label, place, address: hit.address, lat: hit.lat, lon: hit.lon, url: urls.osm, share_link: urls.maps, source: hit.source });
      result = {
        ok: true, pinned: label, address: hit.address, lat: hit.lat, lon: hit.lon, share_link: urls.maps,
        note: `The pin is on the map on the caller's Personal Voice Browser screen RIGHT NOW. Tell them so in ONE short line — e.g. "I've pulled that up on your Personal Voice Browser, the pin's on ${label}" — and give the address in words once; do not describe the map. If they want the location on their phone, text them share_link (that is the Google Maps link to send).`
      };
      break;
    }
    default: return { error: `unknown tool ${name}` };
  }
  const snap = await refresh();
  getBrowser().emitTabs(session); // titles fill in as pages get snapshotted; deduped inside
  const tabsLine = getBrowser().tabStateLine(session);
  return { ...result, ms: result?.ms ?? Date.now() - t0, page_state: (tabsLine ? tabsLine + '\n' : '') + renderPageState(snap) };
}
