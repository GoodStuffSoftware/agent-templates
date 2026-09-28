---
id: an-activity-digest-must-not-enumerate-default-branches
title: A digest that reads only default branches misses the work that happened on side branches
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A daily activity digest read each repository's default branch to summarize recent work. A full week of contribution work on a fork was invisible to it: a fork's default branch mirrors upstream and never moves, while the real commits sat on side branches the digest never looked at. The digest was green — no errors, a plausible-looking summary — and simply wrong by omission.

**Why:** "read the default branch" is a reasonable proxy for "read what happened" only when work always lands there, and forks, feature branches, and draft PRs all violate that assumption structurally. This is the same shape as [[scope-a-broken-finding-to-the-measured-path]] — a measurement that is accurate about the one path it covers and silently wrong about the category — applied to a specific and common instrument: branch enumeration.

**How to apply:**
- Do not enumerate branches to find activity; it does not scale (a host can carry hundreds of branches per repository) and a naive default-branch read is the degenerate case of the same mistake.
- Prefer the platform's own activity/events feed, queried once per repository: it names the branch, the actor, and the time for every push, so only branches someone actually pushed to are followed, and the result is small regardless of how many stale branches exist.
- Dedupe by commit sha across branches before summarizing, since the same commit can appear reachable from more than one ref.
- When auditing an existing digest or report, ask explicitly which refs it reads — "the default branch" is a fact about the instrument, and stating it as the finding's scope is the same discipline as scoping any other measured claim.

Related: [[scope-a-broken-finding-to-the-measured-path]], [[check-the-merge-base-before-believing-a-deletion-count]].
