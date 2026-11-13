// 2026-11-03 (mick-agentic-browser): lexicon sentiment scorer, ported from the
// NoRMA showcase. Scores a line in [-1, 1] with no external call so it adds
// nothing to turn latency. Demo-grade: weighted word list tuned to spoken
// customer phrasing, negation within three words, intensifiers.

const LEXICON = {
  thanks: 0.6, thank: 0.6, cheers: 0.5, great: 0.8, awesome: 0.9, good: 0.5, love: 0.9, perfect: 0.9, helpful: 0.7,
  happy: 0.7, excellent: 0.9, appreciate: 0.7, wonderful: 0.9, nice: 0.5, fine: 0.3, brilliant: 0.9, fantastic: 0.9,
  easy: 0.5, pleased: 0.6, glad: 0.6, yes: 0.2, please: 0.2, lovely: 0.7, amazing: 0.9, best: 0.6, yum: 0.6, delicious: 0.8,
  sorted: 0.6, works: 0.4, cool: 0.4, sweet: 0.4, legend: 0.8,
  // conversational acknowledgements: small weights so an ordinary cooperative call drifts gently
  // positive instead of sitting pinned on 0 (the pill shows the score, so ±0.1 is visible movement)
  okay: 0.15, ok: 0.15, yeah: 0.2, yep: 0.25, sure: 0.2, alright: 0.15, righto: 0.3, ta: 0.4,
  mate: 0.25, beauty: 0.7, magic: 0.6, champion: 0.7, stoked: 0.8, keen: 0.4, wow: 0.5,
  super: 0.5, terrific: 0.8, fabulous: 0.8, haha: 0.5, gold: 0.5,
  bad: -0.6, terrible: -0.9, awful: -0.9, hate: -0.9, angry: -0.8, frustrated: -0.8, frustrating: -0.8, useless: -0.9,
  rubbish: -0.8, ridiculous: -0.8, annoying: -0.7, annoyed: -0.7, wrong: -0.5, broken: -0.6, problem: -0.4, problems: -0.4,
  issue: -0.3, issues: -0.3, complaint: -0.6, disappointed: -0.7, disappointing: -0.7, unhappy: -0.7,
  slow: -0.4, waste: -0.6, worst: -0.9, stupid: -0.8, confusing: -0.5, confused: -0.4, cancel: -0.3,
  fail: -0.6, failed: -0.6, never: -0.3, nothing: -0.3, rude: -0.8, hopeless: -0.8, waiting: -0.3, late: -0.4,
  expensive: -0.4, scam: -0.9, unacceptable: -0.9, ugh: -0.6, damn: -0.6, hell: -0.6, no: -0.2, nope: -0.3, not: 0, sorry: -0.2,
  trouble: -0.4, error: -0.4, stuck: -0.4,
  nah: -0.2, crap: -0.6, bugger: -0.5, dodgy: -0.5, pathetic: -0.8, horrible: -0.8,
  disgusting: -0.8, furious: -0.9, upset: -0.6, worried: -0.4, whatever: -0.3, hurry: -0.4,
  mistake: -0.4, mess: -0.4
};
const NEGATORS = new Set(['not', "n't", 'never', 'cannot', "can't", "don't", "doesn't", "isn't", "wasn't", "won't", 'without']);
const INTENSIFIERS = { very: 1.4, really: 1.4, so: 1.3, extremely: 1.6, absolutely: 1.5, totally: 1.4, bloody: 1.4, quite: 1.1 };
const PHRASES = [
  [/\bfed up\b/, -0.8], [/\bsick of\b/, -0.8], [/\bnot working\b/, -0.7], [/\bthank you\b/, 0.7], [/\bno worries\b/, 0.4],
  [/\bno thanks?( you)?\b/, 0.3], [/\bgoodbye\b|\bbye\b/, 0.1], [/\bwell done\b/, 0.7], [/\bnot happy\b/, -0.8], [/\bhurry up\b/, -0.5],
  [/\bcome on\b/, -0.3], [/\btake(s|n)? (so|too) long\b/, -0.6],
  [/\bspot on\b/, 0.7], [/\btoo easy\b/, 0.5], [/\bno dramas?\b/, 0.4], [/\ball good\b/, 0.5],
  [/\bgood on (ya|you)\b/, 0.6], [/\bbloody hell\b/, -0.6], [/\bwhat the\b/, -0.4],
  [/\bforget it\b/, -0.6], [/\bgive up\b/, -0.5], [/\bno good\b/, -0.5], [/\b(is|what) a joke\b/, -0.6]
];

export function scoreSentiment(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const hits = [];
  let sum = 0;
  for (const [re, w] of PHRASES) if (re.test(lower)) { sum += w; hits.push(re.source); }
  const tokens = lower.replace(/n't\b/g, " n't").replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const w = LEXICON[tokens[i]];
    if (w === undefined || w === 0) continue;
    let v = w;
    const window = tokens.slice(Math.max(0, i - 3), i);
    if (window.some((t) => NEGATORS.has(t))) v = -v * 0.8;
    const intensifier = window.map((t) => INTENSIFIERS[t]).find(Boolean);
    if (intensifier) v *= intensifier;
    sum += v; hits.push(tokens[i]);
  }
  if (/!{2,}/.test(raw)) sum *= 1.2;
  if (hits.length === 0) return { score: 0, label: 'neutral', hits };
  const score = Math.max(-1, Math.min(1, sum / Math.sqrt(hits.length + 1)));
  const label = score > 0.25 ? 'positive' : score < -0.25 ? 'negative' : 'neutral';
  return { score: Math.round(score * 100) / 100, label, hits };
}

/** Trend over the last few scores: slope of a least-squares line. */
export function trendOf(scores, window = 4) {
  const pts = scores.slice(-window);
  if (pts.length < 2) return { slope: 0, trend: 'steady' };
  const n = pts.length, xm = (n - 1) / 2, ym = pts.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  pts.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
  const slope = den ? num / den : 0;
  return { slope: Math.round(slope * 100) / 100, trend: slope > 0.08 ? 'improving' : slope < -0.08 ? 'worsening' : 'steady' };
}
