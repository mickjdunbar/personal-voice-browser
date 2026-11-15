# Personal Voice Browser

**Start here**

* **What it is and why** — [docs/architecture.pdf](docs/architecture.pdf) (also [as a page](docs/architecture.html)).
  The short version: an AI agent that, given a goal, works out which channel the other side
  actually exposes (web page, phone line, chat widget, text, or an MCP integration if one
  exists) and uses it at runtime — no integration defined at build time.
* **What a finished call looks like** — [docs/showcase-dinner-sorted-recap.html](docs/showcase-dinner-sorted-recap.html):
  a synthetic caller (Huey, over the PSTN) asks Aria to find dinner, Aria compares venues on the
  caller's screen, rings the restaurant in her own voice while the caller holds, relays the booking,
  passes a follow-up to the restaurant on the same open call, drops a pin, books the calendar,
  and keeps working on WhatsApp after the call. Both recordings are in the page.
* **Set it up and try it** — [docs/SETUP.md](docs/SETUP.md).
* **The showcase runsheet** — [RUNSHEET-dinner-sorted.md](RUNSHEET-dinner-sorted.md), including every
  take that went wrong and what was fixed.

The rest of this README is the engineering log, oldest at the top; some early details (Gemini
on the S2S lane) have since moved to OpenAI Realtime — `.env.example` is current.

---

# Mick Agentic Browser (engineering log)

Browse any website by **voice or text**. A jambonz **Agent Studio custom harness**
you run on localhost (behind ngrok), a Playwright-driven Chromium the agent acts
in, and a multimodal console that shows the live browser view, the option cards,
the real-time transcript, sentiment, the SOPs and knowledge in force, latency,
TTFT and the models on every turn.

Two agents, one voice, one call:

| Lane | What | Model / voice |
|---|---|---|
| **speech-to-speech** | greeting, small talk | Gemini Live `models/gemini-3.8-live`, voice *Aoede* |
| **pipeline** (custom harness) | anything on the web: open, search, read, click, fill, order | jambonz STT → this harness (fast lane `gemini-3.5-flash-lite`, deep lane `gemini-3.6-flash` + tools + SOP router + Qdrant retrieval + screenshot) → `en-AU-Chirp3-HD-Aoede` |

The conductor swaps lanes mid-call with `redirect`: the S2S model calls
`browse_for_caller(request)` → a bridge line in the same voice → the harness
runs the request (and keeps going while the caller keeps browsing) → when the
chat turns light again it emits `handback` → S2S resumes with a summary. Same
voice name on both sides, so the swap is inaudible.

## The team

The caller is on one call with a **collective of agents**, not a single bot. One agent speaks at
a time; all of them share the transcript and act on what they hear (`src/agent/team.js`):

| Agent | Role | Job |
|---|---|---|
| **Aria** | host (speech-to-speech) | greeting, chit-chat, keeping the line warm, introducing a specialist |
| **Nova** | web concierge | opens any site, searches, follows links — the generalist |
| **Remy** | shopping & orders | food delivery, retail, carts, checkout (read-back before buying) |
| **Sage** | research & reading | reads articles and news, compares, answers factual questions from the page |
| **Lumi** | local & weather | forecasts, opening hours, maps, anything nearby |

Each deep-lane turn is handed to the specialist whose domain fits the request (a specific domain
outranks the generalist; the choice is held for the whole turn so the caller is not passed around
mid-task). The console shows who has the floor, the roster with speaking/listening/idle status, and
labels every transcript bubble and event by agent. **Add an agent**: append one entry to
`SPECIALISTS` in `team.js` (a name, a `match` regex, `sites`, a `priority`, and an `instruction`);
nothing else changes, and it appears in the console automatically.

## Layout

```
src/app.js                  http server: console (/), /ui feed, /harness, /ws, /api/*
src/harness/                custom-harness protocol (harness.jambonz.org v1): server, call, roles/navigator
src/conductor/              jambonz WS application: google_s2s ⇄ agent(vendor harness) via redirect
src/agent/navigator.js      THE brain: lanes, SOP router, knowledge retrieval, tool loop, telemetry
src/agent/persona.js        navigator + S2S personas (same person)
src/browser/                Playwright wrapper, in-page snapshot (numbered refs, items/cards), tools
src/kb/                     markdown docs → chunks → Qdrant (+ BM25/cosine fallback); SOP router
src/observability/store.js  Upstash Redis REST sink (turn records, sessions, daily counters) + memory fallback
src/events.js               console feed (replay buffer + live) + logs/events-YYYY-MM-DD.jsonl (/api/events?day=…)
src/settings.js             runtime settings (ambience mix, call language) — Talk Settings card, Aria's talk_settings, /api/settings
src/conductor/transcript.js one transcript line per spoken item (OpenAI item ids / Gemini synthetic), greetings.js the opening cases
src/phone/dialCap.js        sliding-window cap on real outbound dials (per session + total); src/agent/webClient.js the settings gate
sops/*.md                   10 facts-only SOPs (frontmatter: triggers, sites, always, priority)
knowledge/*.md              site playbooks (Uber Eats, Bing/Wikipedia, AU sites), preferences, FAQ
public/js/                  the console, in ordered classic scripts sharing one scope (no build step; jambonz client SDK + /ui WebSocket)
scripts/                    dev (restart-safe watcher), register-app, route-number, call, smoke, export-kb
tests/ + test/              node:test — kb, lanes, tools gate, protocol, observability, greetings, transcript folding,
                            small talk, web-client gate, dial cap, settings; test/e2e runs headless against a live :3005
```

