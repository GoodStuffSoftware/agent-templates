---
id: probe-behaviour-not-version-stamps
title: Probe behaviour, not version stamps — a self-reported version is a claim by the thing you are auditing
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 1
---
A service's self-reported version — a health endpoint's commit SHA, a build stamp, a `__version__` — is a claim made by the thing you are auditing. It can be stale while the code is current, or current while the code is stale. Treat it as a hint, never as the finding.

The incident: an automated watcher fired a "serving code has drifted from the trunk" alarm, reporting a serving SHA read from the service's own health endpoint and a gap of several hundred commits. Both figures were wrong. The serving SHA came from a constant evaluated once at process boot and captured into a module-level value. The investigating agent noticed that a response it had *already received* from the live service contained a field introduced by a commit inside the supposedly-unshipped range — and that the service imports its route modules statically, with no hot reload. A single process cannot execute code newer than its own boot stamp, so the stamp and the observed behaviour could not both describe the same process. The real gap was an order of magnitude smaller, and the drift was a reporting fault, not a deployment fault.

**Why:** When two sources disagree, you need a ranking rule, and the tempting one — trust the machine-readable number — is backwards. A stamp fails independently of the deploy: a cached response, a second process on the port, a stamp captured at the wrong moment, a probe aimed at the wrong instance. A behavioural probe tests the artifact directly. There is a useful asymmetry: observing new behaviour **disproves** an old-version claim outright, whereas not observing it proves little — so the cheap decisive move is to look for one capability that exists only in the range alleged to be missing.

**How to apply:**
- Rank evidence explicitly: **behaviour beats stamps.** Pick a capability present only in the disputed range and check whether the live system has it.
- Know how the stamp is produced before trusting it. One captured at process boot cannot move without a restart; one baked at build time cannot move at all. Either can disagree with disk.
- If code is imported statically with no hot reload, a process can never serve code newer than its own boot stamp. Seeing it do so means you are talking to a DIFFERENT process than the one you are measuring — look for a second instance, a cache, or a probe aimed at the wrong host ([[monitor-default-target-is-part-of-the-finding]]).
- Re-derive the alarm's own numbers before escalating. For a commit gap: `git merge-base --is-ancestor {{SERVING}} {{REMOTE}}` answers "is this even divergence?", and `git rev-list --left-right --count {{SERVING}}...{{REMOTE}}` gives the real counts. A count computed in a clone with unfetched refs, or one missing the serving object, can be wildly wrong while looking precise.
- Report the reporting fault as its own finding. "The deployment is fine and the watcher is lying" is a more useful result than a restart that fixes nothing.
