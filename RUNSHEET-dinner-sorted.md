# Run sheet — "Dinner, sorted" showcase (recap for Dave Horton + Versa SLT)

One Huey-driven call to Aria, a WhatsApp second act, one shareable recap. 11 Nov 2026.

## Huey resources (org `huey`, project **PVB Showcase — Dinner Sorted**)

| Thing | Name | Id |
|---|---|---|
| Agent | Personal Voice Browser — Aria (dial-in **+61 7 4518 8002** — huey-os Twilio + Huey Jambonz trunk, 12 Nov) | `6af3f6710c0de317a22eb97d` |
| Campaign | Personal Voice Browser — Aria — phone | `6af3f6720c0de317a22eb98a` |
| **Hero segment** | H-01 Dinner sorted — full concierge arc (baseline, cold memory) | **`6af3f7670c0de317a22eba42`** |
| **Memory segment** | H-02 The usual, please — long-term memory showcase | **`6af5ac76706825be8f52165a`** |
| Project | PVB Showcase — Dinner Sorted | `6af3f6710c0de317a22eb982` |
| Persona | Jordan Blake (dinner organiser) 🍴 | `6af3f6d70c0de317a22eb9d5` |
| Feature segments (13 Nov) | H-03 weather + SMS · H-04 two-tab compare · H-05 ring Sunny + relayed question · H-06 hang-up-and-keep-working · **H-07 pin on the map (voice + screen + text + background task)** `6af63f6eeba54985d779dd8b` | `npm run showcase -- h3` … `h7` |

**Outbound contact for tests = Sunny** (Huey's agent-prototype, +61 3 4062 1105): the launcher ARMS the
test-dial redirect to Sunny before every dispatch and reads it back from the server, so every outbound
ask-call is machine-to-machine. `npm run showcase -- h1 --dial-me` redirects to your mobile instead
(you answer as the venue). The switch is server-owned and persisted (`.test-dial.json`); since 13 Nov a
console no longer replays its own saved state on connect (a fresh browser profile used to DISARM it).
**Reload any console tab opened before 13 Nov** — old JS still pushes its saved switch on reconnect.

**WhatsApp 24-hour window**: WhatsApp drops freeform messages (Twilio 63016) unless you've messaged
the sandbox in the last 24 h — the launcher now checks this and tells you to send "hi" to
+1 415 523 8886 when it's closed. Undelivered messages show as ⚠️ rows in the Activity feed.

**Auto-recap**: ~25 s after a call ends an OPEN console builds the shareable recap, hosts it on the tunnel
(`/recaps/…`) and posts the link into the latest task thread — which forwards to your WhatsApp.
If no console is open on `main`, the launcher opens a headless one for the run and prints the link at
the end (two consoles → one link: the server dedupes within 2 min). The ★ button still downloads a copy.
| Smoke segments | T-01/T-02/T-03 (onboarder starters) | disabled — enable T-01 for a 2-min dial-tone check |

Jordan's brief: team dinner **this Friday 6:45 pm, four people** (Jordan, Sarah, Priya, Marco;
Priya is coeliac), Brisbane, booking under "Jordan". He asks for two options compared, picks one,
asks for the venue confirmation call and **stays on the line**, then calendar, then task+WhatsApp,
then a clear goodbye. Compliance policies: single authorised outbound only, read-back before
commitment, no premature hangup.

## Pre-flight (same day — the recap task window is 12 h)

