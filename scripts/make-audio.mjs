// 2026-11-04 (mick-agentic-browser): synthesize the two loopable audio beds the
// call dubs in under the conversation — a soft room-tone "ambience" and a
// gentle "typing" clatter — so the caller is never sitting in dead silence
// while a specialist works. No external assets: both are written here as small
// 8 kHz mono PCM WAVs and served from /public/audio. Run: npm run build:audio.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio');
const SR = 8000; // telephony rate; jambonz resamples as needed and the files stay tiny

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, samples[i])); buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2); }
  return buf;
}

// Seamless loop: crossfade the tail into the head so there is no click at the wrap.
function seamless(buf, fadeSecs = 0.3) {
  const f = Math.floor(fadeSecs * SR);
  const out = buf.slice(0, buf.length - f);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + buf[buf.length - f + i] * (1 - a); }
  return out;
}

// ---- ambience: low room tone — a touch of mains hum under filtered brown noise ----
function ambience(secs = 12) {
  const n = SR * secs;
  const out = new Float32Array(n);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    const hum = 0.0045 * Math.sin(2 * Math.PI * 50 * t) + 0.003 * Math.sin(2 * Math.PI * 100 * t);
    const lfo = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.07 * t); // slow breathing of the bed
    out[i] = (brown * 2.2 * 0.018 + hum) * lfo;
  }
  // one-pole low-pass ~500 Hz to take the hiss off
  const a = Math.exp(-2 * Math.PI * 500 / SR);
  let y = 0; for (let i = 0; i < n; i++) { y = a * y + (1 - a) * out[i]; out[i] = y; }
  return seamless(out, 0.4);
}

// ---- typing: irregular key clicks, like a colleague working at a keyboard -----------
function typing(secs = 9) {
  const n = SR * secs;
  const out = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const gap = Math.floor((0.05 + Math.random() * 0.14) * SR); // 50–190 ms between keys
    const burst = Math.random() < 0.18 ? 0.25 : 1; // occasional softer key
    const len = Math.floor((0.006 + Math.random() * 0.01) * SR);
    const f = 1400 + Math.random() * 2200;
    for (let k = 0; k < len && i + k < n; k++) {
      const env = Math.exp(-k / (len * 0.35));
      out[i + k] += Math.sin(2 * Math.PI * f * (k / SR)) * env * 0.09 * burst + (Math.random() * 2 - 1) * env * 0.03 * burst;
    }
    i += gap;
  }
  return seamless(out, 0.2);
}

// ---- hold (12 Nov): a warm, slow pad for while a call is being made on the caller's behalf —
// two soft chords (Cmaj7 → Am7) breathing every 8 s, detuned sine partials for width, slow
// tremolo, low-passed for warmth. Seamless 16 s loop. Unmistakably "something is happening".
function hold(secs = 16) {
  const n = SR * secs;
  const out = new Float32Array(n);
  const chords = [[261.63, 329.63, 392.0, 493.88], [220.0, 261.63, 329.63, 392.0]]; // C E G B · A C E G
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const phase = (t % secs) / secs;
    const which = phase < 0.5 ? 0 : 1;
    const edgeSecs = Math.min(Math.abs(phase), Math.abs(phase - 0.5), Math.abs(phase - 1)) * secs; // distance to a chord change
    const swell = Math.min(1, edgeSecs / 1.2); // dip to silence at the change, swell back over ~1.2 s
    let s = 0;
    for (const f of chords[which]) s += Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 1.004 * t) * 0.35 + Math.sin(2 * Math.PI * f * 2 * t) * 0.07;
    const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.22 * t);
    out[i] = (s / chords[which].length) * 0.24 * trem * swell;
  }
  for (let pass = 0; pass < 2; pass++) { const a = Math.exp(-2 * Math.PI * 900 / SR); let y = 0; for (let i = 0; i < n; i++) { y = a * y + (1 - a) * out[i]; out[i] = y; } }
  return seamless(out, 0.5);
}

// 12 Nov: normalise every loop to a known peak. The synths above produced loops peaking at
// -37 dBFS (ambience) / -19 dBFS (typing); after the dub gain they were inaudible on a handset —
// the caller heard dead silence while a specialist worked. The MIX now lives in the dub gains
// (config.ambience.*Gain) and every file starts from the same -1 dBFS peak.
function normalise(buf, peakTarget = 0.89) {
  let peak = 1e-9; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const k = peakTarget / peak; for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'ambience.wav'), wav(normalise(ambience())));
writeFileSync(join(OUT, 'typing.wav'), wav(normalise(typing())));
writeFileSync(join(OUT, 'hold.wav'), wav(normalise(hold())));
console.log('wrote', join(OUT, 'ambience.wav'), ',', join(OUT, 'typing.wav'), 'and', join(OUT, 'hold.wav'));
