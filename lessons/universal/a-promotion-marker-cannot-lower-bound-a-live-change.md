---
id: a-promotion-marker-cannot-lower-bound-a-live-change
title: A promotion commit or tag is downstream of a live change and can never lower-bound when it happened
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
In a pipeline that deploys first and only records the promotion commit or tag afterward, the marker's timestamp is provably later than go-live. Using it as the floor of a before/after window silently misclassifies real post-change data as pre-change, and the gap between the two is not always small enough to ignore.

The incident: a production change went live at one timestamp, and its promotion commit landed a little over three minutes later. A measurement window floored on the promotion commit's time misclassified those three-plus minutes of genuinely post-change activity as pre-change — enough to distort any analysis segmented at that boundary.

**Why:** the ordering is structural, not incidental. A pipeline that deploys-then-tags guarantees the tag is always later than the deploy; there is no version of this pipeline shape where the marker could serve as a lower bound, no matter how fast the promotion step usually runs.

**How to apply:**
- For a tight bound on when a live change actually took effect, arm a poll of the live artifact (a version endpoint, a served asset, anything that reflects the deployed state) BEFORE triggering the change, and record the last old-version observation and the first new-version observation — that brackets go-live to roughly the polling interval.
- Without an armed poll, the only honest floor is the deploy's own start time from its run log — never a commit or tag timestamp, which is always downstream of the thing you're trying to bound.
- Report the bound as a window with an explicit "this end is definitely post-change" note, rather than inventing a single instant.
