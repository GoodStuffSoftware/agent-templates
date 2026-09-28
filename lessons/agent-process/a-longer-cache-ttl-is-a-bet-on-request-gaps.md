---
id: a-longer-cache-ttl-is-a-bet-on-request-gaps
title: A longer prompt-cache TTL is a bet on the gaps between requests — measure the gap distribution before flipping it, and set it per role
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Extending a prompt cache's time-to-live only pays off on requests that arrive after the SHORT ttl would already have expired the cache, but before the LONG ttl would. Every write, not only the ones that benefit, is billed at the longer ttl's higher write price — so the decision is a bet on how much traffic actually falls in that middle gap, not a general "longer is safer" call.

**The method, not a single verdict:**
- Bucket the gap between each request and the one before it on the same context into three bands: under-the-short-ttl (a cache hit either way), between-the-two-ttls (a miss today, a hit with the longer ttl), and over-the-long-ttl (a miss either way). Only the middle band is where the longer ttl changes anything.
- The tokens the longer ttl would convert from a miss to a hit are exactly the write volume that falls in the middle band for that context.
- Compute a break-even token share from the write/read price ratio of the two ttls, and compare the middle band's share of total write tokens against it — this is a TOKEN share, not a request share, because a single request's write can be far larger than its read.
- Sanity-check the measurement: the ratio of read tokens to the previous prefix size should be near 100% inside the short ttl and drop sharply past it — if it doesn't, the bucketing is wrong before the economics are even computed.

**Why a single global switch is the wrong shape:** the gap distribution is a property of HOW a given role is used, not a property of the caching mechanism itself. A role that gets resumed for follow-ups minutes apart sits mostly in the middle band and gains from the longer ttl; a role that runs once and is discarded sits mostly in the "miss either way" band and only pays the longer ttl's higher write price for nothing. Measured on live usage, the two groups moved in opposite directions under the same global flag — long-lived, frequently-resumed roles saved a meaningful share of their cost, short-lived one-shot roles got more expensive — so the net effect of one global setting canceled out to roughly nothing while hiding a real win and a real loss inside it.

**How to apply:**
- Don't reason about a ttl change from vendor pricing alone; walk real transcripts, bucket the gaps, and compute the token share before deciding.
- Set the ttl PER ROLE (per agent definition, not globally): long-lived roles that get resumed within the middle gap band get the longer ttl; short one-shot roles keep the short one.
- Re-measure after any change to how a role is used (a new "resume within N minutes" policy, a change in how often it's invoked) — the gap distribution the original measurement was based on can shift underneath a setting that was correct when it was set.
- A resume that lands just past the short ttl's cliff rewrites that worker's entire accumulated transcript at the higher write price — which can cost MORE than simply spawning a fresh worker would have. A "reuse the same worker for follow-ups" policy and a short cache ttl actively work against each other; decide explicitly which one wins for each role, or fund both by lengthening the ttl for the roles that get reused.
- Related: [[an-omitted-worker-tier-inherits-the-leads]] (a different cost-defaulting gap in agent routing) and [[budget-fan-out-against-host-memory]] (measure the real resource distribution before setting a routing knob, rather than reasoning about it in the abstract).
