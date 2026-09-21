---
id: reuse-the-authors-helpers-in-someone-elses-codebase
title: When contributing to a codebase you do not own, reuse the author's helpers — and prove "ours is better" before keeping your own
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Across a multi-agent session extending a third-party plugin and loader codebase, one-shot workers kept writing their own widgets, configuration accessors, and utility structures even where the author's SDK or sibling repositories already had one; two copies of the same widget landed in two sibling repositories. Every parallel system makes an upstream contribution harder to accept — the cost is not duplication, it is rejection.

**Why:** a worker briefed only on "implement X" has no visibility into what the upstream maintainer already ships, and defaults to writing what it can see rather than searching for what already exists. Left unchecked, that produces a codebase that looks locally reasonable and is structurally unacceptable to the project it is meant to join.

**How to apply:**
- Put three rules in every writer brief: use the author's helpers unchanged by default, searching their SDK, headers, and sibling repositories first; keep your own only with a concrete, stated advantage (correctness, thread safety, no per-frame I/O); factor out a helper once a pattern repeats three or more times.
- **Gate the change with an adversarial helper-reuse review before pushing**, using explicit verdicts — REUSE-AVAILABLE / MODIFIED-THEIR-HELPER / PARALLEL-SYSTEM / OURS-BETTER / NEEDS-HELPER / JUSTIFIED-NEW — where the reviewer must try to REFUTE each finding (is the helper reachable, equivalent, thread-safe for this caller?) before it counts. "Different style" is never OURS-BETTER.
- Check the author's own documentation before assuming a platform limit. In one case a worker hand-drew an icon because "the font has no glyphs beyond ASCII," while the author's documentation said the interface library loads any glyph from its bundled icon font on demand — one character would have done it. A claimed limitation is a documentation lookup, not an assumption.
- When two sibling repositories both need the same small utility, that is the signal to promote it to a shared location BEFORE a third copy appears, not after.

Related: [[staff-the-shared-layer-before-fanning-out]] (the same duplication pressure inside a repo you DO own, where the fix is a repo gate rather than an acceptance review), [[grep-the-shipped-artifact-not-the-docs]], [[peer-to-peer-review-routing]].
