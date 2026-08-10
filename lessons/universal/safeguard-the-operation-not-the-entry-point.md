---
id: safeguard-the-operation-not-the-entry-point
title: Put a safeguard on the operation, not on the convenient entry point — the direct path is what people use under pressure
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 2
---
Three separate safeguards in one repo were each found, independently, to be bypassable the same way — and nobody noticed they were one problem until the third turned up.

1. **Git hooks wired by package lifecycle scripts** (`prepare`/`pretest`/`prelint`) rather than by committed config. A clone where nobody ran one of those blessed commands has the hooks path UNSET, so commits and pushes silently skip every gate. CI is safe only incidentally, because it happens to install first.
2. **A guard preventing the test suite from opening the PRODUCTION database**, wired to `pretest`. Running one test file directly skips it — which is the most ordinary thing anyone does when chasing a single failure.
3. **A performance fix setting a temp directory for test fixtures**, applied inside the gated runner. Plain and direct invocations still hit disk.

**Why it evades review:** every one of these passes its own gates — lint clean, tests green, commit lands, HEAD moves, remote sha real. The bypass is invisible because nothing fails; the protection simply isn't present. Consequences ranged from merely slow to able to corrupt production data.

**How to apply:**
- Put the safeguard on the OPERATION, not the entry point. If the risk is "something opens the production database," the check belongs inside the path-resolution function every caller crosses — not in a script someone can route around.
- When a fix is wired into a wrapper or lifecycle hook, ask explicitly: *what invocation skips this?* Then test that invocation, not just the happy one.
- **Enumerate every real invocation shape before shipping**: the service, timers, maintenance scripts, self-update, CI, hand-run commands. A guard that blocks a maintenance script has broken operations rather than protected them.
- **Enumerate every ACTIVATION path too, before stating which invocations are exposed.** The first diagnosis above said "any clone that skipped the install" — wrong, because one clone had hooks from having run the test suite earlier, as a side effect of testing rather than installing.
- Verify the discriminator against the REAL invocation, not a simulated one — read the actual service definition's start command and environment and probe under that exact shape. A simulation only proves the guard agrees with your model of the service.
- In agent reports, distinguish "the gate FIRED" from "I ran the checker BY HAND." Both are evidence; only the first also protects the next person.

**When the operation-level guard lands, expect it to break things that were already broken.** Adding one such guard produced 22 new test failures across 9 files — every one of them a test that had been silently resolving to a real default database all along. Fix the callers, not the guard: rescoping it means weakening the check so it stops detecting the exact condition it was built to detect.

**And make the guard's own failure legible.** In that same case the guard's exception was swallowed by a documented never-throws `try/catch` upstream and surfaced as an unrelated `Cannot read properties of undefined`. A guard that fails closed but sends people looking in the wrong place is worse than one that is merely absent — emit a distinctive, greppable line to stderr *before* throwing, so the diagnosis survives the catch.

Related: [[ship-the-safe-handle-first]], [[guard-coverage-enumerate-issuing-surfaces]], [[match-instrument-to-failure-class]], [[lifecycle-hook-runs-in-production-installs]].
