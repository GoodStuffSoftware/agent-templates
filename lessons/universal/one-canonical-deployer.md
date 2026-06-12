---
id: one-canonical-deployer
title: Exactly one mechanism may deploy production
scope: [universal, stack:ci]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
Production must have exactly one deploy mechanism. A second, redundant deployer (a leftover CI workflow, a manual script someone still runs, a platform's built-in auto-build running *alongside* your own pipeline) is not a harmless backup — it is a liability.

**Why:** A redundant deployer fails silently or races the real one. It generates noise (duplicate builds, conflicting statuses) and — worse — misleads diagnosis: you debug the deploy you *think* shipped while a different mechanism actually shipped the bytes. Time is lost chasing the wrong pipeline.

**How to apply:**
- Before touching any deploy config, verify which mechanism ACTUALLY ships production right now — don't assume it's the one in the file you're editing.
- If two mechanisms can deploy, disable or delete one so exactly one remains canonical.
- Document the single canonical deployer in the deploy doc so the next person doesn't re-add a "backup."
