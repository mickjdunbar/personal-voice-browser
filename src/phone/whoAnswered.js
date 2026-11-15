/**
 * WHO ANSWERED? (14 Nov 2026) — a fast read on what picked up an outbound call, so Aria can pitch
 * the call to it: a HUMAN gets one idea at a time; an AI AGENT can take the whole brief at once;
 * an IVR needs keys; VOICEMAIL gets a message. Pure scoring, no I/O: the conductor feeds it what
 * the line gives us in the first seconds and asks for a verdict after every observation.
 *
 * Signals, cheapest first:
 *   1. answering-machine detection from jambonz (`amd_*` hook events) — fires at pickup
 *   2. the SHAPE of the first utterance: a human says 2–8 words and waits; machines deliver 25+
 *      words without pausing (menus, disclaimers, agent greetings)
 *   3. WORDS: menu grammar ("press 1", "say or press"), voicemail grammar ("after the tone"),
 *      self-identification ("AI assistant", "virtual receptionist"), human greetings ("hello?",
 *      "Dave speaking"), disfluencies ("um", "uh")
 *   4. the RESPONSE to Aria's first line: a menu repeats or says "I didn't get that"; a human or an
 *      agent answers the content; an agent does it fast, fluently and at length
 * A verdict is `decided` once one kind leads by a clear margin, or after three far-end turns
 * (default: treat as human — the safest posture). Classification keeps running after that:
 * an IVR that transfers, or an agent that escalates, hands over to a human mid-call.
 */

import fs from 'node:fs';

export const KINDS = ['human', 'agent', 'ivr', 'voicemail'];

// --- per-number memory (14 Nov pm): what answered this number before, on disk ------------------
const memoryFile = () => process.env.WHO_ANSWERED_FILE || '.who-answered.json'; // read lazily (tests point it elsewhere)
let mem = null, memPath = null;
function loadMem() {
  if (mem && memPath === memoryFile()) return mem;
  memPath = memoryFile();
  try { mem = JSON.parse(fs.readFileSync(memPath, 'utf8')) || {}; } catch { mem = {}; }
  return mem;
}
/** Record a verdict for a number (E.164). Keeps the last ten outcomes. */
export function rememberVerdict(number, v) {
  if (!number || !v?.kind) return;
  const m = loadMem();
  const e = m[number] || { history: [] };
  e.kind = v.kind; e.confidence = v.confidence; e.by = v.by; e.at = new Date().toISOString();
  e.history = [...(e.history || []).slice(-9), { kind: v.kind, by: v.by, at: e.at }];
  m[number] = e;
  try { fs.writeFileSync(memoryFile(), JSON.stringify(m, null, 1)); } catch { /* memory only */ }
}
export function rememberedFor(number) { return loadMem()[number] || null; }
/**
 * The prior for a number before dialling: a finished IVR map wins (we KNOW it is a menu, and we
 * know its tree), then the last verdict. `maps` = ivrmap pub rows for this number (done/stopped,
 * dialled for real, not a test redirect).
 */
export function priorFor(number, { maps = [] } = {}) {
  const map = (maps || []).find((x) => x && x.to === number && x.dialed === number && (x.status === 'done' || x.status === 'stopped') && (x.calls || 0) > 0);
  if (map) return { kind: 'ivr', why: 'a mapped phone menu', mapId: map.id };
  const r = rememberedFor(number);
  if (r?.kind) {
    // Several voicemails in a row on a personal number is still a person's phone: keep the prior soft.
    return { kind: r.kind, why: `last call reached ${r.kind === 'ivr' ? 'a phone menu' : r.kind === 'agent' ? 'an AI agent' : r.kind}` };
  }
  return null;
}
/** A compact text rendering of a mapped menu for the decision prompt: one line per menu node. */
export function renderMenuTree(map, { max = 24 } = {}) {
  const nodes = Object.values(map?.nodes || {}).filter((n) => n && Array.isArray(n.options) && n.options.length);
  if (!nodes.length) return '';
  nodes.sort((a, b) => (a.depth || 0) - (b.depth || 0) || String(a.path).localeCompare(String(b.path)));
  const lines = nodes.slice(0, max).map((n) => `${n.path ? `after keys ${n.path.split('').join(' ')}` : 'at pickup'} — ${n.title || 'menu'}: ${n.options.map((o) => `${o.key}=${o.label}`).join(', ')}`);
  return lines.join('\n');
}
const DECIDE_MARGIN = 0.35;      // leader must be this far ahead of the runner-up
const DECIDE_MIN = 0.55;         // and at least this sure
const MAX_UNDECIDED_TURNS = 3;   // then fall back to 'human'

