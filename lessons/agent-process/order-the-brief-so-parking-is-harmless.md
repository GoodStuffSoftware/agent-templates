---
id: order-the-brief-so-parking-is-harmless
title: Order a worker's brief push-first, verify-second — telling it not to park does not work
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
Four times in one day, workers did correct work and stopped one step short of delivering it: a fix left uncommitted behind a lint false positive; a test run started on a branch with no diff; five correct fixes committed but never pushed; a fix applied and then abandoned while the agent waited for a background notification. Every brief already said **PUSH EARLY** and **deliver RESULTS, not a promise of results**, in bold, at the top.

The common factor was not disobedience. Every brief was ordered *make the change, verify, commit, push*, and verification was the long step. **A long final step invites backgrounding, and a backgrounded final step ends the turn holding the deliverable.**

**The kernel: brief ORDERING beats brief EXHORTATION.** When an instruction fights the natural shape of the step you asked for last, the shape wins — and adding emphasis to the same ordering produces the same outcome.

**How to apply — sequence every builder brief as:**
1. Make the change.
2. **Commit and push immediately**, before any long verification. Record the resulting revision id.
3. THEN run the expensive verification.
4. If it fails, amend or add a commit and push again.

Pushing a branch is not landing it. It is free, reversible, and — critically — readable by someone else if the worker dies, which is a live risk ([[background-agents-die-with-their-host]]). An unpushed correct fix is indistinguishable from no fix.

**Corollary for the verification step:** name the failure mode explicitly and forbid retry-until-clean — *report the REAL number; if it fails again, paste the failure; do not round up and do not re-run until you get a clean result*. A worker that silently re-runs a flaky verification until it passes has destroyed the evidence you commissioned it to gather ([[capture-gate-output-in-full]]).

**Corollary for the orchestrator:** a worker reporting that something is running in the background and it will report when finished has parked, not progressed. Re-brief it immediately with the remaining steps — a direct message is both the probe and the cure. Do not re-send the same ordering with more emphasis and expect a different result ([[recovery-from-silent-teammates]]).

Related: [[write-target-in-initial-brief]], [[first-action-read-only]].
