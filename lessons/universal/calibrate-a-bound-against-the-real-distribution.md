---
id: calibrate-a-bound-against-the-real-distribution
title: Never specify a bound you have not counted — "blocks everything on day one" and "never fires" are equally broken
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A threshold picked from intuition rather than from the actual data it will run against is a coin flip between two failure modes: too tight, and it silently deletes valid cases into a catch-all; too loose, and it never fires at all. Both look identical in code review — a clean, reasonable-sounding number — and both are equally broken.

Two incidents, same root cause. First: a reviewer specified a length bound for a validator without measuring the real vocabulary it would run against. Had it shipped, it would have silently bucketed a real, valid, longer value into the catch-all path on day one — deleting a whole legitimate case from the data with no error, no log line, nothing to notice. The implementer caught it by checking the actual vocabulary in use, widened the bound to cover it, and added a test asserting every known-good key survives validation — guarding the class of valid inputs, not just the one instance that got measured. Second: a pre-existing severity rule required an all-time count of 25 before escalating, while the largest count anywhere in the entire production dataset was 13. The rule had been live and had never once fired, in either direction — not too strict, simply calibrated against a number nobody had checked.

**Why:** a bound feels like a design decision, so it gets made the way design decisions get made — by judgment, in the abstract, before the data exists to check it against. But a bound is actually an empirical claim about a distribution, and judgment about a distribution you have not measured is just a guess wearing the shape of a decision.

**How to apply:**
- Before shipping any threshold, length limit, count cutoff, or timeout, pull the real distribution it will be evaluated against — every current record, not a sample you expect to be representative — and report it alongside the proposed number.
- Require whoever implements a threshold to state, in the same change, the actual class distribution it was calibrated from; a bound with no stated basis is a bound nobody checked.
- Treat "the bound has never fired" as a finding, not a reassurance — it means either the condition never occurs (fine) or the bound is miscalibrated (not fine), and only counting the real data tells you which.
- Add a test that asserts every known-good value on the current distribution survives the bound, so a future tightening trips before it ships rather than after.
- Related: [[a-test-written-from-the-fix-agrees-with-itself]], [[an-open-ticket-is-not-clearance]], [[seed-a-new-counter-from-measured-state]].
