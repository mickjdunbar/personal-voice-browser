// 2026-11-03 (mick-agentic-browser): the in-page script that turns the DOM
// into something a language model can act on: numbered references for every
// interactive element, the headings, a text excerpt, and "items" (repeated
// card-like things: products, dishes, search results) for the console cards.
// Runs inside page.evaluate(); must stay self-contained (no imports).
export const SNAPSHOT_SCRIPT = `(opts) => {
  const maxChars = opts.maxChars || 9000;
  const W = window.innerWidth, H = window.innerHeight;
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const inView = (r) => r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const name = (el) => {
    const aria = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText);
    if (aria) return clean(aria).slice(0, 120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      const lbl = id ? id.innerText : el.closest('label')?.innerText;
      return clean(lbl || el.placeholder || el.name || el.title || el.value).slice(0, 120);
    }
    const img = el.querySelector('img[alt]');
    const t = clean(el.innerText || el.textContent || el.title || (img && img.alt) || el.value);
    return t.slice(0, 120);
  };
  // Stable refs across snapshots of the same document.
  if (!window.__mab) window.__mab = { next: 1 };
  const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=combobox], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const els = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > H * 4) continue; // far below the fold: ignore until scrolled
    let ref = Number(el.getAttribute('data-mab-ref'));
    if (!ref) { ref = window.__mab.next++; el.setAttribute('data-mab-ref', String(ref)); }
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.getAttribute('role') || 'button');
    const n = name(el);
    if (!n && type !== 'text' && type !== 'search' && type !== 'textarea' && type !== 'email' && type !== 'password' && type !== 'number' && type !== 'tel') continue;
    const item = { ref, type, name: n, inView: inView(r), y: Math.round(r.top + window.scrollY) };
    if (tag === 'a') { try { const u = new URL(el.href); item.href = (u.hostname.replace(/^www\\./, '') + u.pathname).slice(0, 80); } catch {} }
    if (tag === 'input' || tag === 'textarea') { if (el.value) item.value = clean(el.value).slice(0, 60); if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked; }
    if (tag === 'select') { const o = [...el.options].slice(0, 12).map((o) => o.text.trim()).filter(Boolean); item.options = o; item.value = el.options[el.selectedIndex]?.text; }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    els.push(item);
  }
  // Dedupe elements with identical type+name+href (menus repeat), keep first.
  const seen = new Set();
  const elements = els.filter((e) => { const k = e.type + '|' + e.name + '|' + (e.href || ''); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, opts.maxElements || 160);

  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(vis).map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText).slice(0, 120) })).filter((h) => h.text).slice(0, 40);
  const mainEl = document.querySelector('main, [role=main], article') || document.body;
  let text = clean(mainEl.innerText || '');
  if (text.length < 200) text = clean(document.body.innerText || '');
  const textTotal = text.length;
  text = text.slice(opts.textOffset || 0, (opts.textOffset || 0) + maxChars);

  // Items: repeated card-like blocks with a title and (often) a price.
  const PRICE = /(?:A?\\$|AUD|USD|€|£)\\s?\\d[\\d,]*(?:\\.\\d{2})?/;
  const cands = [...document.querySelectorAll('li, article, [role=listitem], [data-testid*="item" i], [data-testid*="card" i], [data-testid*="result" i], [class*="card" i], [class*="result" i], [class*="product" i], [class*="store" i], [class*="item" i]')].filter(vis);
  const items = [];
  const usedText = new Set();
  for (const c of cands) {
    const r = c.getBoundingClientRect();
    if (r.height < 40 || r.height > 900 || r.width < 120) continue;
    const t = clean(c.innerText);
    if (t.length < 8 || t.length > 600) continue;
    if (c.querySelector('li, article, [role=listitem]') && c.querySelectorAll('li, article').length > 3) continue; // a container, not an item
    const titleEl = c.querySelector('h1, h2, h3, h4, h5') || c.querySelector('[class*="title" i], [class*="name" i], strong, b') || c.querySelector('a');
    const title = clean(titleEl ? titleEl.innerText : t.split('\\n')[0]).slice(0, 90);
    if (!title || usedText.has(title)) continue;
    const priceM = t.match(PRICE);
    const img = c.querySelector('img');
    const click = c.matches('a, button, [role=button], [role=link]') ? c : (c.querySelector('a[href], button, [role=button], [role=link]') || c.closest('a[href], button, [role=button]'));
    let ref = click ? Number(click.getAttribute('data-mab-ref')) : 0;
    if (click && !ref) { ref = window.__mab.next++; click.setAttribute('data-mab-ref', String(ref)); }
    usedText.add(title);
    items.push({ ref: ref || null, title, price: priceM ? priceM[0] : null, text: t.replace(title, '').slice(0, 160).trim(), image: img && img.src && /^https?:/.test(img.src) ? img.src : null, inView: inView(r) });
    if (items.length >= (opts.maxItems || 24)) break;
  }

  return {
    url: location.href, host: location.hostname.replace(/^www\\./, ''), title: clean(document.title).slice(0, 120),
    scrollY: Math.round(window.scrollY), scrollMax: Math.max(0, Math.round(document.documentElement.scrollHeight - H)), viewport: { w: W, h: H },
    headings, elements, text, textTotal, textOffset: opts.textOffset || 0, items
  };
}`;

/** Best-effort cookie-banner / modal dismissal (runs in page). */
export const DISMISS_SCRIPT = `() => {
  const RX = /^(accept( all)?( cookies)?|agree|i agree|got it|ok(ay)?|allow all|allow cookies|yes,? i agree|continue|close|no thanks|dismiss|not now|maybe later)$/i;
  const btns = [...document.querySelectorAll('button, [role=button], a')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  let clicked = [];
  for (const b of btns) {
    const t = (b.innerText || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (!RX.test(t)) continue;
    const dlg = b.closest('[role=dialog], [aria-modal=true], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="banner" i], [class*="modal" i], [class*="overlay" i]');
    if (!dlg) continue;
    b.click(); clicked.push(t);
    if (clicked.length >= 2) break;
  }
  return clicked;
}`;