const RX = {
  ivr: [
    [/\b(press|dial)\s+(one|two|three|four|five|six|seven|eight|nine|zero|star|hash|pound|\d|\*|#)\b/i, 0.55, 'menu grammar'],
    [/\bfor\s+[^.]{2,50}?,?\s+(press|say)\b/i, 0.45, 'option list'],
    [/\b(say or press|press or say|say\s+["“]?[a-z ]{3,20}["”]?\s+or\s+press)\b/i, 0.5, 'say-or-press'],
    [/\b(main menu|previous menu|repeat (these|the) options|to hear (this|these) (again|options))\b/i, 0.5, 'menu navigation'],
    [/\b(your call (is important|may be (recorded|monitored))|calls? (are|may be|will be) recorded)\b/i, 0.3, 'recording notice'],
    [/\b(please (hold|stay on the line)|next available|all (of )?our (operators|agents|consultants|team members) are (busy|currently))\b/i, 0.35, 'queue language'],
    [/\b(please enter|enter your|followed by (the )?(hash|pound)|key in your)\b/i, 0.5, 'asks for digits'],
    [/\b(in a few words|tell me (briefly )?(why you'?re calling|what you'?re calling about|the reason for your call))\b/i, 0.45, 'speech IVR prompt'],
    [/\b(i didn'?t (get|catch|understand) that|sorry,? i didn'?t understand|that'?s not a valid (option|selection)|invalid (option|entry))\b/i, 0.5, 'no-match prompt'],
    [/\b(our (office|offices) (is|are) (now |currently )?closed|business hours are|opening hours are|outside (of )?(our )?(business|office) hours)\b/i, 0.3, 'hours notice'],
    [/\b(thank you for calling|welcome to|you'?ve reached)\s+[a-z0-9&' ]{2,40}\b/i, 0.2, 'branded welcome'],
    [/\bpara (español|continuar en español)\b/i, 0.4, 'language menu']
  ],
  voicemail: [
    [/\b(leave (a|your) (message|name and number)|after the (tone|beep)|record your message|at the tone)\b/i, 0.65, 'voicemail prompt'],
    [/\b(not available|can'?t (take|get to|come to) (your|the) (call|phone)( right now)?|unable to take your call)\b/i, 0.4, 'unavailable'],
    [/\b(voicemail|voice mail|message ?bank|mailbox|answering machine)\b/i, 0.45, 'names voicemail'],
    [/\b(the (person|number|customer) you (are calling|have called|dialled|dialed)|is (switched off|not reachable|unavailable))\b/i, 0.5, 'carrier announcement']
  ],
  agent: [
    [/\b(ai|a\.i\.|virtual|digital|automated|artificial intelligence|voice)\s+(assistant|agent|receptionist|concierge|helper|attendant)\b/i, 0.6, 'self-identifies as an assistant'],
    [/\b(i'?m|i am|this is)\s+(an?\s+)?(ai|bot|virtual|automated|digital)\b/i, 0.6, 'says it is an AI'],
    [/\b(powered by|built on|an? (ai|automated) (system|service))\b/i, 0.35, 'AI disclosure'],
    [/\bhow can i help you today\b/i, 0.2, 'scripted helper opener'],
    [/\bi can help (you )?(with|you)\b[^.]{0,80}\b(or|and)\b/i, 0.25, 'offers a capability list'],
    [/\b(happy to help|i'?d be happy to|let me (check|look into|help you with) that)\b/i, 0.15, 'service register'],
    [/\b(not a (real |actual )?(person|human)|i(’|')?m not human)\b/i, 0.7, 'says it is not a person'],
    [/\b(calling|acting|speaking) on behalf of\b/i, 0.2, 'speaks for a principal'],
    [/\b(i need (two|three|the following) things|first(ly)?,.{5,80}second(ly)?,)\b/i, 0.25, 'enumerated request'],
    [/\b(is there )?anything else i can (help|do|assist)\b/i, 0.15, 'service closer'],
    [/\b(reference|ref\.?|confirmation|booking) (number |code |id )?(is )?[a-z]{1,4}\s?-?\d{3,}\b/i, 0.2, 'quotes a reference code']
  ],
  human: [
    [/^(hello|hi|hey|yeah|yes|yep|yo|g'?day|hullo|hiya|hallo|yello)\b[\s,.!?]*$/i, 0.55, 'bare greeting'],
    [/^(hello|hi|hey|yeah|yep|g'?day)[\s,.!?]+(hello|hi|yeah|yep|who'?s (this|that|calling)|who is (this|it))\b/i, 0.55, 'greeting + who'],
    [/\b(who'?s (this|that|calling|speaking)|who is (this|it)|sorry,? who)\b/i, 0.45, 'asks who is calling'],
    [/\b(um+|uh+|er+|ah+|hmm+|y'?know|like,)\b/i, 0.3, 'disfluency'],
    [/\b(what\?|sorry\?|pardon\?|say (that )?again|come again|huh\?)/i, 0.3, 'asks to repeat'],
    [/\b(hang on|hold on|one sec|just a sec|two secs|give me a (sec|second|minute))\b/i, 0.3, 'informal hold'],
    [/\b(mate|love|darl|hun|buddy)\b/i, 0.2, 'informal address'],
    [/\b[A-Z][a-z]+ speaking\b/, 0.3, 'name + speaking'],
    [/\b(i(’|')?m|i am|yes,? (i(’|')?m|it(’|')?s)|yeah,? (i(’|')?m|it(’|')?s)) (a |an )?(real |actual |live |genuine )?(person|human|human being)\b/i, 0.8, 'says they are a person'],
    [/\b(last time i checked|flesh and blood|haha|ha ha|lol)\b/i, 0.35, 'laughs it off']
  ]
};
// Lines that a transfer or escalation produces just before a human picks up.
const HANDOFF_RX = /\b(transfer(ring)? you|put(ting)? you through|connect(ing)? you (to|with)|hold (on|the line) (for|while)|one moment (please|while)|let me get (someone|a (person|colleague|human))|speak (to|with) (a|an|one of our) (person|human|team member|colleague|staff member|representative))\b/i;
const ESCALATE_RX = /\b(a (real|actual|live) person|a human|speak to (someone|a person)|operator|representative)\b/i;

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export function createDetector({ kind = 'person', to = '', prior = null } = {}) {
  const score = { human: 0, agent: 0, ivr: 0, voicemail: 0 };
  const cues = [];
  const st = { heardTurns: 0, saidTurns: 0, lastSaidText: '', lastHeardText: '', amd: null, tone: false, decided: null, history: [], rates: [], probeSuggested: false };
  const add = (k, w, why) => { score[k] += w; cues.push(`${k}: ${why} (+${w.toFixed(2)})`); };

  // Priors: who we think we're ringing. Small, so the line overrides them within one utterance.
  if (kind === 'business') { add('ivr', 0.15, 'business number'); add('agent', 0.05, 'business number'); }
  else if (kind === 'inbound') add('human', 0.1, 'inbound caller');
  else add('human', 0.15, 'personal number');
  if (prior && KINDS.includes(prior.kind)) add(prior.kind, prior.mapId ? 0.4 : 0.25, prior.why || `last call to ${to || 'this number'} reached a ${prior.kind}`);

  function observeAmd(type) {
    st.amd = type;
    switch (type) {
      case 'amd_human_detected': add('human', 0.45, 'AMD: short greeting then silence'); break;
      // "machine" = long continuous speech at pickup: an IVR, a voicemail greeting — or an AI agent's intro.
      case 'amd_machine_detected': add('ivr', 0.3, 'AMD: long greeting'); add('voicemail', 0.2, 'AMD: long greeting'); add('agent', 0.2, 'AMD: long greeting'); break;
      case 'amd_tone_detected': st.tone = true; add('voicemail', 0.7, 'AMD: beep'); break;
      case 'amd_no_speech_detected': add('human', 0.1, 'AMD: silent pickup (a person waiting?)'); break;
      default: break; // decision timeout, stopped, error: no information
    }
  }

  function observeHeard(text, { sinceSaidMs = null, durationMs = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return;
    st.heardTurns += 1; st.lastHeardText = t; st.history.push({ role: 'them', text: t });
    const n = words(t);
    // Timing prosody (no audio needed): words per second over the VAD window. Machines deliver a
    // steady 2.6–4.5 w/s with no disfluency; people with something to say idle around 1.5–2.5.
    if (durationMs && durationMs > 1500 && n >= 8) {
      const rate = n / (durationMs / 1000);
      st.rates.push(rate);
      if (rate >= 2.6 && rate <= 4.8 && !/\b(um+|uh+|er+|ah+)\b/i.test(t)) { add('agent', 0.12, `steady delivery (${rate.toFixed(1)} w/s)`); add('ivr', 0.08, `steady delivery (${rate.toFixed(1)} w/s)`); }
      else if (rate < 1.9) add('human', 0.12, `unhurried delivery (${rate.toFixed(1)} w/s)`);
      if (st.rates.length >= 3) {
        const mean = st.rates.reduce((a, b) => a + b, 0) / st.rates.length;
        const sd = Math.sqrt(st.rates.reduce((a, b) => a + (b - mean) ** 2, 0) / st.rates.length);
        if (sd < 0.35) add('agent', 0.1, 'metronomic pace across turns');
      }
    }
    // Shape of the turn
    if (st.heardTurns === 1) {
      if (n <= 8) add('human', 0.3, `short first utterance (${n} words)`);
      else if (n >= 25) { add('ivr', 0.2, `long first utterance (${n} words)`); add('agent', 0.2, `long first utterance (${n} words)`); add('voicemail', 0.1, 'long first utterance'); }
    }
    // Words
    for (const k of KINDS) for (const [rx, w, why] of RX[k]) if (rx.test(t)) add(k, w, why);
    // How it responded to what Aria just said
    if (st.saidTurns > 0 && st.lastSaidText) {
      const repeat = similarity(t, st.history.filter((h) => h.role === 'them').slice(-3, -1).map((h) => h.text).join(' '));
      if (repeat > 0.6) add('ivr', 0.45, 'repeated itself after we spoke');
      else {
        const overlap = contentOverlap(t, st.lastSaidText);
        if (overlap > 0) { add('human', 0.15, 'engaged with what we said'); add('agent', 0.15, 'engaged with what we said'); }
        if (n >= 30 && !/\b(um+|uh+|er+)\b/i.test(t)) add('agent', 0.2, 'long fluent reply');
        if (sinceSaidMs !== null && sinceSaidMs < 1800 && n >= 12) add('agent', 0.15, 'instant, full-sentence reply');
        // "Booked. Reference RB9849." one turn after the request: no human checks a diary that fast.
        if (/\b(booked|confirmed|done|all set|that'?s (booked|confirmed))\b/i.test(t) && /\b[a-z]{1,4}\s?-?\d{3,}\b/i.test(t) && (sinceSaidMs === null || sinceSaidMs < 4000)) add('agent', 0.3, 'completed the request with a reference in one breath');
      }
    }
    // Handover cues: a machine that announces a transfer, then a short human greeting = switch.
    if (st.decided && st.decided.kind !== 'human') {
      if (HANDOFF_RX.test(t)) st.handoffPending = true;
      else if (st.handoffPending && n <= 10 && RX.human.some(([rx]) => rx.test(t))) {
        st.handoffPending = false;
        reset('human', 'a person came on after a transfer');
      }
    }
  }

  function observeSaid(text) {
    st.saidTurns += 1; st.lastSaidText = String(text || ''); st.history.push({ role: 'aria', text: st.lastSaidText });
  }

  function reset(kindNow, why) {
    for (const k of KINDS) score[k] = 0;
    cues.length = 0;
    add(kindNow, 0.9, why);
    st.decided = null;
  }

  function verdict() {
    const ranked = KINDS.map((k) => [k, score[k]]).sort((a, b) => b[1] - a[1]);
    const [lead, leadScore] = ranked[0];
    const margin = leadScore - ranked[1][1];
    const total = ranked.reduce((s, [, v]) => s + v, 0) || 1;
    const confidence = Math.max(0, Math.min(1, leadScore / total + margin / 2));
    let decided = Boolean(st.decided);
    let kindNow = st.decided?.kind || lead;
    if (!st.decided) {
      const sure = leadScore >= DECIDE_MIN && margin >= DECIDE_MARGIN;
      const fallback = st.heardTurns >= MAX_UNDECIDED_TURNS;
      if (sure || fallback) {
        kindNow = sure ? lead : (lead === 'voicemail' || lead === 'ivr' ? lead : 'human');
        st.decided = { kind: kindNow, at: Date.now(), by: sure ? 'score' : 'fallback' };
        decided = true;
      }
    } else if (st.decided.kind !== lead && margin >= DECIDE_MARGIN && leadScore >= DECIDE_MIN + 0.3) {
      // The line changed its mind for us (e.g. an agent escalated to a human and said nothing about it).
      st.decided = { kind: lead, at: Date.now(), by: 'revised' };
      kindNow = lead;
    }
    // The stubborn case: two exchanges in, human and agent neck and neck. Suggest the one-line probe (once).
    let probe = false;
    if (!st.decided && st.heardTurns >= 2 && !st.probeSuggested) {
      const top2 = ranked.slice(0, 2).map(([k]) => k);
      if (top2.includes('human') && top2.includes('agent') && margin < DECIDE_MARGIN) { probe = true; st.probeSuggested = true; }
    }
    return { kind: kindNow, confidence: Number(confidence.toFixed(2)), decided, by: st.decided?.by || null, scores: { ...score }, cues: cues.slice(-8), turns: st.heardTurns, amd: st.amd, probe };
  }

  return {
    observe(evt) {
      if (!evt) return verdict();
      if (evt.type === 'amd') observeAmd(evt.result);
      else if (evt.type === 'heard') observeHeard(evt.text, evt);
      else if (evt.type === 'said') observeSaid(evt.text);
      return verdict();
    },
    verdict,
    /** The leg ended before a decision: take the current leader as a best guess (by: 'end'). */
    finalize() {
      if (!st.decided && st.heardTurns > 0) {
        const ranked = KINDS.map((k) => [k, score[k]]).sort((a, b) => b[1] - a[1]);
        st.decided = { kind: ranked[0][1] > 0 ? ranked[0][0] : 'human', at: Date.now(), by: 'end' };
      }
      return verdict();
    },
    /** A line that settles human-vs-agent when the words haven't: fine to ask, agents answer honestly. */
    probeLine: () => 'Sorry, quick one before I go on — am I talking to a person, or an automated assistant?',
    isEscalationRequest: (text) => ESCALATE_RX.test(String(text || ''))
  };
}

/** How Aria should carry herself once we know what answered. Injected as a standing note. */
const HOSTNAME = process.env.AGENT_NAME || 'Aria';
/** Posture for an INBOUND caller (the main leg): only an agent caller changes anything. */
export function inboundPostureFor(kind) {
  if (kind === 'agent') return `(WHO IS CALLING: the caller is an AI / automated ASSISTANT acting for a person, not the person themselves. Agent-to-agent mode: no small talk, no filler. Ask for everything you need in one turn and accept dense, structured answers. Give your answers complete and structured in one turn too — all the facts, exact figures, times and names, no pacing for comprehension. Dense does NOT mean fast: NEVER state a fact you have not looked up yet. If you need to browse, say one short line that you are checking, stay silent until the result is in, THEN deliver the complete answer once. Confirm key details back once in a compact read-back. If it asks whether you are an AI, say yes plainly: you are ${HOSTNAME}, an AI assistant. If a PERSON takes over the call, drop back to normal human pace at once.)`;
  if (kind === 'human') return '';
  return '';
}
export function postureFor(kind, { who = 'the owner', them = 'them', goal = '', callback = '' } = {}) {
  switch (kind) {
    case 'human':
      return `(WHO ANSWERED: a PERSON. Pitch to a human on a phone: ONE idea per turn, two short sentences at most, then stop and let them talk. Say numbers, names and times slowly and read a key detail back once. No lists, no jargon, no "firstly/secondly". If they sound busy or confused, slow down and simplify rather than repeat. Be warm; let them steer.)`;
    case 'agent':
      return `(WHO ANSWERED: an AI / automated ASSISTANT, not a person. Switch to agent-to-agent mode. Drop the small talk and give it the complete brief in ONE turn, as a compact structured block it can parse: "Brief: I'm ${HOSTNAME}, an AI assistant calling for ${who}. Need: ${goal || 'the goal'}. Constraints: <every one — day, time, party size, name, preferences>. Callback: ${callback || 'this number'}. Please confirm with a reference." Answer its structured questions directly and completely; it will not tire or get confused by detail. Never guess a detail to keep the pace: check first, then answer once. Accept any structured hand-back it offers (a reference, a confirmation read-back, a link or email). If it asks whether you are an AI, say yes plainly. If it cannot do what you need, ask it to transfer you to a person. If a PERSON comes on the line, switch back to human pace immediately: short turns, one thing at a time.)`;
    case 'ivr':
      return `(WHO ANSWERED: an automated PHONE MENU (IVR). Listen for the option that matches the goal and press that key; say nothing unless it asks you to speak, and then answer in two or three words. If no option fits, press 0 or say "operator" / "representative" to reach a person. Once a person answers, treat them as a human: short turns, one idea at a time.)`;
    case 'voicemail':
      return `(WHO ANSWERED: VOICEMAIL. Wait for the tone, then leave ONE short message — who you are, who you are calling for, what you need in one sentence, and how to get back to ${who}. Then end the call and report that you reached voicemail.)`;
    default:
      return '';
  }
}

// --- tiny text helpers (no deps) -------------------------------------------------------------
const STOP = new Set('the a an and or to of for in on at is are was were be been it this that you your i me my we our they them he she his her with as by from not no yes ok okay so just can could would will do did have has had what which who how when where why there here please thanks thank hi hello hey oh'.split(' '));
function tokens(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)); }
function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.min(A.size, B.size);
}
function contentOverlap(reply, said) {
  const A = new Set(tokens(reply)), B = new Set(tokens(said));
  let inter = 0; for (const w of A) if (B.has(w)) inter += 1;
  return inter;
}
