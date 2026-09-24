// Evidence-family classification: REAL-WORLD vs SYNTHETIC benchmark
// evidence, kept strictly separate everywhere a summary or an estimate
// reports a number (operator direction, 2026-09-24).
//
// "Real" means a real bug-fix pack, a real architecture/task-card pack, or
// mined user work. "Synthetic" means the hand-built easy/hard tasks this
// benchmark ships. The two must never be pooled: synthetic tasks saturate
// AND understate usage -- real bug-fix and architecture runs measured
// markedly more tokens and turns than synthetic rounds of the same cells
// (see docs/BENCHMARK.md "Evidence families" and ADR 0003's own "Decision
// rules" R3) -- so a combined number is neither an accurate capability read
// nor an accurate cost projection for either kind of work.
//
// Zero I/O, no imports from bench/runner.mjs or bench/estimate.mjs (both
// import FROM here) -- keeps this the single place the real/synthetic
// registry lives, with no circular dependency.

// The whole registry of fine-grained evidence-family labels this plugin
// knows about, each mapped to its coarse kind. A new fine label (a new task
// pack kind, a new mined-evidence bucket) is added here, once, and every
// consumer (bench/runner.mjs's row-stamping, bench/estimate.mjs's
// seed/history lookups, scripts/benchmark.mjs's estimate-plan builder, this
// module's own classifier) picks it up with no further plumbing.
//
// NOTE for ADR 0003 slice 5 (the proposal engine -- not built yet): this is
// a DIFFERENT vocabulary from the ADR's own `benchmarkTier` field
// ("user-mined" | "shipped-real" | "synthetic-hard" | "synthetic-easy",
// section 1's schema). Both classify the same underlying real/synthetic
// split, but were named independently -- this one for the benchmark
// harness's own summaries/estimates, that one for a routing-profile row's
// provenance. Slice 5 should map between the two vocabularies explicitly
// rather than assume they are interchangeable.
export const FINE_FAMILIES = {
  'easy-synthetic': 'synthetic',
  'hard-synthetic': 'synthetic',
  'real-bugfix': 'real',
  architecture: 'real',
  mined: 'real',
};

// bench/runner.mjs's own coarse TASK_FAMILIES ids ("easy" | "hard" | "real" |
// "pack" | "other") map onto a DEFAULT fine label. "pack" defaults to
// "real-bugfix" (task-packs/FORMAT.md: a task pack is bug-fix shaped by
// convention) unless the pack's own manifest declares `evidenceFamily` --
// see task-packs/lib.mjs's buildTaskFromPack(), which threads that field
// onto the task object. A declared value always wins over this default --
// see evidenceFamilyOf()'s priority order below. "other" (an id this
// benchmark doesn't recognize as any built-in family, and not a task pack
// either) has no default fine mapping at all -- it resolves to "unknown".
export const BUILTIN_FAMILY_TO_FINE = {
  easy: 'easy-synthetic',
  hard: 'hard-synthetic',
  real: 'real-bugfix',
  pack: 'real-bugfix',
};

// Coarse kind of a fine label, or "unknown" for anything not in the
// registry above. NEVER guessed into "real" or "synthetic" -- see
// evidenceFamilyOf()'s own note on why "unknown" exists and is never pooled.
export function coarseOf(fineLabel) {
  return FINE_FAMILIES[fineLabel] || 'unknown';
}

