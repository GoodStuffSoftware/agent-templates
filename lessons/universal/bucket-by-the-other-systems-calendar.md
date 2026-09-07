---
id: bucket-by-the-other-systems-calendar
title: When reconciling against someone else's dashboard, bucket by THEIR day boundary and allow for THEIR reporting lag
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
First-party telemetry is usually stored as UTC timestamps and grouped by UTC day. The third-party dashboard you are reconciling it against — an ad platform, a store console, a payment processor — reports on **its account's own time zone**, and its most recent day is typically incomplete for hours. Group your rows by your calendar and the two tables never line up; the mismatch looks like data loss and gets investigated as one.

Two independent artifacts of the mismatch, neither of them a bug:
- **A day-boundary offset.** Group by `date({{TS}}/1000 - {{ZONE_OFFSET_SECONDS}}, 'unixepoch')` to bucket into the reporting system's local day. Remember the offset changes with daylight saving; hard-coding one shifts every row by an hour for half the year.
- **A lag.** A morning read of a per-day report routinely misses the previous evening. Comparing your complete day against their partial one shows a deficit that fills in by itself.

**Why:** each system's "day" is a property of its own configuration, invisible in the numbers it hands you. Both tables are internally consistent, so nothing looks wrong until you put them side by side — at which point the natural conclusion is that one pipeline is dropping data.

**How to apply:**
- Establish the counterpart's **account time zone** and **reporting lag** before comparing anything, and write both into the reconciliation script rather than the analyst's head.
- Compare on **whole, settled days only**. Exclude the current day on both sides by default.
- Reconcile by **identifier** where identifiers exist; fall back to date bucketing only for aggregates that have none ([[match-ids-not-dates]]).
- Wrap the whole thing in a committed snapshot script instead of hand-written one-off queries, so the offset, the lag rule and the credential live in one reviewed place and every future comparison is the same comparison.
- Watch the tooling seams while you are there: a query CLI's file-input flag may return **execution statistics only** rather than rows (use the inline-command form), and on Windows a Node child cannot spawn a `.cmd` shim directly — go through a shell ([[assert-the-resolved-value-not-the-declaration]] for the general form: read what the tool actually returned, not what you expected it to).
