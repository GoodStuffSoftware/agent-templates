---
id: capture-gate-output-in-full
title: Capture a gate's output in full — a pipeline truncation destroys the evidence and lies about the exit code
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
A gate ran a unit suite as `{{RUNNER}} 2>&1 | tail -6`. The run reported two failed test FILES, but the tail window kept only the summary and discarded the FAIL lines, so the failing files could never be named. Worse, the failure set turned out to be non-deterministic under load, so re-running could not recover them — the evidence was gone permanently. A second defect rode along: in a pipeline the shell reports the LAST command's status, so the recorded exit code was the truncator's zero and the gate looked like it passed.

**Capture the complete output to a file and read the file:**

```bash
{{RUNNER}} > "{{OUT}}" 2>&1; status=$?
grep -nE 'FAIL|Error|failed' "{{OUT}}" | head -40
```

Two distinct failures come from piping a gate into a truncator:

1. **The evidence is destroyed.** Failure detail is emitted *before* the summary, so a tail window sized to catch the summary discards exactly the part naming what broke. When the failure is non-deterministic, re-running does not recover it.
2. **The exit code is wrong.** A failing run piped into a succeeding `tail`, `head`, or `grep` looks like success. Capture the status from the runner directly, or enable the shell's pipeline-failure option where it exists.

Truncate only when *displaying* something you have already stored. The stored artifact is the source of truth; the terminal view is a convenience.

**Corollary for flaky suites:** when a failure will not reproduce, the run that captured it was your only sample. Full-output capture is a precondition for investigating flakiness at all, not something to add once a flake appears ([[a-default-timeout-shorter-than-cold-start-manufactures-flakes]]).

Related: [[exit-code-void-when-output-stream-closes]], [[did-not-run-is-a-third-outcome]], [[assert-the-guard-saw-something]].
