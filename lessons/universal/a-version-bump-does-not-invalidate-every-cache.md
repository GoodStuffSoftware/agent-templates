---
id: a-version-bump-does-not-invalidate-every-cache
title: A version bump does not invalidate every downstream cache — each independent consumer needs its own refresh
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
An artifact published through a distribution registry was updated and verified green by every local check: the registry cache commit, the installed-version report, the manifest version match. A separate hosted client that consumes the same registry kept serving the **previous** version's behaviour anyway. The update sequence run on the local machine never touched the hosted client's cache; it is a different cache, on a different machine, with no shared refresh path. What fixed it was removing the hosted client's copy of the registry and re-adding it — a version bump alone did not invalidate it.

**The kernel:** a version number is metadata, not a cache-invalidation signal. When several clients consume the same distribution channel independently, "I published a new version and my machine sees it" is evidence about exactly one consumer. The others hold whatever they last fetched, for as long as their own policy says.

**How to apply:**
- **Enumerate the consumers** of any cached distribution — every machine, every runtime, every hosted client — and verify the new version at EACH one, by observed behaviour rather than by a reported version string ([[probe-behaviour-not-version-stamps]]).
- Publish a refresh procedure per consumer, and expect at least one of them to need remove-and-re-add rather than a refresh command.
- When a consumer serves stale behaviour, suspect a second cache before suspecting the publish ([[verify-at-destination-prove-the-target]]).

Related: [[one-switch-two-effects-autoupdate]] — the same family seen from the other side, where a second install scope hides behind a current one; that lesson is about one switch with two effects, this one about one artifact with several independent caches.
