# Personal Voice Browser — set it up and try it yourself

This is the hands-on guide. For what the thing *is* and why, read
[architecture.pdf](architecture.pdf) (same content as [architecture.html](architecture.html)).
For what a finished call looks like, open
[showcase-dinner-sorted-recap.html](showcase-dinner-sorted-recap.html) in a browser — it is a
self-contained page with both call recordings, the transcript, the venue call, the screens,
the pin and the WhatsApp task.

Everything runs on your laptop behind a public tunnel. jambonz does the telephony and the
speech-to-speech legs; this repo is the jambonz application plus the browsing team, the console
and the Tasks channel.

## What you need

| | Required for | Notes |
|---|---|---|
| Node 22+, npm | everything | `node --version` |
| Chromium via Playwright | browsing | `npx playwright install chromium` |
| A jambonz account | voice | jambonz.cloud or your own. Needs: an API key, an account SID, one phone number (or a SIP client) and a **speech-to-speech credential for OpenAI** (LLM Services → Speech-to-speech) |
| OpenAI API key | Aria's voice (`gpt-realtime`) and the deep lane (`gpt-5.6-terra`) | one key is fine |
| Google Gemini API key | embeddings for the knowledge base, cascaded fallback voice | free tier is enough |
| A public HTTPS/WSS URL to port 3005 | jambonz has to reach you | ngrok with a reserved domain is what we use |
| Twilio (optional) | SMS and WhatsApp (the Tasks channel) | a Messaging-capable number, or the WhatsApp sandbox |
| Zapier MCP (optional) | calendar, email, contacts | an MCP server URL from zapier.com/mcp |
| Qdrant / Upstash (optional) | vector search / observability | both fall back to in-process |

## Install

```bash
git clone https://github.com/mickjdunbar/personal-voice-browser.git
cd personal-voice-browser
npm install
npx playwright install chromium
cp .env.example .env
```

Fill in `.env`. The minimum for a voice call:

```
PUBLIC_HOST=your-domain.ngrok.app        # the public host, no scheme
WS_SECRET=any-long-random-string         # protects the jambonz WebSocket
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JAMBONZ_API_KEY=...
JAMBONZ_ACCOUNT_SID=...
JAMBONZ_API_BASE=https://api.jambonz.cloud/v1   # or your own
JAMBONZ_FROM_NUMBER=+61...               # the number jambonz rings OUT from
S2S_VENDOR=openai
S2S_MODEL=gpt-realtime
S2S_VOICE=cedar
DEEP_MODEL=gpt-5.6-terra
FAST_MODEL=gpt-5.4-mini
```

Phone-a-person / phone-a-business (the venue call in the showcase):

```
PHONE_ASK_ENABLED=1
PHONE_ASK_FROM=+61...                    # caller ID for outbound calls (usually = JAMBONZ_FROM_NUMBER)
OWNER_PHONE=+61...                       # YOUR mobile: where test texts and WhatsApp go
```

SMS / WhatsApp (optional, the Tasks channel):

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
SMS_FROM=+1...                           # a Twilio messaging number
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   # the sandbox, or your approved sender
TASK_NOTIFY=whatsapp                     # or sms
```

Zapier (optional): put your MCP server URL in `.mcp-servers.json` (copy the shape from
`src/mcp/servers.js`; the file is git-ignored because the URL carries a secret).

## Run

Three terminals:

```bash
npm run dev                              # the app: http://localhost:3005   (scripts/dev.mjs: restarts on src/ changes,
                                         #   but WAITS while a call / IVR map / task turn is live; `rs` + Enter = restart now)
