---
id: resume-the-same-worker-across-follow-up-rounds
title: Resume the same worker across follow-up rounds — a report is a checkpoint, not task end — and stop it between rounds rather than keeping it idle
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
updated: 2026-10-06
provenance: [contrib-2]
corroborated: 1
---
An orchestrator treated a worker's completion report as the end of the task rather than a checkpoint. Follow-up work on the same change — review findings, a mid-task scope change, a live-test failure — kept spawning a fresh worker instead of resuming the one that already held the design and had already walked the dead ends. One worker resumed across four follow-up rounds (a mid-task scope change, a permission-classifier denial, an in-place redesign, and an auto-discovery requirement) each landed in minutes, because the resumed worker never had to rediscover context a fresh spawn would pay for twice: once to explore, once to re-derive what the last worker already ruled out.

**Why:** a worker's first report reads like task completion, but on any task with a realistic chance of follow-up it is better modeled as a checkpoint. Spawning fresh for each round is the default failure — it feels like "starting clean," but a fresh worker pays a real cost to re-explore ground the previous worker already covered and re-derive conclusions it had already reached, and none of that work shows up as wasted in any single spawn's own accounting.

**How to apply:**
- Send follow-ups — review findings, scope changes, live-test failures — to the SAME named worker by resuming it, rather than spawning a fresh one. The lead declares completion, not the worker's first report. State this in the brief up front: "your report is a checkpoint — expect follow-ups until I say the task is complete."
- Reuse a stopped worker whether its cache is warm or cold. Measured 2026-10-06 over a usage study: a message to a cache-cold worker cost about 0.2 plan units; a fresh spawn's first load about 0.6, plus re-reading everything the old worker already knew. Spawns per day had grown from 22 to 237 and start-up load from 1.2% to 6.8% of the weekly limit per day, so the fresh-spawn habit was the cost, not the cold cache. (An earlier version of this lesson said to go fresh once the cache window expired; that was wrong, and is superseded.) Never spawn fresh just because a cache expired.
- A fresh spawn pays a token floor for its initial system and tool setup (about 61-64K tokens measured), plus the time cost of re-exploring what the previous worker already found; both are avoided by reusing.
- A reused worker stays bounded: subagents auto-compact (about 217K with a 250K window), so a long-lived worker does not grow without limit.
- Go fresh only when: the next task is unrelated to the prior one, the next task needs a different model tier than the worker has (do not reuse an opus worker for sonnet-weight work), the worker's context is far larger than the next task needs, or the next step is a review — a reviewer must not be the same agent as the writer it is reviewing.
- File handoffs are for crashes and for work that outlives the session, not the default way to continue a task.
- Stopped-and-resumed versus kept-idle is a capability choice, not a cost one — neither keeps the prompt cache warm past its window, so the two cost roughly the same. Choose based on capability instead: an idle worker is still a live process (memory matters at fleet scale on small machines), it cannot nest under some spawn modes, and it dies with the lead's own process regardless. Reserve always-alive workers for cases where direct peer-to-peer messaging earns its keep — a writer/reviewer pair working concurrently — not as a default holding pattern between rounds of the same task.

Related: [[team-vs-subagent-gate]], [[shutdown-after-verified-not-after-committed]], [[background-agents-die-with-their-host]].
