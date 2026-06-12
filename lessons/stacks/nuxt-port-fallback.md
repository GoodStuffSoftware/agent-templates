---
id: nuxt-port-fallback
title: The Nuxt/Vite dev server walks to the next free port — never assume the requested one
scope: [stack:nuxt, stack:vite]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
The Nuxt (and underlying Vite) dev server does not fail when its default port is taken — it walks to the next free one (`:3000` then `:3001` then `:3002`, …) and prints the actual bound port in its "Local:" line. Never assume the server is on the port you requested.

**Why:** Two dev servers, a stale wedged process, or a previous run that didn't release its port all push the new server to a higher port. Code or scripts that hardcode `:3000`, and humans who assume it, end up pointing at the wrong process — or at nothing.

**How to apply:**
- Read the actual bound port from the server's printed "Local:" URL every time; don't hardcode it.
- This is the stack-specific instance of the general agent-process rules [[report-actual-bound-url]] and [[diagnose-the-right-process]] — the same fallback behavior is why those rules exist.