1. **Server + tunnel up**: `npm run dev` and `npm run tunnel` — then PROVE the tunnel:
   `curl https://mick.au.ngrok.io/api/health` must return JSON, and
   `curl http://localhost:4040/api/tunnels` must show **mick.au.ngrok.io** (an ngrok started any
   other way serves a different domain — jambonz then can't reach the harness and calls die).
   (11 Nov lesson: with the tunnel wrong/down, Huey shows a green "completed/Pass" run of ~5 s with
   an empty transcript — dispatch succeeded, call never connected. ~5 s + 0 turns ⇒ tunnel first.)
   NUMBER FACTS (final, 12 Nov): **+61 7 4518 8002 is Aria's dial-in.** The huey-os Twilio
   account OWNS it (PN52737d5b…) — the 11 Nov SIP 404s happened because it was attached to NO
   trunk. Voice chain: PSTN → huey-os Twilio → "Huey Jambonz" trunk (TKb444…, origination
   sip:huey.sip.jambonz.cloud) → jambonz 61745188002 (carrier Twilio f04775da) → app
   `mick-agentic-browser` → wss://mick.au.ngrok.io/ws. **ONE Mick-side step remains**: in
   vibes/huey/apps/jambonz run `node scripts/attach-aria-number.mjs` (idempotent), then ring the
   number — Aria answering = PSTN proven. Telephony split (12 Nov decision): ALL VOICE on the
   huey-os Twilio; **WhatsApp/SMS stay on the MNDRural Twilio** (the messaging Twilio account, creds in this
   repo's .env) — never mix them. +61 3 4160 2511 (MNDRural) is messaging-side spare: its jambonz
   registration was removed and the planned MNDRural trunk script deleted. **+61 3 4152 5213 is
   OUTBOUND caller-ID only** — inbound it routes to jambonz-huey-proxy. Never give Huey the FROM
   number. (Quinn's +1 505 number / trunk TK013d routes to Cognigy VG — never touch it.)
   RUNNER FACTS (11 Nov): the Dialgood provider is RETIRED in Huey — every outbound phone type
   (huey-phonenumber and the legacy phonenumber/dg-phonenumber spellings) dials through the Huey
   JAMBONZ runner (same path as the Qwik/Quinn 6 Nov campaign).
2. **TEST DIAL** — the launcher arms it (Sunny by default, `--dial-me` for your mobile) and refuses to
   dispatch unless the server confirms it. **Never dispatch any other way without checking Harness →
   Talk Settings first**: the KB holds real venue numbers. Persisted across restarts since 12 Nov.
3. **WhatsApp sandbox joined** within the last 72 h (send the join code to +14155238886 again).
4. **Zapier MCP**: console MCP panel shows the gateway + probe passes; at zapier.com/mcp confirm a
   **Google Calendar create-event** action is enabled (plus the Twilio SMS action already there).
5. Console open on session `main`; press **Clear** for a clean recap canvas.
6. Phone in hand — you will receive: the redirected confirmation call (answer; confirm Friday
   6:45 pm, four, Jordan — keep it under 30 s), WhatsApp task notifications, and the "group" SMS.
7. Optional smoke: enable + run T-01 once (greeting check), re-disable it. Or just ring the number.

## The run — two acts (12 Nov: the LONG-TERM MEMORY arc)

The harness now has a **Memorist** agent: after every session goes quiet it distils durable
self-learnings (contacts, venues, URLs, preferences) into the **Memory KB** (Harness →
Knowledge → 🧠 Memory — human-editable, each doc carries a self-learning scorecard), messages
the **major ones to WhatsApp** for supervision, and every new session starts ARMED with the
ranked digest. The launcher ends the console session before each dispatch, so recall provably
comes from the KB, not chat history.

1. **Take 1 — baseline**: `npm run showcase` (H-01). Memory starts EMPTY — Aria researches
   everything from scratch. After the call ends, watch the 🧠 WhatsApp self-learnings arrive
   (~25 s after quiet) and review them in Knowledge → Memory.
2. **Take 2 — the flex**: `npm run showcase -- h2` (H-02). Jordan asks for "our usual Friday
   dinner, same as last time". Aria must recall venue/time/party/dietary/booking-name from the
   Memorist's learnings — the compliance monitor fails the run if she re-interrogates.
   Repeat either take as needed; every run compounds the memory.
2. **During the call**: answer the redirected call when it comes; watch the console — tab strip,
   activity overlay, the calendar MCP call in the feed.
3. **Act 2 — WhatsApp** (you, after Jordan hangs up; reply to the task's `#n` notification):
   - `#n who's going?` → answered from the plan (Jordan, Sarah, Priya, Marco), no browsing.
   - `#n find a bar nearby for a drink before dinner, then text us all the meeting time and
     share the bar's location` → Aria picks a bar near Rogue Bistro (Newstead), chooses ~6:00 pm,
     and sends ONE text per person — Sarah, Priya, Marco and Jordan are in KB-contacts as a
     DEMO group whose numbers are all **your mobile**, so you receive the texts and nobody else
     does — each with the bar's name, street address and a Google Maps link, then confirms in the
     thread with a screenshot of the bar/map. (Governed by SOP-015; group texts go one-per-person
     because SMS has no group send.)
4. **Build the artefact**: Harness → Activity → **★ Create shareable recap**. Same day. Open it,
   check the Background tasks section carries the images, send to Dave + Versa SLT.
5. Optional: Huey report (`huey_get_results`, then `huey_manage_report generate`) if you want the
   scored compliance view alongside the recap.

## Take-1 lessons applied (12 Nov, after the first real run)

- **The hold killed the call**: Aria's host looped "hang tight / nearly there" every ~9 s during the
  70 s confirmation call; Jordan answered each one, went `frustrated`, hung up at 242 s. Fixed on
  BOTH sides — the host now gets explicit hold rules (one acknowledgement, then quiet or light small
  talk: weather/storms/their week; never progress narration) injected the moment an outbound call
  starts, and both Huey segments tell Jordan to hold quietly, chat back briefly if spoken to, and
  never hang up mid-hold. New compliance policy "Hold etiquette" scores it.
- **Outbound voice**: business calls used to run on the slow cascaded TTS loop (a different
  voice); every ask-call now runs speech-to-speech in Aria's own voice (`PHONE_ASK_BUSINESS_MODE=
  cascaded` keeps the DTMF loop for IVR-heavy targets if ever needed).
- **Memory junk**: the runner announced its instance name and the Memorist stored it as an
  "owner contact" (score 94). `runnerSpeaksName` is now off on both segments, the Memorist ignores
  synthetic identifiers, and the junk doc was deleted. SOP-014 (always in force) now governs how
  the team arms, uses and learns memory; Mnemo 🧠 sits on the roster.
- **Recap** now carries every call leg's audio (inbound + each outbound), the screens the team
  worked through (one shot per page), the outbound-call conversation + outcome, WhatsApp/SMS with
  the owner, and the task threads.
- **Take 2 (13:22) — the caller's own LLM ended it.** Hold small talk worked; then Jordan
  (gemini-flash-lite) read "storms… before the weekend" as a natural ending and called `end_call`
  (proxy log: `session:end reason: harness_hangup`). Both segments now forbid `end_call`/goodbye
  before the scripted step-7 line, and Aria's small talk is open-ended (no sign-off phrases) and
  she drives the next step the moment the booking outcome lands.
  To read how a Huey call ended: https://huey-jambonz-proxy.onrender.com/api/calls
  (`harness_recent[].messages` tail + `conductor_recent[].events`).
- **Atmosphere**: callers now hear a soft room tone throughout, keyboard clatter while a specialist
  works, and a warm hold pad for the whole outbound call (loops normalised; gains in `.env`).
- **"Mick's assistant"**: the outbound intro now uses the CALLER's name (`on_behalf_of`, then
  saved context, then the owner's name as the last resort) — Jordan's booking is made for Jordan.
- **Where the LTM lives**: Harness → 🧠 Memory (opens the Knowledge drawer on the memory kind;
  Qdrant collection `mab_memory`; files in `memory/`). SOP-014 is in Harness → Knowledge → SOPs.

## 13 Nov — feature segments tested against Sunny (machine to machine)

First pass (before the fixes below): H-03 3/4 · H-04 4/4 · H-05 1/5 · H-06 4/4. Call audit on
jambonz: the only outbound leg was H-05's 71 s call to Sunny — nothing else was rung.

- **Clunky outbound call, root causes**: (1) the hold-rules note was injected as a *user turn* that
  forced a reply, so Aria answered the note ("Hey there, great to have you back") BEFORE her
  delegation line; (2) the delegation line only reached the caller after an extra deep-model round
  (~10 s) — after Sunny had already picked up; (3) the small talk chained three questions in a row;
  (4) the Sunny leg gave up when "an AI assistant" answered instead of asking the question.
  Fixes: the hold rules are now a standing note (no forced reply); the turn ends the moment the
  call is placed so the delegation line plays first; small talk = at most ONE question for the whole
  hold, then quiet; the ask leg treats anyone answering for the contact (partner, receptionist,
  AI assistant) as able to answer and asks them.
- **Silence after a request** (H-03/H-04: 20 s until Huey's "hello? still there?"): the Realtime
  model often fires `browse_for_caller` without a word. If nothing was said since the caller's line,
  Aria is now made to say one short "on it" first; the result waits for that to finish (a tool
  output during an active response kills the leg).
- **H-03 "text sent" failed only on timing**: the SMS was delivered (Twilio), but Jordan hung up at
  "just sending it now". The segment now waits for the confirmation; the policy wants a clear "sent".
- **Memory pings**: the Memorist WhatsApps only NEW learnings or refinements whose score moved 10+.
- **Compliance wording** (H-05): delegating to a team member IS the one authorised call; an answer
  obtained via Sunny's assistant counts as the outcome.

## 13 Nov pm — H-07 "Pin it on the map": the multimodal take (voice + screen + text + background task)

`npm run showcase -- h7`. Jordan asks for a bar near Rogue Bistro **and a pin on it**; Aria must name ONE
bar, drop the pin and say **"I've pulled that up on your Personal Voice Browser"**; Jordan then asks for
the location by text (policy wants a clear "sent"), then hands over a long-running job ("work out the
walk from the bar to Rogue Bistro and WhatsApp me") that runs as a background task after he hangs up.

- **How the pin works**: new `drop_pin` tool (deep lane) geocodes the place (Photon → Nominatim
  fallback), opens an OpenStreetMap page with a marker on the live tab, and the console shows a 📍
  badge + toast; the recap gets a "Pins dropped on the Personal Voice Browser" section and the map
  screen appears in the Screens gallery. The tool returns a Google Maps `share_link` for texting.
- **Screen narration everywhere**: the browsing persona now knows the caller's Personal Voice Browser
  mirrors its work live and says so ONCE per thing it puts up; the voice host gets `on_screen` with every
  browse result and adds the line if the answer forgot it. Never "screen share".
- **SOP-011 split**: SHOWING where = `drop_pin`; the xApp map is only for when the caller must PICK a
  spot (pickup/delivery). The lane router now sends "drop a pin / where is / nearby / how far" to the
  deep lane (the first test went to the fast lane and built a caller-input xApp instead).
- **Take 1 (22:41 UTC) = 3/5**: pin + "pulled it up on your Personal Voice Browser" PASSED first time
  (Hello Gorgeous, 32A Chester St). Two misses, both fixed: (1) "text me that location" got a Spanish
  welcome-back line and NO tool call — the host now has a dropped-request watchdog (an action request
  with no tool within 7 s → one nudge to act, in English) and a language-slip corrector; (2) "while
  I'm off the phone, work out the walk and WhatsApp me" was done LIVE by the deep lane, which then
  said "WhatsApp isn't connected" — the host now has its own instant `start_background_task` tool
  (the task exists before Aria finishes the sentence: "underway — I'll WhatsApp you"), and the
  browsing persona treats "WhatsApp me / later / off the phone" as create_task first, never a live
  search; WhatsApp delivery is automatic, so "not connected" is banned.
- **Take 2 (22:50 UTC) = 4/5** — background task PASSED (task #8 did the walk time); the miss was
  "text me that location" going to the new background tool instead of an immediate text. Tool
  descriptions now split the two: a text wanted NOW = `browse_for_caller` (sent on the spot, "sent"
  confirmed); only after-the-call jobs = `start_background_task`. A mid-browse keepalive (one "still on
  it" at 13 s if nobody has spoken for 9 s) covers the 20-s "hello?" during a search + pin.
- **⚠️ Real SMS to a contact (take 2, 22:51 UTC)**: task #7 resolved "text ME that location" through the
  contact book and texted a **personal contact from the contact book** the bar address + map link (Twilio:
  delivered). Every earlier text this week went to your own mobile. Fixes: with the test-dial switch
  ON, **every SMS is now redirected to OWNER_PHONE** (`sms.redirected` event, the model is told it
  went to the caller); the browsing persona is told "text me / send me" is the CALLER's number
  (calling-from number, else the owner's) and never a contact lookup; task threads are told their
  reply IS the WhatsApp message (no WhatsApp MCP hunting, no `enable_zapier_action`). Consider
  removing real third-party numbers from KB-contacts for showcase runs.
- **Take 3 (22:58 UTC) = 5/5.** Pin + PVB line, one bar, text sent (to the owner's phone), background
  task handed off, clean goodbye. Recap: `recap-2026-11-122258-q3wz.html`.
- **Architecture summary in every recap (13 Nov)**: `public/architecture.html` (served at
  `/architecture.html` on the tunnel) explains the high-level architecture (Twilio → jambonz → harness
  → Aria + team + browser; screen, knowledge, messaging, outbound calls, Huey), the feature table
  (why it matters / how it's used), long-running tasks, long-term memory + SOPs/FAQs, how it was
  tested with Huey synthetic callers over the PSTN (per-segment scores), browser sharing and the
  browser-call option, and next steps. The recap builder inlines it as a collapsed "How it works"
  section at the top of every recap, with a link to the standalone page.
  **v2 (13 Nov pm, Mick's notes applied)**: leads with the thesis — services are putting AI agents on
  phones/chats/forms faster than anyone can integrate them, so the assistant must *reason the
  interactions at runtime and discover each counterpart's channel* (web page/form, phone line with a
  human, IVR or AI, chat widget, text; MCP only when an integration exists) — with a discovery-loop
  diagram and a 7-step process flow of Jordan's dinner labelled by channel (incl. the AI↔AI call to
  Sunny). States that the **WebRTC browser call already exists** (the console orb, official jambonz
  client, same app as the number) and that Huey over the PSTN was used to automate + score testing.
  **PDF**: `npm run build:arch` → `public/architecture.pdf` (served at /architecture.pdf, linked from
  the page header and the recap section). Re-run after editing the page or the scores.
- **Memory metadata (13 Nov)**: every KB doc now carries `meta` with version (bumps per save),
  created/updated timestamps, created_by/updated_by (memorist · console · api) and a revision history;
  memory docs add learned_at, source session/trigger/model, score components, used_count/last_used
  (ticks whenever a memory is retrieved into a turn) and the refinement log. Shown read-only above
  the body in Harness → Knowledge. Also fixed: the console's save path decoded JSON per network chunk,
  so an em-dash on a chunk boundary became "�" — bodies are now decoded whole; the Rogue Bistro doc
  was repaired.

## 13 Nov pm — Jordan on a speech-to-speech voice (Huey S2S) + the hero take

- **Huey S2S voices**: the segment/campaign/persona voice block now has `mode: cascaded | s2s`,
  `vendor: google | openai`, `voice`, `model`, `label` (jambonz credential label). H-01 is set to
  **Google Gemini Live, voice "Leda"** (bright female, distinct from Aria's OpenAI "cedar"), model
  `models/gemini-3.8-live`. Verified on the Huey proxy: the live leg reports `mode: huey, lane: s2s`
  and the conductor note `engine=s2s google/models/gemini-3.8-live/Leda`. Other voices: Google Aoede,
  Kore, Zephyr…; OpenAI marin, coral, sage… (OpenAI needs OPENAI_API_KEY or a label on the proxy).
- **Hero take 1 (00:52 UTC, 495 s, 5/6)** — the journey was poor for one reason: the venue
  confirmation call is redirected to **Sunny, who is a homewares-store assistant and honestly says
  "we're not Rogue Bistro"**, so Jordan asked for retries (four calls, all to Sunny). **For the hero
  recap run `npm run showcase -- h1 --dial-me` and answer as Rogue Bistro** (confirm Friday 6:45 pm,
  four, Jordan, GF degustation — keep it under 30 s). Sunny is fine for H-05 (asking Sunny a question)
  but can never play a venue.
- **Sunny now plays Rogue Bistro for Aria's calls (13 Nov, commit 74ba4a7 on hueyai staging)**: the
  agent-prototype resolves a role from the CALLER's number — calls from the PVB's numbers
  (+61745188002 dial-in, +61341525213 outbound caller ID; `VENUE_CALLERS` env) are answered
  "Thanks for calling Rogue Bistro in Newstead, this is Sunny", with a `book_table` tool
  (reference RBnnnn, logged on the call), menu/dietary/hours answers and honest "I'm the
  restaurant's AI assistant". Every other caller still gets the Sunny & Co. store agent, so Huey's
  own Sunny tests are untouched. `VENUE_FORCE=true` = every call is the venue. Check
  `https://huey-agent-prototype.onrender.com/api/health` → `venue_role`. So `npm run showcase`
  (no `--dial-me`) now gives a real AI↔AI booking confirmation.
- **Hero takes 2-3 with Sunny as the venue (01:45 / 01:53 UTC, 6/7 each)**: Sunny booked the table both
  times on take 2 (RB9836, RB6359) but Sunny hung up politely before Aria's leg reported it → "couldn't
  get through". Take 3: Aria found 6:45 for four GONE on Rogue Bistro's SevenRooms page (live data!)
  and recommended Chu The Phat; Sunny answered as Rogue Bistro → honest "wrong place"; the first
  leg sat SILENT 7 min, timed out and stayed connected (zombie). Fixes: an ask leg that ends after
  the venue spoke hands back their last line as the outcome; the ask leg must report the answer
  BEFORE pleasantries; the delegation line carries the read-back (`readback` arg — policy passed);
  tool outputs cancel pending nudges (no more double `response.create`); the ask timeout is now
  EMITTED so the leg is hung up (1.5 s on error/timeout, 25 s after an outcome) and is 180 s
  (`PHONE_ASK_TIMEOUT_MS`); the mid-browse beat says WHAT is being done, never "nearly there"
  (that phrase failed hold etiquette). **Sunny v2 (commit 0ddec3a)**: greets "this is Sunny at the
  front desk" and becomes whichever restaurant the caller names (never "wrong number").
- **✅ HERO TAKE (02:46 UTC, 213 s, 18 turns) — `recap-2026-11-130246-tvhp.html`.** Jordan (Gemini
  Live "Leda") → Aria compares Rogue Bistro vs El Planta on screen → Jordan picks El Planta → Aria
  reads the booking back and hands the call to her team → Sunny answers as El Planta's front desk
  and books it (reference **RB1933**) → outcome delivered while Jordan held → calendar via Zapier →
  pin on the Personal Voice Browser → follow-ups task to WhatsApp → clean goodbye. 6/7: the only
  "fail" was the monitor wanting the venue's words in Jordan's transcript (they're on the other
  call); the "Honest outcome" policy wording now says so. This is the recap to attach to the
  architecture doc.
- Harness fixes from that take: a deferred `response.create` could fire after the caller had started
  talking (server VAD already opened a response) → OpenAI `conversation_already_has_active_response`
  → leg restart → "glad to have you back" (twice). The send now re-checks busy and defers again;
  tool outputs wait up to 20 s for an idle model; the resume prompt forbids greeting/"welcome back"
  and continues from the last transcript line. H-01 brief: one retry max on a failed venue call,
  then accept and move on; policy "Caller-authorised outbound only" now excludes the WhatsApp/
  calendar the caller asked for; new "Honest outcome" policy.

## Recovery moves

- **Aria says she'll ring but nothing dials** → the harness forces a corrective tool round
  automatically; if it still stalls, Jordan's brief tells him to ask once more. Worst case, re-run.
- **Calendar fails** → she self-corrects per the Zapier recipe; if the action isn't connected she
  says so — fix zapier.com/mcp, then in WhatsApp: `#n try adding the calendar entry again`.
- **Runner hangs up early / call drops** → just start the segment again (fresh run, no cleanup needed).
- **No audio answer at all** → tunnel down or jambonz app re-registration needed: check
  `npm run tunnel`, then `scripts/register-app.mjs`.
- **Recap missing the WhatsApp thread** → it includes only tasks STARTED during the call (13 Nov pm;
  before that, anything touched in the last 12 h, which dragged unrelated threads in). A task started
  from WhatsApp outside the call is deliberately not in the recap.

## 13 Nov pm — three tweaks after the hero take (Mick's review)

1. **Jordan said "Silence." on every hold turn.** Gemini Live answers every completed agent turn;
   the brief said "say nothing" and the voice model read that aloud. Huey harness (commit e355629):
   proactive audio on by default for the S2S tester (`HUEY_S2S_PROACTIVE=0` disables) plus a
   "you are speaking aloud — staying quiet means NO speech" rule; H-01 brief says the same.
2. **Cross-call follow-up.** New step 5 in the H-01 brief: once the table is confirmed Jordan asks for
   "a table with a bit of atmosphere, by the window" and WAITS for the venue's answer. Harness: the
   venue leg is no longer hung up 25 s after the first outcome — teardown re-arms while the leg is
   waiting on the owner or a relay just went through (ceiling `PHONE_ASK_FOLLOWUP_MAX_MS`, 150 s);
   a relayed follow-up is put to the venue and reported back with `report_outcome`; the whole venue
   conversation lands in the recap at the end of the leg (`phone.transcript`). Sunny v3: `note_booking`
   tool, says yes to seating requests, waits when told "hang on a sec". New policy "Cross-call follow-up".
3. **Recap tasks** scoped to the call (above).

**✅ HERO TAKE v3 (07:14 UTC, 285 s, 8/8, ZERO filler from Jordan) — `recap-2026-11-130714-jpf8.html`.** This
is the one. Jordan's quiet turns are now a `hold_the_line` tool call on the Huey tester (answered with Gemini's
SILENT scheduling — no audio), used 9 times in this take; the brief never describes silence in words. One venue
call (RB9678), window-table request relayed on the live leg, Sunny's own "Done, I've noted…" relayed back,
calendar + pin + WhatsApp task, clean goodbye.

**Hero take v2 (06:46 UTC, 314 s, 14 turns, 8/8) — `recap-2026-11-130646-t8db.html`** (Jordan voiced "empty turn" once). One venue call
(Sunny as Rogue Bistro, RB4254, coeliac noted) → outcome relayed while Sunny held → Jordan's window-table
request relayed on the SAME call → Sunny: "Done, I've noted a table with a bit of atmosphere by the window…"
→ Aria relays it → "that's all for them" → venue leg says goodbye → calendar + pin → WhatsApp task → bye.
Six takes to get here; what each one broke is in the memory file (entries 29-31). Lessons that matter for
re-runs: never name the words a voice model must not say (it says them); a follow-up outcome is accepted only
after the far end has SPOKEN (VAD, not the lagging transcript); a wrap-up relay needs the caller to have
actually spoken after the outcome; the owner's call ending hangs up every venue leg.
