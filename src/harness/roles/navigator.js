// 2026-11-03 (mick-agentic-browser): the harness role that puts a Navigator
// on a jambonz call. Standalone (Agent Studio custom-harness agent, or our
// conductor's cascaded lane) or as the SPECIALIST half of a hybrid call
// (metadata.mode === 'specialist': answer the handed-over request, keep going
// while the caller keeps browsing, hand back once the chat turns light).
import { getSession, peekSession } from '../../agent/sessions.js';
import { bus, topic } from '../../bus.js';

export const name = 'navigator';

// Gentle, varied check-ins for when the caller goes quiet — never the same line twice in a row, and
// warm rather than robotic. Kept short so they don't crowd the caller when they're just thinking.
const IDLE_NUDGES = ["No rush — I'm here whenever you're ready.", 'All good, take your time.', "Still here whenever you want to carry on.", "Whenever you're ready, just say the word."];
let lastNudge = '';
const pickNudge = () => { let n; do { n = IDLE_NUDGES[Math.floor(Math.random() * IDLE_NUDGES.length)]; } while (n === lastNudge && IDLE_NUDGES.length > 1); lastNudge = n; return n; };

export function create(ctx) {
  const md = ctx.metadata || {};
  const specialist = md.mode === 'specialist';
  let nav = null;
  let pendingHandback = null;
  // How many turns are actively working right now. A web browse now runs SILENT (no fillers — the
  // screen is the feedback), so while a multi-round search is under way jambonz keeps emitting
  // `silence` events and the idle/streak logic would read that as "the caller left" and hang up
  // mid-search (seen at ~32 s). The agent is working, not gone: suppress the nudge/wind-down while a
  // turn is in flight. (phonePending/workPending cover outbound calls + the Lead's team; this covers
  // an ordinary single-task browse, which sets neither.)
  let busyTurns = 0;
  const working = () => busyTurns > 0 || nav?.phonePending > 0 || nav?.workPending > 0;

  async function ensure() {
    if (nav) return nav;
    nav = await getSession(ctx.sessionId, {
      channel: specialist ? 'specialist' : 'voice',
      handoff: specialist ? md.handoff || null : null,
      externalTools: ctx.tools,
      callExternalTool: (n, a) => ctx.callTool(n, a),
      metadata: { instructions: md.instructions || md.env_vars?.instructions, greeting: md.greeting || md.env_vars?.greeting },
      info: { callSid: ctx.callSid, from: ctx.session.from, to: ctx.session.to, direction: ctx.session.direction, mode: specialist ? 'specialist' : 'standalone' }
    });
    if (specialist) { nav.handoff = md.handoff || nav.handoff; nav.channel = 'specialist'; }
    // Let the Navigator speak on THIS live leg for async relays (e.g. an outbound call's answer
    // that lands after the turn that started it has finished).
    nav.liveSay = (t) => { try { ctx.say(t); } catch (err) { ctx.log.warn(`liveSay: ${err.message}`); } };
    return nav;
  }

  // Hand-back to the speech-to-speech host is OFF by default: resuming google_s2s on a redirect
  // proved unreliable and kept dropping calls (jambonz "called party hungup"). After the opening
  // greeting the call simply STAYS on the pipeline — the fast lane IS Aria (the host persona) for
  // chit-chat and the deep lane is the specialists, so it is still a team, just on one reliable leg.
  // Set HYBRID_HANDBACK=1 to re-enable the experimental s2s hand-back.
  const HANDBACK_ENABLED = /^(1|true|yes|on)$/i.test(process.env.HYBRID_HANDBACK || '');

  // Idle watchdog: after the specialist answers, don't leave the caller in dead air. A gentle nudge
  // first, then a graceful wind-down if they have truly gone — all on this leg, no hand-back.
  const IDLE_MS = Number(process.env.SPECIALIST_IDLE_MS) || 14000;
  let idleTimer = null;
  let idleStage = 0;
  const disarmIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
  const armIdle = () => {
    if (!specialist) return;
    disarmIdle();
    idleTimer = setTimeout(async () => {
      try {
        if (nav?.ended) return; // the call already ended — don't speak a nudge/goodbye into a dead leg
        if (working()) { armIdle(); return; } // a call/task/browse is in flight — wait for it, don't nudge or hang up
        if (HANDBACK_ENABLED && idleStage === 0) { idleStage = 1; await handBack('idle'); return; }
        if (idleStage === 0) { idleStage = 1; ctx.say(pickNudge()); armIdle(); }
        else { const id = ctx.say("I'll let you go for now. Call back any time — bye for now!"); await ctx.waitSpoken(id, 8000); await ctx.command('hangup', { reason: 'idle' }); }
      } catch (err) { ctx.log.warn(`idle watchdog: ${err.message}`); }
    }, IDLE_MS * (idleStage === 0 ? 1 : 2));
    if (idleTimer.unref) idleTimer.unref();
  };

  async function run(turn, writer, kind) {
    disarmIdle(); idleStage = 0;
    const n = await ensure();
    busyTurns += 1;
    let result;
    try { result = await n.turn(turn.text, writer, { signal: turn.signal, turnId: turn.turnId, kind }); }
    finally { busyTurns = Math.max(0, busyTurns - 1); }
    const { record, hangup, handback } = result;
    if (handback && HANDBACK_ENABLED) pendingHandback = { replyId: writer.replyId };
    // Start the idle clock only once the reply has actually been SPOKEN (jambonz confirms), not when
    // text generation finished — a long reply can still be playing for 15-20 s, and arming on the
    // text end made the "take your time" nudge fire right over the tail of the answer.
    else if (!hangup) ctx.waitSpoken(writer.replyId, 30000).then(() => { if (!nav?.ended) armIdle(); });
    return { record: { ...record, route: `${record.route}${specialist ? ':specialist' : ''}` }, hangup };
  }

  // (Experimental) hand the mic back to the speech-to-speech host. Only used when HYBRID_HANDBACK=1.
  let handedBack = false;
  async function handBack(reason) {
    disarmIdle();
    if (!HANDBACK_ENABLED || !specialist || handedBack || !nav) return;
    handedBack = true;
    const summary = await nav.summary();
    ctx.log.info(`handback -> conductor (${reason}, ${nav.deepTurns} deep turns)`);
    bus.emit(topic(ctx.callSid, 'handback'), { summary, deepTurns: nav.deepTurns, transcript: nav.transcript() });
  }

  return {
    errorReply: "Sorry, that didn't work on my end. Say that again?",
    async start() { await ensure(); ctx.log.info(`navigator role ${specialist ? 'SPECIALIST' : 'standalone'} session=${ctx.sessionId} studio_tools=${(ctx.tools || []).map((t) => t.function?.name).join(',') || 'none'}`); },
    greeting(turn, writer) { return run(turn, writer, 'greeting'); },
    turn(turn, writer) { return run(turn, writer, 'speech'); },
    noInput(turn, writer) { return run(turn, writer, 'no_input'); },
    async onSilence(e) {
      // Something is actively working — a browse in flight, an outbound call, or the Lead's team
      // narrating results as they land — so a silence here is expected (a silent web browse produces
      // no audio). Don't nudge or hang up; just wait for the work to finish.
      if (working()) return;
      // With hand-back enabled, a lull returns to the host; otherwise the streak wind-down below
      // keeps the caller on this leg and ends gracefully only on real, sustained silence.
      if (HANDBACK_ENABLED && specialist && nav?.deepTurns > 0) { await handBack('silence'); return; }
      if ((e.streak || 1) >= 3) {
        const id = ctx.say("Seems like you've headed off. I'll leave the page open for you. Bye for now!");
        await ctx.waitSpoken(id, 8000);
        await ctx.command('hangup', { reason: 'silence' });
        return;
      }
      ctx.say((e.streak || 1) === 1 ? 'Still there?' : "No rush, I'm here when you're ready.");
    },
    async afterTurn({ replyId }) {
      if (!pendingHandback || pendingHandback.replyId !== replyId) return;
      pendingHandback = null;
      const why = await ctx.waitSpoken(replyId, 15000);
      if (why === 'session_end') return;
      await handBack('chit-chat');
    },
    async onEvent(e) {
      if (e.name === 'dtmf' && e.digits === '0') { ctx.say('Sure, one moment.'); await ctx.command('transfer', {}); }
    },
    async end(msg) {
      disarmIdle();
      if (nav && nav.liveSay) nav.liveSay = null; // this leg can no longer speak
      // The shared session lives on (the console may keep browsing); a specialist leg never ends it.
      const n = nav || peekSession(ctx.sessionId);
      if (n && !specialist && msg?.reason !== 'application_redirect') n.emit('call.end', { reason: msg?.reason, callSid: ctx.callSid });
    }
  };
}
