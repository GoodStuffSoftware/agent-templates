---
id: deliver-the-judgment-not-a-pointer-to-it
title: Deliver the judgment, not a pointer to it — a terseness rule needs a carve-out for the deliverable
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
A recurring scheduled agent wrote a complete, correct four-part interpretation into a long report file on a feature branch, then reported only its one-sentence headline — because the task's own REPORT step asked for "the headline." The branch was unmerged, so the analysis the task existed to produce was unreadable by the person who commissioned it. Every number in the run was right; the deliverable still did not arrive. The operator had to ask for it explicitly.

**When a task's deliverable is an interpretation** — a written read, a recommendation, a verdict — **its instructions must say the interpretation is reproduced VERBATIM and IN FULL in the report, under its own heading.** Naming it ("report the headline", "note the conclusion") invites compression of the one thing that mattered.

Two failure modes this prevents:

- **Terseness bleed.** A standing "keep reports short" rule is about PROCESS noise — dead ends, retries, tool chatter. An agent that applies it to the analysis has followed the letter and lost the deliverable. State the carve-out *where the terseness rule lives* ([[outcome-level-reporting]]), not only in the task.
- **Undelivered artifacts.** Content written to a branch or a path the reader cannot open has not been delivered, however correct it is. Committed is not delivered; a link the reader cannot resolve is not delivery either ([[a-local-path-is-not-a-shared-artifact]]).

**Test when writing any recurring task:** if the agent reported ONLY what this step names, would the person get what they commissioned? If no, the step is underspecified.
