---
id: cheapest-tier-validates-does-not-execute
title: The cheapest tier validates, it does not execute a procedure — the failure mode is omission, not a wrong answer
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A validator and an operator are different jobs, and the cheapest tier only reliably does the first. A cheapest-tier session read pages and confirmed strings without trouble, then failed at running a build through a vendor console: read the script, preview it, read the log, run it, then verify a dozen named settings in a separate UI and report each one. It had to be re-spawned a tier up mid-task. No single step in that list was individually hard — the difficulty was holding a long ordered procedure across tool boundaries without silently dropping a step.

**Why:** "look at this and tell me exactly what it says" is cheapest-tier work — the model reads a fixed artifact and reports what is there, and a wrong answer is the only failure mode, which a spot-check catches. "Do these nine things in order, in a live system, and prove each one" is a different shape even when every individual action looks trivial: the failure mode is *omission* — a step silently skipped, a verification never run, a value assumed rather than re-read — and nothing in the transcript necessarily flags it, because the agent that dropped a step does not know it dropped one. Browser-driven work compounds this: every step is a fresh round trip and state must be re-established each time, multiplying the places a step can go missing.

**How to apply:**
- Route by task SHAPE, not by how hard any one step looks: reads, string checks, screenshots, and "confirm X is still true" go to the cheap tier; anything that changes a live system, or must be done in a fixed order across tool boundaries with each step proved, goes up a tier — regardless of how simple the individual actions appear.
- Distinguish this from a consequence-based routing decision ([[classify-by-consequence-then-find-the-cheapest-executor]]): a reversible, low-stakes action can still need the higher tier if it is one step in a long ordered procedure that omission can silently break. Consequence asks "how bad if it's wrong"; this axis asks "how likely is a step to go unproven."
- If a cheapest-tier worker is already mid-task when this becomes apparent, re-spawn a tier up rather than pushing it through — the omission risk does not shrink because the worker is partway done, and a worker that already dropped one step is not positioned to notice it dropped another.
- Treat this as a DEFAULT to audit like any other routing default: a task classified as "small" by volume, not by shape, can default to the cheap tier by omission exactly the way an unset worker tier does ([[an-omitted-worker-tier-inherits-the-leads]]).

Related: [[classify-by-consequence-then-find-the-cheapest-executor]], [[an-omitted-worker-tier-inherits-the-leads]], [[non-painting-browser-pane-lies]].
