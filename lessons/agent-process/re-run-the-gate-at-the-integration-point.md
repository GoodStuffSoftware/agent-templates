---
id: re-run-the-gate-at-the-integration-point
title: A builder's "validation passed" is a claim — re-run the validating command on the merged tree
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A builder agent reported its validator green in its completion report. An independent integration step, run later on the merged tree, found the same command exiting non-zero: the manifest the builder had authored carried an unquoted colon-space inside a plain scalar, which terminates the scalar. The artifact would have loaded with **empty metadata and never activated** — a silent degradation, not a crash. Everything else the builder reported was accurate and independently reproduced. This was not a careless agent; it was a check run at a moment the builder chose, on a tree only the builder had seen, and possibly not re-run after a later edit.

**Why a self-report cannot close this:** the builder controls both the timing of the check and the state it ran against, and neither is visible to anyone downstream. The gap is not dishonesty — it is that "I ran it and it passed" is a statement about a tree that no longer exists by the time anyone reads it.

It is sharper for **manifest and frontmatter validation** specifically, because the failure mode is silent: nothing downstream complains about metadata that parsed to nothing.

**How to apply:**
- **Still demand the builder's own run.** It catches most defects cheaply and early. Treat it as evidence, not as proof.
- **Put the authoritative run where nothing can be edited after it** — the same step that performs the merge — with an explicit "if this fails, do not publish" rule.
- **Tell the integrator the expected passing output**, so a *changed* result is as visible as a failing one ([[assert-the-guard-saw-something]]).
- For anything whose failure is silent degradation rather than an error, add a witness that the artifact actually took effect — not just that the file parsed.

Related: [[green-means-not-broken]], [[verify-at-destination-prove-the-target]], [[reviewer-matches-the-tier-it-reviews]].
