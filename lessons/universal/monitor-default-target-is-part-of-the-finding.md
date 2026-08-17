---
id: monitor-default-target-is-part-of-the-finding
title: A monitor's default target is part of its finding — an alarm must report what it probed, not just what it found
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 2
---
Before believing a health, parity, or uptime alarm, find out what it actually probed. Resolver defaults are where monitors lie without any bug being present.

The incident: a checker's base-URL resolver returned an explicit environment override if set, otherwise branched on whether edge credentials were present — and the non-edge fallback was a hardcoded loopback address. The service's own daemon carried no edge credentials and set no override, so the monitor silently audited a loopback port on its own host while the traffic it claimed to describe went through the edge. Any second, older process holding that port answers the probe and becomes "the serving version". A separate figure in the same alarm was computed in a directory resolved as `{{EXPLICIT_ENV}} || {{SERVICE_MANAGER_WORKING_DIR}} || the script's own repo root` — so it could be measured in a different checkout than the one under audit. That file's own header already documented the same fallback producing a false verdict once before.

A second incident, same shape from the other end: a release verifier was pointed at the platform-issued default hostname for an environment rather than the hostname the environment is actually served at. Every web channel had been returning HTTP 403 for weeks and it was being read as an environmental quirk of the runner. It was a real misconfiguration — verification aimed at an address that is not required to resolve.

**Why:** A monitor's default target silently rewrites the question. "Is the deployment current?" becomes "is whatever holds this local port current?", and the two diverge exactly when something has gone wrong — which is when you are reading the alarm. The same applies to any path or directory resolved by fallback chain: each branch is a *different subject of measurement*, and the last branch (the script's own location) is almost always wrong yet always succeeds.

**How to apply:**
- **Loopback defaults.** A `localhost`/`127.0.0.1` fallback audits whatever holds that port on that host — not the instance users reach through a proxy, tunnel, or load balancer. A stale leftover process answers happily.
- **Platform-default hostnames.** The address a hosting platform issues by default is not necessarily the address the service is served at, and it is not required to stay reachable. Verify against the hostname real traffic uses.
- **Fallback chains for paths.** `{{EXPLICIT_ENV}} || {{DISCOVERED}} || {{SCRIPT_OWN_LOCATION}}` — the final fallback never fails and is almost never right.
- **A persistent "environmental" error is a finding.** An error that recurs on every run in one environment is a misconfiguration you have not diagnosed yet, not noise. Dismissing it is how a broken verification path stays broken for weeks.
- **"Unverified" caveats get dropped.** Checkers that cannot confirm their target often proceed anyway and attach a caveat; caveats do not survive the trip into an alert summary. Go and look for one.
- **Know which numbers are cosmetic.** Decorative figures (commit counts, drift sizes) are often computed from a different source than the verdict and may be marked non-authoritative in the checker's own source. Do not read a big number as severity.

**Rule:** an alarm should report *what it probed* — resolved URL, resolved directory, and how each was chosen — alongside what it found. Without that, a reader cannot distinguish a broken deployment from a misaimed monitor. Related: [[probe-behaviour-not-version-stamps]] ranks the evidence once you know the target; [[verify-at-destination-prove-the-target]] and [[verify-actual-bound-url]] cover proving the target from the other side.
