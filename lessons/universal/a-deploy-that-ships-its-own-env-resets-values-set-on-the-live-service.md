---
id: a-deploy-that-ships-its-own-env-resets-values-set-on-the-live-service
title: A deploy that ships its own env copy resets any value set directly on the live service — read live values back after every deploy
scope: [universal]
requires: {}
status: active
since: 2026-10-26
provenance: [contrib-2]
corroborated: 1
---
A deploy that bundles its own copy of the environment (a stale file on the build host) replaces the service's environment with it. Anything set directly on the live service, such as a flag enabled by a console command, vanishes on the next deploy. The deploy is green; the symptom arrives later.

**How to apply:**
- Keep every production value (secrets via the secret store) in the source the deploy reads. A value that lives only on the live service is a debt due at the next deploy.
- If one must be set out of band, list it in the release checklist as a post-deploy read-back, and re-apply it.
- Fix the stale copy at its origin instead of re-applying forever.

**Incident:** a billing flag set by console command and an alert address were dropped by successive deploys that shipped a stale env file.

Related: [[a-green-deploy-is-not-a-live-feature]], [[migrated-config-carries-source-host-env]].
