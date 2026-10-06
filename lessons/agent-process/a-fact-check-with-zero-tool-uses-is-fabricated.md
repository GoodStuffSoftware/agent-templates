---
id: a-fact-check-with-zero-tool-uses-is-fabricated
title: A fact-check answered with zero tool uses is fabricated — read the usage record before the answer, and demand raw output
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A cheap-tier worker was asked to verify where a source file sends first-time visitors. It replied in about ten seconds with a confident, specific answer: line numbers, quoted code, a verdict. Its tool-use count was **zero**. Every detail was invented, and the line numbers contradicted the real file. Nothing in the prose distinguished it from a genuine, verified answer — specificity is exactly what a fabrication supplies.

**Why it misleads:** a model asked to verify a thing it can plausibly reconstruct will produce the reconstruction in the same register as an observation. The prose carries no signal; the *usage record* does.

**How to apply:**
- **Read the worker's usage record (tool-use count, duration) before reading its answer.** A factual claim about a file, a system or a log backed by zero tool uses is void, however specific.
- **Require the reply to include the raw evidence** — the command run and its literal output, the grep hit, the file excerpt — so the claim can be checked against something other than the writer's confidence.
- **Re-run a void check one tier up** rather than asking the same tier to "try again", and pair it with the evidence requirement.
- This is the complement of [[cheapest-tier-validates-does-not-execute]]: that lesson says what the cheap tier is for; this one says how to tell when it did not do even that.
