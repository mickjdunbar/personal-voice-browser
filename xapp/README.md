# xApp bridge — build folder

Implements README-xapp.md (repo root). The Cognigy side lives in **na1 / project "Mick
Scratch"**: flow `PVB xApp Bridge` + endpoint `PVB xApp Bridge REST` (URL in `state.json`,
registered as chatbot `xapp` in `.chatbots.json`). The PVB side is `sops/SOP-011-xapp.md`
plus the console link-card + QR (public/app.js `buildLinkCards`, vendor/qrcode.js).

- `cognigy.py` — REST client (key from COGNIGY_API_KEY / xapp/.env / the capstone build/.env)
- `build.py` — creates/refreshes the flow + endpoint and bakes the endpoint URL into the page
- `page/xapp.html` — the generic spec-driven xApp page (Leaflet map_pin; new types switch on spec.type)
- `e2e.py` + `e2e-browser.mjs` — full loop test: create → open (headless Chromium) → OPENED →
  tap pin → confirm → RESULT. Run after any change: `python build.py && python e2e.py`
- `probe.py` / `probe-browser.mjs` — the step-0 verification (xApp submit on a REST session
  works; its throwaway flow/endpoint have been deleted from the project)

## Protocol (what the agent sends the `xapp` bot)

    xapp create {"type":"map_pin","title":..,"prompt":..,"center":{"lat":..,"lng":..},"zoom":13}
      -> LINK <url>   (or ERROR <why>)
    xapp status
      -> PENDING | OPENED | RESULT {"kind":"result","lat":..,"lng":..,"address":".."} | NONE

The page pings `xapp opened` OUT-OF-BAND (fetch to the REST endpoint with the session's own
userId/sessionId) because any SDK.submit makes the xApp shell tear the page down; the final
result IS an SDK.submit, and the flow answers it by rendering a static done page.

## Flow-building gotchas (hard-won)

- Node types: `setHTMLAppState` (not showXAppHtml), `initAppSession`, `getAppSessionPin`.
- Branch content hangs off the then/else node's **next** pointer: create with
  `mode:"append"`, target = the then/else node id. `appendChild` makes a chart child the
  runtime silently never executes (flow runs, no output, no error).
- The whole html is CognigyScript-interpolated at the create turn: `{{input.sessionId}}`,
  `{{input.userId}}` resolve; never write a literal `{{` otherwise.
- `input.apps.url` only exists on the turn that ran initAppSession — stash it in context.
- New endpoints: `ensure_rest_endpoint` never re-points flowId on an existing endpoint.
