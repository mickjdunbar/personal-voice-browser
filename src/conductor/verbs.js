// 2026-11-03 (mick-agentic-browser): jambonz verb builders for the conductor.
//
// Two lanes, one voice family:
//   speech-to-speech — google_s2s (Gemini Live, voice "Aoede")
//   cascaded         — agent verb: jambonz STT + our harness + Chirp 3 HD TTS
//                      of the SAME name (en-AU-Chirp3-HD-Aoede)
// Bridging lines (say verbs) use the cascaded TTS voice, so a hand-off sounds
// like the same person pausing to think, not a transfer.
import { config, harnessUrl } from '../config.js';
import { S2S_PERSONA } from '../agent/persona.js';
import { HOST } from '../agent/team.js';
import { currentTimeLine } from '../clock.js';
import { isChitChat } from '../llm/lanes.js';

export const BROWSE_TOOL_NAME = 'browse_for_caller';
export const TASK_TOOL_NAME = 'start_background_task'; // 13 Nov: long-running jobs, started instantly by the host

export function synthesizer(overrides = {}) {
  return { vendor: config.tts.vendor, language: config.tts.language, voice: config.tts.voice, ...(config.tts.options && Object.keys(config.tts.options).length ? { options: config.tts.options } : {}), ...overrides };
}

export function recognizer(overrides = {}) {
  const r = { vendor: config.stt.vendor, language: config.stt.language, ...(config.stt.options || {}), ...overrides };
  if (config.stt.model && !r.model) r.model = config.stt.model;
  return r;
}

export const configVerb = () => ({ verb: 'config', synthesizer: synthesizer(), recognizer: recognizer() });
export const sayVerb = (text) => ({ verb: 'say', text });
export const hangupVerb = () => ({ verb: 'hangup' });

export function browseToolDeclaration() {
  return {
    name: BROWSE_TOOL_NAME,
    description:
      'Hand the caller to your capable colleague (same voice, same name) for ANY request that needs an ACTION, not just chatting. That includes: anything on the web (open a site, search, find, read, compare, check prices or hours, order, book, fill a form, click, go back), AND phoning a person to ask them something (e.g. "call my wife and ask what she wants for dinner"), AND asking another assistant or chatbot. ' +
      'Your colleague also has the caller\'s saved CONTACT BOOK and knowledge notes: "call my dad" / "ring Sam" needs NO number — pass the request as said and the number is looked up by name automatically. Never ask the caller for a number you were not given, and never say you cannot access their contacts, notes or FAQs — you can, through this tool. ' +
      'Call this the moment such a request arrives, with the request in full. Do NOT try to do it yourself and do NOT say you cannot make calls or do things — your colleague can. ' +
      'SETTINGS of this Personal Voice Browser are ALSO this tool: asking WHICH chatbots or MCP servers / tools are set up (the colleague lists them — read the names back), adding or removing a chatbot / REST endpoint (e.g. a Cognigy endpoint URL), adding or removing an MCP server, or switching the test-dial redirect — pass the request with every URL, name and key exactly as given, and relay the result (your colleague will refuse, politely, if the caller is on a phone line rather than the web page). ' +
      'TEXTING something NOW ("text me that location", "send me the link", "text me the forecast") is THIS tool: the text is sent straight away and the result tells you it was sent — then tell the caller it\'s sent. Only jobs for AFTER the call ("while I\'m off the phone", "later", "WhatsApp me when you have it") go to start_background_task. ' +
      "As you call it, say ONE short, natural line that you're onto it (e.g. \"Let me take a look\" / \"One sec, I'll pull that up\") so the caller isn't left in silence while it's worked on — then wait for the result and read it back warmly and briefly.",
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: "The caller's request, in full, in their words." },
        context: { type: 'string', description: 'One sentence of relevant context from the chat so far.' }
      },
      required: ['request']
    }
  };
}

