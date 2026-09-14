---
id: a-default-timeout-shorter-than-cold-start-manufactures-flakes
title: A default test timeout shorter than a cold process spawn manufactures flakes — the red file is rarely the changed one
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 3
---
A recurring gate failure was blamed, across three separate incidents and several months, on orphaned processes, then on memory exhaustion, then on the diff under test. It was none of those. The runner's **default per-test timeout had never been set**, so a five-second budget applied repo-wide — including to tests that spawn real operating-system subprocesses or use dynamic imports, whose cold start alone can approach that budget under any contention.

The reproduction that settled it: the full suite run five times **sequentially** was green every time; run three times **concurrently** it went red every time, with overlapping but DIFFERENT files failing each run, on a machine with tens of gigabytes free. Memory pressure and orphaned processes were real contributors in earlier incidents, but neither was the cause.

**The diagnostic signature, in order:**
1. **The failing file is usually not the one the diff touched.** A small union of the same spawn-heavy or import-heavy files rotates through the failures.
2. **Green in isolation and red in the suite means contention** — stop investigating the diff.
3. **The contention can come from outside the repository entirely**: another project's suite, a second runner started seconds earlier, a wide agent fan-out on the same host ([[budget-fan-out-against-host-memory]]).
4. Only then check memory and orphan processes, which are two of several ways to exceed the budget, not the mechanism itself.

**How to apply:**
- Set an explicit, load-tolerant default timeout for any suite that spawns processes. Do it as its own change: raising it repo-wide also masks genuinely slow tests, so it does not belong folded into a feature release.
- Never respond to this class by bypassing the gate. The gate is reporting real contention, and the fix is the budget or the load ([[measure-gates-under-normal-load]]).
- Capture full output before investigating, because the failing set is non-deterministic and a truncated log cannot be re-derived ([[capture-gate-output-in-full]]).
- The same arithmetic applies outside tests: never time-box a provisioning step below its real cost ([[heartbeat-over-time-box]]).
