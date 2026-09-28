---
id: a-correction-pass-must-grep-the-summary-too
title: A correction pass follows the prose and skips the summary — status tables and acceptance-criteria rows are claims too
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A wrong claim about a guard's necessity ("without this term, X is possible") was corrected in the code comment, the test comment, the design doc's prose, and the runbook — four places, all fixed. It survived in a fifth: the acceptance-criteria table at the foot of the same design doc, which still carried the pre-correction counts from the same blind spot. Two thorough correction passes and an adversarial review all walked past it.

**Why:** a status-looking table, an acceptance-criteria row, an index entry, or a count column reads as METADATA rather than as prose making a claim, so a correction pass that re-reads sentences does not re-read it — nobody consciously decides to skip it, the table simply never registers as a place a claim could be wrong. The same information is asserted twice in the document, once as an argument and once as a number, and fixing the argument does nothing to the number.

**How to apply:**
- When you correct a claim, grep the whole artifact for its NUMBERS and its NOUNS, not just its sentences — a table cell holding "3" or "N/A" is exactly as wrong as a paragraph saying the same thing, and much easier to miss.
- Treat every summary table, acceptance-criteria row, index entry, and status column as a claim in its own right, subject to the same correction discipline as prose.
- After any correction, search specifically in table-shaped and list-shaped regions of the document — headers, bullet counts, checklists — since that is exactly where a prose-focused re-read skips.
- A reviewer checking a correction should explicitly ask "does anything summarized elsewhere in this document restate the old number?" as a distinct question from "is the argument now correct?"

Related: [[correct-a-durable-record-explicitly]], [[a-necessity-claim-enumerates-the-terms-you-had-in-mind]].
