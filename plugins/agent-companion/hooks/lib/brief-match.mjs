// Brief text helpers for the token bleed guard, phase 2 (new-file tripwire, redo alert).
//
//   firstUserText(path)   the first user message of a transcript: for a helper, its brief
//   briefBody(text)       the lead's own words: cut at the plugin's appended clauses, drop the
//                         TYPE/ROLE/... declaration lines
//   briefSketch(text)     a bottom-k sketch of the brief's distinct words (hex strings), or null
//                         when the brief is too short to be told apart from another
//   sketchSimilarity(a,b) estimated Jaccard similarity of two sketches, 0..1
//
// All pure or bounded reads; nothing throws.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DIRECTIVE_LABELS } from './brief-directives.mjs';

const HEAD_BYTES = 512 * 1024;
export const SKETCH_K = 96;
// Fewer distinct words than this and a brief is a one-liner: it matches nothing.
export const MIN_BRIEF_TOKENS = 20;

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

// The first user message of a transcript with text in it ('' when none or unreadable). Reads
// at most the first 512 KB.
export function firstUserText(path) {
  let fd = null;
  try {
    if (!path) return '';
    fd = openSync(path, 'r');
    const len = Math.min(fstatSync(fd).size, HEAD_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    // A cut last line is half a record: JSON.parse fails and it is skipped.
    for (const line of lines) {
      if (!line.includes('"user"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || r.type !== 'user' || !r.message) continue;
      const t = blocksText(r.message.content);
      if (t.trim()) return t;
    }
  } catch { /* unreadable */ } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  }
  return '';
}

// Everything the plugin appends to a brief starts on its own line with "[agent-companion" or
// "(agent-companion" (reporting contract, scope clause, standing rules, memory pointers, rung
// notes). The brief proper is what comes before.
const APPENDED_RE = /^[ \t]*[[(]agent-companion\b/im;
const DECL_LINE_RE = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*|__)?(?:${DIRECTIVE_LABELS.join('|')})(?:\\*\\*|__)?[ \\t]*:.*$`, 'gim');

export function briefBody(text) {
  let t = String(text || '');
  const cut = APPENDED_RE.exec(t);
  if (cut) t = t.slice(0, cut.index);
  return t.replace(DECL_LINE_RE, ' ');
}

const STOP = new Set(('the and for that this with from have has had are was were will would should could can not but all any '
  + 'its into onto than then them they their there these those been being does did done also each only more most some '
  + 'such when what which who how why where while about after before over under again once here very just like make '
  + 'made use used using need needs your you our out off per via one two new add run').split(' '));

function tokens(text) {
  const out = new Set();
  const re = /[a-z0-9_][a-z0-9_./\\-]*/g;
  const s = String(text || '').toLowerCase();
  let m;
  while ((m = re.exec(s))) {
    const w = m[0].replace(/[./\\-]+$/, '');
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

const h7 = (w) => createHash('sha1').update(w).digest('hex').slice(0, 7);

// Bottom-k sketch of the brief body's distinct words: the k smallest 28-bit hashes, as hex
// strings, ascending. null when the brief has fewer than MIN_BRIEF_TOKENS distinct words.
export function briefSketch(text) {
  try {
    const toks = tokens(briefBody(text));
    if (toks.size < MIN_BRIEF_TOKENS) return null;
    return [...new Set([...toks].map(h7))]
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16))
      .slice(0, SKETCH_K);
  } catch { return null; }
}

// Estimated Jaccard similarity of the two word sets the sketches were cut from: of the
// k smallest hashes of the union, the share that both sketches hold. Exact when both sets
// fit in k.
export function sketchSimilarity(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
    const sa = new Set(a);
    const sb = new Set(b);
    const union = [...new Set([...a, ...b])].sort((x, y) => parseInt(x, 16) - parseInt(y, 16));
    const k = Math.min(SKETCH_K, union.length);
    let both = 0;
    for (let i = 0; i < k; i += 1) if (sa.has(union[i]) && sb.has(union[i])) both += 1;
    return k ? both / k : 0;
  } catch { return 0; }
}
