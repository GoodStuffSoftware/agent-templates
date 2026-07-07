---
id: team-vs-subagent-gate
title: Score weight, phases, communication, and width before spawning a team — a team must earn its order-of-magnitude cost
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Before spawning a persistent team (named teammates, a roster, inter-agent comms), score the task on four dimensions: **weight** (how hard the work is), **phases** (how many distinct stages), **communication** (do workers need to talk to each other or be re-briefed mid-flight), **width** (how many parallel workstreams). A persistent team costs roughly an order of magnitude more tokens than a one-shot subagent — every teammate re-carries its system prompt and roster context on every exchange, and idle teammates still cost briefing, syncing, and shutdown discipline. Low scores → a one-shot subagent, or doing it inline. Escalate lazily: start with the cheapest shape that could work and upgrade only when the task demonstrates the need — a second phase appears, cross-worker coordination emerges, a subagent stalls on scope it can't hold.

**Why:** Teams feel "more capable," so sessions over-spawn them — and then most of the extra capability is spent on self-coordination (briefs, status pings, gate messages) rather than on the work. A one-shot subagent with a complete brief covers the common case — single phase, single writer, no cross-talk — at a tenth the cost. The gate forces the question "what about THIS task needs persistence or communication?" before the expensive shape is chosen, and lazy escalation makes a wrong initial guess cheap to correct; the reverse mistake (tearing down a half-used team) is not.

**How to apply:**
- Score all four dimensions at spawn time; the score is the routing, not a vibe check.
- One phase + one writer + no cross-talk → one-shot subagent with a complete brief ([[write-target-in-initial-brief]]).
- Multiple phases, genuine worker↔worker communication, or 3+ parallel writers → a team is on the table; name it uniquely per session ([[unique-team-name-per-session]]).
- Never pre-build a roster "just in case" — escalate when the need actually shows up.