// Resolves the evidence family for one row/task, in priority order:
//
//   1. An explicit fine label already on the ROW. bench/runner.mjs stamps
//      every new row with `evidence_family_fine` (and `evidence_family`) at
//      write time -- a row that was already classified is never
//      reclassified differently later, even if this module's registry
//      changes underneath it.
//   2. An explicit fine label declared on the TASK object itself -- e.g. a
//      task pack's `manifest.evidenceFamily`, threaded through by
//      `buildTaskFromPack()` (task-packs/lib.mjs), OR a CLI/env `--evidence-
//      family` override applied to any task with no declaration of its own
//      (bench/runner.mjs's `withEvidenceFamilyOverride()` -- an external
//      harness that cannot label every task it builds can still classify
//      a whole run this way).
//   3. The LOCAL mapping file (FS2 fix, 2026-09-24): an operator-authored
//      `<stateRoot>/config/evidence-families.json`, matched by `taskId`
//      against `matchLocalEvidenceFamilyMapping()` below -- classifies rows
//      (including LEGACY ones) that no task/pack builder ever labelled at
//      all. Never shipped, never containing real task ids or pack names in
//      this repo.
//   4. The BUILT-IN coarse family (bench/runner.mjs's `taskFamilyOf()`),
//      mapped through BUILTIN_FAMILY_TO_FINE. `taskFamilyOf` is INJECTED
//      (a parameter, not an import) so this module never creates a circular
//      dependency with bench/runner.mjs, which imports FROM here.
//   5. "unknown" -- an unrecognized task id with no pack metadata, no local
//      mapping match, and no built-in family match. Legacy rows (written
//      before this field existed) fall through to steps 3-4 via their own
//      `task`/`row.task`, which is exactly "classified by task id where
//      that's unambiguous" -- anything left over here genuinely can't be
//      classified, and must never be pooled with either "real" or
//      "synthetic" (see docs/BENCHMARK.md "Evidence families").
// FS2 fix (2026-09-24 family-split review, CRITICAL): a LOCAL, user-authored
// mapping file (never shipped, never containing real task ids or pack
// names in this repo -- see docs/BENCHMARK.md "Evidence families") that
// classifies rows a task/pack builder never labelled at all. Shape:
// `{ "rules": [{ "taskIdPattern": "<glob or regex>", "family": "<fine>" }] }`.
// `taskIdPattern` is either a `/regex/flags` literal or a glob (`*` = any
// run of characters, `?` = any one character, anchored start-to-end) --
// see compileTaskIdPattern(). Rules are tried in order; the first match
// wins. A malformed individual rule (bad pattern, missing field) is
// skipped rather than crashing classification for every other row.
export function compileTaskIdPattern(pattern) {
  const literal = /^\/(.*)\/([a-z]*)$/i.exec(pattern);
  if (literal) return new RegExp(literal[1], literal[2]);
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// Exported for tests. Returns the mapped fine label for `taskId`, or null
// when no rule matches (or `mapping` is absent/empty).
export function matchLocalEvidenceFamilyMapping(taskId, mapping) {
  const rules = (mapping && Array.isArray(mapping.rules)) ? mapping.rules : [];
  for (const rule of rules) {
    if (!rule || typeof rule.taskIdPattern !== 'string' || typeof rule.family !== 'string') continue;
    let re;
    try {
      re = compileTaskIdPattern(rule.taskIdPattern);
    } catch {
      continue;
    }
    if (re.test(taskId)) return rule.family;
  }
  return null;
}

export function evidenceFamilyOf({
  taskId, task = null, row = null, taskFamilyOf, localMapping = null,
}) {
  if (row && typeof row.evidence_family_fine === 'string' && row.evidence_family_fine) {
    const fine = row.evidence_family_fine;
    // FS3 fix (2026-09-24 family-split review, HIGH): a LEGACY row already
    // on disk (results.jsonl is append-only -- this machine's own
    // historical rows may predate a fine label being renamed/removed from
    // the registry above, or predate this validation existing at all) is
    // NEVER thrown here: it cannot be reclassified retroactively, and a
    // summary rebuild must never abort over one old row. Classified
    // "unknown" -- never silently coerced into "real" or "synthetic" --
    // and flagged via `unrecognizedLegacyFine` so a caller (rebuildSummary())
    // can report it rather than silently swallow it.
    if (!(fine in FINE_FAMILIES)) {
      return { fine: 'unknown', coarse: 'unknown', unrecognizedLegacyFine: fine };
    }
    return { fine, coarse: row.evidence_family || coarseOf(fine) };
  }
  if (task && typeof task.evidenceFamily === 'string' && task.evidenceFamily) {
    const fine = task.evidenceFamily;
    // FS3 fix: an unknown label declared on a TASK OBJECT (a task pack's
    // manifest.evidenceFamily, or any external harness's task) IS thrown --
    // this is a configuration error, and it is caught before a row is ever
    // written, not silently downgraded to "unknown" after the fact. See
    // bench/runner.mjs's runOne(), which resolves evidenceFamilyOf() before
    // spawning the model for exactly this reason, and
    // task-packs/lib.mjs's buildTaskFromPack(), which validates a pack's
    // manifest field even earlier, at pack-load time.
    if (!(fine in FINE_FAMILIES)) {
      throw new Error(
        `unknown evidence family "${fine}" declared for task "${taskId}" -- must be one of: `
        + `${Object.keys(FINE_FAMILIES).join(', ')} (bench/evidence-family.mjs's registry). A new fine `
        + 'label is added there, once, before any task/pack can declare it.',
      );
    }
    return { fine, coarse: coarseOf(fine) };
  }
  // FS2 fix: the LOCAL mapping file sits between an explicit task
  // declaration and the built-in registry -- precedence is row field >
  // task.evidenceFamily > local mapping > built-in registry > unknown (see
  // docs/BENCHMARK.md "Evidence families"). A malformed mapping VALUE (a
  // family name not in the registry) IS thrown -- this is the operator's
  // own local file, so a typo is caught immediately rather than silently
  // misclassifying every future summary rebuild.
  if (localMapping) {
    const mapped = matchLocalEvidenceFamilyMapping(taskId, localMapping);
    if (mapped != null) {
      if (!(mapped in FINE_FAMILIES)) {
        throw new Error(
          `local evidence-family mapping declares unknown family "${mapped}" for a rule matching task `
          + `"${taskId}" -- must be one of: ${Object.keys(FINE_FAMILIES).join(', ')}.`,
        );
      }
      return { fine: mapped, coarse: coarseOf(mapped) };
    }
  }
  const builtin = typeof taskFamilyOf === 'function' ? taskFamilyOf(taskId, { task, row }) : null;
  const fine = builtin ? BUILTIN_FAMILY_TO_FINE[builtin] : null;
  if (fine) return { fine, coarse: coarseOf(fine) };
  return { fine: 'unknown', coarse: 'unknown' };
}

// A hard guard for any code -- routing decisions, the future ADR 0003
// slice 5 proposal engine, or a hand-run comparison -- that compares two
// benchmark cells' evidence and could use the comparison to justify a
// decision. Pins the ADR's own rule (ADR 0003 "Decision rules" R3): evidence
// from `synthetic-*` tiers may support an UPGRADE but can NEVER justify a
// DOWNGRADE, because synthetic tasks saturate; and (this benchmark's own
// operator direction, 2026-09-24) synthetic numbers never feed a real-world
// usage/cost projection, or vice versa. Throws rather than returning a
// boolean, so a caller cannot silently ignore a cross-family comparison the
// way it could silently ignore a false return value.
//
// Slice 5 (the proposal engine that would actually run R0-R5) does not
// exist yet -- this function is the rule pinned in code ahead of it, per
// requirement 4 of the 2026-09-24 family-split work; see also the note at
// bench/runner.mjs's rebuildSummary() (the summary-export boundary) and
// docs/BENCHMARK.md "Evidence families".
export function assertComparableEvidence(familyA, familyB, { forDowngrade = false } = {}) {
  const a = coarseOf(familyA);
  const b = coarseOf(familyB);
  if (a === 'unknown' || b === 'unknown') {
    throw new Error(
      `cannot compare evidence family "${familyA}" against "${familyB}": at least one is unclassified `
      + '("unknown" is never pooled with real or synthetic).',
    );
  }
  if (a !== b) {
    throw new Error(
      `refusing to compare a "${a}" cell against a "${b}" cell -- real and synthetic evidence are never `
      + 'pooled or compared directly (docs/BENCHMARK.md "Evidence families").',
    );
  }
  if (forDowngrade && a === 'synthetic') {
    throw new Error(
      'synthetic evidence can never justify a downgrade (ADR 0003 "Decision rules" R3: synthetic tasks '
      + 'saturate) -- it may only support an upgrade.',
    );
  }
}
