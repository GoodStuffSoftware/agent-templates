---
id: hold-a-wait-in-a-cheap-foreground-worker
title: A wait is held by a cheap worker in the foreground — never by the lead, and never by a background loop
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
Work stalls constantly on something the agent does not control: a remote merge gate, a deploy, a package build, a queued job on a shared box. Someone has to hold that wait. Three candidates, and only one of them is right.

**The lead must not hold it.** Every poll is a turn at the most expensive tier in the session, spent to learn that nothing has changed yet. A ten-minute wait checked every thirty seconds is twenty premium turns of "still running."

**A background loop must not hold it either.** It looks free and is not: a backgrounded shell loop hits its own timeout, wakes the lead to report nothing, and starts again — the same premium turns, arriving unbidden. Worse, a background job is a child of its host and dies with it ([[background-agents-die-with-their-host]]), so the wait can silently stop being held at all.

**A cheap worker in the FOREGROUND holds it.** Spawn a bottom-tier agent with background mode OFF, running a poll script that loops internally, and have it return exactly once with the verdict. The whole wait costs the lead one wake. The worker's own turn budget is trivial, and because the lead is blocked on its return value there is no notification path to misroute ([[resolve-the-reply-to-address]]).

**Shape of the poll script** — the part that makes it one wake instead of many: a fixed interval well above the noise floor (around two minutes, not thirty seconds); a bounded run of several minutes per invocation; and distinct exit codes for *finished* versus *still running*, so the worker decides whether to loop again without a model call. The worker reports the final status VERBATIM — a summarized status is a second place for the truth to drift.

**Why the tier matters as much as the placement:** waiting is not reasoning. The judgment is in what to do when the wait ends, and that judgment belongs to the lead, which is awake again by then. Paying a frontier tier to watch a spinner is the purest form of paying for capability you are not using ([[an-omitted-worker-tier-inherits-the-leads]]).

**How to apply:**
- Any wait on a remote gate, a CI job, or a long local build: delegate it to a bottom-tier worker, foreground, one return.
- Never sleep-loop inside the lead's shell, and never arm a self-waking timer for it — where a token-free daemon already holds the watch, use that instead of a worker at all ([[no-self-waking-bus-poller]]).
- If the operator is present and does not want the wait held, hold nothing: check once, at the moment the next action actually needs the answer.
