// 12 Nov 2026 (mick-agentic-browser): the MEMORIST — the team's long-term-memory agent.
//
// It watches every session from the event bus (never on the hot path of a turn), and once a
// session goes quiet (or ends) it distils the exchange into DURABLE self-learnings: contacts
// used, venues chosen, useful URLs, the owner's preferences, repeat-task shortcuts. Each
// learning is written into the LONG-TERM MEMORY knowledge base (kind "memory": markdown on
// disk + Qdrant, human-editable in the Knowledge drawer) with a SELF-LEARNING SCORECARD in
// its metadata — novelty / utility / confidence and a composite score, plus an update history
// so refinements are auditable. Major learnings (score >= MEMORIST_NOTIFY_MIN) are messaged
// to the owner on WhatsApp for supervision.
//
// The rest of the team is ARMED with this memory: navigator.js injects a ranked digest into
// every system prompt and retrieves semantically from the memory collection on deep turns.
//
// Env: MEMORIST=off disables; MEMORIST_MODEL (default = the summary model);
//      MEMORIST_QUIET_MS (default 25000); MEMORIST_NOTIFY_MIN (default 70).
import { subscribe, emitEvent } from '../events.js';
import { completeText } from '../llm/client.js';
import { getStore } from '../kb/store.js';
import { config } from '../config.js';
import { sendOwnerMessage } from '../tasks/transports.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Memorist');
const ENABLED = !/^(off|false|0)$/i.test(process.env.MEMORIST || '');
const MODEL = process.env.MEMORIST_MODEL || config.llm.summaryModel;
const QUIET_MS = Number(process.env.MEMORIST_QUIET_MS || 25000);
const NOTIFY_MIN = Number(process.env.MEMORIST_NOTIFY_MIN || 70);

const buffers = new Map(); // sessionId -> { lines: [], timer, busy }

function buf(sid) {
  let b = buffers.get(sid);
  if (!b) { b = { lines: [], timer: null, busy: false }; buffers.set(sid, b); }
  return b;
}

function note(sid, line) {
  const b = buf(sid);
  b.lines.push(line.slice(0, 400));
  if (b.lines.length > 80) b.lines.shift();
  clearTimeout(b.timer);
  b.timer = setTimeout(() => flush(sid, 'quiet period'), QUIET_MS);
  if (b.timer.unref) b.timer.unref();
}

export function initMemorist() {
  if (!ENABLED) { logger.info('memorist disabled (MEMORIST=off)'); return; }
  subscribe((ev) => {
    const sid = ev.sessionId;
    if (!sid || sid.includes('#w-')) return; // worker sub-sessions are narration noise
    switch (ev.type) {
      case 'caller.said': if (ev.text) note(sid, `[owner] ${ev.text}`); break;
      case 'agent.said': if (ev.text) note(sid, `[${ev.team ? 'team → aria' : 'aria'}] ${ev.text}`); break;
      case 'browser.page': if (ev.url && !/^about:/i.test(ev.url)) note(sid, `[visited] ${ev.title || ''} — ${ev.url}`); break;
      case 'phone.result': if (!ev.relayed || ev.answer) note(sid, `[phoned ${ev.name || ''}] ${ev.answer || ev.error || ''}`); break;
      case 'sms.sent': note(sid, `[sms to ${ev.to}] ${String(ev.body || '').slice(0, 160)}`); break;
      case 'task.created': note(sid, `[background task started] ${ev.title || ''}`); break;
      case 'context.updated': if (ev.note) note(sid, `[fact noted about owner] ${ev.note}`); break;
      case 'session.end': flush(sid, 'session end'); break;
      default: break;
    }
  });
  logger.info(`memorist armed (model ${MODEL}, quiet ${QUIET_MS}ms, notify >= ${NOTIFY_MIN})`);
}

