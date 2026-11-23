# ADR 0008: post-release watch v2 (human-only replies, evidence floors, release chains, standing health)

**Status:** Proposed (2026-11-22)
**Date:** 2026-11-22
**Owner:** agent-companion plugin (`plugins/agent-companion/`)
**Supersedes in part:** the first release-watch design (shipped in 0.31.63: `scripts/release-watch.mjs`, `hooks/lib/release-watch-state.mjs`).

## Context

The operator's rule: after every plugin release is installed, check for broken workers and token bleed at +1h, +2h,
+4h, +8h, then every 4h to +24h; report a flag at once; if the operator has not replied within 30 minutes, hold (no new
spawns or queue admissions, running workers hand off) until the operator clears it; a release is not finished until the
+24h check is clean. A new requirement: the watch must not only look for a regression in the newest release, because
several releases can land within 24 hours and some windows have too little activity to judge.

The first live watch (0.31.63) showed five defects:

1. **An automated prompt acknowledged the flag.** `noteReply()` treats any lead prompt that is not unattended and does not
   start with a known tag as the operator's reply. A scheduled wake-up prompt in another session (transcript fields:
   `isMeta: true`, `promptSource: "system"`, `turnOrigin: "scheduled"`, `wakeupSource: "schedule_wakeup"`, no `origin`)
   arrived 19 minutes after the flag and stopped the countdown. `userType` is `"external"` on every record, typed or not,
   so it cannot tell them apart.
2. **One event tripped a metric.** One spawn denial in 26 spawns (3.8 per 100) crossed a 3-per-100 limit; six queue
   denials in 26 spawns (23.1) crossed 20, though the 7-day rate of the same event is 6.0 per 100 and all six came from one
   project's workers running `cd <dir> && <install>`.
3. **Harness refusals counted as worker failures.** 20 of the 29 failed worker Bash calls behind an 8.2% failure rate
   were Claude Code's own worktree-isolation refusals ("isolated in the worktree ... too complex to verify"); the real
   failure rate was 9 in 335 (2.7%).
4. **A check with almost no activity reported clean.** The +4h check judged 2 spawns and 2 workers and wrote "clean".
5. **The schedule follows only the newest install.** A second install inside 24 hours replaces the schedule and moves
   the baseline to the 7 days before the new install, which includes the earlier release's hours.

Evidence used for the decisions below: 4 days of lead transcripts on this machine (prompt-record metadata only), the
7-day telemetry before the 0.31.63 install (2,116 spawns, 44,992 worker Bash calls, 127 queue denials), the 0.31.61
worked example (253 spawns in 8.4 h) and the 0.31.62 and 0.31.63 check logs.

## Decision

### 1. Only the operator's typed reply counts

- A reply is identified **positively**: the transcript record of the prompt has `origin.kind === "human"`, and is not
  `isMeta`, `isSidechain` or `isCompactSummary`. In 4 days of lead transcripts, 3,427 typed prompts carried
  `origin.kind: "human"` (with `promptSource: "sdk"`, `turnOrigin: "human"`); no automated kind did: task notifications
  (`origin.kind: "task-notification"`), scheduled tasks (`task-notification`/`scheduled-trigger`), messages from other
  sessions (`origin.kind: "peer"`, `isMeta`), keep-warm and loop wake-ups (no origin, `turnOrigin: "scheduled"`,
  `wakeupSource`), CI-monitor events and host reminders (no origin, `turnOrigin: "sdk" | "host_synthetic" |
  "auto_continuation"`), and SDK/CLI sessions (no origin). A record with no `origin` (older builds) never counts.
- The prompt hook does not decide alone. It writes a **candidate** (session, transcript path, time, a hash of the text);
  the candidate is confirmed by reading that session's transcript for the matching record. Confirmation runs in the
  next hook call of that session and in every tick before the hold decision. If the hook payload itself ever carries
  `origin`, that is used directly. Unconfirmed after 10 minutes: dropped. When unsure, no acknowledgement.
- A reply in **any lead session counts**, provided that session had already been shown the flag line on an earlier
  turn: the operator could have read it. A prompt in a session that never showed the flag is not a reply.
