---
id: a-gate-that-exists-vs-a-gate-that-covers
title: Verify a guard's COVERAGE, not just its ability to fail — grep for the underlying command, never the declared script aliases
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
Every guard has two independent properties, and reviews reliably check only the first:

1. **Non-vacuity** — can it fail? Is there an input that trips it?
2. **Coverage** — is it invoked on every path that produces the artifact it protects?

Non-vacuity is the interesting-looking question, so attention goes there. Coverage is the one that determines whether the bad thing ships.

The incident, three instances of the same shape in one afternoon. A change added a build-time guard asserting that a development-only module never reaches a production bundle. The guard was real, tested, and non-vacuous. It also ran on none of the paths that ship. (1) Its scan directory defaulted to the web bundle, not the mobile bundle — and the mobile bundle was the artifact its own rationale had been written about. (2) It was wired into the generic build alias but not the production build alias, which built inline. (3) The reviewer, having just argued (1) and (2), enumerated the package manifest's script aliases exhaustively and STILL missed a fourth path, because a deploy script invoked the build command directly rather than through an alias.

**Why:** A guard's coverage is invisible from inside the guard: it logs only the runs it had, so its record looks clean. And the natural enumeration method is wrong in a specific way — the declared alias list is a list of *conveniences for humans*, not a list of *invocations*. Scripts, CI job steps, and deploy chains call the underlying tool directly and never appear in it.

**How to apply:**
- Ask both questions, separately and out loud: *what input would make this fail?* and *is it invoked on every path that produces the artifact it protects?*
- Answer the second by grepping the whole repository for the underlying **build/deploy command**, not by reading the declared script aliases. `{{BUILD_TOOL}}` invoked inside `{{SCRIPTS_DIR}}/{{DEPLOY_SCRIPT}}` is exactly the path an alias inventory misses, and it is often the one that reaches production.
- Watch for the tell: **a guard whose scan target defaults to the most COMMON output directory rather than the SHIPPING one.** The default was written for the developer's inner loop; the risk lives in the release artifact.
- Prefer moving the guard to the single choke point every path crosses over adding it to each path — see [[safeguard-the-operation-not-the-entry-point]]. If no such point exists, that is the finding.
- Related: [[guard-coverage-enumerate-issuing-surfaces]] (the same coverage gap on the agent-tooling side, where the uncovered surface is configuration rather than a build script), [[assert-the-guard-saw-something]] (the vacuity half), and [[match-instrument-to-failure-class]] (a guard that runs everywhere but is blind to the class).