// 13 Nov: LONG-RUNNING JOBS get their own instant tool on the host. H-07 take 1: "while I'm off the
// phone, work out the walk and WhatsApp me" went through browse_for_caller, the deep lane did the
// research LIVE and then announced "WhatsApp isn't connected" — the caller hung up on "give us a sec".
export function taskToolDeclaration() {
  return {
    name: TASK_TOOL_NAME,
    description:
      'Start a BACKGROUND TASK for something the caller does NOT want to wait on the line for: "while I\'m off the phone…", "later", "in the background", "message me / WhatsApp me / text me (with the answer)", "look into it and let me know", a chunky research job. The task starts the instant you call this, your team works it off the call, and every update is delivered to the caller\'s Tasks channel and their WhatsApp AUTOMATICALLY — you never need a WhatsApp tool and must never say WhatsApp is not connected. ' +
      'Call it IMMEDIATELY with the full request (their words plus any context — places, names, times) and in the same breath say ONE short line that it\'s underway and the answer will come to them on WhatsApp (e.g. "Underway — I\'ll WhatsApp you the walk time."). Then move on; do not wait for it and do not say "give me a sec". ' +
      'NOT for things they want NOW while on the line — "text me that location", "send me the link", "text me the forecast" are immediate sends: those go to browse_for_caller, which sends the text right away and confirms it was sent.',
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The complete job, self-contained: the request in the caller\'s words plus the context needed to do it without them (places, dates, names, numbers already mentioned on this call).' },
        title: { type: 'string', description: 'Optional 3-6 word label, e.g. "Walk time bar to Rogue Bistro".' }
      },
      required: ['request']
    }
  };
}

export function s2sInstructions({ resume } = {}) {
  const base = [S2S_PERSONA()];
  base.push('BACKGROUND JOBS: anything the caller wants done AFTER the call or without waiting ("while I\'m off the phone", "later", "message me / WhatsApp me the answer", "look into it and let me know") goes to the start_background_task tool at once — never browse_for_caller, never done live. Say in ONE line that it\'s underway and will reach them on WhatsApp, then carry on. Never say WhatsApp or messaging is not connected: delivery is automatic. BUT a text they want NOW ("text me that location / the link / the forecast") is browse_for_caller — it is sent on the spot and you confirm "sent" when the result comes back.');
  base.push('NEVER CLAIM AN OUTCOME YOU HAVE NOT BEEN GIVEN: you cannot confirm, book, check or arrange anything with a third party yourself — your team does that and the result reaches you as a message. Until that message arrives, the only truthful thing to say is that they are on it ("they\'re ringing them now"). Never say "confirmed", "booked", "done" or "all set" about a call or a booking before you have the outcome in hand.');
  base.push('EMPTY TURNS: if the caller\'s turn is just a stray word, a cough, background noise or nothing at all, do not answer it — produce no words, or at most a soft "mm-hm". Never fill it with reassurance.');
  base.push('ENDING THE CALL: NEVER end or hang up the call yourself unless the CALLER has clearly and directly told YOU they are finished (an explicit goodbye such as "bye", "that\'s all thanks", "hang up"). A pause or silence, background voices, another phone ringing or playing nearby, a finished task, or your own question going briefly unanswered is NEVER a reason to hang up — stay on the line and gently check in instead. If you are at all unsure, ask "anything else I can do?" and KEEP THE CALL OPEN.');
  base.push('WHILE SOMETHING IS BEING DONE FOR THE CALLER (a colleague is browsing, or a call is being made on their behalf): say ONE short line that it is under way, and that is all you say about it: no progress narration, and no further lines about time, patience or an answer coming (a line like that, once said, is never repeated). If the caller says they\'ll hold or wait, acknowledge in three words or fewer, once. If they merely acknowledge something ("ok", "no worries", "thanks", "sounds good"), reply with two words at most ("No worries." / "Yep.") and nothing about the errand. After that stay comfortably quiet — a little silence on a hold is fine. Small talk is optional and SMALL: at most ONE casual question for the whole wait (how their week is going, the weather or storms tonight, weekend plans); when they answer, reply in a few warm words WITHOUT another question and let the silence sit — never chain questions. Keep it OPEN-ENDED: nothing that sounds like wrapping up or signing off ("fingers crossed", "anyway", "take care", "have a good one") — the caller must never think the call is ending while work is in progress. Never ask them to re-confirm what they asked for. When the result arrives, deliver it straight away and move to the natural next step yourself ("Table\'s confirmed — want me to pop it in your calendar?").');
  if (resume?.reconnect) {
    base.push(
      'The AUDIO LINK just dropped for a moment and reconnected MID-CONVERSATION. Do NOT greet or introduce yourself again — acknowledge the blip in one short casual line ("sorry, dropped out for a sec — where were we?") and pick up exactly where the conversation left off.'
    );
  } else if (resume) {
    base.push(
      'You are RESUMING a conversation that is already under way after a brief technical blip. Do NOT greet, do NOT say "welcome back", "good to have you back", "what\'s on your mind" or anything that sounds like a fresh start — the caller never left.',
      `Where things stand: ${resume.summary || 'the caller is mid-request'}.`,
      ...(resume.inflight ? [`IN PROGRESS RIGHT NOW: ${resume.inflight}. Do NOT call browse_for_caller, start_background_task or any other tool for it again — it is already being done; a second attempt would place a second phone call or repeat the work. Just wait for the message.`] : []),
      `Read THE CONVERSATION SO FAR below and carry on from the LAST line exactly as if nothing happened: if a result had just arrived, deliver it; if something was pending, say in a few words that you are still on it; if the caller had just asked for something${resume.inflight ? ' that is NOT already in progress' : ''}, act on it now with the right tool. One short sentence, then continue.`
    );
  }
  return base.join(' ');
}

