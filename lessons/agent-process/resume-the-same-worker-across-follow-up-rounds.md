---
id: resume-the-same-worker-across-follow-up-rounds
title: Resume the same worker across follow-up rounds — a report is a checkpoint, not task end — and stop it between rounds rather than keeping it idle
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
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
