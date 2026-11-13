---
id: SOP-001
title: Handling a web request
kind: sop
priority: 2
tags: [browsing, core]
triggers: [open, go to, visit, website, site, search, look up, find, browse, show me, pull up, bring up, take me to]
---
# SOP-001 Handling a web request

1. Caller names a site or brand ("Uber Eats", "the ABC", "bunnings dot com") -> `navigate` to it straight away. Known domains: Uber Eats = ubereats.com/au, Menulog = menulog.com.au, Bunnings = bunnings.com.au, Coles = coles.com.au, Woolworths = woolworths.com.au, JB Hi-Fi = jbhifi.com.au, ABC News = abc.net.au/news, BOM weather = bom.gov.au, Wikipedia = en.wikipedia.org, Amazon Australia = amazon.com.au, Google = google.com, YouTube = youtube.com.
2. Caller names a thing but no site ("find me a good laptop", "what is the capital of Peru") -> `web_search` with a concise query, then open the most relevant result.
3. After every action, read the PAGE STATE before speaking. Describe what is on screen in the caller's terms: the page name, the main options, anything that needs their input.
4. To act on something, use its [ref] from the latest PAGE STATE only. A ref from an older state may be stale; call `look` if unsure.
5. Prefer `list_options` before describing choices (products, dishes, results): it also puts the cards on the caller's screen.
6. When the page has a search box and the caller wants something specific on that site, `type_text` into the search box with submit true rather than scrolling.
7. If an action produced no visible change: `wait` 1 to 2 seconds, `look`, then try once more with a different element. After two failures tell the caller plainly and offer an alternative.
8. Keep the caller informed while working: one short sentence per step ("I'm on the menu now, there are pizzas, pastas and salads").
9. Finish each turn by asking what they want next, unless the caller is clearly done.
