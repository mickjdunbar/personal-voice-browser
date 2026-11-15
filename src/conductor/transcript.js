// 16 Nov 2026 (mick-agentic-browser): the live-call transcript folding, as a pure module so it can
// be unit-tested with replayed provider events. ONE line per spoken item:
//  - OpenAI Realtime carries an item id on every transcript event → lines are keyed by it, and a
//    caller line is stamped with the moment its speech STARTED (input_audio_buffer.committed carries
//    the item id; speech_started carried the time), not when the late transcription landed.
//  - Gemini Live carries no item ids → synthetic ones: a new assistant item at every turnComplete,
//    a new caller item whenever the assistant starts speaking after the caller. Without these, a
//    late caller transcription glued Aria's next answer onto her previous line (15 Nov).
// `ctl` is the conductor's per-call object; this module only touches ctl.transcript, ctl.itemAt,
// ctl.farStartAt and ctl.synth.

/** Mark the current open line of `role` closed (a response / turn boundary, or the next speech start). */
export function closeLine(ctl, role) {
  const last = ctl.transcript.at(-1);
  if (last && last.role === role && !last.closed) last.closed = true;
}

/** The caller started speaking (VAD): remember when, and close any open caller line. */
export function noteSpeechStart(ctl, now = Date.now()) {
  ctl.farStartAt = now;
  closeLine(ctl, 'user');
}

/** The caller's utterance was committed under `itemId`: its transcript will arrive later with that id. */
export function noteCommitted(ctl, itemId, now = Date.now()) {
  if (!itemId) return;
  (ctl.itemAt ||= new Map()).set(itemId, ctl.farStartAt || now);
  if (ctl.itemAt.size > 50) ctl.itemAt.delete(ctl.itemAt.keys().next().value);
}

/** A response / turn finished: close the assistant line; Gemini's next assistant line gets a new synthetic item. */
export function noteTurnComplete(ctl) {
  closeLine(ctl, 'assistant');
  (ctl.synth ||= { user: 0, assistant: 0 }).assistant += 1;
}

/**
 * Fold one transcript piece into ctl.transcript. Returns { line, lineNo, newLine }.
 * @param {object} ctl
 * @param {{role:'user'|'assistant', text:string, item?:string|null, now?:number}} piece
 */
export function foldTranscript(ctl, { role, text, item = null, now = Date.now() }) {
  ctl.synth ||= { user: 0, assistant: 0 };
  const last = ctl.transcript.at(-1);
  if (!item) {
    // Gemini: synthesise the item. The assistant starting to speak closes the caller's open line
    // (their next utterance is a new one) and bumps the caller's synthetic counter.
    if (role === 'assistant' && last && last.role === 'user' && !last.closed) { last.closed = true; ctl.synth.user += 1; }
    item = `${role}#${ctl.synth[role]}`;
  }
  // The open line this piece belongs to: the same item (looked for in the last few lines — the
  // caller's late transcription may already sit AFTER Aria's line when her next delta arrives), or,
  // for a line with no item, the last line of this role if it is still open.
  let idx = -1;
  for (let i = ctl.transcript.length - 1; i >= 0 && i >= ctl.transcript.length - 6; i--) {
    const l = ctl.transcript[i];
    if (l.role === role && !l.closed && l.item === item) { idx = i; break; }
  }
  if (idx < 0 && last && last.role === role && !last.closed && !last.item) idx = ctl.transcript.length - 1;
  const newLine = idx < 0;
  if (newLine) {
    const at = role === 'user' ? ((ctl.itemAt?.get(item)) || ctl.farStartAt || now) : now;
    ctl.itemAt?.delete(item);
    ctl.transcript.push({ role, text, item, at });
    idx = ctl.transcript.length - 1;
  } else ctl.transcript[idx].text += text;
  return { line: ctl.transcript[idx], lineNo: idx, newLine };
}