/** Distil the buffered session into memory-KB learnings. Fire-and-forget; never throws. */
async function flush(sid, why) {
  const b = buffers.get(sid);
  if (!b || b.busy) return;
  const lines = b.lines.splice(0);
  clearTimeout(b.timer);
  if (lines.length < 3 || !lines.some((l) => l.startsWith('[owner]'))) return; // nothing worth learning
  b.busy = true;
  try {
    const store = getStore();
    const transcript = lines.join('\n');
    const existing = (store.memory || []).slice(0, 40).map((d) => `- ${d.id}: ${d.title}`).join('\n') || '(none yet)';
    const out = await completeText({
      model: MODEL,
      messages: [
        { role: 'system', content: [
          'You are the MEMORIST for a personal voice-browser agent team. From the session observations, extract 0-3 DURABLE self-learnings worth keeping for FUTURE sessions — things that make the team instantly faster next time:',
          '- contacts actually used (name + number/channel), venues/businesses chosen (name, what for, phone, booking quirks)',
          '- useful URLs/pages worth returning to (what they are for)',
          "- the owner's standing preferences and repeat-task shortcuts (how they like things done)",
          'Rules: ONLY facts still true next week; nothing one-off or conversational; never payment data or secrets; keep concrete handles (names, numbers, URLs) verbatim; write each learning SELF-CONTAINED for an agent who has no other context.',
          'IGNORE synthetic or system identifiers: a caller who introduces themselves with a slug, a run/instance name, a hyphenated machine name or a long digit string (e.g. "personal-voice-browser-phone-385007862") is a TEST HARNESS, not a person — never record such a thing as a contact, name or phone number. A contact is only worth keeping with a plausible human/business name AND a real dialable number or channel.',
          'For bookings and venues, keep the DETAILS that make the next booking instant: venue, what it was for, day/time pattern, party size, dietary needs, booking name, phone/URL — one self-contained learning.',
          'Existing memory titles (do NOT duplicate; if an observation refines one, still output it — the store merges):',
          existing,
          'Reply with ONLY JSON: {"learnings":[{"title":"<=70 chars","text":"2-4 sentences","kind":"contact|place|url|preference|shortcut|fact","tags":["a","b"],"novelty":0..1,"utility":0..1,"confidence":0..1}]} — or {"learnings":[]} if nothing qualifies.'
        ].join('\n') },
        { role: 'user', content: `Session observations (${why}):\n${transcript}` }
      ],
      params: { max_tokens: 900, temperature: 0.2 }
    });
    const parsed = JSON.parse(String(out).replace(/^[\s\S]*?\{/, '{').replace(/\}[^}]*$/, '}'));
    const learnings = Array.isArray(parsed?.learnings) ? parsed.learnings.slice(0, 3) : [];
    const saved = [];
    // Belt and braces for the prompt rule above: a test harness announcing its instance name
    // ("personal-voice-browser-…-385007862") must never become an "owner contact" memory.
    const JUNK = /personal-voice-browser|aria-?[—-]+-?phone|\b\d{9,}\b|instance|synthetic|test[- ]?caller/i;
    for (const l of learnings) {
      if (!l?.title || !l?.text) continue;
      if (JUNK.test(`${l.title} ${l.text}`)) { logger.info(`skipped junk learning: ${l.title}`); continue; }
      const clamp = (x) => Math.max(0, Math.min(1, Number(x) || 0));
      const novelty = clamp(l.novelty), utility = clamp(l.utility), confidence = clamp(l.confidence);
      const score = Math.round(100 * (0.45 * utility + 0.3 * confidence + 0.25 * novelty));
      // Merge with the closest existing memory when it is plainly the same subject.
      let target = null;
      try {
        const { hits } = await store.search(`${l.title} ${l.text}`, { kind: 'memory', topK: 1 });
        if (hits[0]?.score > 0.6) target = store.doc(hits[0].docId);
      } catch { /* search down — create fresh */ }
      // Refinement ACCUMULATES: keep the original title (it names the subject), add only the new
      // sentences, cap the body — 12 Nov: seven merges had overwritten "Rogue Bistro chosen for
      // gluten-free team dinners" with "Rogue Bistro menu page for checking options".
      const title = target ? target.title : l.title;
      let body = l.text;
      if (target) {
        const have = new Set(target.body.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
        const fresh = String(l.text).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !have.has(s.toLowerCase()));
        body = (target.body + (fresh.length ? '\n' + fresh.join(' ') : '')).slice(0, 1400);
      }
      const now = new Date().toISOString();
      const entry = { at: now, score, note: target ? 'refined' : 'created', session: sid, trigger: why };
      // Scorecard fields only — version / created_at / updated_at / by / history are stamped by
      // store.saveDoc on EVERY save (13 Nov), the same for Memorist and human edits.
      const meta = {
        learned_at: target?.meta?.learned_at || now,
        source: { session: sid, trigger: why, model: MODEL },
        kind: String(l.kind || 'fact'),
        novelty, utility, confidence, score,
        used_count: target?.meta?.used_count || 0,
        updates: [...(target?.meta?.updates || []), entry].slice(-12)
      };
      const id = target?.id || `MEM-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const tags = [...new Set([...(target?.tags || []), ...(l.tags || [])])].slice(0, 12);
      const r = await store.saveDoc({ kind: 'memory', id, title, body, tags, meta, by: 'memorist' });
      if (r.error) { logger.warn(`memory save failed (${id}): ${r.error}`); continue; }
      // 13 Nov: only NEW memories, or refinements whose score moved by 10+, are worth a WhatsApp —
      // six "Rogue Bistro (refined)" pings in an hour buried the signal.
      const prevScore = Number(target?.meta?.score);
      saved.push({ id, title, kind: meta.kind, score, updated: Boolean(target), notable: !target || !Number.isFinite(prevScore) || Math.abs(score - prevScore) >= 10 });
      emitEvent('memory.learned', sid, { id, title, kind: meta.kind, score, updated: Boolean(target) });
      logger.info(`self-learning ${target ? 'refined' : 'saved'} ${id} [${score}] ${title}`);
    }
    // Supervision: WhatsApp the owner the MAJOR learnings in one message.
    const majors = saved.filter((s) => s.score >= NOTIFY_MIN && s.notable);
    if (majors.length && config.tasks.ownerPhone && config.tasks.notify) {
      const body = `🧠 Self-learning${majors.length > 1 ? 's' : ''} from the last session:\n` +
        majors.map((m) => `• [${m.score}] ${m.title}${m.updated ? ' (refined)' : ''}`).join('\n') +
        '\nSaved to Long-term memory — review in the console: Knowledge → Memory (edit or delete anytime).';
      sendOwnerMessage({ channel: config.tasks.notify, to: config.tasks.ownerPhone, body })
        .catch((err) => logger.warn(`owner notify failed: ${err.message}`));
    }
  } catch (err) {
    logger.warn(`extraction failed (${sid}): ${err.message}`);
  } finally { b.busy = false; }
}

/** Ranked digest of the long-term memory for ARMING system prompts (both lanes, every turn). */
export function memoryDigest({ max = 6, maxChars = 1400 } = {}) {
  const docs = (getStore().memory || [])
    .slice()
    .sort((a, b) => (b.meta?.score || 50) - (a.meta?.score || 50) || String(b.meta?.learned_at || '').localeCompare(String(a.meta?.learned_at || '')))
    .slice(0, max);
  if (!docs.length) return '';
  let out = 'LONG-TERM MEMORY — self-learned in earlier sessions. USE IT FIRST for contacts, venues, links and the owner\'s preferences: it is what makes you fast. Verify only if it could be stale:\n';
  for (const d of docs) {
    const line = `- (${d.meta?.score ?? '–'}${d.meta?.kind ? ' ' + d.meta.kind : ''}) ${d.title}: ${d.body.replace(/\s+/g, ' ').slice(0, 220)}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}