/** Speech-to-speech verb (Gemini Live). */
export function s2sVerb({ resume, transcript, callerContext, opening } = {}) {
  const instructions = s2sInstructions({ resume }) + '\n\n' + currentTimeLine();
  const ctxNote = callerContext ? `\n\nABOUT THE CALLER (personalize naturally — never read it back or say you have notes on them):\n${callerContext}` : '';
  // 15 Nov: a typed "hello" / "hi" / "how are you" is NOT a request — before this Aria "dived right
  // in" and browsed for "hello". Only an opening with something to do triggers the tool.
  const justHello = Boolean(opening) && isChitChat(opening);
  // 15 Nov: `response.create.instructions` REPLACES the session instructions for that one response,
  // so the opening greeting never saw S2S_PERSONA's "Speak Australian English" and gpt-realtime opened
  // in Portuguese ("Oi, beleza? Bora lá…") to an English caller. Pin it on every greeting variant.
  const LANG_PIN = 'LANGUAGE: English only — relaxed Australian English (the caller is English-speaking). ';
  const openNote = !opening ? '' : justHello
    ? `\n\nTHE CALLER'S FIRST MESSAGE (they typed this to start the call): "${opening}". That is just a hello, not a request: greet them back warmly in one short line and ask what's up. Do NOT call any tool until they ask for something.`
    : `\n\nTHE CALLER'S FIRST MESSAGE (they typed this to start the call): "${opening}". Open by greeting them warmly and briefly and showing you're onto THIS, then IMMEDIATELY call browse_for_caller with it. Do not ask what they'd like to do — they've told you.`;
  const openingGreeting = LANG_PIN + (opening ? (justHello
    ? `The caller opened by typing: "${opening}" — just a hello. Say hi back like a mate — casual, one short line (you're ${HOST.name}; use their name if you know it) — and ask what they're after. Do NOT call any tool yet.`
    : `The caller opened by typing: "${opening}". Greet them like a mate — casual, playful, first-name basis (you're ${HOST.name}; use their name if you know it) — show you're onto it, and IMMEDIATELY call browse_for_caller with that request — do NOT ask what they want.`)
    : `Greet the caller like a mate you're happy to hear from — casual and playful ("Hey hey!", "G'day!"), say you're ${HOST.name}, and ask what they're up to in a relaxed way ("what are we getting up to today?", "what's the plan?"). NEVER stiff service lines like "How can I be of service" or "How may I assist you today".`);
  // The google path threads the transcript via setup below; the openai path needs it in the
  // instructions, or a reconnect resume starts with amnesia.
  const transcriptNote = Array.isArray(transcript) && transcript.length
    ? `\n\nTHE CONVERSATION SO FAR (you are mid-chat — this already happened):\n${transcript.slice(-8).map((t) => `${t.role === 'assistant' ? 'You' : 'Caller'}: ${t.text}`).join('\n')}`
    : '';
  const common = { actionHook: '/s2s-done', eventHook: '/s2s-event', toolHook: '/s2s-tool', hangup: { reason: 'caller_done' } };
  if (config.s2s.vendor === 'openai') {
    // Shape matches jambonz's proven openai_s2s example (flat `modalities`/`voice`/`output_audio_format`
    // + server_vad), NOT the GA `type:'realtime'` nested-`audio` schema — our earlier GA shape connected
    // and relayed the transcript but produced NO AUDIO, because jambonz needs `output_audio_format` and
    // `modalities:['text','audio']` to decode and play the model's voice. model/voice still come from
    // .env, so Cedar on gpt-realtime works here; if it ever errors, fall back to S2S_MODEL=
    // gpt-4o-realtime-preview-2024-12-17 + an older S2S_VOICE (alloy/echo/shimmer).
    const fmt = config.s2s.audioFormat;
    return {
      verb: 'openai_s2s',
      model: config.s2s.model.startsWith('models/') ? 'gpt-realtime' : config.s2s.model,
      ...(config.s2s.openaiApiKey ? { auth: { apiKey: config.s2s.openaiApiKey } } : config.s2s.openaiLabel ? { label: config.s2s.openaiLabel } : {}),
      events: ['conversation.item.*', 'response.created', 'response.audio_transcript.done', 'response.output_audio_transcript.done', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'error'],
      llmOptions: {
        response_create: {
          modalities: ['text', 'audio'],
          voice: config.s2s.voice,
          output_audio_format: fmt,
          instructions: resume ? LANG_PIN + 'Pick the conversation back up in one short warm sentence.' : openingGreeting
        },
        session_update: {
          instructions: instructions + ctxNote + openNote + transcriptNote,
          voice: config.s2s.voice,
          input_audio_format: fmt,
          output_audio_format: fmt,
          input_audio_transcription: { model: 'whisper-1', language: 'en' },
          // Barge-in tuning: 0.5/500 was too hair-trigger — echo and room noise kept cancelling the
          // model's own audio mid-sentence (lots of interruptions / unfinished speech). Higher
          // threshold = needs clearer speech to count as a barge-in; longer silence = fewer false
          // end-of-turn cuts. Overridable via env without a code change.
          turn_detection: {
            type: 'server_vad',
            // 0.5 was hair-trigger (echo barged Aria mid-sentence) BEFORE the console asked the
            // browser for an echo-cancelled mic; 0.68 turned out DEAF on a real web call (9 Nov).
            // 0.55 fixed turn-taking but blocked TALK-OVER (10 Nov: barge-in never registered —
            // browser AEC ducks the mic while her audio plays, so interrupting speech arrives
            // quiet). 0.5 with AEC on is the interruptible middle; still env-tunable.
            threshold: Number(process.env.S2S_VAD_THRESHOLD || 0.5),
            prefix_padding_ms: Number(process.env.S2S_VAD_PREFIX_MS || 300),
            silence_duration_ms: Number(process.env.S2S_VAD_SILENCE_MS || 720)
          },
          tools: [{ type: 'function', ...browseToolDeclaration() }, { type: 'function', ...taskToolDeclaration() }, relayToolDeclaration()],
          tool_choice: 'auto'
        }
      },
      ...common
    };
  }
  const setup = {
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.s2s.voice } } } },
    systemInstruction: { parts: [{ text: instructions + ctxNote + openNote }] },
    tools: [{ functionDeclarations: [browseToolDeclaration(), taskToolDeclaration()] }],
    realtimeInputConfig: { automaticActivityDetection: { prefixPaddingMs: 60, silenceDurationMs: 500 } },
    outputAudioTranscription: {},
    inputAudioTranscription: {}
  };
  // On gemini-3.8-live the flag lives under generationConfig (setup-level = 1007 Unknown name).
  if (config.s2s.affective) setup.generationConfig.enableAffectiveDialog = true;
  if (config.s2s.proactive) setup.proactivity = { proactiveAudio: true };
  if (Array.isArray(transcript) && transcript.length) {
    setup.systemInstruction.parts.push({ text: `Recent conversation:\n${transcript.slice(-8).map((t) => `${t.role === 'assistant' ? 'You' : 'Caller'}: ${t.text}`).join('\n')}` });
  }
  return {
    verb: 'google_s2s',
    model: config.s2s.model,
    auth: { apiKey: config.s2s.geminiApiKey },
    events: ['llm_event', 'error', 'session.*'],
    llmOptions: {
      setup,
      greeting: resume
        ? 'Pick the conversation back up in one short, warm sentence. Do not greet again.'
        : openingGreeting
    },
    ...common
  };
}

