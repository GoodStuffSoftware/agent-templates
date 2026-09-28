---
id: a-crashing-check-reads-as-a-clean-pass
title: A check that cannot fail is not a check — a crashing command can read as a clean pass
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A boundary test was written as `grep -qiF "$needle" file && fail`. On the shell in question, that particular `grep` flag combination aborts (SIGABRT) instead of returning 0 or 1, while `-i` and `-F` each work fine alone. The abort is neither a match (exit 0) nor a non-match (exit 1), so the `&&` never fires and the surrounding harness saw an ordinary non-zero exit — indistinguishable, to anything checking only "did the check step fail," from the needle simply not being present. Every run reported a clean pass, for every needle, because the checker itself was dying.

**Why:** a pass/fail gate is usually built assuming exactly two outcomes, but a command can exit through a third door — crash, signal, timeout — that most callers fold into "did not match" rather than "did not run." This is a sharper case of [[did-not-run-is-a-third-outcome]]: there the missing state is a skipped step, here it is a step that started, died mid-execution, and left an exit code that reads as benign.

**How to apply:**
- Before trusting a check that is SUPPOSED to find nothing, feed it something you know is present and watch it fire. A zero result means nothing until the detector has been demonstrated positive at least once ([[assert-the-guard-saw-something]] — same principle, applied to exit codes instead of empty inputs).
- Prefer exit codes you have seen both ways over a silent green: run the check once against a known-bad fixture and once against a known-good one, and confirm the two runs actually produce different exit codes rather than the same one for different reasons.
- Don't assume a flag combination that works in isolation still works combined — test the exact invocation the gate will run, on the exact shell/binary version the gate will run it on, not a simplified stand-in.
- When a gate wraps a command in `&&`/`||` or a pipeline, check what a crash or signal does to that specific chain — a non-zero-but-unexpected exit code does not always route where the author assumed.

Related: [[did-not-run-is-a-third-outcome]], [[assert-the-guard-saw-something]], [[exit-code-void-when-output-stream-closes]].
