// 2026-11-03 (mick-agentic-browser): central env config. Everything here is
// service-level plumbing; per-call behaviour travels in call metadata.
// See .env.example for what each knob means.
const json = (v, fallback) => {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const geminiKey = process.env.GEMINI_API_KEY || '';

export const config = {
  port: num(process.env.PORT, 3005),
  publicHost: (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),

  // Bearer secret Agent Studio sends on the /harness upgrade (optional).
  harnessSecret: process.env.HARNESS_SECRET || '',
  // Shared secret for the conductor's /ws hook: the verbs it returns carry the
  // Gemini key inline (google_s2s needs it), so anything public must set it.
  wsSecret: process.env.WS_SECRET || '',
  harnessCredentialLabel: process.env.HARNESS_CREDENTIAL_LABEL || '',

  llm: {
    baseURL: process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    // One key covers both lanes: an explicit LLM_API_KEY wins; otherwise, when pointed at OpenAI use
    // OPENAI_API_KEY ONLY (never fall back to the Gemini key — it would 401 on OpenAI); else Gemini.
    apiKey: process.env.LLM_API_KEY || (/\bapi\.openai\.com\b/.test(process.env.LLM_BASE_URL || '') ? (process.env.OPENAI_API_KEY || '') : geminiKey),
    // fast = chit-chat / confirmations (thinking off); deep = browsing + transactions (tool loop)
    fastModel: process.env.FAST_MODEL || 'gemini-3.5-flash-lite',
    deepModel: process.env.DEEP_MODEL || 'gemini-3.6-flash',
    fastParams: json(process.env.FAST_MODEL_PARAMS, {}),
    deepParams: json(process.env.DEEP_MODEL_PARAMS, { reasoning_effort: 'low' }),
    summaryModel: process.env.SUMMARY_MODEL || process.env.FAST_MODEL || 'gemini-3.5-flash-lite',
    // Send a downscaled screenshot with each deep-lane request (multimodal grounding).
    vision: bool(process.env.BROWSER_VISION, true),
    maxToolRounds: num(process.env.MAX_TOOL_ROUNDS, 8)
  },

  s2s: {
    vendor: process.env.S2S_VENDOR || 'google',
    model: process.env.S2S_MODEL || 'models/gemini-3.8-live',
    voice: process.env.S2S_VOICE || 'Aoede',
    // OpenAI Realtime audio PCM format jambonz uses to decode the model's audio into the call. The
    // jambonz openai_s2s example uses 'pcm16'; if the voice is silent (transcript but no audio) try
    // 'g711_ulaw'. Only used by the openai branch.
    audioFormat: process.env.S2S_AUDIO_FORMAT || 'pcm16',
    affective: bool(process.env.S2S_AFFECTIVE, false),
    proactive: bool(process.env.S2S_PROACTIVE, false),
    geminiApiKey: geminiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiLabel: process.env.OPENAI_S2S_LABEL || '',
    // ONE VOICE: when true (default), browse_for_caller runs the team in the BACKGROUND and the result
    // is returned to the S2S host (Aria) who speaks it — the call never leaves her leg, so the whole
    // call is one voice (Cedar) at Realtime latency. false = the old behaviour: redirect/swap to the
    // cascaded specialist leg (Chirp voice) for the work.
    backgroundBrowse: bool(process.env.S2S_BACKGROUND_BROWSE, true)
  },

  tts: {
    vendor: process.env.TTS_VENDOR || 'google',
    voice: process.env.TTS_VOICE || 'en-AU-Chirp3-HD-Aoede',
    language: process.env.TTS_LANGUAGE || 'en-AU',
    options: json(process.env.TTS_OPTIONS, { apiMode: 'live' })
  },
  stt: {
    vendor: process.env.STT_VENDOR || 'google',
    language: process.env.STT_LANGUAGE || 'en-AU',
    model: process.env.STT_MODEL || '',
    options: json(process.env.STT_OPTIONS, {})
  },
  // 2026-11-03: Google STT inside the agent verb on jambonz.cloud never ends the turn
  // with turnDetection 'stt'; Krisp's acoustic end-of-turn is included and works.
  agentVerb: {
    turnDetection: process.env.AGENT_TURN_DETECTION || 'krisp',
    // Seconds of sustained caller speech required to confirm a barge-in. 0.5-0.7 let the echo of the
    // agent's OWN voice (and brief noises) cut it off mid-sentence; paired with mic echo-cancellation
    // on the softphone, 1.2 means only a real, sustained interruption stops it while genuine barge-ins
    // still work. (Echo cancellation is the primary fix; this is the safety net.)
    bargeInMinSpeech: num(process.env.AGENT_BARGEIN_MIN_SPEECH, 1.2),
    // Seconds jambonz waits for the caller before ending the agent verb (→ /agent-done → hangup).
    // 15 s was too short: a web task now stays SILENT while browsing (the screen is the feedback), so
    // a multi-round search exceeded it and the call hung up mid-search (~22 s). 60 s lets a search
    // finish; the harness's OWN idle watchdog (nudge ~14 s, graceful goodbye) handles real silence
    // after the answer, well before this fires.
    noResponseTimeout: num(process.env.AGENT_NO_RESPONSE_TIMEOUT, 60),
    // Milliseconds jambonz waits for the harness's FIRST streamed token before declaring it failed
    // (→ closes the harness WS → speaks onHarnessFailure "having trouble on my end"). 4 s was fine
    // when a filler was written instantly, but a silent web browse now produces no user-facing chunk
    // until the answer is ready (2+ browse rounds ≈ 10-20 s, cold browser more), so 4 s falsely
    // failed a working search. 45 s covers a multi-round browse and still sits under noResponseTimeout
    // (60 s); a genuinely thrown harness error surfaces at once (it writes errorReply = a chunk), so
    // this only governs the slow-but-working case.
    firstChunkTimeoutMs: num(process.env.AGENT_FIRST_CHUNK_TIMEOUT_MS, 45000),
    options: json(process.env.AGENT_VERB_OPTIONS, {})
  },

  browser: {
    headless: bool(process.env.BROWSER_HEADLESS, false),
    // Hidden (default): keep a REAL headed browser (so sign-ins and anti-bot work) but park its
    // window off-screen so it never covers your desktop. The console screenshot stream still works
    // because the occlusion/throttling flags keep it rendering. Set BROWSER_HIDDEN=false to bring the
    // window on-screen (e.g. to sign in to a site), or BROWSER_HEADLESS=true for no browser at all.
    hidden: bool(process.env.BROWSER_HIDDEN, true),
    // Persistent profile: log in to sites yourself in this window once; the agent reuses the session.
    profileDir: process.env.BROWSER_PROFILE_DIR || '.profile',
    viewport: { width: num(process.env.BROWSER_WIDTH, 1280), height: num(process.env.BROWSER_HEIGHT, 800) },
    homeUrl: process.env.BROWSER_HOME_URL || 'https://www.bing.com/',
    // 2026-11-03: Bing renders for headless Chromium; Google and DuckDuckGo block automation.
    searchUrl: process.env.BROWSER_SEARCH_URL || 'https://www.bing.com/search?q={q}',
    navTimeoutMs: num(process.env.BROWSER_NAV_TIMEOUT_MS, 20000),
    screenshotQuality: num(process.env.BROWSER_SCREENSHOT_QUALITY, 45),
    screenshotIntervalMs: num(process.env.BROWSER_SCREENSHOT_INTERVAL_MS, 1500),
    maxSnapshotChars: num(process.env.BROWSER_MAX_SNAPSHOT_CHARS, 9000),
    // Domains the agent may never submit a purchase/payment on without the SOP confirmation step.
    blockedHosts: (process.env.BROWSER_BLOCKED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)
  },

  kb: {
    sopsDir: process.env.KB_SOPS_DIR || 'sops',
    knowledgeDir: process.env.KB_KNOWLEDGE_DIR || 'knowledge',
    // Long-term memory (12 Nov): self-learned docs (contacts, venues, URLs, preferences) written
    // by the Memorist agent and editable by hand in the Knowledge drawer. Same markdown+Qdrant
    // machinery as the other kinds; each doc carries a self-learning scorecard in `meta`.
    memoryDir: process.env.KB_MEMORY_DIR || 'memory',
    // Optional semantic retrieval on top of BM25 (Gemini embeddings via the OpenAI-compatible endpoint).
    embeddings: bool(process.env.KB_EMBEDDINGS, false),
    embeddingModel: process.env.KB_EMBEDDING_MODEL || 'gemini-embedding-001',
    // Embeddings keep their OWN base + key, independent of the chat lane. The Qdrant collection was
    // built with Gemini embeddings, so even when the chat/S2S models move to OpenAI the query vectors
    // must stay on the SAME embedding model/endpoint or retrieval breaks (mismatched vector space).
    embeddingBaseURL: process.env.KB_EMBEDDING_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    embeddingApiKey: process.env.KB_EMBEDDING_API_KEY || geminiKey,
    topK: num(process.env.KB_TOP_K, 3)
  },

  jambonz: {
    apiKey: process.env.JAMBONZ_API_KEY || '',
    accountSid: process.env.JAMBONZ_ACCOUNT_SID || '',
    apiBase: (process.env.JAMBONZ_API_BASE || 'https://api.jambonz.cloud').replace(/\/$/, ''),
    applicationSid: process.env.JAMBONZ_APPLICATION_SID || '',
    fromNumber: process.env.JAMBONZ_FROM_NUMBER || '',
    selfRegister: bool(process.env.JAMBONZ_SELF_REGISTER, false),
    registerSids: (process.env.JAMBONZ_REGISTER_APPLICATION_SIDS || process.env.JAMBONZ_APPLICATION_SID || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
  },

  // Atmosphere: looping audio beds dubbed UNDER the live call (jambonz `dub`
  // tracks) so the caller never sits in dead silence. A soft room tone plays
  // for the whole call; a quiet typing clatter fades in while a specialist is
  // working the browser and fades out on hand-back. Needs PUBLIC_HOST set (the
  // feature server fetches the WAVs over the tunnel) and a feature server that
  // supports dub.
  // 12 Nov: levels raised to be clearly audible on a handset (-34/-30 dB were effectively
  // silence), and a third track — a warm HOLD pad — plays on the caller's leg for the whole
  // time an outbound call is being made on their behalf.
  ambience: {
    enabled: bool(process.env.AMBIENCE_ENABLED, true),
    // Mix levels applied to loops normalised to -1 dBFS peak (scripts/make-audio.mjs):
    // bed = soft room tone under speech · typing = clearly-there clatter while a specialist
    // works · hold = a present but gentle pad while an outbound call is made for the caller.
    bedGain: process.env.AMBIENCE_BED_GAIN || '-30 dB',
    typingGain: process.env.AMBIENCE_TYPING_GAIN || '-20 dB',
    holdGain: process.env.AMBIENCE_HOLD_GAIN || '-16 dB',
    bedFile: process.env.AMBIENCE_BED_FILE || 'ambience.wav',
    typingFile: process.env.AMBIENCE_TYPING_FILE || 'typing.wav',
    holdFile: process.env.AMBIENCE_HOLD_FILE || 'hold.wav'
  },

  // External chatbots are no longer configured here — they live in a runtime registry edited from
  // the console (Talk Settings → Chatbots) and persisted to .chatbots.json. See src/chat/bots.js.

  // "Phone a person for the answer": the agent places a short outbound call, asks one question and
  // brings back the answer. OFF by default (it dials real phones + costs money). Needs jambonz
  // outbound calling + a caller ID (PHONE_ASK_FROM, else JAMBONZ_FROM_NUMBER).
  phoneAsk: {
    enabled: bool(process.env.PHONE_ASK_ENABLED, false),
    fromNumber: process.env.PHONE_ASK_FROM || process.env.JAMBONZ_FROM_NUMBER || '',
    // Ms to let the spoken "I'm ringing X now" confirmation play before the outbound dial actually
    // fires, so the caller hears it BEFORE the person picks up (the call API has no TTS latency).
    leadMs: num(process.env.PHONE_ASK_LEAD_MS, 2500),
    // Person calls run on the Realtime S2S model (snappy, natural); business/IVR calls always use
    // the DTMF-capable gather loop. PHONE_ASK_S2S=0 forces every ask call onto the gather loop.
    s2s: bool(process.env.PHONE_ASK_S2S, true)
  },

  // Tasks over SMS / WhatsApp: the Tasks channel reached from the owner's phone (Twilio
  // Messaging webhooks in, Twilio REST out). OFF until OWNER_PHONE is set — the webhook
  // ignores every sender that is not the owner, and with no owner nothing gets through.
  tasks: {
    // The owner's own mobile in E.164 (+614…): the ONLY number the webhook accepts, and
    // where task updates are sent.
    ownerPhone: process.env.OWNER_PHONE || '',
    // Forward EVERY Aria task reply to the owner's phone on this channel ('whatsapp' | 'sms'),
    // so updates arrive even when no console is open. '' = only tasks STARTED from a phone
    // message reply on that same channel.
    notify: /^(whatsapp|sms)$/i.test(process.env.TASK_NOTIFY || '') ? process.env.TASK_NOTIFY.toLowerCase() : '',
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      // Same constraint as the MCP SMS path: the toll-free is the account's only SMS-capable sender.
      smsFrom: process.env.SMS_FROM || '+18558713724',
      // Twilio's shared WhatsApp SANDBOX number — works without Meta business verification
      // (join the sandbox once from the owner's phone). Replace after registering a real sender.
      whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '+14155238886'
    }
  },

  agentName: process.env.AGENT_NAME || 'Mick',
  logLevel: process.env.LOG_LEVEL || 'info'
};

/** https://<public host>/audio/<file> — a URL the jambonz feature server can fetch, or '' on localhost-only. */
export function audioUrl(file) {
  if (!config.publicHost) return '';
  return `https://${config.publicHost}/audio/${file}`;
}

/** wss://<host>/harness — what jambonz dials to reach the harness. */
export function harnessUrl(role) {
  const host = config.publicHost || `localhost:${config.port}`;
  const scheme = /^(localhost|127\.0\.0\.1)/.test(host) ? 'ws' : 'wss';
  return `${scheme}://${host}/harness${role ? `?role=${encodeURIComponent(role)}` : ''}`;
}

/** wss://<host>/ws[?token=…] — what jambonz applications must point at. */
export function conductorUrl(host = config.publicHost) {
  const h = host || `localhost:${config.port}`;
  const scheme = /^(localhost|127\.0\.0\.1)/.test(h) ? 'ws' : 'wss';
  return `${scheme}://${h}/ws${config.wsSecret ? `?token=${encodeURIComponent(config.wsSecret)}` : ''}`;
}

export function validateConfig(logger) {
  if (!config.llm.apiKey) logger.warn('No LLM_API_KEY / GEMINI_API_KEY: model turns will fail');
  if (!config.publicHost) logger.warn('PUBLIC_HOST unset: harness URL falls back to localhost (fine for the smoke test and the text console only)');
  if (config.publicHost && !config.wsSecret) logger.warn('WS_SECRET unset: /ws is OPEN and the verbs it returns carry the Gemini key; set WS_SECRET and re-register the application');
  if (config.s2s.vendor === 'google' && !config.s2s.geminiApiKey) logger.warn('S2S vendor google needs GEMINI_API_KEY');
}