ngrok http --url=your-domain.ngrok.app 3005
npm run register                         # creates/updates the jambonz application → wss://your-domain/ws?token=…
```

Then route a number to the application. Either in the jambonz portal (Phone numbers → your
number → Application = *mick-agentic-browser*) or:

```bash
node scripts/route-number.mjs --number 61xxxxxxxxx
```

Open **http://localhost:3005**. That page is the Personal Voice Browser: the live browser
view, the transcript, who on the team has the floor, the pins, and three edge tabs: **Async**
(tasks — the channel that runs beside the call), **Live** (the real-time text channel, same thread
as the voice) and **Harness** (SOPs, knowledge, memory, talk settings). You can type to it straight away.

The Async composer takes files as well as words: paste a screenshot, drop files onto the drawer, or
use the 📎 button. Images (png/jpg/gif/webp) go to the model as pictures; documents (pdf, docx, txt,
md, csv, json) are read as text (pdf/docx need `python` with `pymupdf` and `python-docx` on PATH,
`pdftotext` is the pdf fallback). Up to 8 files, 15 MB each, stored under `.tasks-media/` beside the
thread. URLs in replies are clickable.

Now **ring the number**. Aria answers. Try, in one call:

* "Find me two places for dinner Friday with proper gluten-free options and compare them."
* "Ring the first one and confirm a table for four at 6:45 under &lt;your name&gt;. I'll hold."
* while she has them: "Ask them for a table by the window."
* "Put it in my calendar and drop a pin on the venue." (the pin shows on the page you have open)
* "Set up a task to track the follow-ups and message me on WhatsApp."

## Before you let it ring anyone: the test-dial switch

`phone_someone` places **real outbound calls**. The console has a switch
(Harness → Talk Settings → *Redirect calls to a test number*) that sends every outbound call to
one number of your choosing instead of the real one, and redirects every SMS to `OWNER_PHONE`.
It persists in `.test-dial.json` and is **on by default when you use the showcase launcher**.
Point it at your own mobile and you can answer as the restaurant yourself.

Emergency numbers are refused in code regardless.

## Knowledge, SOPs and memory

* `sops/*.md` — short, facts-only procedures with frontmatter triggers. The router splices the
  relevant ones into the deep lane's prompt per turn; the console shows which and why.
* `knowledge/*.md` — site playbooks and FAQs. Add your own contacts as a markdown list in
  `knowledge/KB-contacts.md` (git-ignored) and "ring Dad" works by name.
* `memory/` — long-term memory the Memorist distils after each call (versioned, with
  metadata; git-ignored). Edit or delete entries in the console under Harness → Memory.

Everything in the knowledge base is embedded with Gemini and searched hybrid (vector + BM25).
No Qdrant? It runs in-process. `GET /api/kb/search?q=…` shows what the agent would see.

## Testing it with synthetic callers (Huey)

The showcase calls in the recap were made by **Huey**, a synthetic caller on a
speech-to-speech voice, dialling in over the PSTN like a customer would. The brief, the
expected outcome and the eight scoring policies live in the Huey campaign; the launcher is

```bash
npm run showcase -- h1       # arms test-dial, dispatches the Huey run, waits, prints scores + recap link
```

`RUNSHEET-dinner-sorted.md` is the full runsheet, including everything that went wrong on
the way to the final take. If you do not have a Huey account, ring the number yourself: the
console still builds the shareable recap about 25 s after the call ends (`★ Create shareable
recap` builds one on demand too).

## Useful endpoints

| | |
|---|---|
| `GET /api/health` | lanes, test-dial state, live calls, KB status |
| `GET /api/events?limit=500` | the console's event ring (replayable) |
| `GET /api/calls` | live and recent jambonz legs the conductor knows about |
| `GET /api/recordings` | recordings jambonz made of the legs |
| `GET /api/tasks` | the Tasks channel |
| `POST /api/recaps` | hosts a recap and posts the link into the Tasks thread |
| `/architecture.html`, `/architecture.pdf` | the architecture summary (`npm run build:arch` rebuilds the PDF) |

## jambonz specifics worth knowing

* Aria's leg is `openai_s2s` with `tool_choice: auto`; tools are `browse_for_caller`,
  `start_background_task` and `relay_to_callee`. Results go back as `function_call_output`;
  `conversation.item.create` + `response.create` are used to push background results into the
  live leg, deferred while a response is active (`conversation_already_has_active_response`
  ends the verb otherwise).
* Outbound "ask" legs are also `openai_s2s`, placed with the REST `Calls` API and tagged
  `{mode:'ask', askId}`; `ask_owner`, `report_outcome` and `finish_call` keep both calls open
  for a real back-and-forth. Follow-up outcomes are accepted only after the far end has
  spoken (server VAD, not the transcript).
* Hold music and the typing bed are `dub` tracks on the caller's leg.
* Stuck legs: `POST /v1/Accounts/{sid}/Calls/{callSid}` with `{call_status:'completed'}`.

## Troubleshooting

* **Aria answers but nothing happens on the web** — the Playwright Chromium did not start;
  run `npm run smoke`.
* **No audio / call drops at once** — the jambonz application URL is stale (`npm run register`
  after every tunnel change) or the S2S credential is missing in jambonz.
* **"the tunnel is not ready"** from the launcher — ngrok is down or on another domain.
* **The recap has one audio leg** — build it before restarting the app; the event ring is
  in memory.
