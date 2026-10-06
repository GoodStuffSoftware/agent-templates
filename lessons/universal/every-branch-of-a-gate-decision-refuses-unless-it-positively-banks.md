---
id: every-branch-of-a-gate-decision-refuses-unless-it-positively-banks
title: Every branch of a gate decision refuses unless it positively banks — "cannot determine" is an input, not a falsy skip
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A function deciding "may this pass be recorded?" had two silent fail-opens. A failed probe at run start returned an empty sha, and the condition "both shas non-empty" then disabled the only detector for a mid-run commit: the check was converted into a lost check by the very failure it should have refused. Separately, omitting a sample parameter silently removed a whole check while a null first sample refused loudly — the asymmetry favoured the unsafe side. An incremental patch also introduced an ordering bug: a null check landed after a dereference. The pinned test's justification ("refusing would refuse every non-git checkout") was false, since an earlier branch already refused that case; the guard only ever lost a check.

**How to apply:**
- **Write the decision as a pure function in which "cannot determine" is a distinct input that refuses**, never a falsy value that skips.
- **Make every missing or null argument refuse, loudly and the same way**, so a parameter forgotten by a future caller fails closed.
- **Order branches most-specific refusal first, never dereference before the null check, and let exactly one path bank.**
- **When a test's stated justification is wrong, invert the test** and write down why it was wrong.
- **Rewrite such a function as a unit rather than patching it** incrementally.

Related: [[a-cap-counter-fails-closed-on-a-malformed-read]], [[fail-open-on-the-action-never-on-the-record]], [[a-freshness-guard-belongs-at-record-time-not-spend-time]].
