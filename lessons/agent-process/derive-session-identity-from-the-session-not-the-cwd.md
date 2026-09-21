---
id: derive-session-identity-from-the-session-not-the-cwd
title: A hook that derives identity from the current working directory drifts — derive it once, from the session
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A registration hook proposed an agent's name by deriving it from the current working directory. After a lead's directory moved into an unrelated folder mid-session, the hook asked that lead to register under a different project's identity — which would have stranded its inbox, its task claims, and its wake path under a name nobody was listening to.

**Why:** the working directory is ambient, mutable, and not an identity. Any process is free to `cd` for a subtask, follow a symlink, or be launched from a shared scratch path, and none of those events are supposed to mean "you are now a different agent." A hook that reads `cwd` at the moment of use is really reading "wherever I happen to be standing right now," and treating that as durable identity conflates a coordinate with a name.

**How to apply:**
- Resolve identity once, at session start, from a session-stable source (the session identifier, an explicit configured name) and cache it. Never re-derive it from ambient state on every use.
- If a derived name must include a project, derive the project ALSO at birth — from the repo root or an explicit argument passed in at spawn time — not from whatever directory a later tool call happens to be running in.
- Make any rename an explicit operation that carries the prior name forward (so inbox, claims, and wake handles migrate with it), rather than a silent side effect of a directory change.
- When auditing a registration hook, ask specifically: "what happens if `cwd` changes mid-session but nothing else about this agent's role changed?" If the answer is "it re-registers under a new name," the hook is deriving identity from the wrong input.

Related: [[a-guard-that-reads-ambient-state-is-not-reading-the-target]], [[registry-identity-and-liveness-honesty]], [[unique-team-name-per-session]].