- The flag record keeps `ack = { session, promptAt, confirmedAt, signal, shownAt }`; `signal` names the proof
  (`transcript-origin-human` or `payload-origin-human`). The explicit clear command and the "clear hold" words are unchanged.
- **Notified means shown to a person (0.31.65).** The tick writes the flag with `notifiedAt = null`; the first session
  that shows the flag line (`noteShown`) sets `notifiedAt`, and the hold countdown (`release_watch_hold_minutes`) runs
  from that first showing, never from the tick. Cause: a tick wrote a flag at 17:00Z, the operator's lead sat idle until
  19:55Z, and the countdown had run from the tick, so the hold could fire before any lead had shown the flag. A flag that
  is new or has more than doubled is a new notification and resets `notifiedAt` to null. The flag line states the
  countdown ("Hold countdown: N min left; ... held at <time>").
- **The flag line runs in its own process.** `hooks.json` registers `runaway-notice.mjs` twice on UserPromptSubmit:
  `--watch` (release watch only, timeout 5 s, small state files) and `--no-watch` (budget scan, interrupted-worker scan,
  notice drain; timeout 10 s). The slow scans can reach their timeout on a large session after an idle spell, and a hook
  that times out delivers nothing; with the flag line in the same process, one such prompt lost it. No argument runs both
  (tests, older registrations).
- **Showing a flag is never an answer.** `noteShown` sets `shownTo` and `notifiedAt` and nothing else; only a confirmed
  typed reply (above) or the clear command writes `ackedAt`.

### 2. Evidence floors per metric

Every metric has a minimum event count (numerator) and a minimum denominator. Below the denominator the metric is
**inconclusive**; above it but below the event floor it is **ok**. Release-window floors: 30 spawns for spawn-rate
metrics, 20 worker transcripts for worker-share metrics, 200 worker Bash calls for Bash metrics; event floors 3 to 10
by metric (spec table). Queue denials are judged against max(20, 2x the 7-day rate) per 100 spawns, not a fixed 20.
Floors that differ from the general rule (0.31.65):

| Metric | Denominator floor | Event floor |
|---|---|---|
| `blocked-share` | 20 finished workers | **5 blocked workers** (was 3: three blocked of 39, all brief or environment problems of other projects, started a hold) |
| `no-final-status`, `partial-share` | 30 / 20 finished workers | 5 |
| `harness-refusals` | 200 worker Bash calls | 10 |
| `worker-bash-fail` | 200 worker Bash calls | 10 |

The worker metrics read worker transcripts chosen by file mtime inside the window (newest first, a safety cap of 12000
files above a full busy week; before 0.31.65 the first 2000 in directory order, which dropped about 65% of a week and
whole projects). A worker's STATUS is the latest `STATUS:` line of its assistant text or of its `SubagentHandback`
call (`input.message`), so a report delivered through the handback tool, or given before the worker was woken again,
counts. Agent types off the reporting contract (`Explore`, `Plan`, `web-fetch`, `claude-code-guide`,
`statusline-setup`) and hook-verification probe spawns (brief opens with "Hook verification spawn, not real work")
stay out of `no-final-status`, `partial-share`, `blocked-share`, `worker-bash-fail` and `harness-refusals`; their
counts are named in `workers.excluded` (and in the standing file), never dropped silently. Usage and context metrics
still count every worker.

`runaway` is the one metric with no floor, on purpose: a runaway session is a real fault even once, so a single
`runaway:fired` event in the window flags it.

### 3. Harness refusals are their own metric

Bash tool results that carry Claude Code's worktree-isolation refusal text are counted as `harness-refusals` (per 100
worker Bash calls) and removed from `worker-bash-fail`, which now counts only real non-zero exits (and also excludes
plugin hook denials, already counted by the denial metrics). `harness-refusals` is reported, never holds: it measures
the harness, not the release.

### 4. Release chains

- Releases installed while an earlier one is still under watch form a **chain**. The baseline is the 7 days before the
  **oldest unfinished release** of the chain (`baseAnchor`), fixed when the chain starts, so an earlier bad release
  never becomes the new normal.
- Each check judges the combined change since the previous conclusive check. Metrics are also split per version where
  rows allow (spawn rows carry the plugin version; other rows and worker transcripts are assigned to the newest
  release installed before their time); a per-version value is shown only when it meets its own floors.
