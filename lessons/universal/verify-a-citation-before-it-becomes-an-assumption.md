---
id: verify-a-citation-before-it-becomes-an-assumption
title: A citation hardens into an assumption of completeness — verify the cited section before it enters a decision record
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A scoping note recorded that five numbered sections of an external partner specification had been "adopted wholesale," and a decision log cited them as settled. Writing design records against those citations, a cheap verification pass found them only partly load-bearing: one section specified a real flow and a service surface but **no field schema and no threshold** for the one parameter the design turned on; another enumerated dependent object types but gave **no traversal mechanism** for reaching them; and a third — credited in the decision log as the source of an entire retention model — contained no such policy at all. The same log stated, three entries later, that the partner "has no retention policy," flatly contradicting its own earlier attribution. Nobody had noticed, because nobody had opened the cited section since writing the citation.

**The kernel: a citation hardens into an assumption of completeness the moment it enters a decision record.** Downstream readers treat "adopted from §N" as meaning §N is implementable, and nobody re-checks. Verifying costs minutes at a cheap tier; not verifying costs a builder discovering mid-implementation that the adopted design has a hole exactly where its load-bearing parameter should be.

**Verify with a three-verdict rubric** (delegable; the judgement is in reading the verdicts, not producing them):

| Verdict | Means |
|---|---|
| **FULL** | Present and specific enough to implement from. Requires verbatim quotes — if the checker cannot quote implementable content, it is not FULL. |
| **PARTIAL** | The section exists but is a headline, a principle, or a flow without the schema, threshold, or mechanism needed to build it. **"Mentions the concept" is PARTIAL, never FULL.** |
| **ABSENT** | No such section, or the content attributed to it is not there. |

Rules that follow:

- **Only a FULL section may be cited as "adopted."** A PARTIAL one is cited as *the principle is adopted; the mechanism is an open decision* — and that open decision goes on the register with options, not into the record as if settled.
- **A principle that deliberately declines to choose between mechanisms is FULL as a principle and ABSENT as a decision.** Do not let your own summary silently upgrade "must satisfy property X" into "use mechanism Y" — check whether the source chose, or whether your notes chose on its behalf and then forgot.
- **When your summary and the source disagree, the source wins and the summary is corrected in the same pass.** Counts and enumerations drift in summarization (a taxonomy summarized as "twenty types" enumerated twenty-five). Tell builders to transcribe from the source: a summary that is wrong by five is wrong in a way nobody will question.
- **Grep the decision log for other claims about the same source.** The contradiction above was discoverable from the log alone, with no access to the external document. Where one attribution is wrong, check its neighbours ([[correct-a-durable-record-explicitly]]).

Related: [[review-docs-against-the-code-seam]], [[brief-for-the-decision-not-your-conclusion]], [[a-checkout-is-not-the-running-system]].
