// 2026-11-05 (mick-agentic-browser): the PLANNER — the Lead's first job. Turns
// one caller utterance into a small task graph so the team can work in parallel
// and in order. Most turns are a single action ("open uber eats and find pizza"
// is ONE browse task, not two); only genuinely multi-step requests become a
// graph. A cheap heuristic (looksMultiTask) gates the extra model call, so the
// common single-task turn never pays for planning.
//
// Task shape (what the worker + lead consume):
//   { id, kind:'phone'|'browse'|'chatbot', agent, title, goal,
//     to?, name?, question?, bot?, message?, needs:[ids], derive? }
//   needs  — ids this task waits for; it starts only once they have all finished.
//   derive — a note on what to take from those results (e.g. "party size = who
//            said yes"); the upstream answers are handed to the worker as context.
import { completeText } from '../llm/client.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Planner');

// Cheap pre-filter: is this utterance plausibly more than one task? Only then do we spend a model
// call deciding. A false "no" just means we behave as today (one specialist, one tool loop) — safe.
const SEQUENCE_RX = /\b(then|and then|after (that|you|they)|afterwards|once (you|they|i|we|he|she|it)\b|as well as|at the same time|meanwhile|followed by)\b/i;
const ACTION_RX = /\b(call|ring|phone|dial|book|reserve|order|buy|find|search|look up|open|check|ask|compare)\b/gi;
export function looksMultiTask(text = '') {
  const t = String(text);
  if (SEQUENCE_RX.test(t)) return true;
  const actions = (t.match(ACTION_RX) || []).length;
  const ands = (t.match(/\band\b/gi) || []).length;
  // Two distinct action verbs joined ("call X and book Y"), or two call targets, mean a graph.
  return actions >= 2 && ands >= 1;
}

const VALID_KINDS = new Set(['phone', 'browse', 'chatbot']);
const VALID_AGENTS = new Set(['shopper', 'local', 'scout', 'concierge']);

const SYSTEM = `You break a person's spoken request to a voice assistant into a SMALL set of tasks the assistant's team can run in parallel and in order. Output STRICT JSON only, no prose, no code fence.

Shape:
{"tasks":[{"id":"t1","kind":"phone|browse|chatbot","agent":"shopper|local|scout|concierge","title":"3-4 word label","goal":"full instruction for this one task","to":"phone number if known, else omit","name":"person's name for a phone task","question":"the single question to ask on a phone task","needs":["ids this waits for"],"derive":"what to take from those results, if any"}],"say":"one natural spoken sentence the assistant can say RIGHT NOW to acknowledge the whole plan"}

Rules:
- Make the FEWEST tasks that capture the request. Prefer ONE task. Only split when the parts are genuinely INDEPENDENT (different people, different channels, or truly unrelated) or must happen IN ORDER across channels (find a number on the web, THEN phone it).
- A single web flow is ALWAYS ONE browse task, even with several steps on the page: "open uber eats and find a pizza", "search for the best laptop under 1500 and compare the top two", "find a recipe and read it to me" are each ONE browse task. Do NOT split searching from reading/comparing/choosing on the same site — the browse task does all of that itself.
- kind "phone" = ring a real PERSON to ask them one question (needs a name; include "to" only if a number is given in the request/context). kind "browse" = anything on the web. kind "chatbot" = ask a named external assistant.
- Tasks with no "needs" run at once, in parallel. A task that depends on others lists their ids in "needs" and starts only when they finish; use "derive" to say what it takes from them (e.g. "party size = people who said yes").
- agent: shopper=food/shopping/orders/bookings, local=weather/hours/maps/nearby, scout=reading/research/comparison, concierge=general web. For a phone task use concierge.
- Never invent phone numbers. If the request names a person but no number is known, still make the phone task (the assistant resolves the number from what it knows about the caller).
- "say" must fit ALL the tasks in one friendly sentence, present tense, no list read-out (e.g. "Right — I'll ring Sarah and Luke about dinner, then book the pub once I hear back.").`;

function coerce(parsed) {
  const raw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const id = String(r.id || `t${i + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = VALID_KINDS.has(r.kind) ? r.kind : 'browse';
    const agent = VALID_AGENTS.has(r.agent) ? r.agent : (kind === 'phone' ? 'concierge' : 'concierge');
    const goal = String(r.goal || r.title || '').trim();
    if (!goal && kind !== 'phone') continue;
    tasks.push({
      id, kind, agent,
      title: String(r.title || goal).slice(0, 48),
      goal,
      to: r.to ? String(r.to) : undefined,
      name: r.name ? String(r.name) : undefined,
      question: r.question ? String(r.question) : undefined,
      bot: r.bot ? String(r.bot) : undefined,
      message: r.message ? String(r.message) : undefined,
      needs: Array.isArray(r.needs) ? r.needs.map(String).filter((n) => n !== id) : [],
      derive: r.derive ? String(r.derive) : undefined
    });
  }
  // Drop needs that point at tasks that did not survive, so nothing waits forever.
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.needs = t.needs.filter((n) => ids.has(n));
  return { tasks, say: typeof parsed?.say === 'string' ? parsed.say.trim() : '' };
}

function extractJson(text = '') {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * Plan a request into tasks. Returns { multi, tasks, say }. `multi` is true only when the request
 * genuinely needs the team (two or more tasks); otherwise the caller runs the normal single turn.
 */
export async function planTasks({ text, contextText = '', history = [] } = {}) {
  if (!looksMultiTask(text)) return { multi: false, tasks: [], say: '' };
  try {
    const recent = history.filter((m) => typeof m.content === 'string' && m.content)
      .slice(-6).map((m) => `${m.role === 'user' ? 'Caller' : 'Assistant'}: ${m.content}`).join('\n');
    const user = [
      contextText ? `What is known about the caller:\n${contextText}` : '',
      recent ? `Recent conversation:\n${recent}` : '',
      `The caller just said: "${text}"`
    ].filter(Boolean).join('\n\n');
    const out = await completeText({
      model: config.llm.summaryModel,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      params: { max_tokens: 500, temperature: 0.2 }
    });
    const { tasks, say } = coerce(extractJson(out));
    const multi = tasks.length >= 2;
    log.info(`planned ${tasks.length} task(s) (multi=${multi}) for "${String(text).slice(0, 60)}"`);
    return { multi, tasks, say };
  } catch (err) {
    log.warn(`planning failed, falling back to single turn: ${err.message}`);
    return { multi: false, tasks: [], say: '' };
  }
}
