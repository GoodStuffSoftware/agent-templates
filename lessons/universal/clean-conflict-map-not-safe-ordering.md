---
id: clean-conflict-map-not-safe-ordering
title: A clean conflict map bounds textual risk only — it says nothing about whether landing A before B causes harm
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Textual conflict detection answers one question: **will these merge.** It is structurally incapable of answering the other: **does landing A before B cause harm.** Two changes can share zero files — different directories, different subsystems — and still be ordered, because one changes how often something happens and the other fixes what happens each time.

A green map is routinely read as clearing both questions. It clears one.

**The failure shape:** branch A makes an expensive operation more frequent. Branch B makes that operation cheap. Individually both are improvements and both are correct. Land A alone and you have shipped a regression that the map, the tests, and the review all called clean — because each of them was answering a question that was not the one that mattered.

The incident: a queue of ten branches waiting to land. A careful pairwise conflict map was built across six of them, looking specifically for pairs that were individually correct and jointly wrong. It found none, correctly — there were none in that set. Then a different pair surfaced the hazard: two branches sharing no files at all, which every mechanical measure reported as disjoint and safe in either order. One increased how often a UI panel re-rendered; the other fixed that panel's habit of destroying its own state on re-render. Landed alone, the first made a user-reported symptom measurably worse.

**Why:** the mitigation everyone reaches for — "the author will flag it" — is not a control. In the case above the author did flag it, unprompted, and then correctly refused the credit: they noticed only because they had finished writing the second side minutes earlier. Split the two branches across two people, or two weeks, and the warning does not get written. The mitigation's success rate tracks scheduling, not diligence, and it fails *silently*, because nobody knows what warning they did not receive.

**How to apply:**
- When an author volunteers an ordering constraint, **record it next to the branch with the reasoning attached.** The danger is a later sequencer overriding it on a clean-merge signal — which is exactly what that signal will appear to say.
- Report "no textual conflicts" as a *bounded* result. Say what it covers, the way [[scope-a-broken-finding-to-the-measured-path]] asks of any negative finding.
- **The structural fix, when a queue is big enough to earn it:** have a branch declare what BEHAVIOUR it changes, not only which files it touches, so "makes {{OPERATION}} more frequent" and "assumes {{OPERATION}} is cheap" can be seen to collide without anyone holding both in their head.
- Do not resolve another author's *semantic* conflict against a refactor you did not write — hand it back and ask for a rebase. Resolving it yourself is how a subtle behavioural bug ships with clean attribution.
- Related: [[union-merge-eats-shared-closer]] is the same review's other blind spot — a resolution that reads perfectly and does not parse.
