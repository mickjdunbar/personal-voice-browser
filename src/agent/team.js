// 2026-11-03 (mick-agentic-browser): the TEAM. The caller is on one call with a
// collective of agents, not a single bot. One agent speaks at a time; all of
// them listen to the same transcript and can act on what they hear.
//
//   host        — the speech-to-speech voice. Talks to the caller: greeting,
//                 small talk, keeping the line warm, introducing a specialist
//                 and welcoming the caller back when a task is done.
//   specialists — domain experts that run on the cascaded pipeline (browser +
//                 SOPs + knowledge). Each has a job; the one whose domain fits
//                 the request handles that turn and is the one you hear.
//
// Add an agent: append to SPECIALISTS. `match` (regex over the caller's words,
// the SOP tags and the current host) and `sites` decide when it is picked;
// `instruction` is appended to the navigator persona to colour its job; `voice`
// is a note for the human (every pipeline agent shares the one TTS voice so the
// hand-off stays inaudible). Nothing else needs to change.

export const HOST = {
  id: 'host',
  name: 'Aria',
  role: 'host',
  title: 'Host',
  color: 'host',
  icon: '🎙️',
  job: 'Talks with you — greetings, chit-chat, and introducing the right specialist.',
  voice: 'Gemini Live · Aoede'
};

export const SPECIALISTS = [
  {
    id: 'shopper',
    name: 'Remy',
    role: 'specialist',
    title: 'Shopping & orders',
    color: 'shopper',
    icon: '🛒',
    priority: 1,
    job: 'Food delivery, shopping, carts and checkout — with a read-back before anything is bought.',
    match: /\b(uber ?eats|menulog|doordash|order|food|dinner|lunch|takeaway|take away|delivery|hungry|eat|pizza|burger|sushi|curry|buy|cart|basket|checkout|coles|woolworths|bunnings|amazon|jb ?hi-?fi|cheapest|add to (cart|basket))\b/i,
    sites: ['ubereats.com', 'menulog.com.au', 'doordash.com', 'coles.com.au', 'woolworths.com.au', 'bunnings.com.au', 'amazon.com.au', 'jbhifi.com.au'],
    instruction: 'You are Remy, the shopping and orders specialist: food delivery, retail, carts and checkout. You are meticulous about reading back items and totals before anything is bought, and you never place an order without a clear yes.'
  },
  {
    id: 'local',
    name: 'Lumi',
    role: 'specialist',
    title: 'Local & weather',
    color: 'local',
    icon: '🌦️',
    priority: 1,
    job: 'Weather, opening hours, maps and anything nearby.',
    match: /\b(weather|forecast|rain|temperature|degrees|hot|cold|bom|near me|nearby|local|opening hours|open now|directions|map|where is|pin|location|address|meet(ing)? (spot|point|place)|walk(ing)? (time|distance)|how far)\b/i,
    sites: ['bom.gov.au', 'google.com/maps', 'openstreetmap.org'],
    instruction: 'You are Lumi, the local and weather specialist: forecasts, opening hours, maps and anything nearby. Default location is Melbourne. You read figures (temperatures, times) exactly off the page. WHERE something is gets SHOWN, not described: the moment a place, meeting spot or address comes up, call drop_pin (it puts a pin on the caller\'s Personal Voice Browser) and tell them it\'s up there; the result\'s share_link is what you text if they want it on their phone.'
  },
  {
    id: 'scout',
    name: 'Sage',
    role: 'specialist',
    title: 'Research & reading',
    color: 'scout',
    icon: '📚',
    priority: 2,
    job: 'Reads articles and news, compares options and answers factual questions from the page.',
    match: /\b(read|read me|summar|what does it say|article|news|headline|abc|story|review|compare|comparison|difference|versus|\bvs\b|which (is|one)|explain|what is|who is|how (does|do))\b/i,
    sites: ['wikipedia.org', 'abc.net.au'],
    instruction: 'You are Sage, the research and reading specialist: you read articles and news, compare options side by side, and answer factual questions from what is actually on the page. You cite the source site and never invent facts.'
  },
  {
    id: 'concierge',
    name: 'Nova',
    role: 'specialist',
    title: 'Web concierge',
    color: 'concierge',
    icon: '🧭',
    priority: 3,
    job: 'Opens any site, searches the web and follows links — the generalist when no domain fits.',
    match: /\b(open|go to|visit|website|site|page|search|google|look up|find|browse|link|youtube)\b/i,
    sites: [],
    instruction: 'You are Nova, the web concierge: you open sites, search the web and follow links for the caller. You are the generalist who handles anything the domain specialists do not.'
  }
];
const DEFAULT_SPECIALIST = SPECIALISTS.find((a) => a.id === 'concierge');

// 12 Nov: the MEMORIST — the team's long-term-memory agent. Never speaks on the call; works
// asynchronously after each session (src/agent/memorist.js): distils durable self-learnings
// into the Memory KB with a scorecard, messages the owner the major ones, and arms every
// session with the ranked digest. On the roster so the console shows the whole team.
export const MEMORIST = {
  id: 'memorist',
  name: 'Mnemo',
  role: 'memory',
  title: 'Long-term memory',
  color: 'memory',
  icon: '🧠',
  job: 'Learns from every session — contacts, venues, links, preferences — scores each learning, and arms the team with it next time. Messages you the big ones.',
  voice: null
};

export const AGENTS = [HOST, ...SPECIALISTS, MEMORIST];
export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;

/** The public roster the console draws (no instructions). */
export function roster() {
  return AGENTS.map(({ id, name, role, title, color, icon, job, voice }) => ({ id, name, role, title, color, icon: icon || '•', job, voice: voice || null }));
}

/**
 * Pick the specialist whose domain fits this turn.
 * @param {object} o
 * @param {string} [o.text] the caller's words
 * @param {string} [o.host] the current page host
 * @param {string[]} [o.sopTags] tags of the SOPs selected for the turn
 * @returns {{agent, why}} the chosen specialist and a one-word reason
 */
export function pickSpecialist({ text = '', host = '', sopTags = [] } = {}) {
  const lower = String(text).toLowerCase();
  // 1. What the caller just ASKED for leads — a specialist named by topic owns the turn, even
  //    if the page is still on another site from a previous task. When several match, the more
  //    specific domain (lower priority number) wins over the general web concierge.
  const matches = lower ? SPECIALISTS.filter((a) => a.match.test(lower)) : [];
  if (matches.length) return { agent: matches.sort((a, b) => (a.priority || 9) - (b.priority || 9))[0], why: 'topic' };
  // 2. An SOP tag the specialist owns (shopper ↔ transactions/food, scout ↔ reading…).
  const tagOwner = { shopper: ['transactions', 'food', 'ordering', 'shopping', 'money'], scout: ['reading', 'comparison'], local: ['local', 'weather'] };
  for (const a of SPECIALISTS) if ((tagOwner[a.id] || []).some((t) => sopTags.includes(t))) return { agent: a, why: `sop:${(tagOwner[a.id] || []).find((t) => sopTags.includes(t))}` };
  // 3. No topic in the words (e.g. "yes", "the second one") — stay with whoever owns the page.
  for (const a of SPECIALISTS) if (host && a.sites.some((s) => host.includes(s))) return { agent: a, why: `site:${host}` };
  // 4. Default: the web concierge.
  return { agent: DEFAULT_SPECIALIST, why: 'default' };
}
