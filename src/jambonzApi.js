// 2026-11-03 (mick-agentic-browser): jambonz REST helpers — place a call via
// the conductor application and point applications at this host.
import { config, conductorUrl } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('JambonzAPI');

export async function jambonz(method, path, body) {
  if (!config.jambonz.apiKey) throw Object.assign(new Error('JAMBONZ_API_KEY not configured'), { status: 503 });
  const res = await fetch(`${config.jambonz.apiBase}/v1${path}`, { method, headers: { Authorization: `Bearer ${config.jambonz.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`jambonz ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`), { status: 502 });
  try { return JSON.parse(text); } catch { return text; }
}

/** Ring a phone through the conductor (hybrid by default). */
export async function placeCall({ to, mode = 'hybrid', session = 'main', from, applicationSid }) {
  if (!to) throw Object.assign(new Error('`to` is required'), { status: 400 });
  const appSid = applicationSid || config.jambonz.applicationSid;
  if (!appSid) throw Object.assign(new Error('JAMBONZ_APPLICATION_SID not configured'), { status: 503 });
  const payload = { application_sid: appSid, from: from || config.jambonz.fromNumber, to: { type: 'phone', number: String(to).replace(/^\+/, '') }, tag: { mode, session }, timeout: 45 };
  logger.info(`placing ${mode} call to ${to} via app ${appSid}`);
  const result = await jambonz('POST', `/Accounts/${config.jambonz.accountSid}/Calls`, payload);
  return { ok: true, mode, to, call_sid: result?.sid || result?.call_sid || result, raw: result };
}

/** Point jambonz applications at THIS deployment (wss://<PUBLIC_HOST>/ws). Idempotent. */
export async function registerApplications({ host = config.publicHost, sids = config.jambonz.registerSids } = {}) {
  if (!host || /^(localhost|127\.0\.0\.1)/.test(host)) return { skipped: 'no public host' };
  if (!config.jambonz.apiKey) return { skipped: 'no JAMBONZ_API_KEY' };
  if (!sids?.length) return { skipped: 'no application sids' };
  const wsUrl = conductorUrl(host);
  const results = [];
  for (const sid of sids) {
    try {
      const app = await jambonz('GET', `/Applications/${sid}`);
      const current = app?.call_hook?.url;
      if (current === wsUrl && app?.call_status_hook?.url === wsUrl) { results.push({ sid, name: app?.name, status: 'unchanged', url: wsUrl }); continue; }
      await jambonz('PUT', `/Applications/${sid}`, { call_hook: { url: wsUrl, method: 'POST' }, call_status_hook: { url: wsUrl, method: 'POST' } });
      results.push({ sid, name: app?.name, status: 'updated', from: current || null, url: wsUrl });
      logger.info(`jambonz application ${app?.name || sid} -> ${wsUrl} (was ${current || 'unset'})`);
    } catch (err) {
      results.push({ sid, status: 'error', error: err.message });
    }
  }
  return { url: wsUrl, results };
}
