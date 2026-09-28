---
id: worker-report-states-continuing-or-stopped
title: A worker report that doesn't state continuing-or-stopped is ambiguous, and a lead must confirm progress from durable evidence
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A worker's status report that does not explicitly say whether it is still working or has stopped is silently ambiguous, and a lead that reads a progress statement like "underway" as closed-enough can let a task sit idle for days before anyone notices it stalled.

The incident: a lead reported a task slice as "underway" without independently verifying that anything was actually still happening. Nobody checked back, because the report read as sufficient. The card sat idle for three days before the gap surfaced.

**Why:** "underway," "working on it," and similar phrasing describe a state at the moment they were written, not a commitment about what happens next. A reader has to guess whether the sender means "still actively running, check back later" or "I did some of it and I'm done for now" — and a busy lead defaults to the optimistic reading, because chasing every ambiguous report doesn't scale.

**How to apply:**
- Require every worker report to end with an explicit state, not a bare progress statement: either "continuing with X now" or "stopped, and waiting on Y." Never leave it implicit.
- The lead confirms liveness from durable evidence — a commit, a file timestamp, a test run — not from the tone or content of the last message received. A report that says "continuing" is a claim to verify against evidence at the next check, not a fact to file away.
- Apply this even when the report sounds confident or detailed; detail is not the same axis as state, and a long, specific update can still omit whether the sender intends to keep going.

Related: [[recovery-from-silent-teammates]] (recovering once silence has already happened — this rule exists to prevent the ambiguity that recovery has to clean up), [[heartbeat-over-time-box]] (abort on actual blockers, not elapsed time — the same discipline of not trusting a vague signal).
