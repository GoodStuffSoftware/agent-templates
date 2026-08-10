---
id: prune-by-exact-name-not-pattern
title: Prune a shared namespace by exact name, never by prefix or glob — the load-bearing row usually shares the prefix
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
A cleanup pass proposed removing four probe-like rows from a shared registry by adding patterns to an existing prune script. It was declined, and the reasoning generalises.

One of the four differed from a **real, load-bearing** row only by a suffix: `{{HOST}}-coldwake-probe` against `{{HOST}}`. Any pattern broad enough to catch the probe can catch the machine row, and that row is the anchor for an entire class of agents' wake path. Losing it makes those agents unreachable — a far worse outcome than four untidy rows.

**Why:** prune patterns are written by humans under time pressure, against a listing they are looking at right now, for a namespace that grows. This is precisely the shape that produces an over-broad match, and the blast radius is invisible in the diff because the pattern is short and the victims are data.

**How to apply:**
- **Match on exact names.** If the list is short enough to be worth cleaning, it is short enough to enumerate.
- **Weigh the benefit honestly first.** In this case the display layer already suppressed those rows, so the visible problem was solved *without* a data mutation, and the benefit was 4 rows out of ~142. A mutation that buys nothing visible is all risk.
- If the real problem is scale (exhaust accumulating from an automated source), a hand-written prune pattern is treating the symptom at the wrong layer entirely.
- Where a tombstone or soft-delete path exists, prefer it — and take a backup of the store before any mutation, with the backup path reported in the same message ([[normalize-before-declaring-difference]]).
- Related: [[validate-cli-args-against-injection]] (the other way a value becomes an operator it was never meant to be).
