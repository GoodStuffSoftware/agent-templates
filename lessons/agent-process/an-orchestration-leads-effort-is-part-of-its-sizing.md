---
id: an-orchestration-leads-effort-is-part-of-its-sizing
title: An orchestration lead's EFFORT is part of its sizing, and it drifts silently — check it at start and after every resume
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Lead-sizing rules usually name the MODEL ("use the strong model for multi-agent orchestration") and say nothing about the effort or reasoning level the lead runs at. Measured: a lead on the right model ran a long multi-release orchestration (a dozen workers and reviewers across several releases) at a lower effort than the doctrine intended, and the operator had to catch it. Nothing in the session flagged it. The lead never looked, because no rule told it to, and its output looked normal enough that the gap surfaced only as thinner judgement calls.

**Why it drifts:** effort is a session setting, not a property of the model choice, and a resume or a compaction can land a session in a different configuration than it started in. A setting nobody reads is a setting nobody notices changing.

**How to apply:**
- **Treat lead effort as a checked setting, not an assumed one.** At session start, and again after any resume or compaction, have the lead read its own session metadata and compare the effort to the doctrine. For an orchestration lead that is the high end of the scale.
- **If it is lower, the lead says so in one line and asks the operator to raise it.** It must not change the setting itself and must not carry on silently at the lower level. In an unattended run there is nobody to ask: continue, and state the effort once in the output.
- **Enforce this as a session-start injected rule**, not a line in a long guide: a document rule is read once and forgotten ([[re-inject-a-standing-rule-from-a-hook]]).
- Sibling of [[an-omitted-worker-tier-inherits-the-leads]]: that lesson audits the defaults workers inherit from the lead; this one audits the lead's own configuration.