## Run it (localhost dev)

```bash
npm install
npx playwright install chromium         # once
cp .env.example .env                    # GEMINI_API_KEY, JAMBONZ_*, PUBLIC_HOST, WS_SECRET
./start.sh                              # preflight + restart-safe watcher; http://localhost:3005 (headed Chromium opens)
                                        #   --bg / --stop / --status / --headless / --once / --port N
ngrok http --url=mick.au.ngrok.io 3005  # in another shell (start.sh never starts ngrok)
npm run register                        # creates/updates the jambonz app → wss://mick.au.ngrok.io/ws?token=…
node scripts/route-number.mjs --number 61745188002   # route a number to it (inbound hybrid calls)
npm run smoke                           # fake jambonz drives /harness with the real models + browser
npm test
```

Open **http://localhost:3005**:

* **Type**: text turns go to the same Navigator session as voice (shared tab + history).
* **Talk**: enter a jambonz **Client** (portal → Build → Clients; realm `huey.sip.jambonz.cloud`,
  SBC `wss://sip.jambonz.cloud:8443`) and dial `+61745188002` (routed to the conductor →
  hybrid S2S ⇄ pipeline) or `app:<application_sid>` to dial the application directly.
  Your jambonz account has no *device calling application* set, so a bare SIP call from a
  Client is not routed; dial the number.
* **Live browser view**: JPEG frames after every action; option cards are clickable
  (a direct `click` on that element); URL bar, back, scroll, list options.
* **Right column**: lane/model/TTFT/first-chunk/tokens/tools for the turn, the SOPs in
  force (and why: always / trigger / site / retrieval), the knowledge hits with lexical +
  semantic scores and backend, and every event the harness saw or sent.

### Agent Studio (custom harness)

In the Studio agent (`…/builder/custom-harness`): Harness URL
`wss://mick.au.ngrok.io/harness?role=navigator&session=main`, Secret = `HARNESS_SECRET`
(if set), Hear & speak = Google STT en-AU + `en-AU-Chirp3-HD-Aoede`. **Test → This browser**
runs the pipeline agent alone (Studio owns the audio, so the S2S lane is not in play
there); the console still shows everything. Add a Studio variable `session` to bind a
call to a different console session (`?session=` in the console URL).

### Phone (hybrid showcase)

Route a number to the `mick-agentic-browser` application (`scripts/route-number.mjs`) and
call it, or `node scripts/call.mjs --to +61…` to be rung. Tag `{mode:'cascaded'}` on an
API call skips the S2S lane.

## Knowledge base and SOPs

* `sops/*.md` are **facts-only procedures** with frontmatter: `triggers` (phrases),
  `sites` (hosts), `always` (every turn), `priority`. The router picks SOPs per deep-lane
  turn from always + triggers + site + retrieval and splices them into the system prompt;
  the console shows which and why.
* Retrieval: every chunk is embedded with Gemini `gemini-embedding-001` (768 d) and
  upserted into **Qdrant** collections `mab_sops` / `mab_knowledge` (`QDRANT_URL` — Cloud
  or `docker run -p 6333:6333 qdrant/qdrant`). Search is hybrid: Qdrant vector + BM25,
  fused 0.6/0.4, site bonus. Without Qdrant the same embeddings are scored in-process; without
  an API key it is BM25 only. `GET /api/kb/search?q=…` shows what the agent would get.
* **jambonz Studio Knowledge**: Studio's knowledge bases are only available to cascaded /
  realtime agents (`search_knowledge_base`), **not to custom-harness agents** (the harness
  does its own retrieval). `npm run export:kb` writes `dist/kb/` (SOPs + knowledge as
  markdown, plus `always-known-facts.txt` for the pinned-facts box) so the same documents
  can be uploaded to a Studio knowledge base for any Studio-native agent.

## Observability (Upstash Redis)

Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (console.upstash.com → database →
REST). Every turn record (lane, models, TTFT, tokens, tools, SOPs, knowledge, sentiment,
`first_chunk_ms`), session summary and lane swap is written over the REST pipeline:

