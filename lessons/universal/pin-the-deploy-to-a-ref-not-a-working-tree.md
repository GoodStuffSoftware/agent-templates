---
id: pin-the-deploy-to-a-ref-not-a-working-tree
title: A deploy that builds a shared machine's working tree ships whatever is checked out there
scope: [universal, stack:ci]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A deploy path that builds from a shared build machine's current working tree has no way to know what the caller intended — it ships whatever branch that machine happens to be sitting on at the moment the build runs, regardless of what the caller asked for.

The incident: a deploy orchestration tool offered two production targets. The version-pinned target checks a named reference out into an isolated, throwaway location and builds THAT — it cannot ship the wrong thing because it never touches anything the caller didn't specify. The "plain" target instead builds the CURRENT WORKING TREE of the shared build machine. Worse, the plain target was documented as requiring an explicit confirmation flag before it would run, and did not actually enforce that requirement: a request sent without the flag was accepted anyway and started a real production deploy of unrelated code that happened to be checked out at the time.

**Why:** a working-tree build looks identical to a ref-pinned build from the outside — same command shape, same success output — but its input is ambient state (whatever the last person or process left checked out) rather than a value the caller controls. Combined with an unenforced safety flag, the failure mode compounds: neither the caller's intent nor the documented gate is actually load-bearing.

**How to apply:**
- Require a version- or ref-pinned deploy path for anything production-facing, and treat a working-tree build as a development-only mode that never runs against a real target.
- Never trust that a documented safety flag is enforced just because it is documented — send one request without it, in a safe environment, and observe what actually happens ([[unenforced-absence-invariant]]).
- Verify the outcome by reading the actually-deployed artifact or version from the live system afterward, never by trusting the response status of the deploy call itself ([[verify-at-destination-prove-the-target]]).
- Related: a deployment directory that is also a checkout is production, not a workspace ([[never-test-in-a-live-deployment-tree]]), and exactly one mechanism may deploy production ([[one-canonical-deployer]]).
