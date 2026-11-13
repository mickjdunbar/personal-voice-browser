// 2026-11-11 (mick-agentic-browser): TASKS OVER MESSAGING — SMS and WhatsApp as transports
// for the Tasks channel, Instinct-style: no app, just a chat with Aria on the owner's phone.
//
//   in : Twilio Messaging webhook (POST /webhooks/message, form-encoded) → ownerMessage()/createTask().
//        Only the OWNER's number is accepted (OWNER_PHONE); with TWILIO_AUTH_TOKEN set, the
//        X-Twilio-Signature is verified too. Everything else is dropped with a 200 (no bounce
//        that would reveal the endpoint is live).
//   out: every Aria reply on a task is forwarded over Twilio REST — always to the channel the
//        task was STARTED from (a WhatsApp-born task answers on WhatsApp), plus the global
//        TASK_NOTIFY channel when set. No TWILIO_ACCOUNT_SID/AUTH_TOKEN → sends become logged
//        dry-runs, so the whole path is testable before credentials exist.
//
// Threading on a flat chat: every outbound line is prefixed "#<seq> <title>". A reply starting
// with #<seq> continues that task; a WhatsApp quoted-reply (OriginalRepliedMessageSid) also
// resolves, because outbound message SIDs are remembered per task. Anything else = a NEW task.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { subscribe, emitEvent } from '../events.js';
import { createTask, ownerMessage, taskBySeq, taskContact, getTask } from './store.js';
import { createLogger } from '../logger.js';

const log = createLogger('TaskMsg');
const T = config.tasks;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// --- helpers (exported for tests) ---------------------------------------------------
const digits = (s) => String(s || '').replace(/\D/g, '');
/** Loose same-phone check: compare the last 9 digits (survives +61 vs 0, spaces, etc.). */
export function sameNumber(a, b) {
  const x = digits(a), y = digits(b);
  if (!x || !y) return false;
  const n = Math.min(9, x.length, y.length);
  return n >= 7 && x.slice(-n) === y.slice(-n);
}

/** "#12 any text" → { seq: 12, rest: "any text" }; null when the message carries no task tag. */
export function parseTaskTag(body) {
  const m = /^\s*#(\d{1,5})\b[\s:.,—-]*/.exec(String(body || ''));
  return m ? { seq: Number(m[1]), rest: String(body).slice(m[0].length).trim() } : null;
}

/** Twilio request signing: base64 HMAC-SHA1(authToken, url + sorted(key+value)). */
export function validTwilioSignature({ url, params, signature, authToken }) {
  if (!authToken) return true; // nothing to verify against
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature || ''))); }
  catch { return false; }
}

// --- outbound ------------------------------------------------------------------------
const sidToTask = new Map(); // outbound Twilio SID -> taskId (WhatsApp quoted-reply threading)
const introduced = new Set(); // `${taskId}|${channel}` → the "#n to reply" hint already sent

