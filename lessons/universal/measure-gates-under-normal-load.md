---
id: measure-gates-under-normal-load
title: A green measurement taken in a quiet window is not evidence about a contended one
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
When a gate, suite, or health check is qualified by measuring it, the measurement inherits the conditions of the window it ran in. If the machine's NORMAL state is concurrent — several runs in flight, many working clones, other services live — then a clean result measured during a quiet moment says nothing about the state you are shipping into.

The incident: a pre-push gate was proposed with an honest full-pass measurement behind it. Its "hermetic" subset included a test that contends on a machine-global mutex; the gate's own hook then blocked the author's push with failures, and the same file passed in isolation seconds later. The box had several concurrent test runs across many active clones — the normal state, not an unlucky window. Because CI ran the same gated command on the same machine, shipping it would have made the self-update job fail nondeterministically and production would silently stop updating. The gate was held rather than merged, and the acceptance criterion became: the subset passes while the machine-global resource is *deliberately held by another process*.

**Why:** Flakiness under contention is a property of the pair (test, environment), and the environment during qualification is chosen implicitly — usually by whenever the author happened to run it, which is biased toward quiet. Shipping a gate that fails randomly is worse than shipping no gate: it converts an occasional real failure into constant noise, and teaches everyone to bypass it.

**How to apply:**
- Qualify a gate under adversarial conditions, not convenient ones: hold the contended resource on purpose, run the suite concurrently with itself, or run it on the loaded machine at a normal hour. State the conditions alongside the pass count — "270/270" without a window is not a claim.
- Any test that takes a machine-global lock is disqualified from a fast pre-push subset. Give it a per-run resource path (a unique temp directory), or move it to an explicitly allowlisted slower tier with the reason recorded.
- Check whether CI runs on the same machine as developers. If it does, a machine-global contention bug is not a local annoyance; it is a production-delivery outage waiting for a busy afternoon.
- Holding a complete, well-verified, explicitly-requested change is the right call when its failure mode recreates the exact incident it was meant to prevent. Record the hold and its acceptance criterion where the next session will find it ([[no-stall-decision-protocol]]).
- Related: [[green-means-not-broken]] — a pass measured in the wrong conditions is another way green fails to mean right.
