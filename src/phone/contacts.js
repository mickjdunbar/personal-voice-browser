// 17 Nov 2026 (mick-agentic-browser): the contact book, looked up the way a person would.
//
// The knowledge docs (KB-contacts, KB-family …) hold lines like "- **Rik Jonson** - phone +61…" and
// "- Sunny (Sunny & Co.) — Jordan's mate …: +61…". The old lookup ran a vector search and then an
// exact whole-word regex on the spoken name, so "Rick" never found "Rik Jonson" and Aria said she
// had no number. This parses every name → number line once per lookup and matches the name
// forgivingly: exact, then first-name, then sound-alike (Rick/Rik, Johnson/Jonson, Steven/Stephen),
// then a one-letter slip. Two different numbers that match equally well = ambiguous → the caller
// is asked which one, never guessed.

const STOP = new Set(['my', 'our', 'the', 'a', 'mr', 'mrs', 'ms', 'dr', 'mate', 'uncle', 'aunty', 'aunt']);

export function normName(s) {
  return String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
}

/** A crude sound-alike key: enough for Rick/Rik, Jon/John, Steven/Stephen, Clark/Clarke. */
export function phonetic(token) {
  let s = String(token || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/dg/g, 'j').replace(/gh/g, '').replace(/wh/g, 'w').replace(/th/g, 't').replace(/v/g, 'f')
    .replace(/h(?![aeiou])/g, '').replace(/h$/, '');
  s = s[0] + s.slice(1).replace(/[aeiouy]/g, '');
  return s.replace(/(.)\1+/g, '$1');
}

export function editDistance(a, b) {
  a = String(a); b = String(b);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const NUMBER_RX = /\+?\d[\d()\s-]{6,}\d/;

/** Every "name → number" line in the given docs → [{ name, aliases, number, doc }]. */
export function parseContacts(docs = []) {
  const out = [];
  for (const d of docs) {
    if (!d || d.kind === 'sop') continue;
    for (const raw of String(d.body || d.text || '').split(/\n/)) {
      const m = raw.match(NUMBER_RX);
      if (!m) continue;
      const number = m[0].replace(/[()\s-]/g, '');
      if (number.replace(/\D/g, '').length < 6) continue;
      let head = raw.slice(0, m.index).replace(/^\s*[-*•]\s*/, '').replace(/\*\*/g, '').trim();
      // "Dad (Mick's father) - phone" → name "Dad", alias "Mick's father"; "Sunny (Sunny & Co.) — Jordan's mate …:" → "Sunny"
      const aliases = [];
      head = head.replace(/\(([^)]*)\)/g, (_, a) => { aliases.push(a.trim()); return ' '; });
      const name = head.split(/\s[—–-]\s|:|\s·\s|\s-\s/)[0].replace(/\b(phone|mobile|mob|tel|cell)\b.*$/i, '').trim();
      if (!name || /^(phone|mobile|tel|call)$/i.test(name)) continue;
      const tail = head.slice(name.length).replace(/\b(phone|mobile|mob|tel|cell)\b/gi, ' ').replace(/[—–:·-]/g, ' ').trim();
      if (tail) aliases.push(tail);
      out.push({ name, aliases, number, doc: d.id || d.title || '' });
    }
  }
  return out;
}

function scoreContact(c, q) {
  const nameT = normName(c.name);
  const aliasT = c.aliases.flatMap(normName);
  const allT = [...nameT, ...aliasT];
  if (!q.length || !nameT.length) return 0;
  const full = nameT.join(' ');
  if (q.join(' ') === full) return 100;
  // A forgiving match keeps the first letter (Rick/Rik, Steven/Stephen — never Mick/Nick/Rick) and is
  // either a sound-alike with a key worth trusting (3+ consonants, or a one-letter slip on top of a
  // short key) or a one-letter slip on a name of 5+ letters (two on 8+).
  const close = (t, qt) => {
    if (t === qt) return true;
    if (!t || !qt || t[0] !== qt[0]) return false;
    const pk = phonetic(t), pq = phonetic(qt);
    if (pk && pk === pq && (pk.length >= 3 || editDistance(t, qt) <= 1)) return true;
    return qt.length >= 5 && editDistance(t, qt) <= (qt.length >= 8 ? 2 : 1);
  };
  const hit = (qt, pool, loose) => pool.some((t) => t === qt || (loose && close(t, qt)));
  // The NAME outranks what is in brackets: "Mick" is Mick Dev (90), not Dad via "(Mick's father)" (70).
  if (q.every((qt) => hit(qt, nameT, false))) return q.length > 1 ? 95 : (nameT[0] === q[0] ? 90 : 85);
  if (q.every((qt) => hit(qt, nameT, true))) return q.length > 1 ? 80 : (close(nameT[0], q[0]) ? 75 : 65);
  if (q.every((qt) => hit(qt, allT, false))) return 70;
  if (q.every((qt) => hit(qt, allT, true))) return 60;
  // a two-word query where only the first name fits (e.g. "Rik Johnston" vs "Rik Jonson") still counts, lower
  if (q.length > 1 && close(nameT[0], q[0])) return 55;
  return 0;
}

/**
 * Best match for a spoken name. Returns { number, match, candidates, ambiguous }:
 *  - number set → one clear contact (or several entries sharing one number);
 *  - ambiguous → two or more different numbers fit equally well; candidates lists them for the caller to pick;
 *  - neither → nobody in the book.
 */
export function matchContact(contacts, query) {
  const q = normName(query);
  if (!q.length) return { number: '', match: null, candidates: [], ambiguous: false };
  const scored = contacts.map((c) => ({ c, s: scoreContact(c, q) })).filter((x) => x.s >= 55).sort((a, b) => b.s - a.s);
  if (!scored.length) return { number: '', match: null, candidates: [], ambiguous: false };
  const top = scored[0].s;
  const best = scored.filter((x) => x.s >= top - 5); // ties and near-ties
  const numbers = [...new Set(best.map((x) => x.c.number))];
  if (numbers.length === 1) return { number: numbers[0], match: best[0].c, candidates: best.map((x) => ({ name: x.c.name, number: x.c.number, note: x.c.aliases.join(', ') })), ambiguous: false };
  const seen = new Set();
  const candidates = best.filter((x) => !seen.has(x.c.number) && seen.add(x.c.number)).slice(0, 4).map((x) => ({ name: x.c.name, number: x.c.number, note: x.c.aliases.join(', ') }));
  return { number: '', match: null, candidates, ambiguous: true };
}

/** Look a name up in the knowledge store's documents (knowledge + memory kinds). */
export function findContactNumber(store, name) {
  const docs = store?.docs || [...(store?.knowledge || []), ...(store?.memory || [])];
  return matchContact(parseContacts(docs), name);
}
