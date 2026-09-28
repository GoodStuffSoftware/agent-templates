---
id: sanity-check-a-mechanism-against-a-known-invariant
title: Sanity-check a proposed mechanism against a known-true invariant before relaying it — "if this were true, what else would be broken?"
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A proposed root-cause mechanism is cheap to falsify against something you already know to be true, before spending any more investigation on it. If the mechanism, taken literally, would break a feature you can independently confirm is working, the mechanism is wrong regardless of how well it explains the original symptom.

The incident: an explanation for a test failure assumed two checkouts of one repository had disjoint object stores, so a cross-checkout content-hash comparison could deterministically fail. But linked worktrees of one repository SHARE an object store — that sharing is precisely why the cross-checkout cache the mechanism described works at all. The mechanism, if true, would have broken a feature that was visibly working. One pass of "what does this claim imply, and is that implication already false?" would have killed it before it was relayed.

**Why:** a mechanism is evaluated for how well it explains the symptom in front of you, which biases toward accepting anything that fits. Checking it against an invariant you did not go looking for — a feature working, a system live, a value bounded — is a different, independent test the mechanism also has to pass, and it is much cheaper than re-running the original investigation.

**How to apply:**
- Before relaying a proposed mechanism, ask "if this were true, what ELSE would be broken?" — then check whether that other thing is, in fact, broken. If it plainly is not, the mechanism is refuted without touching the original symptom again.
- Prefer invariants you can check for free: a feature that depends on the same assumption and is visibly functioning, a documented design property, a constraint the codebase enforces elsewhere.
- This is a second, independent gate on top of not relaying a manufactured reproduction as fact ([[a-manufactured-reproduction-proves-can-never-did]]) — a mechanism can fail this check even when it was derived from a real reproduction, not only a hand-built one.
- Related: [[read-which-error-fired-before-theorising]] (a theory that predicts a different observable is already refuted — the same falsification habit, applied to evidence already in hand rather than to a known invariant).
