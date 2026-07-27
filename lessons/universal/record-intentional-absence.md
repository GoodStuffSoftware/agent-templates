---
id: record-intentional-absence
title: Record a deliberate removal where the next session will look, or someone restores it as a fix
scope: [universal]
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 1
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
