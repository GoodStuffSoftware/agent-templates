---
id: no-field-in-a-last-write-wins-record-is-history
title: In a last-write-wins record, no field is evidence about the past except the counter — read the write statement before inferring history
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Aggregate records that accumulate a counter while overwriting everything else are everywhere: an error tracker, a metrics rollup, any upsert-shaped summary row. The counter is cumulative. Every descriptive field is whatever the *most recent* write happened to carry. Nothing in the record says which is which, and both kinds sit side by side looking equally factual.

Across three sessions, hours were spent inferring event history from such a record. A "first seen" field was read as when the problem began, but it was reassigned on every write. Equal first-seen and last-seen values were read as simultaneity, but the client stamps both to the same instant on every unbatched send. The length of a samples array was read as an event count, but it held however many reports one warm server instance happened to fuse, capped. A user identifier was read as who was affected, but it was whoever wrote last, out of an unknown number of reporters. Three mechanisms were proposed to explain the shape and all three were wrong, for one shared reason: **they treated a snapshot as a log.** Each was a plausible bug that would have produced what was observed, and no analysis of the stored fields could have separated them, because the schema had already discarded the thing that would have.

**How to apply:**
- **Before inferring anything from a stored aggregate, read the write statement.** Which fields accumulate, which are assigned, and does any timestamp come from the server or only from the payload? It is usually one function and a few minutes, and it tells you which questions the data can answer at all.
- **Name each field in the narrowest true terms** ("last write's timestamp", "last reporter"), because "first seen" and "affected user" assert a history the record does not keep. The downstream hazard is a report that filters on "first seen within this window": it computes something nobody intended and looks reasonable indefinitely, since every input is a real field with a sensible name.
- **"Fully explained without X" is not "X disproved."** When the schema's own behaviour accounts for the whole dataset, competing hypotheses are not refuted, they are unobservable. Say unobservable; it is shorter than the argument that follows from claiming more, and it leaves room for the evidence that would settle it.
- **When you say a conclusion holds "under every model", check that the model set contains a no-defect option.** An exhaustive-looking set of bugs reads as exhaustive, and the omission is invisible from inside the list. Here the boring explanation (the counter is honest and the events really happened) was missing from a two-model dichotomy, and a specific factual claim about a real issue was nearly sent on the strength of it.

Related: [[derive-at-read-time-over-storing]], [[cross-tab-side-effect-needs-a-write-then-reread-claim]], [[scope-a-broken-finding-to-the-measured-path]], [[absence-observed-is-not-absence-explained]].