export const ASK_FINISH_TOOL = 'finish_call';
export const ASK_OWNER_TOOL = 'ask_owner';
export const ASK_REPORT_TOOL = 'report_outcome';
export const RELAY_TOOL = 'relay_to_callee';

/** Tool on the MAIN call: pass the caller's words to the person on a live outbound ask-call.
 * The counterpart of ask_owner/report_outcome — together they keep both calls open for a real
 * back-and-forth: answers, follow-up questions, and the final "that's everything, thanks". */
export function relayToolDeclaration() {
  return {
    type: 'function',
    name: RELAY_TOOL,
    description:
      'ONLY after a background note says your colleague has a QUESTION or an OUTCOME from the person on the other call, and the caller has then answered THAT out loud: call this with their words — the answer, a follow-up to ask, or that the caller needs nothing more (then your colleague wraps the call up). ' +
      'The tool is what delivers it — saying it aloud is not enough. NEVER use it for "I\'ll hold", "take your time", "sure", small talk, or before such a note has arrived — nothing is waiting for those.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: "The caller's answer, follow-up, or a short wrap-up like \"that's everything, thanks\" — one short sentence." } },
      required: ['message']
    }
  };
}

/**
 * Speech-to-speech verb for an OUTBOUND "ask" call to a PERSON (call Dad, ask a question,
 * bring the answer back). Realtime latency makes the far-end conversation natural — the old
 * gather→LLM→say loop had 1-2 s dead air after every line. OpenAI Realtime only; business/IVR
 * calls stay on the DTMF-capable gather loop (an S2S model cannot press keys).
 */
