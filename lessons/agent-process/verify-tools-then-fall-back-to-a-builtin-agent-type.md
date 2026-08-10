---
id: verify-tools-then-fall-back-to-a-builtin-agent-type
title: A custom agent type can come up missing its declared tools — verify tools as the literal first instruction, then respawn as a built-in type
scope: [agent-process]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
A spawned agent whose definition declares a shell tool can come up **without it**, while the registry still lists it. Respawning the *same* custom type does not fix it — the session reuses its start-time snapshot of that definition, so the second spawn inherits the same gap.

The incident: two consecutive spawns of a custom writer type came up with file tools only — no shell, no messaging — despite the registry listing both. The first had them and LOST them mid-session; the second never had them. A spawn of the harness's **built-in** general-purpose type, with an identical brief, came up with the full toolset on its first turn. Cost of not knowing this: two dead spawns and roughly a quarter of a million subagent tokens producing zero code.

**Why the built-in type works:** built-in agent types are not defined by the project's agent-definition files, so a stale or partially-applied project definition cannot strip their tools.

**How to apply:**
- **Make tool verification the literal first instruction in every writer brief.** One trivial read-only command in each tool the work requires, reported back, and **STOP if any is missing** rather than working around it with file writes. A dirty tree the agent cannot lint, test, or commit is worse than no work at all. This is the [[first-action-read-only]] opening, extended to cover capability as well as liveness.
- **On the first "tool missing" report, respawn as a BUILT-IN agent type** — do not respawn the same custom type, and do not immediately fall back to a split-work arrangement.
- When you do, **paste the project's rules into the brief**: shell dialect, path conventions, commit format, write target. A built-in type inherits none of the context that lived in the custom definition.
- Keep the split arrangement in reserve, for when you specifically need the custom type's baked-in context: the writer makes edits and reports the exact changed-file list; a session that *does* have a working shell runs lint, type-check, tests, and the commit. It works, but it costs two actors and an iterate-by-resume loop.
- Related: [[recovery-from-silent-teammates]], [[write-target-in-initial-brief]], [[tool-listing-is-scope-filtered]] (the same "what I can see is not what exists" shape, one layer out).
