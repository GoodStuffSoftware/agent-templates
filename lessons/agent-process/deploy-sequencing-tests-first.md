---
id: deploy-sequencing-tests-first
title: Run the test suite to completion before deploying — never in parallel
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
Tests and deploys must run in serial, not parallel. Complete the full test suite (and confirm it passes) before any deploy teammate is spawned or any deploy command is issued.

**Why:** A deploy teammate running in parallel with tests can ship a build before the suite has a chance to catch a regression. The deploy lands in production; the test results arrive afterward. If they fail, the broken build is already live with no clean rollback signal — recovering from a broken deploy is far more expensive than a serial pipeline.

**How to apply:**
- In multi-teammate sessions, do NOT put a deploy agent and a test agent in the same parallel batch. Tests finish first; their exit code gates the deploy brief.
- The orchestrator is the enforcement point — the deploy brief must not be sent until the reviewer/tester's sign-off message arrives.
- One-shot scripted pipelines are fine as long as they execute tests before deploy steps in the same chain.
