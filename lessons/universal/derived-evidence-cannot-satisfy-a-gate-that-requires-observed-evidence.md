---
id: derived-evidence-cannot-satisfy-a-gate-that-requires-observed-evidence
title: Derived evidence cannot satisfy a gate that requires observed evidence — fix it in the consumer, and say which origin was rejected
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A merge gate documented itself as "exact tree match only, never inheritance", but the shared record store wrote inherited passes ("this tree is equivalent to a proven one") in the same shape as real runs, differing only by a provenance field. The gate accepted any entry whose suite field said "full", so "full suite green for this exact tree" could be an inheritance record with no run behind it — and inheritance chains arbitrarily deep, each hop minting another full entry. Calling the exact-match lookup instead of the inheritance lookup was necessary but never sufficient: the record's *shape* was the problem.

**How to apply:**
- **Fix it in the consumer that needs observed evidence:** require "not derived" explicitly, and make the refusal say which origin was rejected.
- **Leave the writer's shape alone** if another legitimate consumer (a cheap fast path) depends on it, and state the asymmetry in a header: inheritance is right for the fast path and wrong for the last full run before release.
- **Test both halves:** a one-hop and a chained derived entry must NOT satisfy the gate, and a directly recorded entry still earns the skip, so the fix is not "always run it" in disguise.
- **Rewrite header comments that describe intent rather than what the code does** ([[a-right-conclusion-does-not-vouch-for-its-premise]]).

Related: [[a-gate-that-exists-vs-a-gate-that-covers]], [[a-test-written-from-the-fix-agrees-with-itself]].
