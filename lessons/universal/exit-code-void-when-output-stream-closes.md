---
id: exit-code-void-when-output-stream-closes
title: A long command's exit code carries no information once something closed its output stream — verify the effect, not the summary
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
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
