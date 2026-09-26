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
//
// Byte-identical round trip: the opening marker records how many line
// endings withBlock() put in front of the block (sep=0|1|2) and whether the
// text was empty (created), so withoutBlock() removes exactly what was added.

export const BEGIN = '<!-- agent-companion:compact-instructions -->';
export const END = '<!-- /agent-companion:compact-instructions -->';
const BEGIN_RE = /<!-- agent-companion:compact-instructions(?: sep=([0-2]))?( created)? -->/g;

export const BODY = [
  '# Compact instructions',
  'When compacting, keep: the current task and its done-condition; open decisions and who owns them;',
  'exact file paths, branches and commit SHAs in play; where the session\'s handoff/state file lives,',
  'if one exists. Drop resolved dead ends and raw tool output.',
];

export const BLOCK_LINES = [BEGIN, ...BODY, END];

const HEADING = /^#{1,6}\s*compact instructions\b/im;

function findBegin(text) {
  const all = [...text.matchAll(BEGIN_RE)];
  if (!all.length) return { count: 0 };
  const m = all[0];
  return {
    count: all.length, index: m.index, length: m[0].length,
    sep: m[1] === undefined ? null : Number(m[1]), created: Boolean(m[2]),
  };
}
const beginLine = (sep, created) => `<!-- agent-companion:compact-instructions sep=${sep}${created ? ' created' : ''} -->`;

// Returns { state, foreign, created, problem } for a CLAUDE.md text:
//   state: 'absent' | 'ours' | 'ours-stale'   problem: '' or why it must not be edited
//   foreign: true when a "Compact instructions" heading exists outside our block.
//   created: true when our block was installed into an empty or missing file.
export function inspect(text) {
  const bg = findBegin(text);
  const ne = text.split(END).length - 1;
  const e = text.indexOf(END);
  if (bg.count !== ne || bg.count > 1 || (bg.count === 1 && e < bg.index)) {
    return { state: 'absent', foreign: false, created: false, problem: 'agent-companion compact-instructions markers are unbalanced or duplicated' };
  }
  const outside = bg.count ? text.slice(0, bg.index) + text.slice(e + END.length) : text;
  const foreign = HEADING.test(outside);
  if (!bg.count) return { state: 'absent', foreign, created: false, problem: '' };
  const inner = text.slice(bg.index + bg.length, e).replace(/\r\n/g, '\n').trim();
  return { state: inner === BODY.join('\n') ? 'ours' : 'ours-stale', foreign, created: bg.created, problem: '' };
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Appends (or refreshes) our block. Assumes inspect() found no problem.
// `created`: the file did not exist before (the installer passes it; an
// existing empty file is not "created", so uninstall leaves it in place).
export function withBlock(text, { created = !text } = {}) {
  const eol = eolOf(text);
  const bg = findBegin(text);
  if (bg.count) {
    const e = text.indexOf(END) + END.length;
    const lines = [beginLine(bg.sep ?? 2, bg.created), ...BODY, END];
    return text.slice(0, bg.index) + lines.join(eol) + text.slice(e);
  }
  const sep = !text || text.endsWith(eol + eol) ? 0 : text.endsWith(eol) ? 1 : 2;
  const lines = [beginLine(sep, created && !text), ...BODY, END];
  return text + eol.repeat(sep) + lines.join(eol) + eol;
}

// Removes our block, the line ending after it and the separator withBlock()
// recorded before it — nothing the operator wrote.
export function withoutBlock(text) {
  const bg = findBegin(text);
  if (!bg.count) return text;
  const eol = eolOf(text);
  let start = bg.index; let end = text.indexOf(END) + END.length;
  if (text.startsWith(eol, end)) end += eol.length;
  // A marker without sep= (written before it was recorded): one blank line.
  const sep = bg.sep ?? (text.slice(0, start).endsWith(eol + eol) ? 1 : 0);
  if (sep && text.slice(0, start).endsWith(eol.repeat(sep))) start -= eol.length * sep;
  return text.slice(0, start) + text.slice(end);
}
