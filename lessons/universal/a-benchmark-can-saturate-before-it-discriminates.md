---
id: a-benchmark-can-saturate-before-it-discriminates
title: A capability benchmark on bounded synthetic tasks saturates before pass/fail can separate frontier models
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A model x effort benchmark harness built hand-authored synthetic tasks (lookup, verify, procedure, diagnosis, instruction-logic), then hardened them into deliberately harder variants — multi-hop, multi-file, longer precedence chains. Every mid-tier and top-tier model/effort cell still passed 100% of tasks, across multiple repetitions; only the cheapest tier in the lineup ever failed, and only on one task. Pass/fail was completely uninformative for separating the paid tiers the benchmark existed to compare.

**Why:** a benchmark built from hand-authored tasks, calibrated against what feels hard to the person writing them, saturates for capable models far sooner than expected — every model above the cheapest tier can converge on 100% pass even after deliberately hardening the tasks, because the model and its training data are well-practiced at exactly this shape of hand-built exercise. Once that happens, pass/fail stops separating the cells a benchmark exists to compare.

**How to apply:**
- When every cell above the floor passes, do not discard the run as uninformative. Tokens, turns, and cost still separate cells cleanly (2-4x spreads are typical) even when every cell passes — treat that as a proxy for effort/verbosity compliance, not for capability, and report it as such.
- To recover real pass/fail signal, mine tasks from a project's own real bug-fix commits instead of hand-authoring them: extract the buggy function(s) verbatim into a standalone fixture, hand-translate the real regression test's assertions into a self-contained hidden test (verify each translated assertion against both the real parent commit, which must still fail it, and the real fix commit, fetched fresh rather than retyped), and grep-assert that no dated or diagnostic language from the sourcing commit leaked into the sandbox the model sees.
- Fairness rule this depends on: a held-out hidden test may only assert behavior the task's own prompt states or implies — never something the fixer knows from the original diff or commit message that the prompt never told the model.
- When a real-history-derived cell fails, audit before concluding a genuine capability gap: if every other cell also failed, or the failure is on exact wording rather than substance, it is a test-wording bug — relax the assertion and re-score the saved answer, no re-run needed. If the fixture has a shape the prompt never told the model how to handle, it is genuine prompt under-specification — fix the prompt and re-run only the affected cells. Only rule it a real capability gap once every other cell, at every other tier, solved the identical prompt against the identical fixture.
- **When a trial fails for an infrastructure reason unrelated to the model** — a resource collision, a co-scheduled run stepping on shared state — re-score the output that was already produced rather than re-running the model for a fresh attempt. Re-running introduces survivorship bias for any nondeterministic model: discarding the failed attempt and keeping only a new, independent one systematically favors passing. Re-scoring the existing output costs no additional tokens and carries no such bias.

This is distinct from [[probe-behaviour-not-version-stamps]] (that lesson ranks evidence sources when they disagree about drift; this one is about a check that stops discriminating once every candidate clears it) — both share the shape of "a check that no longer separates good from bad," but the mechanism and the fix differ.

Related: [[calibrate-a-bound-against-the-real-distribution]].
