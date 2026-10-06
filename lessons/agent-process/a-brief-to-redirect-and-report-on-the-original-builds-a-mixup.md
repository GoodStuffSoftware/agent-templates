---
id: a-brief-to-redirect-and-report-on-the-original-builds-a-mixup
title: A brief that says "isolate this path, and report on the real one" builds an undetectable mix-up — ask for both values
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A lead briefed a subagent to point a shared-state environment variable at a scratch file for safety, and separately to report that shared file's record count before and after. The agent reported **1 entry** in a file that actually held **470**. It had read its own scratch file and named the real path. The claim reached the lead as catastrophic truncation of shared state on a machine where a dozen sessions depended on that file.

**Why it beat every check:** the number was specific, the quoted path was correct, the agent had genuinely performed the isolation it claimed, and the finding was exactly what you want escalated loudly. Nothing was incoherent. Alarm is what shortcuts verification, so the most alarming reports are the ones most likely to be relayed unverified.

**The brief caused it.** Asking one agent to *redirect* a path and to *report on the original* puts two paths in its head under one name in its output.

**How to apply:**
- **Ask for BOTH values explicitly** — "the real file's count and your scratch file's count" — so a mix-up surfaces as two numbers that disagree rather than one number that is simply wrong. A single figure with a path attached is unfalsifiable from outside.
- **Lead-side: verify an alarming claim at the named location yourself** before acting on it or passing it upstream. Here it was one command; relaying it would have sent an operator chasing a data-loss incident that never happened.
- **Same family, different tools:** a test runner's result laundered by `| tail -n` so the pipeline reported the filter's exit status ([[exit-code-void-when-output-stream-closes]]); a deploy exit code that said nothing about whether the deployed thing was live. In all three the success channel and the claimed outcome were never connected. Ask what specifically would have had to fail for this signal to look bad, and whether that thing was even in the chain you measured.

Related: [[an-inherited-env-var-beats-the-child-cwd]], [[verify-at-destination-prove-the-target]].