/** Send one message to the owner over Twilio REST. Missing credentials → logged dry-run. */
export async function sendOwnerMessage({ channel, to, body, mediaUrls = [], taskId }) {
  const { accountSid, authToken, smsFrom, whatsappFrom } = T.twilio;
  const dest = channel === 'whatsapp' ? `whatsapp:${to}` : to;
  const from = channel === 'whatsapp' ? `whatsapp:${whatsappFrom}` : smsFrom;
  if (!accountSid || !authToken) {
    log.info(`DRY RUN (no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN): ${channel} → ${dest}: ${String(body).slice(0, 140)}`);
    emitEvent('transport.sent', null, { channel, to: dest, task: taskId, dry_run: true, body: String(body).slice(0, 200), media: mediaUrls.length });
    return { ok: true, dryRun: true };
  }
  const form = new URLSearchParams({ From: from, To: dest, Body: body });
  for (const u of mediaUrls.slice(0, 10)) form.append('MediaUrl', u);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn(`${channel} send failed (${res.status}): ${j.message || 'no detail'}`);
      emitEvent('transport.sent', null, { channel, to: dest, task: taskId, error: j.message || `HTTP ${res.status}` });
      return { error: j.message || `HTTP ${res.status}` };
    }
    if (taskId && j.sid) {
      sidToTask.set(j.sid, taskId);
      if (sidToTask.size > 800) sidToTask.delete(sidToTask.keys().next().value);
    }
    emitEvent('transport.sent', null, { channel, to: dest, task: taskId, sid: j.sid, media: mediaUrls.length });
    // 13 Nov: a SID is not delivery. WhatsApp quietly fails with 63016 once the owner's 24-hour
    // window has lapsed (every message on 12 Nov went "undelivered" that way). Check back shortly
    // and surface it, so the console and the launcher can say exactly what to do.
    if (j.sid) setTimeout(async () => {
      try {
        const s = await (await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages/${j.sid}.json`, { headers: { authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') } })).json();
        if (/^(failed|undelivered)$/.test(s.status || '')) {
          const hint = String(s.error_code) === '63016' ? 'WhatsApp 24-hour window closed — the owner must send any message to the sandbox number to reopen it' : (s.error_message || `Twilio error ${s.error_code}`);
          log.warn(`${channel} ${j.sid} ${s.status}: ${hint}`);
          emitEvent('transport.failed', null, { channel, to: dest, task: taskId, sid: j.sid, status: s.status, error_code: s.error_code, hint, body: String(body).slice(0, 120) });
        }
      } catch { /* status check is best effort */ }
    }, 9000).unref?.();
    return { ok: true, sid: j.sid };
  } catch (err) {
    log.warn(`${channel} send failed: ${err.message}`);
    emitEvent('transport.sent', null, { channel, to: dest, task: taskId, error: err.message });
    return { error: err.message };
  }
}

/** Where a task's Aria replies go: the channel it was born on + the global notify channel. */
function targetsFor(taskId) {
  const out = new Map(); // channel -> to
  const contact = taskContact(taskId);
  if (contact?.channel && contact?.to) out.set(contact.channel, contact.to);
  if (T.notify && T.ownerPhone && !out.has(T.notify)) out.set(T.notify, T.ownerPhone);
  return [...out].map(([channel, to]) => ({ channel, to }));
}

function forward(taskPub, msg) {
  for (const target of targetsFor(taskPub.id)) {
    const tag = `#${taskPub.seq ?? '?'}`;
    const media = Array.isArray(msg.media) ? msg.media : [];
    let text = String(msg.text || '').trim();
    if (!text && media.length) text = media[0].kind === 'sketch' ? 'Sketch attached.' : 'Screenshot attached.';
    // WhatsApp carries the image itself (Twilio fetches MediaUrl over the tunnel); SMS cannot
    // (the toll-free sender has no MMS route to an AU mobile) — point at the drawer instead.
    const mediaUrls = target.channel === 'whatsapp' && config.publicHost
      ? media.map((m) => `https://${config.publicHost}${m.url}`) : [];
    if (media.length && !mediaUrls.length) text += `\n(${media.length === 1 ? 'image' : media.length + ' images'} in your Tasks drawer)`;
    let body = `${tag} ${taskPub.title}\n${text}`;
    const limit = target.channel === 'whatsapp' ? 3800 : 1200; // WhatsApp caps ~4096; SMS segments add up
    if (body.length > limit) body = body.slice(0, limit - 44) + '…\n(full write-up in your Tasks drawer)';
    const introKey = `${taskPub.id}|${target.channel}`;
    if (!introduced.has(introKey)) {
      introduced.add(introKey);
      body += `\n\nReply starting with ${tag} to continue this thread — anything else starts a new task.`;
    }
    sendOwnerMessage({ channel: target.channel, to: target.to, body, mediaUrls, taskId: taskPub.id })
      .catch((err) => log.warn(`forward to ${target.channel} failed: ${err.message}`));
  }
}

let started = false;
/** Subscribe once: every Aria task reply fans out to the phone transports. */
export function initTransports() {
  if (started) return;
  started = true;
  subscribe((ev) => {
    if (ev.type !== 'tasks.update' || !ev.task || !ev.msg) return;
    if (ev.msg.role !== 'aria') return;
    try { forward(ev.task, ev.msg); } catch (err) { log.warn(`forward failed: ${err.message}`); }
  });
  const how = [
    T.ownerPhone ? `owner ${T.ownerPhone.slice(0, 4)}…` : 'NO OWNER_PHONE (inbound disabled)',
    T.twilio.accountSid && T.twilio.authToken ? 'twilio creds set' : 'no Twilio creds (sends dry-run)',
    T.notify ? `notify=${T.notify}` : 'notify off'
  ].join(' · ');
  log.info(`task messaging: ${how}`);
}

// --- inbound -------------------------------------------------------------------------
/** Handle one Twilio Messaging webhook POST. Returns { status, twiml }. Never throws. */
export async function handleInboundMessage({ raw, headers = {}, path = '/webhooks/message' }) {
  let params = {};
  try { params = Object.fromEntries(new URLSearchParams(String(raw || ''))); } catch { /* fall through to reject */ }
  const from = String(params.From || '');
  const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const fromNum = from.replace(/^whatsapp:/, '');
  const reject = (why) => {
    log.warn(`inbound ${channel} dropped: ${why}`);
    emitEvent('transport.rejected', null, { channel, why });
    return { status: 200, twiml: EMPTY_TWIML }; // a quiet 200: no bounce, no probe feedback
  };

  if (!T.ownerPhone) return reject('OWNER_PHONE is not set — all inbound is ignored');
  if (!sameNumber(fromNum, T.ownerPhone)) return reject('sender is not the owner');
  if (T.twilio.authToken) {
    const url = `https://${config.publicHost || `localhost:${config.port}`}${path}`;
    const sig = headers['x-twilio-signature'];
    if (!validTwilioSignature({ url, params, signature: sig, authToken: T.twilio.authToken })) {
      return reject('bad or missing X-Twilio-Signature');
    }
  }

  const body = String(params.Body || '').trim();
  if (!body) return reject('empty body');

  // Route: "#<seq> …" continues that task; a WhatsApp quoted-reply continues the quoted task;
  // anything else starts a new one, remembering where it came from so replies go back there.
  const tag = parseTaskTag(body);
  let task = null, text = body;
  if (tag) {
    task = taskBySeq(tag.seq);
    if (task && tag.rest) text = tag.rest;
    else if (task && !tag.rest) return reject(`tag #${tag.seq} with no message`);
  }
  if (!task && params.OriginalRepliedMessageSid && sidToTask.has(params.OriginalRepliedMessageSid)) {
    task = getTask(sidToTask.get(params.OriginalRepliedMessageSid));
  }
  emitEvent('transport.inbound', null, { channel, task: task?.id || null, body: body.slice(0, 200) });
  if (task) {
    const r = ownerMessage(task.id, text, channel);
    if (r.error) return reject(`ownerMessage: ${r.error}`);
    log.info(`inbound ${channel} → task #${task.seq ?? '?'} (${task.id})`);
  } else {
    const t = createTask({ text, via: channel, contact: { channel, to: fromNum } });
    log.info(`inbound ${channel} → NEW task #${t.seq ?? '?'} (${t.id})`);
    // Immediate ack so the phone isn't silent while Aria researches (can take minutes).
    sendOwnerMessage({ channel, to: fromNum, body: `#${t.seq} ${t.title}\nOn it — I'll message you here when I have something.`, taskId: t.id })
      .catch(() => {});
  }
  return { status: 200, twiml: EMPTY_TWIML };
}
