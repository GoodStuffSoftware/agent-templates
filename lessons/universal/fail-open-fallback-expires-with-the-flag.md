---
id: fail-open-fallback-expires-with-the-flag
title: Tie a rollout fail-open to the feature's own enablement flag — never to someone remembering to close it
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A publicly-routed webhook endpoint performed an entitlement REVOCATION and authenticated nothing: anyone who learned a token could post a synthetic envelope and revoke that user's access. The fix added signature verification — but gated it on a configuration value being present, because enforcing a signature the upstream subscription had not yet been configured to send would drop every real notification during rollout.

Written unconditionally, that gate fails OPEN forever. Missing the one activation step would leave a live, publicly-reachable, unauthenticated revocation endpoint in production, with nothing anywhere reporting a problem. The correct shape is one line: the gate fails open only while the feature itself is disabled, and fails closed the moment the feature is turned on.

**Why:** a rollout fail-open is a deliberate, time-boxed hole whose expiry is stored in a human's memory. Every other part of the activation has a switch; this one has an intention. And it is invisible by construction — a fail-open produces no errors, no logs anyone reads, and no failing test, so nothing surfaces it on the day it starts mattering.

**How to apply:**
- **Key the fallback to a condition the system already evaluates** — the feature's own enablement flag, the presence of the dependency it is protecting, the environment. `if (!featureEnabled) allow` is self-closing; `if (!configPresent) allow` is permanent.
- **Order the activation checklist so the hole closes before the feature opens.** If the flag is the closer, no separate step is needed — which is the point.
- **Log loudly while the fallback is active**, naming the exact configuration that will close it. A silent temporary state becomes a permanent one.
- **When a fail-open protects a MUTATION, weight it as a live vulnerability, not a rollout detail.** The reachable-and-unauthenticated window is real regardless of whether the feature it belongs to is "on" — an attacker does not need your feature enabled to call your endpoint.
- **Audit the direction of every fallback you add** during an activation review: which way does it fail, under what condition, and what closes it. See [[secret-resolution-fallback-chain]] for the resolution-order sibling and [[did-not-run-is-a-third-outcome]] for what an inactive check reports about itself.