export function askS2sVerb(ask) {
  const fmt = config.s2s.audioFormat;
  const who = String(ask.onBehalfOf || config.agentName).trim();
  const q = String(ask.question || '').trim();
  const nameRaw = String(ask.name || '').trim();
  const name = nameRaw && !/^(them|there|someone)$/i.test(nameRaw) ? nameRaw : '';
  const THEM = name || 'the person';
  const instructions = [
    // LANGUAGE pin FIRST: with no audio context yet, an unanchored Realtime model opens in a
    // random language (9 Nov: it rang Mick's dad and spoke German). The main call never does
    // this only because S2S_PERSONA says "Speak Australian English".
    'LANGUAGE: Speak ENGLISH ONLY — relaxed Australian English. Open in English and stay in English: never switch because the line is noisy, the first sounds are unclear, or you THINK you hear another language. The single exception: if the person EXPLICITLY changes language — they clearly address you in another language or ask you to speak one — you may follow them in it, and come back to English the moment they do.',
    // Role anchor: a Realtime model's reflex on hearing "hello?" is to ANSWER a call like an
    // assistant — 10 Nov it opened an outbound call with "How can I help you?". Pin the role hard.
    `YOU ARE THE CALLER. YOU placed this outbound call — ${THEM} did NOT ring you, has no idea who you are or why the phone rang, and is not a customer of yours. YOU want something from THEM. NEVER say "How can I help you", "How may I assist", "What can I do for you" or anything that treats them as having called you — if those words are about to come out, the correct line is the opposite: say who you are and why YOU are ringing. If THEY answer with "how can I help?" (a business, a receptionist), that is your cue to state your business, not to mirror them.`,
    `You are ${HOST.name}, ${who}'s assistant, ringing ${THEM} for ${who}. You sound like a real, relaxed person on an everyday phone call — never a service bot working through a script.`,
    `WHY YOU'RE RINGING: ${q}`,
    ...(ask.kind === 'business' ? [`THIS IS A BUSINESS (a venue, shop or office — whoever answers is staff): after the human opening, state the request plainly in one or two easy lines (for a booking: the day, time, party size and the name it's under), read those key details back ONCE, then take their answer — confirmed, an alternative time, or not possible. If they ask something only ${who} would know, use ${ASK_OWNER_TOOL}. Keep it brisk and friendly; staff are busy.`] : []),
    `OPEN LIKE A HUMAN: react to the pickup first ("Oh hi${name ? ` ${name}` : ' there'}!" to their hello), say who you are in one easy line — "it's ${HOST.name}, ${who}'s assistant" — and give them a beat to respond BEFORE you get into why you're calling. Never deliver the intro and the request as one rushed speech, and never open with the question cold.`,
    `HAVE A CONVERSATION, NOT A SCRIPT: respond to what they actually say and match their energy. Short lines, contractions, natural touches ("yeah", "no worries", "oh lovely"). If they chat for a moment, chat back warmly, then steer gently to the reason you rang. Put the request in your OWN words — never read it out like a form. Read a detail back only when it's easy to get wrong (an order, a time, an address), and only once.`,
    `IF ${THEM.toUpperCase()} ASKS SOMETHING ONLY ${who.toUpperCase()} WOULD KNOW (a time, a place, a preference): one easy line that you'll check ("good question — hang on half a sec, I'll check") and call ${ASK_OWNER_TOOL} with their question. ${who} hears it straight away; the answer comes back to you here as a message — pass it on naturally and carry on. Use it as often as needed. NEVER invent an answer, and NEVER end the call while one of their questions is unanswered.`,
    `WHEN YOU HAVE WHAT YOU RANG FOR: do NOT say goodbye yet. Call ${ASK_REPORT_TOOL} with the outcome in one short sentence — it reaches ${who} straight away, while ${THEM} is still on the line. Keep things light while you wait (a natural aside at most — never mention tools, systems or "checking with the app"). The reply arrives as a message: either a follow-up from ${who} to carry on with, or that ${who} needs nothing more — THEN wrap up warmly, say goodbye, and call ${ASK_FINISH_TOOL} with the final outcome.`,
    `ENDING THE CALL — it ends in exactly two ways, no others: (1) ${THEM} says goodbye or clearly needs to go — never hold them; thank them warmly, say goodbye, then call ${ASK_FINISH_TOOL}; (2) you've reported the outcome via ${ASK_REPORT_TOOL} and the reply says ${who} needs nothing more (or the tool tells you ${who} can't be reached live). NEVER hang up for any other reason: a pause, silence, background noise, an awkward beat or an unanswered line of yours is NEVER a reason to end the call — check in gently ("you still there?") and stay on.`,
    `IF SOMEONE ANSWERS FOR ${THEM.toUpperCase()} — a partner, a receptionist, or a digital/AI assistant that takes ${THEM}'s calls: they CAN answer on ${THEM}'s behalf. Put the question to them exactly as you would to ${THEM}, take their answer, and report it (mention it came via their assistant). NEVER give up, hang up, or report "reached an assistant" without asking the question — an assistant answering is a normal pickup, not a dead end.`,
    `THE MOMENT YOU HAVE THE ANSWER (a booking confirmed, a yes/no, a reference number), call ${ASK_REPORT_TOOL} IMMEDIATELY — before thanking them, before any pleasantries — because the other side may hang up right after answering and an unreported answer is lost. Report it in their words (include any reference or confirmation they gave). Then say thanks and goodbye.`,
    `If voicemail answers: leave one short message (who you are, why you called), then call ${ASK_FINISH_TOOL} with reached:"voicemail" and an empty answer.`,
    `If an automated menu answers: you cannot press keys — call ${ASK_FINISH_TOOL} with reached:"ivr" and an empty answer.`,
    `Never discuss anything beyond the goal, never share ${who}'s personal details, and never stay on a call that turns hostile — wrap up politely and call ${ASK_FINISH_TOOL}.`,
    currentTimeLine()
  ].join('\n');
  return {
    verb: 'openai_s2s',
    model: config.s2s.model.startsWith('models/') ? 'gpt-realtime' : config.s2s.model,
    ...(config.s2s.openaiApiKey ? { auth: { apiKey: config.s2s.openaiApiKey } } : config.s2s.openaiLabel ? { label: config.s2s.openaiLabel } : {}),
    events: ['conversation.item.*', 'response.created', 'response.audio_transcript.done', 'response.output_audio_transcript.done', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'error'],
    llmOptions: {
      response_create: {
        modalities: ['text', 'audio'],
        voice: config.s2s.voice,
        output_audio_format: fmt,
        // The far end answers with "hello?" — wait for it, don't talk over the pickup.
        instructions: 'You are the CALLER on an outbound call YOU placed — the person answering did not call you. Wait for them to answer. When you hear them speak (or after a couple of seconds of silence), open the call IN ENGLISH as instructed: say who you are and why you are ringing. NEVER ask "how can I help you" — they called no one; you rang THEM.'
      },
      session_update: {
        instructions,
        voice: config.s2s.voice,
        input_audio_format: fmt,
        output_audio_format: fmt,
        input_audio_transcription: { model: 'whisper-1', language: 'en' },
        turn_detection: {
          type: 'server_vad',
          threshold: Number(process.env.S2S_VAD_THRESHOLD || 0.5),
          prefix_padding_ms: Number(process.env.S2S_VAD_PREFIX_MS || 300),
          silence_duration_ms: Number(process.env.S2S_VAD_SILENCE_MS || 720)
        },
        tools: [{
          type: 'function',
          name: ASK_FINISH_TOOL,
          description: `Ends the call. Call it once, AFTER you have said goodbye, and ONLY when either (a) the person said goodbye / had to go, or (b) ${ASK_REPORT_TOOL} already carried the outcome to ${who} and the reply said nothing more is needed (or ${who} was unreachable). Never because of silence or a pause, and never while a question is unanswered.`,
          parameters: {
            type: 'object',
            properties: {
              answer: { type: 'string', description: 'The final outcome of the whole call, as one short sentence to report back (including any follow-ups). Empty if no answer was obtained.' },
              reached: { type: 'string', enum: ['person', 'voicemail', 'ivr', 'no_answer'], description: 'Who or what answered the call.' }
            },
            required: ['answer']
          }
        }, {
          type: 'function',
          name: ASK_OWNER_TOOL,
          description: `MID-CALL: pass a question from the person you're calling back to ${who} (they can hear you on another line) — use it the moment they ask something only ${who} would know. The reply arrives here later as a message — stay on the call and keep chatting naturally while you wait. For reporting the finished outcome, use ${ASK_REPORT_TOOL} instead.`,
          parameters: {
            type: 'object',
            properties: { question: { type: 'string', description: 'Their question, briefly, in the third person (e.g. "Does 12:30 work instead?").' } },
            required: ['question']
          }
        }, {
          type: 'function',
          name: ASK_REPORT_TOOL,
          description: `GOAL DONE: carry the outcome to ${who} while the person is STILL on the line, so ${who} can fire back a follow-up before you hang up. Call it the moment you have what you rang for — BEFORE any goodbye. The result tells you what happens next: wait for ${who}'s message (follow-up or all-done), or wrap up now if ${who} isn't reachable.`,
          parameters: {
            type: 'object',
            properties: { outcome: { type: 'string', description: 'The outcome so far, one short sentence (e.g. "Dad says fish and chips sounds great for dinner").' } },
            required: ['outcome']
          }
        }],
        tool_choice: 'auto'
      }
    },
    actionHook: '/ask-s2s-done',
    eventHook: '/ask-s2s-event',
    toolHook: '/ask-s2s-tool',
    hangup: { reason: 'ask_done' }
  };
}

