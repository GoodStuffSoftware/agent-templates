---
id: outcome-level-reporting
title: Report to the user at outcome level — what happened, what's next, what needs them — with detail in files
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Default every user-facing update to three slots: **what happened, what's next, what needs the user.** Suppress troubleshooting narratives, resolved dead-ends, and debugging detail — they spend the user's attention and bury the ask. Exactly two exception classes earn an explicit flag inside an update:

1. **"Want your take"** — you made (or face) a call you'd like the user's judgment on.
2. **"Worth your attention"** — something the user should know: a risk taken, cost implications, a recurring hazard, a change to how their tools behave, a decision logged to the ledger.

Everything below outcome level lives in files — teammate reports, the decision ledger, handoff docs — reachable on demand, never pushed into the conversation.

**Why:** The user's attention is the scarcest resource in the system — scarcer than tokens. An update padded with the story of a resolved dead-end reads as noise and hides the one line that actually needed a human. The two flag classes exist because pure outcome-reporting over-corrects: silently absorbing risks, costs, or tool-behavior changes deprives the user of oversight they'd want. And naming exactly two classes keeps the flag meaningful — if everything is flagged, nothing is. This is the user-facing twin of [[teammate-reports-to-files]]: that lesson protects the lead's context from teammate detail; this one protects the user's attention from the lead's detail.

**How to apply:**
- Template each update: what happened / what's next / what needs you (omit empty slots).
- Prefix the exceptions explicitly: "worth your attention: …" / "want your take: …".
- Route detail to its durable home instead of the conversation: reports → files ([[teammate-reports-to-files]]); decisions → the ledger ([[no-stall-decision-protocol]]); in-progress state → the handoff doc ([[handoff-doc-live-state]]).
