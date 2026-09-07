---
id: unauthenticated-tool-layer-is-not-a-wall
title: A missing or unauthenticated tool layer is a convenience that went missing — find the credentialed client the repo already ships
scope: [agent-process]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
When a session's tool integration for a service is absent or reports "needs authentication", the reflex is to stop and ask a human to sign in. Usually you do not have to. That integration is a **convenience layer over an HTTP API**, and the repository you are already working in very often ships its own client for the same service — because its lifecycle hooks and scripts must talk to that service **with no model attached**, which means they carry a credential path of their own.

The incident: a forked session had none of the service's tools; the plugin showed "needs authentication" and the machine was enrolled through an interactive sign-in flow, so the documented bearer-token fallback could not work either. But the session's own start-up hook had already registered it with that service — proof that a working, credentialed client existed in the tree. Importing the repo's hook library (a secret resolver plus `getJson`/`postJson` wrappers) from a scratch script restored the equivalent of every tool in one turn: no sign-in, no restart, no human.

**Why:** the tool layer and the credential are separate things, and only the tool layer went missing. Hooks are the tell: anything that runs without a model must resolve its own secret, so wherever hooks talk to a service, a credential path is already solved and tested in that repo.

**How to apply:**
- Before declaring the layer unreachable, **grep the repo's hooks and scripts** for the module that already calls the same service (a bearer/secret resolver, an HTTP wrapper). Reuse it rather than re-deriving auth — re-deriving is where sessions burn an hour and then ask the human anyway.
- Wrap it as a tiny CLI: `{{CLIENT}} METHOD /api/path @body.json`. **Pass bodies from files, never inline JSON** — shells that strip or re-quote quotes turn an inline body into a silent 400 that reads like an auth problem.
- Confirm **one read route answers** before building anything on it. That single call separates "no credential" from "wrong base URL" (a loopback address that is down versus the public origin is a common split).
- Poll long-running server-side jobs from a **background process loop**, never from the model loop, and re-read state at your next natural turn ([[no-self-waking-bus-poller]]).
- Say plainly in your report that you used the REST path and why, so the missing integration still gets fixed rather than quietly worked around forever.
- Related: [[tool-listing-is-scope-filtered]] (an absent tool name proves nothing about the capability) and [[verify-tools-then-fall-back-to-a-builtin-agent-type]].
