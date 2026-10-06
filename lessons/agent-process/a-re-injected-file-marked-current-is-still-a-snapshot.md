---
id: a-re-injected-file-marked-current-is-still-a-snapshot
title: A re-read file marked "current" is still a snapshot, and says so nowhere — report when your copy arrived
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Harnesses that re-inject instruction or memory files mid-run commonly label them as refreshed — "these have been re-read; each replaces its earlier copy". That framing reads as currency. It is not: it is a snapshot as of the moment of the read, and nothing in it distinguishes "this is the file now" from "this was the file when I looked".

Measured: an agent was handed a re-injected memory index explicitly marked as re-read, containing a line that had been corrected shortly afterwards. It raised a live alarm about stale information propagating, on the strength of a document labelled current. The alarm was the right instinct; the agent had no signal available to catch that its refreshed copy was already behind. This is worse than an ordinary stale context, because the refresh label actively suppresses the doubt that would prompt a live check.

**How to apply:**
- **Treat any injected file copy as read-at-a-timestamp, not as state.** When flagging something from one, say when your copy arrived, or ask a party who can read live to confirm.
- **When receiving such a flag, re-read the source before acting** — the flag is evidence that something was true once, not that it is true now.
- **Readers and writers need different protocols:** the reader reports, the writer verifies, and the writer never takes the reader's copy as the current state.

Related: [[a-checkout-is-not-the-running-system]], [[verify-a-citation-before-it-becomes-an-assumption]].
