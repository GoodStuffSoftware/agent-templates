---
id: shutdown-after-verified-not-after-committed
title: Never shut down a teammate whose output hasn't been verified working at runtime
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Lint passing and a commit landing is necessary but NOT sufficient to shut down a teammate. A teammate is only safe to shut down after their output has been verified working: the build passes, the relevant feature has been confirmed working in the runtime environment (browser, device, test suite), and no follow-up task is pending from their output.

**Why:** A commit can have runtime bugs that only show in the browser or on the device — it passes lint and typecheck but breaks something visible. Shutting down the teammate before runtime verification means the agent with the full context of the change is gone when the bug surfaces. The orchestrator then has to re-derive what was built and why, or spawn a fresh debugger with less context than the original agent had.

**How to apply:**
- Treat the Definition of Done for any teammate as: committed AND runtime-verified (browser check, device check, or automated test run). Not just committed.
- The orchestrator should not issue a shutdown request until runtime verification is confirmed (either from the reviewer's sign-off or from a direct user confirmation).
- "Reviewer signed off on the diff" is still not runtime verification — the reviewer checks correctness; runtime verification checks behavior.
