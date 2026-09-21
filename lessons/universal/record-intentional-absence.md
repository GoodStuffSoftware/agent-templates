---
id: record-intentional-absence
title: Record a deliberate removal where the next session will look, or someone restores it as a fix
scope: [universal]
requires: {}
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 3
---
When you deliberately take something out of a standing set — a service out of a process manager's autostart list, a job out of a scheduler, a check out of a pipeline, an entry out of a config — the only trace the decision leaves behind is an absence. And an absence is indistinguishable from breakage. The next session investigating that surface sees a gap where the other entries are, reads it as drift, and restores it. A considered decision is silently reverted by someone doing what looks like maintenance.

Pair every deliberate removal with a durable note that (a) states the absence is intentional, (b) says what to do instead, and (c) says how to reverse it. Put it where a session investigating *that surface* will actually read it — the project's operational notes or agent-facing memory — not only in a commit message and not only in a decision ledger, which is a review queue nobody consults while debugging.

**Why:** Additions announce themselves; removals do not. Every other mechanism you might rely on is the wrong shape: a commit message is findable only if you already suspect a change was made, a ledger entry is read at review time rather than at investigation time, and the diff is buried under everything since. Meanwhile the cost of the silent revert is higher than the original decision — the thing comes back, the reason it was removed still applies, and nobody knows to look for the note that was never written.

**How to apply:**
- Write the note in the same change as the removal. What was removed, from which set, why, how to invoke it on demand if it still exists, and the exact reversal.
- Phrase it as an anti-regression instruction, in those words: "if you find `{{THING}}` missing from `{{STANDING_SET}}`, that is intentional — do not re-add it as a fix."
- Keep a reversible snapshot of the mutated state (`{{STATE_FILE}}.bak-{{YYYY-MM-DD}}-pre-{{REASON}}`) and name it in the note, so reversing is a copy rather than a reconstruction.
- Enumerate what deliberately **stays**, not just what went. A partial teardown is where the next session guesses wrong in the other direction and removes something load-bearing.
- Also log the decision in the ledger for review ([[no-stall-decision-protocol]]) — but treat that as the review trail, not as the place the discovery happens.

**The same rule applies to DATA, and there it has a second payoff.** A backfill stamping a new field found a handful of records whose upstream source no longer exists. Deleting them as residue was rejected — deletion is irreversible, it was outside the scope of a stamp-a-field change, and it would have stranded their dependent records in other collections. Instead each got an explicit **sentinel** value meaning "the backfill looked and there is no source", with the real cleanup carded separately. Beyond honesty, the sentinel earns its place mechanically: a typed null drops those rows out of range queries over the field automatically, where a missing field or a fabricated default would have quietly polluted every later aggregate. Choose the sentinel so that the *absence* is representable in the field's own type, and say in the schema notes what it means.

**The mirror image is a deliberate ADDITION whose eventual removal looks harmless.** A reliability runbook's most valuable section documented exactly how the fix it described tends to get silently undone. Dropping one flag at its call sites reads, on its own, like reducing log noise — a tidy-up, not a regression. In fact it zeroed out telemetry for an entire signed-out population, while the surrounding code still visibly "looked like" it was capturing and reporting, and the whole test suite stayed green throughout, because nothing in the suite asserted on the flag's presence, only on the capture path executing without throwing.

The technique that generalises from this case: beside any load-bearing flag or parameter, name the controls that ALREADY bound whatever cost it appears to be causing — a per-fingerprint dedup window, a sampling rate, a rate limit. A future person reaching for a way to cut noise then has a documented, correct target to reach for instead of the flag that's actually load-bearing. The absence-of-a-note problem here is identical to a removal: the flag's necessity is legible only to whoever added it, and everyone after them sees a knob that looks safe to turn off.

**How to apply (continued):**
- Treat a deliberate addition the same as a deliberate removal when it is non-obviously load-bearing: write down, next to it, what happens if someone takes it out, phrased as the anti-regression instruction above.
- When a flag exists to fix a symptom (dropped events, noisy output, excess volume), name the OTHER mechanisms already in place for controlling that symptom, so a future reader who wants less noise has a correct place to make that change instead of removing the flag.
- A green test suite is not evidence a removal was safe if nothing in the suite exercises the population the removed thing was protecting — for a flag gating capture of a signed-out or otherwise hard-to-instrument population, add a test that would fail if the flag were removed, not just one that passes with it present.

Related: [[a-queue-gated-on-identity-cannot-record-identity-failures]].
