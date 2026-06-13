---
id: verify-actual-bound-url
title: State the actual bound URL, then verify it before relaying or diagnosing
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1, contrib-2]
corroborated: 2
---
Dev tooling silently falls back to the next free port when the requested one is taken (`:3000` then `:3001` then `:3002`). So the agent running the server must relay the EXACT "Local:" URL the tool printed — never the port it *requested* — and the orchestrator must probe that exact URL (expect HTTP 200) before passing it to the user or diagnosing a failure on it.

**Why:** A failure described as "on `:3001`" is meaningless if the build is actually on `:3002` and `:3001` is a stale wedged process. Relaying or debugging an assumed port wastes a whole diagnostic cycle on the wrong target.

**How to apply:**
- Server owner: copy the literal printed "Local:" URL into your message; don't paraphrase it to the port you asked for.
- Orchestrator: probe the exact URL and confirm 200 before passing it on or starting to diagnose.
- See also [[diagnose-the-right-process]] and the stack-specific [[nuxt-port-fallback]].