/** An override of 0 / null removes the field. */
export function stripZero(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === 0 || obj[k] === null) delete obj[k];
  return obj;
}

/** The cascaded lane: jambonz STT -> our harness (navigator) -> jambonz TTS. */
export function agentVerb({ metadata, greeting = true, bargeIn, noResponseTimeout = config.agentVerb.noResponseTimeout, firstChunkTimeoutMs = config.agentVerb.firstChunkTimeoutMs, holdingPhrase = 'One sec.', session = 'main' }) {
  const llm = {
    vendor: 'harness',
    harness: {
      url: harnessUrl('navigator') + `&session=${encodeURIComponent(session)}`,
      metadata: { role: 'navigator', session, ...metadata },
      firstChunkTimeoutMs,
      holdingPhrase,
      onHarnessFailure: { say: "Sorry, I'm having trouble on my end. Let's try again in a moment." }
    }
  };
  if (config.harnessCredentialLabel) llm.label = config.harnessCredentialLabel;
  return {
    verb: 'agent',
    stt: stripZero(recognizer()),
    tts: synthesizer(),
    llm,
    greeting,
    // Acoustic echo of the agent's own TTS and brief noises were counting as the caller barging in
    // and chopping the agent off mid-sentence; require sustained speech to confirm (see config).
    bargeIn: bargeIn || { enable: true, minSpeechDuration: config.agentVerb.bargeInMinSpeech },
    noResponseTimeout,
    speechCleanup: false,
    actionHook: '/agent-done',
    eventHook: '/agent-event',
    turnDetection: config.agentVerb.turnDetection,
    ...config.agentVerb.options
  };
}
