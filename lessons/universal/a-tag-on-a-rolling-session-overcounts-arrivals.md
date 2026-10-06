---
id: a-tag-on-a-rolling-session-overcounts-arrivals
title: A campaign tag that rides a rolling session overcounts arrivals — derive from a single-row property and name the count a floor
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A campaign tag persisted for a 30-minute rolling session and rode every beacon, so counting rows carrying the tag produced about 3.2x the arrivals of the retired signature-join method; cost per arrival would have been understated by the same factor. The server stored no install id or landing flag, and the referrer was stripped by ad redirects. One per-row property needs no join: the "visitor" field reads *new* only on a device's first-ever beacon. Rows with the tag AND visitor=new are genuine, un-double-countable arrivals — but the count is a FLOOR, because a returning device clicking the ad is missed.

**How to apply:**
- **Name every count as a floor or exact.** Never present a floor as the figure.
- **Derive from a single-row property rather than a join,** and recompute against the old method before trusting the new one.
- **Split "instrument proven" (any real device sent a row) from "funnel measured" (organic, non-household data),** and date the first row as instrument-live, never as the first data point of a funnel.

Related: [[your-own-usage-is-in-the-metric]], [[timing-correlation-deanonymizes-id-free-streams]], [[scope-a-broken-finding-to-the-measured-path]].
