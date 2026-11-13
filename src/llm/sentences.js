// 2026-11-03 (mick-agentic-browser): split streamed text into speakable
// sentences, and scrub what a voice must never read aloud.
// Sentence/clause boundaries for streaming: a run of . ! ? … ; (and the closing quote/bracket that
// may trail them) followed by whitespace or end-of-text. Semicolons let long replies break into
// speakable pieces instead of arriving as one block.
const BOUNDARY = /[.!?…;]+["')\]]*(\s+|$)/g;

export class SentenceSplitter {
  constructor({ maxBuffer = 90 } = {}) {
    this.buffer = '';
    this.maxBuffer = maxBuffer;
  }

  /** Add streamed text; returns the sentences it completed. */
  push(text) {
    this.buffer += text;
    const out = [];
    for (;;) {
      BOUNDARY.lastIndex = 0;
      let m;
      let cut = -1;
      while ((m = BOUNDARY.exec(this.buffer))) {
        const end = m.index + m[0].length;
        const atEnd = end === this.buffer.length;
        if (!atEnd && /\s$/.test(m[0])) { cut = end; break; }
      }
      if (cut < 0) break;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (sentence.trim()) out.push(sentence);
    }
    if (this.buffer.length > this.maxBuffer) {
      const comma = this.buffer.lastIndexOf(', ');
      if (comma > 20) {
        out.push(this.buffer.slice(0, comma + 2));
        this.buffer = this.buffer.slice(comma + 2);
      }
    }
    return out;
  }

  flush() {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? rest : '';
  }
}

/** Strip things a voice must never read aloud (markdown, stage directions, element refs, URLs). */
export function scrubForSpeech(text) {
  return String(text)
    .replace(/\[(END_CALL|HANDBACK|SPECIALIST)[^\]]*\]/gi, '')
    .replace(/\[\s*(ref\s*)?\d{1,4}\s*\]/gi, '')
    .replace(/https?:\/\/\S+/gi, (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } })
    .replace(/[*_`#>]+/g, '')
    .replace(/\((?:pauses?|laughs?|sighs?|smiles?|chuckles?)\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ');
}
