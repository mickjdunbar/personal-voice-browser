// 16 Nov 2026 (mick-agentic-browser): is this session's owner on the WEB CLIENT (the Personal Voice
// Browser page)? Settings changes are only allowed from there — never over a phone line, WhatsApp
// or SMS. Pure so it can be unit-tested.
//
// Signals, in order:
//  - a task thread: the store marks metadata.webOwner per turn (thread born in the console, or this
//    very message typed there);
//  - an explicit tag: the conductor sets info.webClient from the softphone's INVITE headers
//    (X-Client: pvb-web / X-Session) — a WebRTC call from the page, and its background browse;
//  - the legacy fallback for voice legs with no tag (the harness/cascaded path has no SIP headers):
//    the jambonz `to` of a direct-app call is "app-…", a PSTN call is a number;
//  - text sessions: the console's own text box (channel 'text') or the boot warm-up.
export function isWebClient({ channel = 'text', info = {}, metadata = {} } = {}) {
  if (metadata?.task) return Boolean(metadata.webOwner);
  const i = info || {};
  if (typeof i.webClient === 'boolean') return i.webClient;
  if (channel === 'voice' || channel === 'specialist') return /^app-/i.test(String(i.to || ''));
  return i.channel === 'text' || i.channel === 'boot';
}
