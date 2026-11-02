---
id: build-the-whole-plan-then-test-it-once
title: Build a multi-step plan to the end, then test, review and fix it once — not CI plus a review per step
scope: [agent-process]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
An orchestrator ran a ~35-step design one step at a time, each with its own top-tier worker, cloud CI run and same-tier reviewer. One day used about a third of a weekly usage allowance before anyone noticed; the operator never saw the plan's shape or cost.

**How to apply:**
- For {{N}}+ steps, builders run local builds and unit tests only.
- Then ONE integration pass: local runs where the target exists, CI only for the rest, one parity review of the whole diff, one fix round.
- Split work across workers for context size; keep the testing in the one pass.
- Per-step CI plus review only where a step's blast radius justifies it.
- Before a long run, state the shape (workers, CI runs, reviews) and a rough share of the usage budget; if no answer comes, take the cheaper default and log it.

Related: [[size-subagents-by-context-not-by-task]], [[reviewer-matches-the-tier-it-reviews]], [[no-stall-decision-protocol]].
