---
id: dev-servers-persistent-owner
title: Long-lived dev servers belong to a persistent owner, not transient writers
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
A long-lived dev server is owned by the main session or a dedicated server-minder — never by a transient writer agent. Writer agents *request* a preview URL from the owner; they don't spawn their own `dev` server.

**Why:** A sub-agent's dev server dies when the sub-agent ends, but the listener it bound often doesn't get cleaned up — stray listeners accumulate across a session, and the next server walks to a different port (see [[verify-actual-bound-url]]). The result is a pile of orphaned processes and confusion about which one serves the build.

**How to apply:**
- Designate one persistent owner for dev servers per session.
- Writers ask the owner for a preview/URL instead of running their own long-lived server.
- When you find stray listeners from dead agents, reap them.
