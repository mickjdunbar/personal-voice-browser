// 2026-11-06 (mick-agentic-browser): a reliable clock for the agent. Without this the model
// guesses the date/time (and got it wrong), so we inject the real current time, in the caller's
// timezone, into the agent + voice-host prompts every turn. Timezone defaults to the owner's
// (Toogoolawah, QLD → Australia/Brisbane); override with TIMEZONE in .env.
export const TIMEZONE = process.env.TIMEZONE || 'Australia/Brisbane';

/** e.g. "Thursday, 6 November 2026 at 2:14 pm (Australia/Brisbane)". */
export function currentTimeString(tz = TIMEZONE) {
  try {
    const s = new Intl.DateTimeFormat('en-AU', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date());
    return `${s} (${tz})`;
  } catch {
    return new Date().toString();
  }
}

/** A ready-made prompt line telling the model the current time and to use it. */
export function currentTimeLine(tz = TIMEZONE) {
  return `CURRENT DATE & TIME: ${currentTimeString(tz)} — use this for "today", "now", the time or date, and any date/time maths. Never guess the time.`;
}
