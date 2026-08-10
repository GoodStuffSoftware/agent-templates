---
id: match-ids-not-dates
title: Match identifiers, don't compare dates — distinct date fields name distinct events
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Two agents reconciling a work-board backfill against session records on disk spent four round-trips converging on a number. Every wrong step was the same mistake with a different pair of date fields:

1. Session START compared against a deletion horizon that ages by LAST WRITE — a session started in one month and resumed two months later is still on disk.
2. File CREATION time used as a proxy for session start — but copy/move resets it, and a resumed session can land in a fresh file, so three sessions that began in one month carried creation stamps from the next.
3. One agent then used the other's creation-time count as a CEILING, producing "at least 24 orphaned" when the truth was 22 — a floor the truth sat below.

A single pass of matching identifiers gave the exact answer with no inference at all.

**Why:** "created", "started", "last modified", "last seen", "completed" are different quantities. Their magnitudes are comparable; the events behind them may not be. Any claim that requires two dates to refer to the same event is resting on an assumption nothing in the data supports.

**How to apply:**
- Before comparing two dates, establish they measure the same event. If they don't, the comparison is not a weaker answer — it is a different question.
- **If a claim NEEDS two dates to refer to the same event, that is the signal to stop and match ids instead.** Identifier matching is usually cheap, always exact, and ends the argument.
- **A lower bound the truth sits below is worse than a plain wrong number.** A bound invites being leaned on, and being wrong in the conservative-sounding direction is what makes it dangerous. State the raw measurement unless the derivation is airtight.
- Record measured facts as `{value, checkedAt, checkedOn}` and leave unknowns ABSENT. An absent field says "unknown"; a fabricated default says "checked, and fine" — opposite claims to a later reader ([[record-intentional-absence]]).
- **Name the scope of a check in the field itself.** A presence check run on one machine cannot distinguish "absent everywhere" from "absent here" ([[scope-a-broken-finding-to-the-measured-path]]).

Related: [[normalize-before-declaring-difference]], [[verify-at-destination-prove-the-target]].
