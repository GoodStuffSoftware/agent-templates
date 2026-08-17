---
id: post-deploy-checks-need-their-own-harness
title: A post-deploy check needs its own harness — a flag on the local suite verifies localhost and calls the release green
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 1
---
Tests that must hit a deployed system belong in a SEPARATE configuration, not in the local suite behind a flag. A test harness built for local development carries setup that silently redirects the target: a global setup that boots fake backends, a web-server block that starts a dev server, fixtures that seed a local store. A new project or tag inside that configuration inherits all of it and quietly tests localhost.

That is exactly how one release pipeline shipped a green verdict for months: an "enabled" flag ran the local end-to-end suite after each deploy and reported the release verified, having never touched the deployed host.

**Why:** Inheritance in test configuration is invisible at the call site. The new tier looks like it targets the deployed URL because you wrote the deployed URL in it — the overriding setup lives in a file you did not edit. And the failure is silent in the worst direction: the suite passes, because localhost is healthy.

**How to apply:**
- Give the live tier its own config file with no shared global setup and no local server block. Separate directory, separate entry point, separate command.
- Only reuse helpers that are genuinely surface-agnostic. A helper that seeds local browser state is portable; anything that talks to a fake backend, a fixture store, or a test-only auth path is not, and reusing it re-imports the local world.
- Design against the fact that the target is real and shared: run serially with one worker, and prefer checks that structurally cannot pollute (an incomplete run that cannot produce a durable record) over checks that need cleanup afterwards.
- Choose the checks by asking how releases have ACTUALLY shipped broken — the app fails to boot, the bundle points at the wrong backend, today's generated content is missing, a real account cannot sign in through the form and write. Pick the small set that maps to observed failures rather than re-testing what the local suite already covers.
- Include at least one check no cheaper proxy can reach. An API-level sign-in proves credentials are accepted; only the real form proves the login page works and the session's first write survives live authorization rules.
- Related: [[monitor-default-target-is-part-of-the-finding]] (the target a check resolves is part of its finding), [[match-instrument-to-failure-class]], [[verify-at-destination-prove-the-target]].
