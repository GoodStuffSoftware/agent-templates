// compact-instructions.mjs — the OPTIONAL "Compact instructions" block that
// scripts/install-compact-instructions.mjs manages in a CLAUDE.md, plus the
// pure edit functions (no I/O, safe to import from tests).
//
// Why a CLAUDE.md block and not a PreCompact hook: per the hooks reference a
// PreCompact hook can only block compaction (exit 2 / decision "block"); its
// systemMessage and continue are discarded and it cannot add instructions to
// the summary. The documented way to steer what compaction keeps is a
// "# Compact instructions" section in CLAUDE.md (and `/compact <focus>` for a
// manual compaction). Every line here is paid at every session start, so it
// stays short.

export const BEGIN = '<!-- agent-companion:compact-instructions -->';
export const END = '<!-- /agent-companion:compact-instructions -->';

export const BODY = [
  '# Compact instructions',
  'When compacting, keep: the current task and its done-condition; open decisions and who owns them;',
  'exact file paths, branches and commit SHAs in play; where the state/handoff file lives',
  '(SESSION-STATE.md, HANDOFF.md). Drop resolved dead ends and raw tool output.',
];

export const BLOCK_LINES = [BEGIN, ...BODY, END];

const HEADING = /^#{1,6}\s*compact instructions\b/im;

// Returns { state, problem } for a CLAUDE.md text:
//   state: 'absent' | 'ours' | 'ours-stale'   problem: '' or why it must not be edited
//   foreign: true when a "Compact instructions" heading exists outside our block.
export function inspect(text) {
  const b = text.indexOf(BEGIN); const e = text.indexOf(END);
  const nb = text.split(BEGIN).length - 1; const ne = text.split(END).length - 1;
  if (nb !== ne || nb > 1 || (nb === 1 && e < b)) {
    return { state: 'absent', foreign: false, problem: 'agent-companion compact-instructions markers are unbalanced or duplicated' };
  }
  const outside = nb ? text.slice(0, b) + text.slice(e + END.length) : text;
  const foreign = HEADING.test(outside);
  if (!nb) return { state: 'absent', foreign, problem: '' };
  const inner = text.slice(b + BEGIN.length, e).replace(/\r\n/g, '\n').trim();
  return { state: inner === BODY.join('\n') ? 'ours' : 'ours-stale', foreign, problem: '' };
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Appends (or refreshes) our block. Assumes inspect() found no problem.
export function withBlock(text) {
  const eol = eolOf(text);
  const block = BLOCK_LINES.join(eol);
  const b = text.indexOf(BEGIN);
  if (b >= 0) {
    const e = text.indexOf(END) + END.length;
    return text.slice(0, b) + block + text.slice(e);
  }
  if (!text) return block + eol;
  const sep = text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
  return text + sep + block + eol;
}

// Removes our block and the blank line withBlock() put before it.
export function withoutBlock(text) {
  const b = text.indexOf(BEGIN);
  if (b < 0) return text;
  const eol = eolOf(text);
  let start = b; let end = text.indexOf(END) + END.length;
  if (text.startsWith(eol, end)) end += eol.length;
  if (text.slice(0, start).endsWith(eol + eol)) start -= eol.length;
  return text.slice(0, start) + text.slice(end);
}
