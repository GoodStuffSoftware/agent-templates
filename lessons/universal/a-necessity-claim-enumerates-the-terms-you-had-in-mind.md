---
id: a-necessity-claim-enumerates-the-terms-you-had-in-mind
title: A reachability or necessity claim is only an enumeration of the terms you had in mind
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Three separate wrong claims turned up on one small change, all the same shape: "without this guard, X is possible" (false), "X is not reachable" (false), "adding this closes nothing" (false). Every time, the term that refuted the claim was the one adjacent to the change itself — the author enumerated the terms they had in mind, stopped, and the missed term was the new one just introduced. In every instance, the refuting variant took one run to produce.

**Why:** a reachability or necessity claim ("this cannot happen," "this term does nothing," "removing X changes nothing") is stated as though it were a proof, but it is almost always an enumeration over a finite set of cases the author was actively holding in mind at the time — and a change that just happened, by definition, is not yet in that set. The claim FEELS complete because it accounts for everything the author was thinking about; it is wrong exactly where the author's attention had already moved on.

**How to apply:**
- Treat any sentence of the shape "X cannot happen," "this term does nothing," or "removing X changes nothing" as a test to run, not a statement to trust. Write the variant (the input that would falsify it), run it, and read which cases move.
- Weight suspicion toward whatever changed MOST RECENTLY, especially anything adjacent to the change under discussion — that is precisely the term least likely to have been in the author's enumeration.
- When reviewing a necessity or reachability claim, ask explicitly "what was enumerated to reach this conclusion, and what is missing from that list?" rather than "is this reasoning sound?" — the reasoning is usually sound; the enumeration is what's incomplete.
- The refuting case is nearly always cheap: a single run against a concrete input. Prefer running it over re-reasoning about it, since the whole failure mode is that reasoning already missed the case once.

Related: [[a-correction-pass-must-grep-the-summary-too]], [[unenforced-absence-invariant]], [[absence-observed-is-not-absence-explained]].
