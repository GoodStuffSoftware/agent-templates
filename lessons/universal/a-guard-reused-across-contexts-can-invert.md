---
id: a-guard-reused-across-contexts-can-invert
title: A guard's rule can invert in a neighbouring context — a check that fails a correct outcome teaches people to ignore red
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A release-verification channel reused an existing assertion whose rule was *this artifact is always backed by the staging environment*. That rule is correct for the sideload distribution path it was written for — a developer-only channel where a production-backed build would be a mistake.

On a production release it inverts. The production artifact is *supposed* to be production-backed. So the verification failed a release that was entirely correct — after it had already built, signed, uploaded, and gone live — and reported "do not ship this," aborting the rest of the bundle.

**A check that fails a correct outcome is worse than no check**, because its output trains everyone who sees it to route around red.

**Why:** a guard encodes a rule plus an unstated context in which the rule holds. Reuse carries the rule and drops the context, and the reuse looks like exactly the kind of consolidation reviewers approve of — one assertion, two call sites, less duplication. The two call sites disagree about what "correct" means.

**How to apply:**
- **Before reusing an assertion in a new context, state the rule as a sentence and ask whether it is still true there.** "The artifact is always X" is a context-bound claim; "the artifact matches its own environment" is the portable one.
- **Add a per-context rule alongside the original rather than bending either.** The stricter guard keeps its stricter rule; the new context gets its own. The same artifact being a valid production release and an invalid sideload simultaneously is a real, expressible fact — and only separate rules can express it.
- **Prefer a rule parameterised on the target over a rule naming a constant.** "Requires this environment's own backend AND forbids the other" catches both mis-wirings and reads correctly in every context; "always staging" catches one and lies in the other.
- **Treat a red on a known-good artifact as a defect IN THE CHECK, with the same urgency as a missed defect.** Log it, fix it, and say so — a check nobody trusts is a check you are paying for and not getting ([[green-means-not-broken]] covers the opposite direction; both erode the same signal).
- Related: [[match-instrument-to-failure-class]] and [[monitor-default-target-is-part-of-the-finding]].
