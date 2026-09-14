---
id: correct-a-durable-record-explicitly
title: Overturn a wrong entry in a durable record explicitly — an unmarked correction leaves two contradictory claims
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 2
---
A memory file, decision ledger, handoff doc, or runbook is only as good as its WORST entry. When you discover that a previously recorded claim was wrong, do not quietly append the truth beside it. Write the correction as a correction: *this record previously claimed {{X}}; that was wrong; here is the evidence; the current answer is {{Y}}.*

The incident: an earlier session recorded a confident causal diagnosis of a recurring wake ("the listener must not be persisting its inbox cursor"). The claim was false — the cursor design was in fact correct, with an in-memory read cursor and an on-disk durable one advanced only after a clean exit — and the real cause was elsewhere entirely. The wrong claim had been written with exactly the same confidence as the verified facts around it, so a later session inherited it and spent a full cycle overturning it.

**Why:** Durable records are read by people and agents who were not there. They have no way to weigh entries against each other, so two contradictory claims in one file is not "one right and one wrong" — it is a file that cannot be used. Appending the truth without marking the falsehood preserves the ambiguity indefinitely, and confidence in the original phrasing makes the stale entry look like the newer one.

**How to apply:**
- Name the superseded claim verbatim enough to be recognized, say it was wrong, and give the evidence that settled it. Do not delete it silently either — the next reader may have acted on it and needs to know.
- Date both the original and the correction. A record whose entries cannot be ordered cannot be corrected.
- If the wrong claim was a *guess* recorded as a *fact*, say that too — the durable fix is usually "this was inferred from the payload; the dispatcher's own log settles it in one read" ([[identify-which-target-woke-you]]).
- Same discipline as [[record-intentional-absence]] (write down deliberate removals where the next session looks) and [[docs-living-or-historical]] (a living doc is maintained, a historical record is not retro-edited — corrections to a living record belong IN it).

**Second case — a RIGHT conclusion resting on a WRONG reason still needs a retraction.** A decision entry argued for keeping a second safety check, citing two code paths that supposedly produced the unsafe state. A reviewer disproved both by execution: neither path could produce it. The check was still correct to keep — for a different reason entirely — so nothing in the code changed, and it would have been easy to leave the record alone.

Leaving it alone is the failure. **The reason is what the next person reasons from** when deciding whether the rule still applies; a discredited justification gets re-derived, found wanting, and the safeguard is dropped as pointless ([[under-a-denylist-deploy-order-is-a-security-property]]). Retract the reason explicitly, state the correct one, and propagate the correction to every place the old reason was copied — the code comment, the spec, the tracking item — in the same pass.
