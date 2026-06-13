---
id: peer-to-peer-review-routing
title: Writers and reviewers communicate directly; the lead receives only a one-line rolled-up verdict
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
In a writer-reviewer pair, the reviewer messages the writer directly with the full verdict. The orchestrator/lead receives only a single-line rolled-up message ("batch X ready to commit" or "batch X blocked: <one-liner>"). The full review report goes to a file; neither the writer nor the lead reads multi-paragraph review output inline.

**Why:** Every message routed through the lead adds to their context window. In long sessions, the lead's context fills more from teammates' verbose reports than from actual decision-making. A reviewer's full checklist dump into the lead's chat is expensive noise. The lead only needs the verdict; the writer needs the details; peer-to-peer routing puts the right content in the right stream.

**How to apply:**
- Review verdict goes to a file. The reviewer messages the writer a pointer + verdict; separately messages the lead a pointer + rolled-up verdict.
- The lead acknowledges the rolled-up verdict without reading the file unless there is a blocker that requires orchestrator escalation.
- Writer addresses blockers in response to the reviewer's message — no lead relay needed for nits.
- Pairs with [[reports-to-files-long-session]] (the file-not-chat discipline this routing depends on).
