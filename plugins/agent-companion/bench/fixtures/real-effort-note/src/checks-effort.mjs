// Extracted from a larger static-audit script's agent-definition checks.
// Real, reduced to a pure function: given a parsed agent-definition
// frontmatter's model and effort fields (plus a "does this model take an
// effort parameter" predicate), what finding string (if any) should the
// audit report for a definition with no effort stated.
import { modelTakesEffort } from './effort-note.mjs';

// { model, effort } -> finding string | null
export function checkAgentDefNoEffortFinding({ model, effort }) {
  if (!effort && model && modelTakesEffort(model)) {
    return /opus/i.test(model)
      ? `no effort set on an opus definition -- Opus 5.5 defaults to MEDIUM (one level below Opus 5's old HIGH default); state it explicitly`
      : `no effort set`;
  }
  return null;
}
