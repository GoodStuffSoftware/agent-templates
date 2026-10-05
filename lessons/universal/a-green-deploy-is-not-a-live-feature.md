---
id: a-green-deploy-is-not-a-live-feature
title: A green deploy is not a live feature — confirm by reading the deployed artifact or a runtime signal, never an exit code
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
In one codebase, three separate incidents had a deploy report success while the deployed thing was dark. A conditionally declared secret was never bound because module scope was evaluated before configuration loaded; the runtime still received the config, so the feature ran unprotected and every payment verification failed. A deploy wrapper reported a hard refusal as a timeout or a possible success. A scheduled job's deploy exited 0 while nothing proved it would ever fire.

**How to apply:**
- **Confirmation means reading the DEPLOYED ARTIFACT or a runtime signal:** the live revision, a version poll armed *before* the deploy fired, a heartbeat record, the endpoint actually answering. Never an exit code, and never "no errors in the log" — runs that predate per-step capture retain no stdout, so "no error" can mean "no logs".
- **Treat an ambiguous deploy result as a failure.** A tool that calls a hard failure maybe-fine is worse than the failure.
- **Keep declarations that gate deploy-time validation unconditional.** A required value that must exist everywhere is a cheap, loud problem; one silently skipped by a flag undefined at scan time is an expensive, quiet one. Where a dependency is genuinely inert in some environment, a placeholder satisfies the existence check — verify by tracing the validation call chain, since existence checks and value reads are usually different code paths.

Related: [[verify-at-destination-prove-the-target]], [[post-deploy-checks-need-their-own-harness]], [[a-scheduled-job-needs-a-registered-but-unobserved-state]], [[agreement-between-agents-who-share-a-method-is-one-observation]].
