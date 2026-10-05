---
id: exit-code-void-when-output-stream-closes
title: A long command's exit code carries no information once something closed its output stream — verify the effect, not the summary
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 2
---
Pipe a long-running command into a consumer that stops reading early, and the command dies of a broken pipe *after* its work looks finished. The console shows a green summary; the effect never happened.

The concrete shape: a push whose pre-push gate runs a full test suite for 12–25 minutes. The gate runs to GREEN and prints its success summary. Then the transfer step writes to a pipe the consumer closed long ago, and the process dies on a broken pipe. **The gate passed. The ref never moved.** Because the visible output ends with a green gate, it reads as a successful push.

**It is broader than piping.** The same failure was observed with stdout and stderr redirected to separate files and no pipe anywhere, when the command was launched as a *background task* — the stream was closed by the harness's background wrapper, not by any consumer the author wrote. Observed three times in two days across three different actors.

**The durable rule: on a long command, the exit code carries no information.**

1. Never treat a broken-pipe exit as failure, and never treat exit 0 as success.
2. **ALWAYS verify the effect at the destination.** For a push: compare `git ls-remote --heads origin {{BRANCH}}` against `git rev-parse HEAD` — identical or it did not push. For anything else, ask the destination what it now holds ([[verify-at-destination-prove-the-target]]).
3. **If the gate went green but the effect did not land, just do it again.** A gate that caches its result by tree hash will skip the whole suite on the retry and finish in seconds. Do not re-run the suite, do not investigate.

**Why it bites the runs that matter most:** a short command never triggers it — the consumer has not had time to leave. Only the long ones, the ones behind an expensive gate, run long enough for the stream to be gone by the time the real work is written.

**How to apply:**
- Redirect long commands to a FILE and read the file afterwards; never pipe them through a filter that takes only the first or last N lines.
- Treat "the summary said it worked" as a claim about the *gate*, never about the *outcome*.
- Related: [[green-means-not-broken]], [[match-instrument-to-failure-class]].

**Two more shapes of the same gap, both observed on real pushes.**

**(i) A green gate plus a plausible exit code are BOTH insufficient — twice, on the same branch.** A push exited 141 (SIGPIPE) with the pre-push gate already GREEN and a "recorded green pass" log line already written, while the remote reference had NOT moved. It happened twice in a row on the same branch, and each time the log looked identical to a real success: gate green, exit code present, summary line printed. A green gate is evidence the CODE is fine; it is not evidence the PUSH happened, because the gate and the transfer are two different operations that can succeed and fail independently. **How to apply:** every brief that asks a worker to push must require the remote reference and the local reference to be reported SIDE BY SIDE with an explicit MATCH / DOES NOT MATCH verdict — "pushed, exit 0" or "gate passed" is not evidence on its own. Generalize this beyond git: an acceptance status from an ingest endpoint means the payload was accepted for processing, not that the record now exists — check the record, not the response code.

**(iii) The same green-gate-plus-unmoved-ref symptom has at least THREE independent causes, and they need different diagnoses.** A controlled comparison isolated one: the same command, run foreground inside a tool call with a 10-minute ceiling, died with no pass/fail banner at all; the identical command run backgrounded so no ceiling applied completed cleanly. That looked like it explained everything — until a second case, also backgrounded so the ceiling could not apply, had its gate complete and print a full green result and THEN the transfer died with an explicit "connection closed by remote host" message. Both are real, they are not the same mechanism, and a fix aimed at only one leaves the other live.

**The diagnostic tell: did the gate print its RESULT before the failure?** Result printed, then the transfer failed — that's the remote hanging up during a long-running hook, and it happens even when nothing local is holding a timer over the command. Cut off mid-run with no result banner at all — that's your own harness or tool-call ceiling killing the process mid-hook, before the gate ever got to report anything. The two produce visually similar dead ends but point at opposite places to fix.

**Nothing about the remedy changes with the diagnosis, which is why it survived being wrong about the cause at first.** Decouple the slow gate from the push itself: run the gate on its own, backgrounded, with nothing holding a foreground ceiling over it; confirm the tree is clean and sitting on the exact commit that was tested (a short-circuit cache is typically keyed on tree hash, and one stray untracked file or the wrong HEAD silently forces a full, over-long re-run); then push, so the hook short-circuits on the already-recorded pass and the transfer itself is fast enough that neither mechanism has room to bite. That defeats both causes at once without needing to tell them apart in advance — the diagnostic tell above is for understanding what happened after the fact, not for choosing the fix.

**(ii) On Windows, a successful script can crash AFTER printing all its real output.** A Node script doing network I/O can complete its work, print its full successful output, and then crash during event-loop teardown in a race that is specific to how Windows tears down open handles — yielding a garbage or negative exit code that has nothing to do with whether the work succeeded. A caller that gates purely on the exit code treats a genuine success as a hard failure and either retries destructively or reports a false regression. **How to apply:** for scripts with this shape on Windows, parse the verdict out of stdout (a final success marker, a summary line) rather than trusting the process exit code alone; treat a non-zero exit accompanied by a complete, coherent success log as a teardown artifact to investigate, not as proof of failure.

**Second observation, the disputed push (corroborated):** a coordinator doubted a "pushed" claim that had been made after a green gate, with no destination check on record. The claim was settled in one command by comparing the remote head with the local head, and was in fact true. The cheap destination check is also the way to *defend* a true claim; make it before reporting, so a later doubt costs nothing.
