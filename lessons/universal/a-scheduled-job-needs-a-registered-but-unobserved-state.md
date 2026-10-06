---
id: a-scheduled-job-needs-a-registered-but-unobserved-state
title: A scheduled job needs a "deployed, unconfirmed" state and a two-timestamp heartbeat, or it gets marked done on deploy day
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Deploying a scheduled job proves the scheduler REGISTERED it. It proves nothing about whether it has ever fired or ever succeeded, and for any cadence longer than a few minutes those facts are separated by a real, possibly multi-day window. A weekly job deployed on a Thursday cannot be confirmed until the following Monday. During that window "succeeded" is a lie and "failed" is also a lie, so a runbook offering only those two will record success — on deploy day, from an exit code. The problem is not only that people misread the signal; **the status vocabulary has no word for the true state.**

**The technique, three parts:**
1. **Make the job write a heartbeat record on every run, including failed ones.** A run that fails and leaves no trace is indistinguishable from a schedule that never fired. Keep two timestamps: `lastRunAt` advancing on every run, `lastOkAt` advancing only on a clean one.
2. **Make that one record readable without credentials** — a narrowly scoped public read on the single record, never the collection, never write — so the confirmation can run from any host (a deploy box, a laptop, CI with no service account). A check needing a credential is the check most likely not to run. Keep identifying data and error text out; publish failing keys or dates and leave messages in the log.
3. **Give the runbook the missing third state by name:** `deployed, unconfirmed`, a real state rather than a soft success. Then:
   - no record at all: the scheduler never fired (registration missing or broken);
   - `lastRunAt` fresh, `lastOkAt` absent or stale: it fires and the work fails (go to the logs);
   - both fresh: confirmed; only now mark done.

**Two traps:**
- **Size the staleness check to the cadence.** Moving a job from daily to weekly while leaving a 48-hour window makes a healthy producer a permanently failing check, and a check that always fails trains everyone to ignore it.
- **A staleness check does not replace first-run confirmation.** Before anything has run there is no record, so a well-built check reports "not applicable"; nothing blocks on a scheduler that never fired. Only the explicit first-run confirmation catches that.

**Why it bit:** the deadline that would have surfaced a dead scheduler was removed by a backfill (coverage extended three months), quietly deleting the forcing function exactly when the confirmation step stopped feeling urgent. Generalises to any cron function, queue consumer, or job whose first execution is later than its deployment.

Related: [[a-green-deploy-is-not-a-live-feature]], [[an-absence-is-evidence-only-if-the-window-could-have-produced-one]], [[heartbeat-over-time-box]].
