---
id: make-test-isolation-structural-not-empirical
title: "No test depends on the real home or shared state" must be enforced by the harness, not held by luck
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A requirement that no test outcome may depend on the operator's home directory held only empirically: several product files called `os.homedir()` directly, so one new test could reach the real config. Separately, a test that ran a real hook against a throwaway repo did not redirect the machine-global ledger the hook writes to. Other sessions on the box read and wrote that ledger concurrently, so the test could read and WRITE state they depend on.

**How to apply:**
- The test harness sets HOME and USERPROFILE to a per-run sandbox for itself AND its child processes, so even direct `homedir()` calls land there.
- Add a guard test that fails the offending file when anything touches the real home (and sweeps stale sandboxes).
- Give every machine-global path (ledger, cache, lock, state dir) an environment override, set it to a temp path in the runner, and make the runner REFUSE a test's attempt to override it back.
- Run scripts under test from the sandbox, not the real tree.

Related: [[an-inherited-env-var-beats-the-child-cwd]], [[neutralize-ambient-env-in-negative-tests]], [[never-test-in-a-live-deployment-tree]].
