---
id: resume-the-same-worker-across-follow-up-rounds
title: Resume the same worker across follow-up rounds — a report is a checkpoint, not task end — and stop it between rounds rather than keeping it idle
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 2
---
An orchestrator treated a worker's completion report as the end of the task rather than a checkpoint. Follow-up work on the same change — review findings, a mid-task scope change, a live-test failure — kept spawning a fresh worker instead of resuming the one that already held the design and had already walked the dead ends. One worker resumed across four follow-up rounds (a mid-task scope change, a permission-classifier denial, an in-place redesign, and an auto-discovery requirement) each landed in minutes, because the resumed worker never had to rediscover context a fresh spawn would pay for twice: once to explore, once to re-derive what the last worker already ruled out.

**Why:** a worker's first report reads like task completion, but on any task with a realistic chance of follow-up it is better modeled as a checkpoint. Spawning fresh for each round is the default failure — it feels like "starting clean," but a fresh worker pays a real cost to re-explore ground the previous worker already covered and re-derive conclusions it had already reached, and none of that work shows up as wasted in any single spawn's own accounting.

**How to apply:**
- Send follow-ups — review findings, scope changes, live-test failures — to the SAME named worker by resuming it, rather than spawning a fresh one. The lead declares completion, not the worker's first report. State this in the brief up front: "your report is a checkpoint — expect follow-ups until I say the task is complete."
- Mind the cache-window cost basis: a resumed worker's own prompt cache window is typically much shorter than the main session's (on the order of minutes, not an hour) unless explicitly extended. Resume inside that window and the transcript re-read lands at cache rate; resume after it has expired and the re-read pays a full cache rewrite — the same as a fresh spawn's initial read. The savings come from skipping re-exploration, not from the cache alone. If follow-ups routinely land after the window closes, extend the window for that worker rather than accepting a full rewrite on every resume.
- A fresh spawn separately pays a token floor for its initial system/tool setup, plus the time cost of re-exploring what the previous worker already found — both are avoided by resuming.
- Go fresh when: the worker's cache window has already expired, the next task is unrelated to the prior one, the transcript is near auto-compaction, or the next step is a review — a reviewer must not be the same agent as the writer it is reviewing.
- Stopped-and-resumed versus kept-idle is a capability choice, not a cost one — neither keeps the prompt cache warm past its window, so the two cost roughly the same. Choose based on capability instead: an idle worker is still a live process (memory matters at fleet scale on small machines), it cannot nest under some spawn modes, and it dies with the lead's own process regardless. Reserve always-alive workers for cases where direct peer-to-peer messaging earns its keep — a writer/reviewer pair working concurrently — not as a default holding pattern between rounds of the same task.

Related: [[team-vs-subagent-gate]], [[shutdown-after-verified-not-after-committed]], [[background-agents-die-with-their-host]].

**Measured amendment: resume only while the cache is warm and the follow-on is short.** A transcript study over five weeks of real traffic tested "reuse workers by default" and refuted it. A continued worker costs about 0.11 (warm) to 0.16 (cold, over an hour) plan units per call, against 0.06 to 0.07 for a fresh follow-on, because the continued worker re-reads its whole earlier context on every call. A cold resume's first call cost about 8 times a fresh worker's. Re-discovery was only 1 to 4 percent of a follow-on's cost, so skipping it rarely repays the re-read. Applied to one week, continuing every follow-on would have cost 7 to 13 percent of the weekly limit more.
- Rule: continue a worker only while its cache is warm (under 5 minutes) AND the follow-on is short (about 10 calls or fewer). Otherwise spawn fresh with a short handoff file naming what was found and what was ruled out.
- Never resume merely to keep a worker "in the loop" after its cache expired, and go fresh when its context is far larger than the next task needs.
- Limits of the evidence: no matched tasks; quality, rework and operator time were not measured. Re-measure on matched tasks before widening the rule.
This amends the "resume by default" framing above: the checkpoint idea stands, but the cost basis decides.
