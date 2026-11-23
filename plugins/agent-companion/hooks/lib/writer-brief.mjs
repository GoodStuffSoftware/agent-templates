// Writer brief clauses (0.31.54): what every writer spawn is told about handing off, running tests and,
// for a brief with many deliverables, working in stages. One short clause appended to the spawn brief by the
// spawn guard (lib/sg-finish.mjs, next to the scope clause), silent: no message, no note.
//
//   - HANDOFF_SENTENCE replaces the old "finish every task, no self-chosen sections" wording: finish the task,
//     but on the context handoff notice, hand off (stage 2 of 0.31.54 adds the notice itself).
//   - TEST_SENTENCE: affected test files while fixing; the whole suite once, at the end, in the background.
//   - STAGING_SENTENCE, only for a writer brief with MORE THAN 4 top-level numbered or bulleted deliverables.
//
// Which spawns: a writer, by the scope rule's own reading (TYPE first, else ROLE; lib/scope-rule.mjs scopeKind),
// plus ROLE: lander when no TYPE is declared. Lookup, review, docs and undeclared spawns get nothing.
//
// Counting deliverables (countDeliverables): a brief has several lists (setup steps, requirements, acceptance
// bullets), and counting all of them would make every brief "staged". So the count is the LONGEST RUN of top-level
// list items of one kind (numbered, or bulleted). A run is consecutive top-level items; an indented line (an
// item's own sub-bullets and continuation) stays inside its item, and an unindented prose line (a heading such as
// "Acceptance:") ends the run. Not counted: nested items, anything in a code fence, a block quote or an HTML
// comment, and list items that are declaration lines (- ROLE: writer, **TYPE:** x).

import { DIRECTIVE_LABELS, declarationLines } from './brief-directives.mjs';
import { scopeKind } from './scope-rule.mjs';

export const WRITER_MARKER = '[agent-companion: writer]';
export const STAGING_THRESHOLD = 4; // more than this many deliverables: staged
export const HANDOFF_SENTENCE = 'Finish the task; but on the context handoff notice, finish the current step, commit and push WIP, write <task>-handoff.md (done, remaining, files touched, branch and sha, the exact next step), and return "DONE: partial, handoff at <path>".';
export const TEST_SENTENCE = 'While fixing, run only the affected test files; run the full suite once at the end, in the background (unless a tier clause below says the lead runs it).';
export const STAGING_SENTENCE = 'Work in stages in the brief\'s order; commit after each stage; at the handoff notice, stop at the next stage boundary.';

const ITEM = /^(?:(\d{1,9})[.)]|[-*+])(?=[ \t])/;
const DECL = new RegExp(`^(?:\\*\\*|__)?(?:${DIRECTIVE_LABELS.join('|')})(?:\\*\\*|__)?[ \\t]*:`, 'i');

// The longest run of top-level list items of one kind (see the banner). 0 for text with none.
export function countDeliverables(brief) {
  let best = 0;
  let run = 0;
  let kind = null;
  for (const line of declarationLines(brief)) {
    const indent = line.length - line.trimStart().length;
    if (indent > 1) continue; // an item's own sub-item or continuation
    const rel = line.trimStart();
    const m = ITEM.exec(rel);
    if (!m) { run = 0; kind = null; continue; } // unindented prose ends the run
    if (DECL.test(rel.slice(m[0].length).trimStart())) continue; // a declaration line is not a deliverable
    const k = m[1] ? 'num' : 'bul';
    if (k !== kind) { kind = k; run = 0; }
    run += 1;
    if (run > best) best = run;
  }
  return best;
}

// Whether the spawn is a writer's: the scope rule's reading, plus ROLE: lander when no TYPE is declared.
export function isWriterSpawn(type, role) {
  if (scopeKind(type, role) === 'writer') return true;
  const t = typeof type === 'string' ? type : '';
  return !t && String(role || '').toLowerCase() === 'lander';
}

// The text to append, or '' (not a writer, or the brief already carries the clause).
export function buildWriterClause(type, role, brief = '') {
  if (!isWriterSpawn(type, role)) return '';
  const text = String(brief ?? '');
  if (text.includes(WRITER_MARKER)) return '';
  const staged = countDeliverables(text) > STAGING_THRESHOLD;
  return `\n\n${WRITER_MARKER} ${HANDOFF_SENTENCE} ${TEST_SENTENCE}${staged ? ` ${STAGING_SENTENCE}` : ''}`;
}

// --- worktree command clause --------------------------------------------------------------------
// Claude Code itself refuses some commands from a worktree-isolated agent as too complex to verify
// (`cd X && ... <<EOF` compounds, `git -C` aimed outside its own tree). A spawn with isolation
// "worktree" gets one short clause naming the shapes that pass. One sentence per entry, so a later
// addition (a per-project standard command list) is one more entry. Keep the whole clause near 300 chars.
export const WORKTREE_MARKER = '[agent-companion: worktree]';
export const WORKTREE_SENTENCES = [
  'Commands already run in your worktree: do not cd into it.',
  'Use git -C only on your own tree.',
  'Write files with Write, never with heredocs.',
  'Run a heavy command (install, build, test suite) as one plain command so the queue can wrap it.',
];

// The text to append, or '' (not a worktree spawn, or the brief already carries the clause).
export function buildWorktreeClause(isolation, brief = '') {
  if (isolation !== 'worktree') return '';
  if (String(brief ?? '').includes(WORKTREE_MARKER)) return '';
  return `\n\n${WORKTREE_MARKER} ${WORKTREE_SENTENCES.join(' ')}`;
}
