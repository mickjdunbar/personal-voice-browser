// 2026-11-03 (mick-agentic-browser): one call on the jambonz custom-harness
// protocol (subprotocol harness.jambonz.org, protocol 1). jambonz keeps STT,
// turn detection, barge-in and TTS; we receive the caller's words as text and
// stream replies back as OpenAI-style chat.completion.chunk deltas.
//
// A HarnessCall owns the wire; a ROLE (src/harness/roles/*) owns the brain.
// Protocol reference: https://docs.jambonz.org/agent-studio/custom-harness/protocol
import { SentenceSplitter, scrubForSpeech } from '../llm/sentences.js';
import { emitEvent } from '../events.js';
import { createLogger } from '../logger.js';

const MAX_TURN_RECORD_BYTES = 16 * 1024;

export class HarnessCall {
  constructor(ws, start, role, { sessionId } = {}) {
    this.ws = ws;
    this.start = start;
    this.callSid = start.call_sid;
    this.roleName = role.name;
    this.sessionId = sessionId || start.call_sid;
    this.metadata = start.metadata || {};
    this.tools = Array.isArray(start.tools) ? start.tools : [];
    this.seq = 0;
    this.turns = 0;
    this.current = null;
    this.pendingCommands = new Map();
    this.pendingTools = new Map();
    this.replies = new Map();
    this.spokenWaiters = new Map();
    this.startedAt = Date.now();
    this.ended = false;
    this.turnRecordExtra = {};
    this.log = createLogger(`Harness:${role.name}:${this.callSid.slice(0, 8)}`);
    this.handlers = role.create(this.ctx());
  }

  ctx() {
    const call = this;
    return {
      get callSid() { return call.callSid; },
      get sessionId() { return call.sessionId; },
      get session() { return call.start; },
      get metadata() { return call.metadata; },
      get tools() { return call.tools; },
      get log() { return call.log; },
      get startedAt() { return call.startedAt; },
      say: (text, opts) => call.say(text, opts),
      command: (name, args) => call.command(name, args),
      callTool: (name, args) => call.callTool(name, args),
      record: (field, value) => { call.turnRecordExtra[field] = value; },
      emit: (name, payload) => emitEvent(name, call.sessionId, { callSid: call.callSid, ...payload }),
      waitSpoken: (replyId, timeoutMs) => call.waitSpoken(replyId, timeoutMs)
    };
  }

