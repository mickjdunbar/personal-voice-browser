# xApp bridge — build brief

**Goal**: mid-call, the Personal Voice Browser (PVB) pushes a **Cognigy-hosted xApp**
to the caller's phone (SMS) or screen (console card), the caller completes a visual
input that is miserable by voice, and the result flows back into the voice
conversation as an ordinary fact. First xApp type: **map pin-drop** ("show me where").

PVB already treats Cognigy as a chatbot integration (`src/chat/bots.js` →
`ask_chatbot(bot, message)` tool, provider `cognigy`), so **PVB needs almost no code**.
The build is: one Cognigy flow with a text protocol, one generic spec-driven xApp
page, one new SOP file, and an SMS path.

## The loop

```
Caller (voice) ──► PVB agent ──ask_chatbot──► Cognigy REST endpoint
                      │                            │ creates xApp session, returns LINK
                      │◄──── "LINK https://…" ─────┘
                      ├─ sends SMS (phone call) or shows a link card (console/app)
                      │         … caller taps pin on phone …
                      ├──ask_chatbot "xapp status"──► Cognigy reads context ──► "RESULT {lat,lng,address}"
                      └─ reads the address back by voice and continues
```

**Load-bearing constraint**: the Cognigy REST endpoint is strictly
request/response, so the xApp result cannot be *pushed* to PVB. The xApp
submission lands in the Cognigy **session Context**, and PVB **polls** for it with
another `ask_chatbot` call. This dictates both sides' design below.

**Session correlation is free**: `bots.js` mints a stable `sessionId` per
(PVB session, bot) and reuses it on every turn; the xApp session is born inside
that same Cognigy session, so `create` and `status` naturally hit the same
Context. Do not invent a correlation scheme.

## 1. Protocol (text commands over the existing REST bridge)

`ask_chatbot` carries only text, so the Cognigy flow pattern-matches a tiny
command grammar — Lookup nodes on `input.text` prefixes, **no LLM nodes**,
fully deterministic:

```
→ xapp create {"type":"map_pin","title":"Delivery location","prompt":"Drop a pin where we should deliver","center":{"lat":-27.47,"lng":153.03},"zoom":13}
← LINK https://<xapp-session-url>

→ xapp status
← PENDING | OPENED | RESULT {"lat":-27.4698,"lng":153.0251,"address":"123 Queen St, Brisbane City QLD"}
```

Rules:

* Replies are **plain text** in the normal Cognigy output (`{text}` /
  `outputStack[].text`) — PVB's provider extracts that and the LLM parses
  `RESULT {...}` fine. Keep every reply under the bridge's 2,000-char cap.
* `OPENED` is set by the xApp page pinging on load (before submit), so PVB can
  narrate "I can see you've opened the map…". Cheap, makes the demo feel alive.
* Optional nicety: `xapp status wait 15` — the flow loops Sleep-and-check up to
  15 s before answering (long-polling), saving PVB tool rounds.

## 2. The generic xApp page (Cognigy-hosted)

**One** HTML page, rendered entirely from the JSON **spec** stored in Context by
`xapp create` — every future xApp type is a payload, not a new page.

* **Spec schema**: `{type, title, prompt, …type-specific fields…}`. The page
  switches on `type`. First type `map_pin` with `center`, `zoom`, optional
  `requireAddress`. Leave room for `form`, `slider`, `signature`.
* **Map stack**: Leaflet + OpenStreetMap tiles — no API key, no billing, works in
  any mobile browser. Tap to place the pin, drag to adjust, one big Confirm button.
* **Reverse geocode client-side**: on pin placement the page calls Nominatim and
  shows the address under the pin; the caller confirms *the address*, and the
  submission is `{lat, lng, address}`. Keeps the Cognigy flow dumb and gives PVB a
  human-readable string to speak. (Nominatim courtesy limit ~1 req/s — debounce
  the drag; fine for a demo.)
* **Submit behaviour**: after submit, show "Done — you can go back to the call."
* **Mobile-first**: full-screen map, large touch targets; must work in the ugly
  in-app browsers that SMS links open into.

### ⚠ Verify FIRST (step 0, before building anything)

Confirm in a throwaway flow that an **xApp submission on a REST-endpoint session**
actually executes the flow and can write to Context (xApps are usually demoed on
webchat/voice endpoints). If it does not work, the bulletproof fallback: skip the
xApp SDK for the submit and have the page `POST` straight back to the REST
endpoint itself as `xapp submit {...}` with the same `sessionId` (Cognigy
templates the endpoint URL + sessionId into the page when rendering it). This is
the only real unknown in the design, together with the SMS path below.

