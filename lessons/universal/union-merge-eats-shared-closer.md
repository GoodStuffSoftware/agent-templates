---
id: union-merge-eats-shared-closer
title: Keep both sides is not a safe conflict resolution when both sides end the same way — parse-check every resolved file
scope: [universal, stack:git]
requires: { stack: git }
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
When two branches each APPEND a block at the end of a file, the appended blocks end with the same closing token — `});`, `}`, `end`, `)`, `</div>`. Git treats that shared trailing line as **context common to both sides**, so it appears exactly once, below the closing conflict marker, outside the conflict region.

Resolve by keeping both bodies and you keep **two blocks and one closer.** The file no longer parses.

Nothing about this looks wrong. No line was deleted by anyone — a line simply was never duplicated. The diff reads as a clean union. Every block is individually well-formed. Review by reading does not catch it; it has been missed by reviewers who already knew the failure mode, twice in a single conflict-mapping exercise.

**The diagnostic trap is the expensive half.** The build or suite then fails at *file* granularity rather than at *block* granularity. That reads as "these two changes are jointly incompatible," so the investigation goes looking for a semantic interaction between two changes that are, in fact, entirely independent. A file-level parse error immediately following a hand-resolved conflict is this until proven otherwise.

**The check.** After resolving any conflict, before running anything else, parse every file you touched:

    git diff --name-only --diff-filter=U | xargs -n1 {{PARSE_CHECK_COMMAND}}

(`node --check`, `python -m py_compile`, `ruby -c`, a type-checker in no-emit mode, a compiler front end — whatever is cheapest for the language.) Make it automatic after every resolution rather than something you remember when appending "feels likely." It costs milliseconds and it is the only check that finds this.

**Highest-risk shape:** test files, because appending at the end is the ordinary way to add one, so two people adding tests to the same file collide here by default.

Related: [[clean-conflict-map-not-safe-ordering]] (the other thing a green conflict map does not tell you).