  send(msg) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  chunkMessage(replyId, turnId, text, first) {
    return {
      type: 'reply:chunk',
      reply_id: replyId,
      ...(turnId !== undefined ? { turn_id: turnId } : {}),
      ...(first || {}),
      chunk: { id: replyId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'harness', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
    };
  }

  async handle(msg) {
    switch (msg.type) {
      case 'turn:start': return this.runTurn(msg);
      case 'turn:cancel':
        if (this.current?.turnId === msg.turn_id) { this.log.debug(`turn ${msg.turn_id} cancelled (${msg.reason})`); this.current.abort.abort(msg.reason); }
        emitEvent('turn.cancel', this.sessionId, { callSid: this.callSid, turnId: msg.turn_id, reason: msg.reason });
        return;
      case 'transcript':
        emitEvent('stt.partial', this.sessionId, { callSid: this.callSid, turnId: msg.turn_id, text: msg.text, final: msg.final, confidence: msg.confidence });
        this.handlers.onTranscript?.(msg);
        return;
      case 'speech:start':
        emitEvent('stt.speech_start', this.sessionId, { callSid: this.callSid, turnId: msg.turn_id });
        this.handlers.onSpeechStart?.(msg);
        return;
      case 'event': return this.handleEvent(msg);
      case 'command:result': {
        const p = this.pendingCommands.get(msg.command_id);
        if (p) { this.pendingCommands.delete(msg.command_id); p({ ok: msg.ok, error: msg.error }); }
        return;
      }
      case 'tool:result': {
        const p = this.pendingTools.get(msg.call_id);
        if (p) { this.pendingTools.delete(msg.call_id); if (msg.error !== undefined) p.reject(new Error(msg.error)); else p.resolve(msg.result); }
        return;
      }
      case 'session:end': return this.end(msg);
      default: this.log.debug(`ignoring message type ${msg.type}`);
    }
  }

  async handleEvent(e) {
    if (e.name === 'user_interruption') this.trimToSpoken(e);
    if (e.name === 'reply_spoken' || e.name === 'reply_dropped') {
      const done = this.spokenWaiters.get(e.reply_id);
      if (done) { this.spokenWaiters.delete(e.reply_id); done(e.name); }
    }
    if (e.name === 'error') this.log.warn(`jambonz refused a message: ${e.code} ${e.message}`);
    emitEvent(`jambonz.${e.name}`, this.sessionId, { callSid: this.callSid, ...e, type: undefined });
    try {
      if (e.name === 'silence') await this.handlers.onSilence?.(e);
      else await this.handlers.onEvent?.(e);
    } catch (err) { this.log.error(`event handler (${e.name}) threw: ${err.message}`); }
  }

  trimToSpoken(e) {
    const msg = this.replies.get(e.reply_id);
    if (!msg) return;
    const spoken = (e.spoken || '').trim();
    msg.content = spoken || '(interrupted before speaking)';
    msg.interrupted = true;
    this.log.info(`interrupted; kept "${spoken.slice(0, 60)}"`);
  }

  async runTurn(msg) {
    if (this.current) this.current.abort.abort('superseded');
    const turnId = msg.turn_id;
    const replyId = `r${++this.seq}`;
    const abort = new AbortController();
    this.current = { turnId, replyId, abort };
    this.turns += 1;
    const turnStartedAt = Date.now();
    const writer = this.writer(replyId, turnId, abort.signal);
    const input = msg.input || { type: 'no_input' };
    let record = { route: this.roleName, steps: [], model_calls: [], flags: [] };
    let hangup = null;
    emitEvent('turn.start', this.sessionId, { callSid: this.callSid, turnId, input: input.type, text: input.text || '' });
    try {
      const turn = { turnId, input, text: input.type === 'speech' ? String(input.text || '').trim() : '', record, signal: abort.signal };
      let result;
      if (input.type === 'greeting') result = await this.handlers.greeting(turn, writer);
      else if (input.type === 'no_input') result = await this.handlers.noInput(turn, writer);
      else result = await this.handlers.turn(turn, writer);
      hangup = result?.hangup || null;
      if (result?.record) record = { ...record, ...result.record };
    } catch (err) {
      if (abort.signal.aborted) this.log.debug(`turn ${turnId} aborted: ${abort.signal.reason}`);
      else {
        this.log.error(`turn ${turnId} failed: ${err.stack || err.message}`);
        record.flags.push('error');
        record.note = `turn failed: ${err.message}`;
        if (!writer.started) writer.write(this.handlers.errorReply || 'Sorry, I lost my train of thought. Could you say that again?');
      }
    }
    if (abort.signal.aborted) { if (this.current?.turnId === turnId) this.current = null; return; }
    writer.finish();
    record.first_chunk_ms = writer.firstChunkMs ? writer.firstChunkMs - turnStartedAt : null;
    record.steps.push({ name: 'turn_total', ms: Date.now() - turnStartedAt });
    record = { ...record, ...this.turnRecordExtra };
    this.turnRecordExtra = {};
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_TURN_RECORD_BYTES) record = { route: record.route, lane: record.lane, note: 'turn_record truncated (over 16 KB)' };
    this.send({ type: 'reply:done', reply_id: replyId, turn_id: turnId, turn_record: record });
    this.current = null;
    try { await this.handlers.afterTurn?.({ turnId, replyId, record, reply: writer.text }); } catch (err) { this.log.error(`afterTurn threw: ${err.message}`); }
    if (hangup) {
      await this.waitSpoken(replyId, 10000);
      await this.command('hangup', { reason: hangup.reason || 'harness_done' });
    }
  }

  writer(replyId, turnId, signal) {
    const call = this;
    const splitter = new SentenceSplitter();
    let started = false;
    let firstChunkAt = null;
    const firstOpts = {};
    const assistantMsg = { role: 'assistant', content: '' };
    const w = {
      replyId,
      get started() { return started; },
      get text() { return assistantMsg.content; },
      get firstChunkMs() { return firstChunkAt; },
      get message() { return assistantMsg; },
      setInterruptible(v) { firstOpts.interruptible = v; },
      setInterrupt(v) { firstOpts.interrupt = v; }, // first chunk flushes any speech in progress
      emit(text) {
        let clean = scrubForSpeech(text);
        if (!clean.trim() || signal?.aborted) return;
        // Keep a space between consecutive chunks (e.g. a filler beat then the answer) so sentences
        // never run together as "for you.Searching" — both in the spoken audio and the transcript.
        if (started && assistantMsg.content && !/\s$/.test(assistantMsg.content) && !/^\s/.test(clean)) clean = ' ' + clean;
        if (!started) { call.replies.set(replyId, assistantMsg); call.send(call.chunkMessage(replyId, turnId, clean, firstOpts)); started = true; firstChunkAt = Date.now(); }
        else call.send(call.chunkMessage(replyId, turnId, clean));
        assistantMsg.content += clean;
        emitEvent('tts.chunk', call.sessionId, { callSid: call.callSid, replyId, turnId, text: clean });
      },
      push(delta) { for (const s of splitter.push(delta)) w.emit(s); },
      write(text) { for (const s of splitter.push(text)) w.emit(s); const rest = splitter.flush(); if (rest) w.emit(rest); },
      finish() { const rest = splitter.flush(); if (rest) w.emit(rest); }
    };
    return w;
  }

