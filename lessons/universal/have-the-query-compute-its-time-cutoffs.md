---
id: have-the-query-compute-its-time-cutoffs
title: Never hand-type an epoch cutoff into a query — a wrong one returns zero rows, which reads as an outage, not a bad parameter
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A worker typed epoch-millisecond cutoffs straight into a SQL query without verifying them. The values were hours off (a UTC-versus-local-time confusion or an arithmetic slip). The query returned zero rows. Zero rows is the *correct* answer to "find rows between these two (wrong) instants", so there was no error, no warning and nothing to notice — only an empty result that looked exactly like a dead pipeline. It nearly held a release and took hours to diagnose, because the cause sat in a completely different place from where everyone looked.

**Why it misleads:** an empty result set is a valid answer to a malformed question. The tool cannot tell "no events happened" from "you asked about a window in which none could have", and the person reading it sees only the first reading.

**How to apply:**
- **Do not hand-compute an epoch value for a query cutoff.** Make the query compute it from a human-readable literal, e.g. SQLite `CAST(strftime('%s','YYYY-MM-DD HH:MM:SS') AS INTEGER) * 1000` for milliseconds, with the time zone named in the literal.
- **SELECT the computed expression once and print it** (as an ISO string and as the number) before running the real query, and put both in the brief or the report, so the writer and the reader can check that the window is the one intended.
- Treat a surprising zero from a time-windowed query as a prompt to check the window first, before suspecting the pipeline ([[normalize-timezones-before-timestamp-arithmetic]], [[bucket-by-the-other-systems-calendar]]).
- The same rule covers any environment-specific constant that can silently be wrong: if it can be derived from a testable source, derive it inside the tool that uses it.
