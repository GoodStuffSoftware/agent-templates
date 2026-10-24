// Scope rule: one short clause appended to a spawn brief so a worker does not
// build what the brief did not ask for (token bleed guard, phase 1). Pure
// functions: spawn-guard.mjs merges the text into the updatedInput it is
// already building, like lib/brevity.mjs.
//
// Which clause: by the brief's TYPE first (the writer types and the
// lookup/research/verify types below), else by its ROLE line. Reviews,
// operate work, docs and anything undeclared get no clause.

export const SCOPE_MARKER = '[agent-companion: scope]';

export const SCOPE_WRITER_CLAUSE = 'Build the smallest change that meets the ask. Before creating a script, workflow, module, test file or feature the brief does not name, stop and report the proposal to the lead instead of building it.';
export const SCOPE_LOOKUP_CLAUSE = 'Create no new files beyond the requested output.';

export const SCOPE_WRITER_TYPES = [
  'bounded-feature', 'bounded-feature-small', 'integration', 'debug-root-cause', 'large-refactor',
  'novel-design', 'critical-change', 'long-autonomous-run', 'mechanical-edit', 'subagent-worker',
];
export const SCOPE_LOOKUP_TYPES = ['explore', 'lookup', 'research', 'survey', 'verify'];

// 'writer' | 'lookup' | null
export function scopeKind(type, role) {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (SCOPE_WRITER_TYPES.includes(t)) return 'writer';
  if (SCOPE_LOOKUP_TYPES.includes(t)) return 'lookup';
  if (t) return null; // another type (code-review, operate) or an unknown one: no clause
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (r === 'writer' || r === 'fixer') return 'writer';
  if (r === 'lookup') return 'lookup';
  return null;
}

// The text to append, or '' when none applies or the brief already has it.
export function buildScopeClause(type, role, brief = '') {
  const kind = scopeKind(type, role);
  if (!kind) return '';
  if (String(brief).includes(SCOPE_MARKER)) return '';
  return `\n\n${SCOPE_MARKER} ${kind === 'writer' ? SCOPE_WRITER_CLAUSE : SCOPE_LOOKUP_CLAUSE}`;
}
