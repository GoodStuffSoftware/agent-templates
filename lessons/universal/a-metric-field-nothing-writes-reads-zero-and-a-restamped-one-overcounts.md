---
id: a-metric-field-nothing-writes-reads-zero-and-a-restamped-one-overcounts
title: A usage chart reads whatever field you point it at — check the field is written, and written once, before trusting the line
scope: [universal]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
An admin dashboard's "users playing" and "daily active" charts showed 0 for weeks: the field they read was never written by the app (1 of 21 production records, in a type the reader dropped). Its "new users" tile over-counted (8 shown, 4 real) because the creation field was re-stamped on a fallback path whenever a pre-read missed. Both looked like plausible data.

**How to apply:**
- Before charting a field, count how many production records actually carry it and sample a few.
- Derive activity from events that really are written (finished games, last-activity stamps); use a write-once field for "created" and check no path re-stamps it.
- Compare one window against a hand count; bucket days in the operator's zone.

Related: [[a-silent-guard-needs-a-canary]], [[bucket-by-the-other-systems-calendar]], [[your-own-usage-is-in-the-metric]].
