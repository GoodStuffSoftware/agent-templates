---
id: size-subagents-by-context-not-by-task
title: Size a subagent to finish inside a context ceiling and a time budget; split by phase through files when it will not fit
scope: [agent-process]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
Several analysis workers each bundled a full-history scan, hand-labelling, analysis and a review. All hit the context ceiling, were compacted and told to wrap up, and one returned half-done and needed follow-up workers. Per-call cost roughly doubles near 200K of context versus a fresh worker, and a post-compaction wrap-up fires after the expensive calls.

**How to apply:**
- Size a worker to finish within {{TIME_BUDGET}} and under {{CONTEXT_CEILING}} (tune both per setup). A build-test-fix-land job is ONE worker when it fits.
- A job that will not fit is split by phase (scan, label, analyse, review). Each phase is a fresh worker that writes its output to a file, which the next one reads, and prints only a summary. Run independent phases in parallel.
- Never continue a cold worker just to carry context; pass a file ([[resume-the-same-worker-across-follow-up-rounds]] covers when a warm resume is cheaper).
- Prefer a checkpoint at a context ceiling over waiting for compaction.

Related: [[teammate-reports-to-files]], [[delegate-wide-queries-the-result-set-lands-in-you]].