- Every release in the chain keeps its own +1h ... +24h schedule; a chain finishes as a whole, when its newest release
  finishes (section 5). Earlier releases show "clean, waiting for the chain" until then.
- An open or pending flag from an earlier release stays open; a new install is not an answer and does not restart or
  stop the countdown. Answered-flag cooldowns are keyed to the chain, not to one install.

### 5. Too little activity is inconclusive

- A check verdict is `flag` (any flag), `clean` (no flag, and spawns, workers and Bash calls all met their floors), or
  `inconclusive`. An inconclusive window rolls into the next check's window.
- A chain finishes only when, at or after its newest release's +24h, the activity since that release meets the finish
  floors (100 spawns, 60 worker transcripts, 600 worker Bash calls, 6 active hours) and the latest check is clean with
  no unanswered open flag. Otherwise the watch extends in 4h steps up to +72h after the newest release, then ends as
  `insufficient-data` and tells the operator once that it could not get enough data. That notice never holds. The notice
  names the real reason (floors not reached, an unanswered flag still open, or the last check not clean); it never blames the
  floors when they were reached.
- An answered flag does not block a finish. A flag the operator answered (a typed reply, section 1) is cleared by the next
  conclusive clean check ("clean after ack"): the release has measured clean since the answer, so the flag closes with
  `clearedReason: clean after ack` and a `flag-cleared` row. An unanswered open flag is never cleared by a clean check; it
  blocks the finish, and a chain that runs to the cap with it still open ends as `insufficient-data` for that reason. A hold,
  if one is on, is lifted only by the operator's clear, never by a clean check.

### 6. Standing health

A daily check that runs whether or not a release is under watch: last 7 days against absolute ceilings, and the 7-day
rate against the 28 days before it (trend factor 1.5, with floors). Example it catches today: queue denials at about 6
per 100 spawns, mostly from workers running `cd X && cmd`. It writes one row, shows one line once per day at session
start, and appears in `status`. It **never** opens a release flag, never starts a hold, never extends a release watch.

### 7. Status output

`status` prints, per check: time, verdict, every metric's value against its limit and baseline, the sample size behind
it, and worker usage as % of the weekly limit (per hour and for the window); plus the chain, the ack record with its
signal, the hold, and the last standing-health result. `status --json` prints the same as JSON.

## Alternatives rejected

- **Classify prompts by text prefix** (today's approach, extended). Rejected: an automated prompt can be plain text, and
  each new automation needs a new pattern; the harness already marks typed prompts.
- **Use `userType`**. Rejected: it is `"external"` for every record.
- **Require the reply in the session that first showed the flag.** Rejected: the operator may answer from another
  session; "shown earlier in that session" keeps the proof that the flag was visible.
- **Statistical tests (Poisson or bootstrap intervals) instead of floors.** Rejected for now: floors are simple to state
  and audit; the usage report already carries bootstrap intervals for slow drift.
- **Restart the schedule and baseline on every install** (today). Rejected: it lets an earlier bad release become the
  baseline and loses the earlier release's remaining checks.
- **Judge each release only on its own exclusive window.** Rejected: after the second install the first release's code
  is no longer observable alone; the per-version split gives the attribution the data allows.
- **Report "clean" with a low-sample note.** Rejected: the operator's rule treats clean as finished.
- **Let standing health hold work.** Rejected: a standing problem is not caused by the release now installed, and a
  hold would stop all work for a known, accepted condition.

## Consequences

- A false acknowledgement by automation can no longer stop the countdown; a real reply is confirmed up to 10 minutes
  late in the worst case (tick cadence), still inside the 30-minute window.
- Fewer false flags at low volume; quiet periods now produce `inconclusive` and longer watches (up to +72h) instead of
  early "clean".
- One more file read per prompt in lead sessions while a flag is open and unanswered (bounded transcript tail).
- Thresholds rest on one machine's week of data; they ship as labelled defaults and are options.
- The run-state file changes shape (v2) and migrates on first read; an acknowledgement recorded before v2 without a
  proof is re-verified and revoked if no typed prompt matches it.
