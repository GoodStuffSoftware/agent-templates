// The worker's STATUS line (brevity contract: "Open with STATUS: done | blocked | partial").
// parseStatus is pure and bounded: it looks at the first 12 non-empty lines of at most the
// first 8 KB, so a huge final message costs nothing. The transcript fallback reads a bounded
// tail only. Nothing here throws.

import { tailRecords } from './context.mjs';

const HEAD_CHARS = 8192;
const MAX_LINES = 12;
// Leading quote/bold/heading/list/table/code marks, STATUS, separators, then the word.
const STATUS_RE = /^[\s>*_#|`-]*STATUS(?![A-Za-z0-9])[\s:*_`=|-]*(done|blocked|partial)\b/i;

// 'done' | 'blocked' | 'partial' | null. First match wins.
export function parseStatus(text) {
  try {
    if (typeof text !== 'string' || !text) return null;
    const lines = text.slice(0, HEAD_CHARS).split(/\r?\n/);
    let seen = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      seen += 1;
      if (seen > MAX_LINES) break;
      const m = STATUS_RE.exec(line);
      if (m) return m[1].toLowerCase();
    }
  } catch { /* fail open */ }
  return null;
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

// The last non-empty assistant text of an agent transcript (512 KB tail read), '' when unreadable.
export function lastAssistantText(path) {
  try {
    if (!path) return '';
    const recs = tailRecords(path, { bytes: 512 * 1024, filter: (l) => l.includes('"assistant"') });
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const r = recs[i];
      if (!r || r.type !== 'assistant' || !r.message) continue;
      const t = blocksText(r.message.content);
      if (t.trim()) return t;
    }
  } catch { /* unreadable */ }
  return '';
}
