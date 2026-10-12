---
id: a-fail-open-guard-must-finish-inside-its-timeout
title: A guard that fails open on timeout turns a deny into an allow on large input — make its matchers linear and test the worst shapes
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A pre-tool hook that denies destructive commands had a 15 s timeout and failed open. Seven of its regexes were quadratic under the engine's backtracking: a 100K-character force-push with mixed whitespace took 27 s, so the hook timed out and the command was ALLOWED. A later rule using greedy loops hit the engine's backtrack-stack limit near 8.4M characters; the thrown error also failed open.

**How to apply:**
- Treat the matcher's worst-case time as part of the guard's coverage. Rewrite each pattern to an equivalent linear form (anchor one start per segment, lazy loops, atomic scans through lookahead capture) instead of adding a size pre-guard that itself adds denies.
- Prove equivalence by differential fuzz, old pattern against new, on millions of inputs, plus the full decision corpus ([[change-a-guard-against-a-recorded-corpus]]).
- Add a regression test that spawns the real hook on the worst shapes (hundreds of thousands of characters, plus a multi-million stack shape) with a small time budget, and confirm each single-site revert to the old regex fails it.
- Keep the error path honest: a throw must not become an allow silently ([[fail-open-on-the-action-never-on-the-record]]).