| key | type | content |
|---|---|---|
| `mab:sessions` | ZSET | session id → started_at |
| `mab:session:{id}` | HASH | channel, from/to, turns, deep_turns, duration, last_url, sentiment_avg |
| `mab:turns:{id}` | LIST | one JSON turn record per turn |
| `mab:events:{id}` | LIST | lane swaps, call start/end |
| `mab:metrics:daily:{YYYY-MM-DD}` | HASH | turns, lane_fast/deep, ttft_sum_ms/ttft_n, input/output tokens, tool_calls, errors |

`GET /api/observability` (and `?session=id`) reads it back. Without Upstash the same records
are kept in memory for the process lifetime. Agent Studio additionally stores the 16 KB
`turn_record` we send with every `reply:done` (route, lane, steps, model_calls, own_tools,
sops, knowledge, sentiment, flags).

## Safety rails (in code, not just prompt)

* **Transactions**: a click on anything matching place order / pay / buy now / checkout /
  send / delete / subscribe (or any host in `BROWSER_BLOCKED_HOSTS`) returns
  `needs_confirmation` the first time and sets a pending action; the navigator marks it
  approved only when the caller's *next* turn is an explicit yes; only then does the same
  click go through (SOP-002). The console shows "confirmation required / confirmed / declined".
* **Credentials**: `type_text` refuses password fields; the SOP tells the caller to sign in
  in the headed browser window (persistent profile `.profile/`, so once per site).
* The harness never reads URLs, refs or markdown aloud (`scrubForSpeech`).

## Facts learned (3 Nov 2026)

* Playwright `page.evaluate(string)` evaluates an *expression*: a function-source string
  comes back as an unserialisable function. Build a real function with `new Function`.
* Headless Chromium: **Bing** renders search results; DuckDuckGo (html and JS) answers with
  an "anomaly" page and Google with "unusual traffic". Default search is Bing.
* Playwright 1.64 wants Chromium build 1248 (`npx playwright install chromium`).
* jambonz.cloud has no `/Accounts/{sid}/Clients` REST route (404): WebRTC Clients are created
  in the portal. Studio has no REST API: the Harness URL/secret are pasted in the UI.
* Gemini embeddings via the OpenAI-compatible `/embeddings` endpoint accept `dimensions`
  (768 used); 22 chunks index in ~5 s.
* Uber Eats and Menulog refuse **headless** Chromium with a security check ("blocking web
  requests"). No fingerprint tricks are used: run headed (the default) with the persistent
  profile and sign in once yourself; if a site shows a human check the agent asks you to do it
  on screen (SOP-007). Wikipedia, Bing, ABC, BOM work headless.
* Agentic browsing turns are long: 5-6 tool rounds × (page load 2-3 s + model TTFT ~1.3 s)
  = 30-50 s. The navigator speaks a progress beat whenever 3.5 s pass in silence
  ("I'm on wikipedia now.", "Searching now."), on top of the instant filler, so jambonz never
  reaches its holding phrase and the caller is never left wondering.
* A **headed** Chromium returns BLACK screenshots while its window is occluded by another window.
  The console is the view, so the browser launches with `--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding` and `CalculateNativeWinOcclusion` off; frames are then valid
  whatever is on top. A frame ticker also streams the view every ~0.9 s while a specialist works.
* The console covers the quiet during long browse turns with a WebAudio bed (soft ambience) and
  typing clicks on tool/model activity — local to the console, off by default, one toggle.
* The esm.sh build of `@jambonz/client-sdk-web` throws `ge(...) is not a function` at import
  (it pulls in React for optional hooks); the SDK is bundled locally with esbuild (`npm run
  build:vendor`, React stubbed) and served from `/vendor/`.
* Docker Desktop pulls of `qdrant/qdrant` failed repeatedly with CloudFront `EOF` on this
  network; the in-process index carried the demo in the meantime.

## Planned: xApp bridge

See `README-xapp.md` — the build brief for pushing a Cognigy-hosted xApp (map
pin-drop first) to the caller mid-call via the existing `ask_chatbot` bridge,
with the result polled back into the voice conversation.

## Not verified yet

* A real phone or Studio browser call (needs ngrok up and a handset / the Studio Test panel).
* Gemini Live `google_s2s` tool-call payload on jambonz.cloud for `browse_for_caller`
  (handled with the same defensive parsing as the Huey harness, where it was verified).
* The jambonz client SDK softphone from the console end to end (the SDK is bundled locally
  with esbuild, `npm run build:vendor`, because the esm.sh build throws at import; the NoRMA
  sip.js softphone had a mic-audio-path issue that this official SDK should avoid).
