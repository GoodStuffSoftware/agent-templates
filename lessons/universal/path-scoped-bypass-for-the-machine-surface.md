---
id: path-scoped-bypass-for-the-machine-surface
title: Give machine clients a path-scoped bypass, not a share of the human sign-in
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
When one hostname serves both a human-facing dashboard and a machine-callable API, do not try to make machine clients complete the same interactive sign-in as a person. Give the API path its own narrow authentication-bypass rule, guarded by a bearer credential, and leave the broader rule on the same hostname gating the human interface behind full interactive authentication.

The incident: a service put its dashboard and its automation API behind the same reverse-proxy authentication layer, on the same hostname. Machine clients — headless agents with no browser session — could not complete the interactive login the proxy demanded, so the reachable fix was a rule scoped to the exact API path prefix, resolved ahead of the broader hostname rule, that bypasses interactive auth for that path alone and instead requires a bearer credential on every request. The human dashboard, reached at any other path on the same hostname, stayed behind full interactive sign-in.

**Why:** reverse-proxy authentication layers typically resolve the MOST SPECIFIC matching rule for a given path, so a narrow bypass on one path coexists safely with a broad gate on the rest of the hostname — the two rules never actually conflict, they just need to be written at different specificities. The alternative — teaching every machine client to complete an interactive flow — either fails outright in headless contexts, or pushes operators to disable the gate for the WHOLE hostname just to unblock automation, which is a much larger hole than the one path they actually needed open.

**How to apply:**
- Scope the bypass to the exact path prefix the machines call and nothing broader — a prefix that also matches human-facing routes reopens exactly the surface you meant to keep closed.
- Require a bearer credential on every request behind the bypass. "No interactive auth" must never mean "no auth" — it means a different, machine-appropriate auth.
- After adding the bypass, verify from an unauthenticated context that the human interface is STILL gated. A too-broad path silently opens it, and that regression will not show up in a test that only exercises the machine client.
- Keep the credential in a vault with a documented rotation path rather than scattered across per-machine config files that go stale — see [[secret-resolution-fallback-chain]] for how to resolve it safely at multiple privilege levels.
- The bypass is a convenience layer, not a wall — see [[unauthenticated-tool-layer-is-not-a-wall]] for the companion mistake of treating an unauthenticated surface as more solid than it is, and [[persist-the-secret-before-the-artifact]] for writing the bearer credential to its vault before anything else depends on it.
