// 2026-11-05 (mick-agentic-browser): the LEAD — a silent team leader (traffic
// cop). It never speaks to the caller; only Aria does. Its job:
//   1. plan a request into a task graph (planner.js);
//   2. fan the ready tasks out to WORKERS concurrently (worker.js) — several at
//      once, including several of the same kind (two phone calls in parallel);
//   3. as each worker finishes, COMPOSE one coherent spoken line that fits the
//      whole plan (not four agents talking over each other) and hand it to Aria
//      to say — live, so the caller is never left in silence;
//   4. run dependent tasks once their inputs land ("book the pub for the three
//      of us" after the two calls), feeding them the upstream results;
//   5. let the caller interject mid-flight — cancel, add to the plan, ask for a
//      status, or just chat — and replan.
//
// It rides on primitives that already work live: Aria speaks async lines via
// nav.liveSay (the same path the phone feature relays answers on), and every
// result is written into the shared history so follow-ups have the context.
import { planTasks } from './planner.js';
import { runTask } from './worker.js';
import { completeText } from '../llm/client.js';
import { config } from '../config.js';
import { renderContext } from '../context.js';
import { agentById, HOST } from './team.js';
import { createLogger } from '../logger.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export class Lead {
  constructor(nav) {
    this.nav = nav;
    this.log = createLogger(`Lead:${nav.sessionId.slice(0, 8)}`);
    this.active = false;
    this.tasks = [];
    this.state = new Map(); // id -> { status, result, controller }
  }

  get running() { return [...this.state.values()].filter((s) => s.status === 'running'); }
  get live() { return this.active && [...this.state.values()].some((s) => !TERMINAL.has(s.status)); }

  /**
   * Consider a caller turn for orchestration. Returns false for a single-task request (the caller
   * then runs the normal one-specialist turn). Returns true once it has taken the turn over: it has
   * spoken an immediate acknowledgement on `writer` and dispatched the team in the background.
   */
  async kickoff(text, writer, record = {}) {
    const { multi, tasks, say } = await planTasks({
      text, contextText: renderContext(this.nav.sessionId), history: this.nav.history
    });
    if (!multi) return false;

    this.active = true;
    this.tasks = tasks;
    this.state = new Map(tasks.map((t) => [t.id, { status: 'pending', result: '', controller: null }]));
    record.flags?.push('orchestrated');
    record.plan = tasks.length;
    this.nav.emit('team.plan', {
      tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, agent: t.agent, title: t.title, needs: t.needs }))
    });

    const line = say || this.fallbackKickoff(tasks);
    writer.write(line);
    this.nav.history.push({ role: 'assistant', content: line });
    this.log.info(`orchestrating ${tasks.length} tasks: ${tasks.map((t) => `${t.id}:${t.kind}`).join(', ')}`);

    // Keep the live leg from winding down while the team works (reuses the idle watchdog's guard).
    this.nav.workPending = (this.nav.workPending || 0) + tasks.length;
    setTimeout(() => this.dispatch(), 0); // after this turn's reply is flushed
    return true;
  }

  fallbackKickoff(tasks) {
    const now = tasks.filter((t) => !t.needs.length).map((t) => t.title.toLowerCase());
    const later = tasks.filter((t) => t.needs.length).map((t) => t.title.toLowerCase());
    let s = now.length ? `Right — I'll ${joinList(now)} now` : "Right — I'm on it";
    if (later.length) s += `, then ${joinList(later)} once I hear back`;
    return s + '.';
  }

  /** Start every task whose dependencies have all finished. */
  dispatch() {
    if (!this.active) return;
    for (const task of this.tasks) {
      const st = this.state.get(task.id);
      if (!st || st.status !== 'pending') continue;
      if (!task.needs.every((n) => TERMINAL.has(this.state.get(n)?.status))) continue;
      this.startTask(task, st);
    }
  }

  startTask(task, st) {
    st.status = 'running';
    const controller = new AbortController();
    st.controller = controller;
    const agent = agentById(task.agent) || HOST;
    this.nav.emit('task.start', { id: task.id, kind: task.kind, title: task.title, agent: { id: agent.id, name: agent.name, title: agent.title, color: agent.color } });
    const upstream = task.needs
      .map((n) => this.state.get(n)?.result)
      .filter(Boolean)
      .join('; ') + (task.derive ? ` (${task.derive})` : '');
    runTask(task, {
      sessionId: this.nav.sessionId,
      contextText: renderContext(this.nav.sessionId),
      upstream: upstream.trim(),
      signal: controller.signal
    })
      .then((o) => this.onDone(task, o))
      .catch((err) => this.onDone(task, { ok: false, result: '', error: err.message }));
  }

  async onDone(task, outcome) {
    const st = this.state.get(task.id);
    if (!st || st.status === 'cancelled' || !this.active) return;
    st.status = outcome.ok ? 'done' : 'failed';
    st.result = outcome.result || (outcome.error ? `couldn't finish ${task.title}` : '');
    this.nav.workPending = Math.max(0, (this.nav.workPending || 1) - 1);
    this.nav.emit('task.done', { id: task.id, title: task.title, ok: outcome.ok, result: st.result.slice(0, 160) });
    this.log.info(`task ${task.id} ${st.status}: ${st.result.slice(0, 80)}`);

    const allDone = this.tasks.every((t) => TERMINAL.has(this.state.get(t.id)?.status));
    const line = await this.narrate(task, allDone);
    this.speak(line, agentById(task.agent) || HOST);

    if (allDone) { this.active = false; this.log.info('all tasks complete'); }
    else this.dispatch();
  }

  /** Compose ONE coherent spoken line for Aria: what just happened, and what is still in flight. */
  async narrate(justFinished, wrapUp) {
    const done = this.tasks.filter((t) => this.state.get(t.id)?.status === 'done').map((t) => this.state.get(t.id).result);
    const failed = this.tasks.filter((t) => this.state.get(t.id)?.status === 'failed').map((t) => `${t.title}: ${this.state.get(t.id).result}`);
    const waiting = this.tasks.filter((t) => !TERMINAL.has(this.state.get(t.id)?.status)).map((t) => t.title);
    try {
      const sys = wrapUp
        ? 'You are a voice assistant wrapping up a few tasks you did for the caller. In ONE or TWO short, natural spoken sentences, tell them the outcome of everything. Mention anything that failed plainly. No preamble, no lists, no quotes.'
        : 'You are a voice assistant giving the caller a quick spoken update as tasks finish one by one. In ONE short, natural sentence, say what JUST came back and, if anything is still running, that you are waiting on it. No preamble, no quotes.';
      const user = [
        `Just finished: ${justFinished.title} — ${this.state.get(justFinished.id)?.result || 'done'}`,
        done.length ? `Completed so far: ${done.join(' | ')}` : '',
        failed.length ? `Didn't work: ${failed.join(' | ')}` : '',
        waiting.length ? `Still running: ${waiting.join(', ')}` : 'Nothing left running.'
      ].filter(Boolean).join('\n');
      const out = await completeText({
        model: config.llm.summaryModel,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        params: { max_tokens: 80, temperature: 0.5 }
      });
      const line = String(out).trim();
      if (line) return line;
    } catch (err) { this.log.warn(`narrate failed: ${err.message}`); }
    // Template fallback keeps the line coherent even without the model.
    const base = this.state.get(justFinished.id)?.result || `done with ${justFinished.title}`;
    return waiting.length ? `Okay — ${base}. Still working on the rest.` : `Okay — ${base}.`;
  }

  /** Hand a line to Aria: speak it live if we can, keep it in shared history, show it on the console. */
  speak(line, agent = HOST) {
    if (!line) return;
    this.nav.history.push({ role: 'assistant', content: line });
    this.nav.emit('agent.said', {
      turn: this.nav.turns, text: line, lane: 'team',
      agent: { id: agent.id, name: agent.name, title: agent.title, color: agent.color },
      unprompted: true, async: true
    });
    try { this.nav.liveSay?.(line); } catch (err) { this.log.warn(`liveSay failed: ${err.message}`); }
  }

  /**
   * A caller turn arrived while the team is working. Decide what they want and act. Always writes a
   * short spoken reply to `writer` (this turn's reply).
   */
  async interject(text, writer) {
    const decision = await this.decide(text);
    this.nav.history.push({ role: 'user', content: text });
    if (decision.action === 'cancel') {
      this.cancelAll('caller asked to stop');
      writer.write(decision.say || "Okay, I've stopped that.");
      return;
    }
    if (decision.action === 'augment') {
      const { tasks } = await planTasks({ text, contextText: renderContext(this.nav.sessionId), history: this.nav.history });
      if (tasks.length) {
        const offset = this.tasks.length;
        for (let i = 0; i < tasks.length; i++) {
          const t = { ...tasks[i], id: `a${offset + i + 1}` };
          this.tasks.push(t);
          this.state.set(t.id, { status: 'pending', result: '', controller: null });
          this.nav.workPending = (this.nav.workPending || 0) + 1;
        }
        this.active = true;
        writer.write(decision.say || "Sure, I'll add that.");
        setTimeout(() => this.dispatch(), 0);
        return;
      }
    }
    if (decision.action === 'status') {
      writer.write(decision.say || this.statusLine());
      return;
    }
    // Default: a direct short reply; keep working.
    writer.write(decision.say || "I'm still on it — I'll let you know as each bit comes back.");
  }

  statusLine() {
    const running = this.running.map((s) => this.taskById(s)?.title).filter(Boolean);
    const done = this.tasks.filter((t) => this.state.get(t.id)?.status === 'done').length;
    if (running.length) return `Still working on ${joinList(running)} — ${done} done so far.`;
    return this.live ? "Still on it." : "That's all done.";
  }

  taskById(stObj) { return this.tasks.find((t) => this.state.get(t.id) === stObj); }

  /** Quick fast-model triage of an interjection. Degrades to a status reply on any failure. */
  async decide(text) {
    try {
      const out = await completeText({
        model: config.llm.summaryModel,
        messages: [
          { role: 'system', content: `The assistant is running these tasks for the caller: ${this.tasks.map((t) => t.title).join(', ')}. The caller just interrupted. Decide what they want. Reply STRICT JSON only: {"action":"cancel|augment|status|answer","say":"one short spoken sentence to reply with now"}. cancel=stop the work; augment=add a new task; status=they asked how it's going; answer=small talk or a question you can answer in one line.` },
          { role: 'user', content: text }
        ],
        params: { max_tokens: 100, temperature: 0.2 }
      });
      const a = out.indexOf('{'); const b = out.lastIndexOf('}');
      const parsed = a >= 0 && b > a ? JSON.parse(out.slice(a, b + 1)) : {};
      const action = ['cancel', 'augment', 'status', 'answer'].includes(parsed.action) ? parsed.action : 'status';
      return { action, say: typeof parsed.say === 'string' ? parsed.say.trim() : '' };
    } catch { return { action: 'status', say: '' }; }
  }

  cancelAll(reason = 'cancelled') {
    for (const st of this.state.values()) {
      if (st.status === 'running' || st.status === 'pending') { st.status = 'cancelled'; try { st.controller?.abort(reason); } catch { /* ignore */ } }
    }
    this.active = false;
    this.nav.workPending = 0;
    this.nav.emit('team.cancelled', { reason });
  }
}

function joinList(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
}
