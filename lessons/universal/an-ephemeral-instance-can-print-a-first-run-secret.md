---
id: an-ephemeral-instance-can-print-a-first-run-secret
title: A fresh service instance can print a first-run credential at boot — never let an agent read its stdout
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
Services with fail-closed first-run provisioning — no credential file, so generate one and PRINT it once — leak that credential into an agent's tool output the moment the agent boots a throwaway instance for a measurement or a smoke test and reads its stdout. It also fires when the boot FAILS *after* the print: a missing build artifact did exactly that, producing four throwaway instances and four tokens in one transcript. Two agents hit it in one day on the same project.

**In every brief that boots an ephemeral instance:**

1. **Satisfy every boot precondition first** — build the artifact the server asserts on — so the boot cannot fail-after-print.
2. **Start the instance with stdout and stderr redirected to a file.**
3. **Never dump that file.** Grep it ONLY for the readiness line or the bound port ([[verify-actual-bound-url]]).
4. **If a credential is printed anyway:** kill that instance by its real process id (not the wrapper), delete its data directory so the printed value has no backing store, and report it as an incident rather than treating it as fine.

Put the rule in the shared brief-rules file so every spawn inherits it — this is not a thing to remember per task.

**Why it keeps happening:** the credential print is a *correct* behaviour of a well-designed service (print once, never again), and the agent's read is a *correct* debugging instinct. Neither side is wrong on its own; the combination is the leak. Treat "I will just check what the server printed" as the dangerous step.

Related: [[credentials-never-reach-an-error-path]], [[persist-the-secret-before-the-artifact]], [[never-test-in-a-live-deployment-tree]].
