---
id: relocate-a-gate-that-cannot-run-here
title: A gate that structurally cannot run on this host is not a gate — relocate it and name the enforcing one
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
Two incidents, one shape.

**Retrying an impossible gate.** A merge required a full end-to-end suite. The developer machine was memory-starved and could not boot the emulators the suite needs. Three local retries burned about an hour before anyone used the path that always existed: the merge tool runs the same suite fail-closed on a capable host, and landed it green on the first attempt.

**Pretending an impossible gate passed.** On the same machine, roughly two dozen of that project's tests are structurally unpassable — POSIX permission modes, shell-script tests, filesystem scans that assume another platform. The local runs had been reported green for weeks. They were false: a pipe on the runner's output was swallowing the suite's exit status, so nobody had ever seen the failures ([[exit-code-void-when-output-stream-closes]]).

**Why:** a gate that cannot run here has only three outcomes, and two of them are damage. Retrying spends time on a fixed constraint. Bypassing removes the check. Only relocating preserves it — and relocating is the option nobody takes, because the local gate is the one in the muscle memory and the remote one requires knowing it exists.

**How to apply:**
- **Distinguish "failed" from "cannot run here" on the first failure, not the third.** A missing runtime, an unsupported filesystem semantic, or insufficient memory is an environment verdict; treat it as [[did-not-run-is-a-third-outcome]] and stop retrying immediately.
- **Name the ENFORCING gate explicitly, in writing, wherever the local one is relaxed.** "Locally we run lint plus the subset; the full suite is enforced by {{REMOTE_GATE}} and is never bypassed" is a policy. "We skip it locally" is a hole. Record it in the decision log with how to reverse it.
- **Relaxing a local gate is only legitimate when the enforcing gate is provably still in the path.** Verify that, once, before writing the policy — not by assuming the pipeline covers it.
- **Card the platform-specific failures rather than absorbing them.** A named known-environmental set, or a skip-with-reason, converts silent noise back into a signal — and until that lands, the suite's local result carries no information either way ([[assert-the-guard-saw-something]]).
- **Suspect a long-standing local green that nobody has watched run.** Pipes, background wrappers, and summarising filters all detach a suite's real status from what gets printed; re-run it once with output to a file and read the file.
- Related: [[budget-fan-out-against-host-memory]] (the host cause behind many "cannot run here" verdicts) and [[one-canonical-deployer]] (the same single-enforcing-mechanism discipline for shipping).
