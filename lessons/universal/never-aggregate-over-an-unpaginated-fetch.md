---
id: never-aggregate-over-an-unpaginated-fetch
title: Never aggregate over an unpaginated fetch — a truncated ordered page looks exactly like a complete small result
scope: [universal]
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Before computing any total, share, ranking, or "X is absent" claim from an API result set, confirm you have the COMPLETE set: follow `next` / `next_url` / cursor links to exhaustion, or verify the response asserts there are no further pages.

The incident: an agent pulled a breakdown report from an ads API, analysed the returned rows, and reported firm conclusions — "these two targets got 0% of delivery", "tier-1 markets got 4.5%". The response was paginated AND ordered alphabetically, so only page 0 came back and every conclusion was drawn from roughly the first letter of the alphabet. The full set ran to over a hundred pages and several thousand rows, and reversed the findings outright: the entities reported as absent were present, and the largest segments — which happened to start with late letters — had been invisible. The output looked complete at every stage: valid JSON, plausible row count, sensible numbers, no error, no warning.

**Why:** A partial page of an ordered result set is indistinguishable from a complete small result. It parses cleanly, sums cleanly, and yields confident wrong answers. Alphabetical ordering is what makes it dangerous — random ordering would produce an obviously odd sample, whereas alphabetical ordering yields a tidy list that reads as a whole dataset.

**How to apply:**
- Two independent red flags that you are looking at page 0 of an ordered set: (a) the returned keys cluster at the start of an alphabet or numeric range, and (b) the row count is a suspiciously round number ({{PAGE_SIZE}} — 50 / 100 / 1000 / 3000).
- Sanity-check by reconciling the parts against the whole: compare the sum of a breakdown against the known grand total. If the parts do not reconcile, you are missing pages.
- Applies to any paginated source — ads platforms, CRMs, issue trackers, cloud billing, log search — and is worth echoing in any analyst- or researcher-style agent definition that aggregates API results.