## 3. The Cognigy flow (~6 nodes, deterministic)

1. Lookup on `input.text` prefix:
   * `xapp create` → parse spec into Context → Init xApp Session / Show xApp Page
     → Say `LINK <url>`.
   * `xapp status` → Lookup on `context.xappState` → Say `PENDING` / `OPENED` /
     `RESULT <json from context.xappResult>`.
   * anything else → help line (or normal demo-bot behaviour).
2. xApp **load ping** path → set `context.xappState = "opened"`.
3. xApp **submission** path → write `context.xappResult`, set
   `context.xappState = "done"`. No spoken output (it has nowhere to go on REST).

## 4. The PVB side — a SOP, not code

Register the bot once in the console (Talk Settings → Chatbots, provider
`cognigy`, the flow's REST endpoint URL). Then write **`sops/SOP-011-xapp.md`**
(frontmatter like the other SOPs — `triggers`: "send me a map", "drop a pin",
"pick a location", "send it to my phone"; mid `priority`) instructing the agent:

1. When the caller needs to give a location (or any input that's better on a
   screen), call `ask_chatbot` with the xapp bot and an `xapp create {...}`
   command — compose the spec yourself (title/prompt from the conversation,
   sensible map centre).
2. Extract the URL from the `LINK` reply. **Never read the URL aloud**
   (`scrubForSpeech` enforces this anyway) — say "I've sent a map to your phone."
3. Deliver the link per channel (section 5).
4. Tell the caller to say "done" when they've dropped the pin. On that cue — or
   after one optimistic check ~10 s in — call `ask_chatbot` with `xapp status`.
   If `PENDING`, keep chatting and retry on the next cue. **Poll on cue, not in a
   tight loop** — tool rounds are expensive and voice fills the wait naturally.
5. On `RESULT`, read back the **address**, confirm it, and carry
   `{lat, lng, address}` forward like any other fact (e.g. hand it to Lumi/Remy:
   "closest store to that pin…").

## 5. Channel split

* **Phone call → SMS.** Plan A: jambonz sends it — works only if the
  carrier/trunk on the account is SMS-enabled (**verify early**; the Huey Twilio
  trunk was KYC-blocked). Fallback already wired into PVB: the
  Zapier / Composio / Twilio **MCP presets** in `src/mcp/servers.js` can send SMS
  today via `use_mcp_tool`. The SOP names whichever path lands. Caller's number:
  inbound caller-ID (`from`) by default, ask by voice as fallback — never SMS a
  number the caller didn't confirm.
* **Web console / Capacitor app → link card.** No SMS. Surface the URL as a
  tappable card in the console transcript, plus a **QR code** so a desktop user
  can flick it to their phone. If the console doesn't already linkify URLs in bot
  replies, this card is the **one** PVB code change in the project. In the mobile
  app, tapping the card opens the phone browser — same page, zero extra work.
* The SOP chooses by session channel (PVB knows it): call → SMS; console/text →
  card.

## 6. Acceptance test — the 3-turn demo

1. **Caller**: "Can you get a courier to pick something up from me?" →
   **PVB**: "Sure — easiest if you show me exactly where. I've just texted you a
   map, drop a pin on the pickup spot." *(create + SMS happen here)*
2. *(caller taps pin)* → **PVB** (on OPENED ping or cue): "I can see you've got
   the map open… got it — that's **123 Queen Street, Brisbane City**. Right?"
3. **Caller**: "Yep." → **PVB**: "Booked for pickup there. Anything else?" —
   then the flex: "what's the nearest cafe to that pin?" and the browser lanes
   take over. The xApp result feeding the agentic browser is the showcase moment.

## Build order

0. **Verify the two unknowns**: xApp-submit-on-REST (throwaway flow) and the SMS
   path. Nothing else starts until both have an answer.
1. Cognigy flow + text protocol.
2. The map xApp page (spec-driven shell + `map_pin` type).
3. Register the bot in PVB and test the whole loop by **typing** in the console —
   the text lane uses the identical `ask_chatbot` path, no phone needed.
4. `sops/SOP-011-xapp.md` (+ the console link/QR card if needed).
5. Live phone call end to end.
