---
id: change-a-guard-against-a-recorded-corpus
title: Change a deny-rule guard strictly additively and prove it against a recorded corpus — old versus new, zero loosenings
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
Three earlier rewrites of one command guard each regressed a live catch. The approach that held: leave the proven rules untouched and add a second pass (or extra patterns) after them, so the new version can only deny MORE.

**How to apply:**
- **Additive, not refactored.** Keep the old rule's text byte-identical; where a second copy of its patterns exists (for a normalising layer), pin the two with a drift test.
- **Differential harness.** Run old and new over a case corpus (thousands of cases, benign near-misses included). Classify each as SAME, NEW-DENY-EXPECTED or REGRESSION; REGRESSION must be zero, and every new deny must be explained.
- **Replay real history.** Feed every command from local transcripts (about 200K here) through both versions; expect zero loosenings and a short, reviewable list of new denies.
- **Write down the accepted false denies and the out-of-scope residuals** (quote or escape obfuscation, abbreviations). A guard that cries wolf gets deleted, so the list is part of the decision.
- **Case-sensitivity is a decision.** A case-insensitive flag made PowerShell's `-Format` read as a short flag; match what the real tool treats as case-sensitive.
- Install with a backup and a recorded checksum, and ship the guard plus its drift and linear tests together.

Related: [[a-fail-open-guard-must-finish-inside-its-timeout]], [[an-ignore-rule-protects-a-spelling-not-a-concept]].