  /**
   * Drive a turn from TYPED text as if the caller had spoken it: the role answers and the reply is
   * streamed to jambonz and SPOKEN on the call, but the typed words themselves are never voiced.
   * Used when the operator types in the console during a live call.
   */
  async injectText(text) {
    const clean = String(text || '').trim();
    if (!clean || this.ended) return { ok: false, error: this.ended ? 'call ended' : 'empty' };
    if (this.current) this.current.abort.abort('superseded_by_typed_input');
    const replyId = `i${++this.seq}`;
    const abort = new AbortController();
    this.current = { turnId: undefined, replyId, abort };
    this.turns += 1;
    const startedAt = Date.now();
    // turnId undefined -> reply chunks carry no turn_id, so jambonz speaks them as agent-initiated
    // speech (the same path as say()), not as the answer to a solicited turn.
    const writer = this.writer(replyId, undefined, abort.signal);
    // The typed reply flushes any speech still playing, so a correction is heard AT ONCE instead of
    // queuing behind the now-wrong answer (which left the caller in silence, asking "still there?").
    writer.setInterrupt(true);
    let record = { route: `${this.roleName}:typed`, steps: [], model_calls: [], flags: ['typed_injected'] };
    let hangup = null;
    emitEvent('turn.start', this.sessionId, { callSid: this.callSid, turnId: replyId, input: 'typed', text: clean });
    try {
      const turn = { turnId: replyId, input: { type: 'speech', text: clean }, text: clean, record, signal: abort.signal };
      const result = await this.handlers.turn(turn, writer);
      hangup = result?.hangup || null;
      if (result?.record) record = { ...record, ...result.record };
    } catch (err) {
      if (!abort.signal.aborted) { this.log.error(`typed turn failed: ${err.message}`); if (!writer.started) writer.write(this.handlers.errorReply || 'Sorry, say that again?'); }
    }
    if (abort.signal.aborted) { if (this.current?.replyId === replyId) this.current = null; return { ok: false, error: 'superseded' }; }
    writer.finish();
    record.first_chunk_ms = writer.firstChunkMs ? writer.firstChunkMs - startedAt : null;
    this.send({ type: 'reply:done', reply_id: replyId, turn_record: record });
    this.current = null;
    try { await this.handlers.afterTurn?.({ turnId: replyId, replyId, record, reply: writer.text }); } catch (err) { this.log.error(`afterTurn (typed) threw: ${err.message}`); }
    if (hangup) { await this.waitSpoken(replyId, 10000); await this.command('hangup', { reason: hangup.reason || 'harness_done' }); }
    return { ok: true, reply: writer.text, record };
  }

  say(text, { interrupt = false, interruptible } = {}) {
    const replyId = `u${++this.seq}`;
    const msg = { role: 'assistant', content: '' };
    const splitter = new SentenceSplitter();
    let first = true;
    const emit = (t) => {
      const clean = scrubForSpeech(t);
      if (!clean.trim()) return;
      const opts = first ? { interrupt, ...(interruptible !== undefined ? { interruptible } : {}) } : undefined;
      this.send(this.chunkMessage(replyId, undefined, clean, opts));
      msg.content += clean;
      if (first) { this.replies.set(replyId, msg); first = false; }
    };
    for (const s of splitter.push(text)) emit(s);
    const rest = splitter.flush();
    if (rest) emit(rest);
    this.send({ type: 'reply:done', reply_id: replyId });
    emitEvent('agent.said', this.sessionId, { callSid: this.callSid, text: msg.content, unprompted: true });
    return replyId;
  }

  command(name, args = {}) {
    const commandId = `c${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.pendingCommands.delete(commandId)) resolve({ ok: false, error: 'timeout' }); }, 15000);
      this.pendingCommands.set(commandId, (r) => { clearTimeout(timer); resolve(r); });
      this.send({ type: 'command', command_id: commandId, name, args });
      emitEvent('harness.command', this.sessionId, { callSid: this.callSid, name, args });
    });
  }

  callTool(name, args = {}) {
    const callId = `t${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pendingTools.delete(callId)) reject(new Error(`tool ${name} timed out`)); }, 30000);
      this.pendingTools.set(callId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ type: 'tool:call', call_id: callId, ...(this.current ? { turn_id: this.current.turnId } : {}), name, args });
    });
  }

  waitSpoken(replyId, timeoutMs = 20000) {
    if (!this.replies.has(replyId)) return Promise.resolve('unknown');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.spokenWaiters.delete(replyId); resolve('timeout'); }, timeoutMs);
      this.spokenWaiters.set(replyId, (why) => { clearTimeout(timer); resolve(why); });
    });
  }

  async end(msg) {
    if (this.ended) return;
    this.ended = true;
    this.current?.abort.abort('session_end');
    for (const r of this.pendingCommands.values()) r({ ok: false, error: 'session_ended' });
    this.pendingCommands.clear();
    for (const p of this.pendingTools.values()) p.reject(new Error('session_ended'));
    this.pendingTools.clear();
    for (const done of this.spokenWaiters.values()) done('session_end');
    this.spokenWaiters.clear();
    const durationMs = msg?.duration_ms ?? Date.now() - this.startedAt;
    this.log.info(`session ended (${msg?.reason || 'socket closed'}, ${durationMs} ms, ${this.turns} turns)`);
    try { await this.handlers.end?.(msg || { reason: 'socket_closed' }); } catch (err) { this.log.error(`end handler threw: ${err.message}`); }
    emitEvent('harness.end', this.sessionId, { callSid: this.callSid, reason: msg?.reason, duration_ms: durationMs, turns: this.turns });
  }
}
