// 2026-11-03 (mick-agentic-browser): the two model lanes behind every
// cascaded turn, and the cheap classifier that picks one.
//
//   fast — small thinking-off model for greetings, chit-chat, yes/no
//          confirmations and "what's on the page" when nothing has to be done.
//   deep — the browsing agent: a tool loop (navigate, click, type, read) on a
//          thinking model, always preceded by a spoken filler so the line never
//          goes quiet.
import { config } from '../config.js';

// Actions handled by a dedicated tool rather than the browser — kept as named patterns so the
// classifier AND the spoken filler can tell a phone request from a chatbot ask from a web task.
const PHONE_RX = /\b(phone(?!\s+numbers?\b)|dial|telephone)\b|\b(call|ring)\s+(my|the|his|her|their|him|them|mum|mom|dad|wife|husband|partner|son|daughter|brother|sister|friend|mate|boss|doctor|dentist|neighbou?r|someone|number|\+?\d)\b|\b(call|ring|phone|dial)\s+(back\s+)?(?:up\s+)?\+?\d/i;
// "call Nic", "ring Dave" — a verb of calling followed by a capitalised proper name. Case-SENSITIVE
// (no /i) so it catches names without misfiring on idioms like "call it a day" or a capitalised
// sentence-start "Call back any time". STT (Deepgram) capitalises names, so this holds for voice too.
const PHONE_NAME_RX = /\b(?:call|ring|phone|dial)\s+[A-Z][a-z]+/;
const CHATBOT_RX = /\bask\s+(hia|the|my|a|an)\b|\bchat(bot)?\b/i;
const BROWSE_PATTERNS = [
  /\b(go to|open|visit|navigate|load|pull up|bring up|take me to|head to)\b/i,
  /\b(search|google|look up|lookup|find me|find|look for|browse)\b/i,
  /\b(click|press|tap|select|choose|pick|scroll|type|enter|fill|submit|log ?in|sign ?in|check ?out|add to (cart|basket)|order|buy|book|reserve)\b/i,
  /\b(website|web ?site|site|page|link|url|dot com|\.com|\.au|\.org|tab)\b/i,
  /\b(what('s| is) on (the|this) page|read (me|it|that|the)|what (does it|do they) say|summar(ise|ize)|next (page|result)|back|previous)\b/i,
  /\b(menu|price|prices|cost|how much|delivery|options?|available|in stock|reviews?|rating|hours|opening)\b/i,
  /\b(uber ?eats|amazon|ebay|wikipedia|youtube|bunnings|coles|woolworths|jb ?hi-?fi|bom|weather|news|abc)\b/i,
  // Follow-up cues on a task already under way (weather especially): "what about the forecast for…",
  // "and tomorrow?", "the rest of the week". These need the page, so they belong on the deep lane.
  /\b(forecast|temperature|degrees|rain|rainfall|humidity|wind|uv|sunrise|sunset|tonight|tomorrow|this (week|weekend)|rest of the (week|day)|next few days)\b/i,
  /^(what about|how about|and )\b/i,
  // 13 Nov: WHERE questions are screen work — drop_pin (a map with a marker on the caller's Personal
  // Voice Browser) lives on the deep lane, so "drop a pin / where is it / nearby / how far" must go there.
  /\b(drop (a|the) pin|pin (it|that|them)|on (a|the) map|where (is|are|'s)|where exactly|directions|address|location|nearby|near (me|here|there|the)|how far|walk(ing)? (time|distance)|meeting (spot|point|place)|closest|nearest)\b/i,
  // Actions handled by a tool, not just chit-chat: phoning a person, or asking an external bot.
  PHONE_RX,
  PHONE_NAME_RX,
  CHATBOT_RX
];
const CHITCHAT_PATTERNS = [
  /^(hi|hello|hey|g'?day|good (morning|afternoon|evening)|how are you|how's it going|thanks?|thank you|cheers|bye|goodbye|see ya|ok(ay)?|cool|nice|yeah|yep|nah|no worries|sweet|lovely)\b/i,
  /\b(joke|how's your day|what's up|tell me about yourself|who are you|what can you do)\b/i
];
const CONFIRM_PATTERNS = [/^(yes|yeah|yep|yup|sure|go ahead|do it|confirm|correct|that's right|ok(ay)?|no|nope|nah|cancel|stop|wait)\b[.!]?$/i];

/** @returns {'fast'|'deep'} */
export function classify(text = '', { pendingConfirmation = false } = {}) {
  const t = String(text).trim();
  if (!t) return 'fast';
  const words = t.split(/\s+/).length;
  // A one-word answer to a pending "shall I…?" belongs to the deep lane (it completes an action).
  if (pendingConfirmation && CONFIRM_PATTERNS.some((re) => re.test(t))) return 'deep';
  if (CHITCHAT_PATTERNS.some((re) => re.test(t)) && words <= 10 && !BROWSE_PATTERNS.some((re) => re.test(t))) return 'fast';
  if (BROWSE_PATTERNS.some((re) => re.test(t))) return 'deep';
  if (words >= 14 && /\?/.test(t)) return 'deep';
  return 'fast';
}

/** True for plain social turns (greeting / thanks / farewell / a bare yes-no) with nothing to do. */
export function isChitChat(text = '') {
  const t = String(text).trim();
  if (!t) return true;
  const words = t.split(/\s+/).length;
  if (/^(yes|yeah|yep|yup|sure|no|nope|nah|ok(ay)?|thanks?|thank you|cheers|bye|goodbye|see ya|cool|nice|great|perfect|awesome)[.!]?$/i.test(t)) return true;
  if (CHITCHAT_PATTERNS.some((re) => re.test(t)) && words <= 6 && !BROWSE_PATTERNS.some((re) => re.test(t))) return true;
  return false;
}

export function laneConfig(lane) {
  return lane === 'deep'
    ? { lane: 'deep', model: config.llm.deepModel, params: { temperature: 0.4, max_tokens: 3000, ...config.llm.deepParams } }
    : { lane: 'fast', model: config.llm.fastModel, params: { temperature: 0.8, max_tokens: 200, ...config.llm.fastParams } };
}

// The opening filler is spoken the instant a deep-lane turn starts — before any tool is chosen —
// so the line never goes quiet. It must match the KIND of request, or we promise the wrong action
// ("let me pull that up" for a phone call makes no sense). Keyed by intent; generic is the safe
// fallback that commits to nothing.
// Fillers now fire ONLY for actions the caller can't see — phoning a person, asking an external bot
// (web tasks show live on screen, so they get none). They should sound easy and human, like a mate
// stepping away for a sec, not a robot announcing a task.
export const FILLERS = {
  phone: ["Yeah, no worries — I'll give them a bell now.", "Righto, let me get them on the line.", "Sure thing, I'll ring them for you — one sec.", "Leave it with me, I'll call them now."],
  chatbot: ["Good question — let me find out for you.", "Yeah, let me check on that, won't be a sec.", "No worries, I'll look into that now.", "Let me ask about that for you."],
  browse: ['Sure, let me have a look.', 'Okay, one sec while I pull that up.', 'Right, let me do that for you.', 'On it. Give me a moment.'],
  generic: ['Sure, let me sort that out.', 'Okay, give me a moment.', 'Right, on it.', 'Let me take care of that.']
};
export const DEEP_FILLERS = FILLERS.browse; // back-compat alias
/** Which kind of deep-lane action does this request imply? Phone/chatbot win over a plain web task. */
// 14 Nov pm: a request that RULES OUT calling ("no phone calls", "don't ring them", "without calling")
// used to pick the phone filler ("I'll ring them for you") for a plain browse. Negated mentions are
// blanked before the phone test; "phone number" (something to look up) never counts as a call either.
const NEGATED_PHONE_RX = /\b(no|not|don'?t|do not|never|without|avoid|skip|rather than|instead of|no need to|needn'?t)\b[^.;!?]{0,24}?\b(phone|phoning|phones|call|calls|calling|ring|ringing|rings|dial|dialing|dialling|telephone)\b(\s+(calls?|anyone|anybody|them|him|her|it|the\s+\w+))?/gi;
export function intentOf(text = '') {
  const t = String(text).replace(NEGATED_PHONE_RX, ' ');
  if (PHONE_RX.test(t) || PHONE_NAME_RX.test(t)) return 'phone';
  if (CHATBOT_RX.test(t)) return 'chatbot';
  if (BROWSE_PATTERNS.some((re) => re.test(t))) return 'browse';
  return 'generic';
}
export function pickFiller(intent = 'generic') {
  const list = FILLERS[intent] || FILLERS.generic;
  return list[Math.floor(Math.random() * list.length)];
}
