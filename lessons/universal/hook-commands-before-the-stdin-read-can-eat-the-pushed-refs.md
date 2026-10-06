---
id: hook-commands-before-the-stdin-read-can-eat-the-pushed-refs
title: A hook's early commands inherit the pushed-ref pipe — a drained stdin silently skips the whole gate
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A pre-push hook receives the pushed refs on its standard input, and it can be read only once. The hook ran two test-runner commands BEFORE the line that captured stdin. Both inherited the hook's pipe. Any runner, reporter, spawned child or prompt in those chains that reads stdin empties it, and the hook then sees "no refs", takes its "nothing to gate" early exit, and silently skips the whole test gate: a clean exit 0, no message, nothing in the output to suggest a gate was skipped. It is the worst fail-open shape because it leaves no trace, and it fires only when a child happens to read stdin, so it passes in every manual trial.

**Why it misleads:** the capture line looks like the first thing the hook does and the commands above it look like harmless preflight. Stdin is an inherited, consumable resource, not a parameter.

**How to apply:**
- **Capture stdin into a variable as the very first executable line**, or redirect every command above the capture from the null device.
- **Audit each line above the capture.** Shell options and env exports consume nothing; any external command must be redirected.
- **Add two tests:** a behavioural one (a stub that drains stdin must still leave the hook able to see the refs and reach the gate) and a structural one that walks every executable line above the capture and fails unless it consumes no stdin by construction or carries an explicit redirect, so a later addition cannot reintroduce the bypass.
- **Prove the test catches it** by running against the pre-fix hook (empty trace, gate never invoked) ([[assert-the-guard-saw-something]]).

Related: [[a-silent-guard-needs-a-canary]], [[an-inherited-env-var-beats-the-child-cwd]].
