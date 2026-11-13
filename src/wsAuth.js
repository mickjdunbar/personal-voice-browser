// 2026-11-03 (mick-agentic-browser): shared-secret guard for the jambonz
// application WebSocket (/ws). The verbs we answer with carry the Gemini key
// inline (google_s2s needs it), so the hook must not be open to anyone who
// finds the hostname. jambonz dials the hook URL verbatim, so the secret
// rides in the URL: wss://<host>/ws?token=<WS_SECRET>. Unset secret = open.
import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export function authorizeUpgrade(req, secret) {
  if (!secret) return true;
  const url = new URL(req.url || '/', 'http://localhost');
  if (same(url.searchParams.get('token'), secret)) return true;
  const auth = req.headers?.authorization;
  const h = Array.isArray(auth) ? auth[0] : auth;
  if (h && /^basic /i.test(h)) {
    const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (same(password, secret)) return true;
  }
  if (h && /^bearer /i.test(h) && same(h.slice(7).trim(), secret)) return true;
  return false;
}

export function bearerMatches(header, secret) {
  if (!secret) return true;
  return same(header, `Bearer ${secret}`);
}

export function rejectUpgrade(socket, status = 401, text = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
