---
id: shared-container-pays-every-dependency
title: In a shared deployment container, weight added for a rare fallback is paid on the critical path — state a dependency's size before adding it
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Serverless function directories, plugin bundles, and mobile app binaries are usually ONE shared deployment unit. A fat dependency added for a single rarely-used path is paid as cold-start latency, install size, or download weight by EVERY entry point in that unit — including the one on the signup or first-run critical path.

**Weight added for a fallback is weight paid on the happy path.**

The measurement that made this concrete: one function directory's dependency tree came to 182 MB, of which a single API meta-package accounted for 106 MB — 58% of the tree, in *production* dependencies, for a project that used one or two of the hundreds of services it bundles. A proposal to add a 15–20 MB vendor SDK for a NON-DEFAULT email transport would have been paid by every function, forever, for a path almost nobody takes.

**How to apply:**
- **State a dependency's installed size and what it buys, before adding it.** Not an estimate — measure the installed tree.
- **Prefer the leanest interface that is still first-class.** In the case above, the same provider over a protocol client already present (0.5 MB) beat the same provider over its HTTPS SDK (15–20 MB): same quota, same reputation, same authentication, same limits, 3% of the weight.
- **Prefer a scoped client over a meta-package.** Replacing a bundle-everything API package with the single scoped client typically removes 95% of it.
- **Extracting a separate service is a legitimate option, but not the first one.** It trades size for a runtime dependency, which is a bad trade in a load-bearing path. Reach for it only when the *code* is the weight, not the dependency.
- Audit the existing tree periodically. The standing offender usually dwarfs anything a feature branch is likely to add, and nobody finds it while arguing about the feature branch.
