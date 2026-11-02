---
id: ask-the-live-owner-before-spawning-a-lookup
title: Before spawning a worker to look something up, ask the live session that owns the topic
scope: [agent-process]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
A lead spawned a lookup worker to learn why a scheduled routine was running in a degraded mode. The operator refused: a local session already owned that area and could simply be messaged. The owner already holds the answer and its own history; a fresh lookup costs tokens, rebuilds context from files and can contradict the owner.

**How to apply:**
- Before spawning an investigator, list live sessions ({{LIST_SESSIONS_CMD}}) and match the topic to an owner (ads, mobile builds, error triage, stats).
- If one exists, send it the question and ask it to answer the requester directly.
- When the operator says "the X agent", they mean that existing session, not a new one.
- Spawn a lookup worker only when no owner is live.

Related: [[check-before-duplicating-a-peers-work]], [[same-machine-peers-use-the-harness-channel]].
