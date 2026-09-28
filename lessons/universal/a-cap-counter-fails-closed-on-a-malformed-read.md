---
id: a-cap-counter-fails-closed-on-a-malformed-read
title: A shared counter enforcing a cap must fail CLOSED on a malformed read, never treat it as zero
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A shared counter used to enforce a cap (a daily quota, a rate limit, an allowance) should fail CLOSED on a malformed read: a stored value that is missing, null, negative, fractional, or otherwise non-numeric should be treated as already at the cap, never as zero.

Failing open — treating an unparseable value as zero — turns any storage corruption, a partial write, or a schema drift into an unlimited allowance, silently, for as long as the corruption persists. Failing closed turns the exact same fault into a temporary, safe under-grant: legitimate requests are refused until a human notices and fixes the underlying data, which is a far cheaper failure than an uncapped grant that nobody is watching for.

**Why:** the two failure directions are not symmetric in cost. An under-grant is visible (someone gets refused and complains) and bounded (it stops as soon as the cap logic runs again correctly). An unbounded grant from a "helpful" zero-fallback is invisible until someone notices the cap did nothing, by which point it may have done nothing for a long time.

**How to apply:**
- When parsing a stored counter value for a cap check, treat every value that is not a valid, non-negative integer as "already at the cap" — not as zero and not as the counter's default.
- Leave the malformed value as found rather than repairing it inline as part of the read path; repairing storage is a separate, deliberate operation, not a side effect of a cap check.
- Pair this with an explicit signal (a separate tally, a log line) so the fail-closed state is visible and gets fixed, rather than silently refusing requests forever with no trace of why.

Related: [[fail-open-on-the-action-never-on-the-record]] (the adjacent but distinct asymmetry: fail open on whether an ACTION proceeds, never on whether it gets RECORDED — this lesson is specifically about which direction a value-parsing fallback should fail, not about action-vs-record).
