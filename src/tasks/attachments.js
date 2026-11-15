/**
 * Owner attachments on task threads (14 Nov 2026): images and documents pasted, dropped or
 * picked into the Async composer. Saved under .tasks-media/<task>/ beside Aria's own screenshots
 * and sketches, served at /task-media/…, and turned into model input for the turn:
 *   - images    → vision parts on the owner's message (data URLs, read back from disk)
 *   - documents → extracted text, appended to the owner's message under a header
 * Text extraction: plain-text formats inline; pdf/docx via scripts/extract-text.py (python -I,
 * pymupdf / python-docx), pdftotext as the pdf fallback. Extracted text is kept in a .txt sidecar
 * so a later turn (or a server restart) re-reads it without re-parsing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const logger = createLogger('attach');
const MEDIA_DIR = process.env.TASKS_MEDIA_DIR || '.tasks-media';
const EXTRACTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/extract-text.py');
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
const TEXT_CAP = 60_000; // chars of document text handed to the model per attachment

// What the composer may send. Key = extension we save under; value = served content type.
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const DOC_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/plain; charset=utf-8' // served as text on purpose: an uploaded page is never executed
};
export const SERVED_TYPES = { ...IMAGE_TYPES, ...DOC_TYPES, svg: 'image/svg+xml' };

const BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
};
function extOf(name, type) {
  const fromName = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (fromName && (IMAGE_TYPES[fromName] || DOC_TYPES[fromName])) return fromName;
  return BY_MIME[String(type || '').toLowerCase().split(';')[0]] || null;
}

/** Validate + save one attachment {name, type, data(base64)} for a task. Returns a media record or {error}. */
export function saveAttachment(taskId, { name, type, data } = {}) {
  const ext = extOf(name, type);
  if (!ext) return { error: `unsupported file type: ${name || type || 'unknown'} (images png/jpg/gif/webp; documents pdf/txt/md/csv/json/docx)` };
  let buf;
  try { buf = Buffer.from(String(data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch { return { error: 'bad file data' }; }
  if (!buf.length) return { error: `${name || 'file'} is empty` };
  if (buf.length > MAX_ATTACHMENT_BYTES) return { error: `${name || 'file'} is over 15 MB` };
  const dir = path.join(MEDIA_DIR, String(taskId));
  const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${ext}`;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), buf); }
  catch (err) { return { error: `could not save ${name || 'file'}: ${err.message}` }; }
  const kind = IMAGE_TYPES[ext] ? 'image' : 'document';
  return { url: `/task-media/${taskId}/${file}`, type: SERVED_TYPES[ext].split(';')[0], kind, name: String(name || file).slice(0, 120), size: buf.length, owner: true };
}

function diskPath(media) {
  const m = /^\/task-media\/([A-Za-z0-9]+)\/([a-z0-9]+\.[a-z0-9]+)$/.exec(media?.url || '');
  return m ? path.join(MEDIA_DIR, m[1], m[2]) : null;
}

/** Owner images of a message as data URLs for the vision model. */
export function imageDataUrls(media = []) {
  const out = [];
  for (const m of media) {
    if (m.kind !== 'image') continue;
    const p = diskPath(m);
    if (!p || !fs.existsSync(p)) continue;
    try { out.push(`data:${m.type};base64,${fs.readFileSync(p).toString('base64')}`); } catch { /* skip */ }
  }
  return out;
}

function runExtractor(file) {
  return new Promise((resolve) => {
    execFile('python', ['-I', EXTRACTOR, file], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ text: String(stdout || '') });
      resolve({ error: String(stderr || err.message).trim().split('\n').at(-1) });
    });
  });
}
function runPdftotext(file) {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-layout', file, '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

/** Text of a document attachment (cached in a .txt sidecar). '' when nothing could be read. */
export async function documentText(media) {
  const p = diskPath(media);
  if (!p || !fs.existsSync(p)) return '';
  const side = `${p}.txt`;
  if (fs.existsSync(side)) return fs.readFileSync(side, 'utf8').slice(0, TEXT_CAP);
  const ext = path.extname(p).slice(1).toLowerCase();
  let text = '';
  try {
    if (['txt', 'md', 'csv', 'json', 'html'].includes(ext)) text = fs.readFileSync(p, 'utf8');
    else if (ext === 'pdf' || ext === 'docx') {
      const r = await runExtractor(p);
      if (r.text !== undefined) text = r.text;
      else {
        logger.warn(`extractor failed for ${media.name}: ${r.error}`);
        if (ext === 'pdf') text = (await runPdftotext(p)) || '';
      }
    }
  } catch (err) { logger.warn(`could not read ${media.name}: ${err.message}`); }
  text = text.replace(/\u0000/g, '').trim();
  try { fs.writeFileSync(side, text, 'utf8'); } catch { /* cache only */ }
  return text.slice(0, TEXT_CAP);
}

/** The owner's words plus attached documents, as the model should read them. */
export async function composeTurnText(text, media = []) {
  const parts = [String(text || '').trim()];
  const docs = media.filter((m) => m.kind === 'document');
  const imgs = media.filter((m) => m.kind === 'image');
  if (imgs.length) parts.push(`[${imgs.length === 1 ? 'The owner attached an image' : `The owner attached ${imgs.length} images`}: ${imgs.map((m) => m.name).join(', ')} — shown to you with this message.]`);
  for (const d of docs) {
    const body = await documentText(d);
    parts.push(`[Attached document: ${d.name} (${Math.max(1, Math.round(d.size / 1024))} KB)]\n${body || '(no readable text could be extracted — say so if you needed it)'}\n[end of ${d.name}]`);
  }
  if (!parts[0]) parts[0] = docs.length || imgs.length ? 'Please look at what I attached.' : '';
  return parts.filter(Boolean).join('\n\n');
}

/** One-line stand-in for attachments when a thread is re-seeded into a fresh Navigator's history. */
export function attachmentSummary(media = []) {
  if (!media?.length) return '';
  return ` [attached: ${media.map((m) => m.name || m.kind).join(', ')}]`;
}
