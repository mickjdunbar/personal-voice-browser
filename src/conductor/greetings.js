// 16 Nov 2026 (mick-agentic-browser): how the host opens a call, as named cases instead of a
// string-concatenation ternary in verbs.js (which broke twice on 15 Nov). Every variant starts with
// the language pin: `response.create.instructions` REPLACES the session instructions for that one
// response, so the greeting never sees the persona's language rule — gpt-realtime opened in
// Portuguese to an English caller before the pin existed.
import { isChitChat } from '../llm/lanes.js';

/**
 * @param {object} o
 * @param {string} [o.opening]   what the caller typed to start the call ('' = a cold call)
 * @param {object} [o.resume]    resume info ({reconnect:true} or {summary, inflight}) — a continuation, not a greeting
 * @param {string} o.hostName    e.g. 'Aria'
 * @param {string} o.langPin     from settings.language().pin
 * @returns {{kind:'resume'|'hello'|'request'|'cold', greeting:string, openNote:string}}
 *   greeting = the per-response instruction for the opening line; openNote = what the session instructions
 *   get appended about the caller's first message ('' unless they typed one).
 */
export function openingPlan({ opening = '', resume = null, hostName = 'Aria', langPin = '' } = {}) {
  const typed = String(opening || '').trim();
  if (resume) {
    return { kind: 'resume', greeting: langPin + 'Pick the conversation back up in one short warm sentence. Do not greet again.', openNote: '' };
  }
  if (typed && isChitChat(typed)) {
    // A typed "hello" / "hi" / "how are you" is NOT a request (15 Nov: Aria "dived right in" and browsed for "hello").
    return {
      kind: 'hello',
      greeting: langPin + `The caller opened by typing: "${typed}" — just a hello. Say hi back like a mate — casual, one short line (you're ${hostName}; use their name if you know it) — and ask what they're after. Do NOT call any tool yet.`,
      openNote: `\n\nTHE CALLER'S FIRST MESSAGE (they typed this to start the call): "${typed}". That is just a hello, not a request: greet them back warmly in one short line and ask what's up. Do NOT call any tool until they ask for something.`
    };
  }
  if (typed) {
    return {
      kind: 'request',
      greeting: langPin + `The caller opened by typing: "${typed}". Greet them like a mate — casual, playful, first-name basis (you're ${hostName}; use their name if you know it) — show you're onto it, and IMMEDIATELY call browse_for_caller with that request — do NOT ask what they want.`,
      openNote: `\n\nTHE CALLER'S FIRST MESSAGE (they typed this to start the call): "${typed}". Open by greeting them warmly and briefly and showing you're onto THIS, then IMMEDIATELY call browse_for_caller with it. Do not ask what they'd like to do — they've told you.`
    };
  }
  return {
    kind: 'cold',
    greeting: langPin + `Greet the caller like a mate you're happy to hear from — casual and playful ("Hey hey!", "G'day!"), say you're ${hostName}, and ask what they're up to in a relaxed way ("what are we getting up to today?", "what's the plan?"). NEVER stiff service lines like "How can I be of service" or "How may I assist you today".`,
    openNote: ''
  };
}
