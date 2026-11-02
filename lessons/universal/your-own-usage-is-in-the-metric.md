---
id: your-own-usage-is-in-the-metric
title: Your own usage is inside the metric — exclude internal actors before quoting a count
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 3
---
Two counts from the same product, both wrong in the same way:

- An install figure used to judge a paid campaign included the operator's own household devices. The platform's reporting cannot distinguish them, and the exclusion list that existed covered only a web beacon — a different instrument entirely.
- A scarce promotional allocation reported "three of fifty claimed." Two of the three holders were internal zero-activity accounts, one of them already holding the very entitlement the promotion was meant to grant. The real external number was one.

**The kernel: you are inside your own funnel.** Test accounts, staff devices, household members, and internal smoke runs all produce genuine events, and every dashboard counts them. Nothing flags them, because from the instrument's point of view they are indistinguishable from the users you care about.

**How to apply:**
- **State the exclusion coverage whenever you quote a number** — which instrument excludes which actors. "Excluded" on one collector says nothing about a second collector measuring the same funnel.
- **Before a count drives a decision, list the known internal actors and subtract them by hand** if the instrument cannot. Two of three is not a rounding error.
- **Ask the operator rather than assuming** when internal attribution is not machine-knowable — a cost-per-acquisition figure that may be contaminated cannot be quoted until that question is answered.
- **A scarce allocation needs an eligibility gate that measures the behaviour you care about**, not a proxy that internal accounts satisfy for free: a sign-in is not usage, and an account that exists is not a user ([[match-instrument-to-failure-class]]).

**The internal actor need not be a person, and one exclusion does not travel to a second channel measuring the same thing.** Two more faces of the same gap:

- An internal verification server running automated checks produced hits in the error data that were indistinguishable from real failed sign-in attempts. Nothing marked them as synthetic; they aged into the same backlog a human failure would.
- An exclusion built for one telemetry channel did nothing for a different channel measuring the same underlying behavior. A web-analytics address exclusion filtered a site's own analytics correctly, but the app-store console's install and return-rate reports have no such exclusion, and once household devices were accounted for by hand, a headline return rate of roughly 28% became 0%.

- **Enumerate every channel that measures a behaviour and confirm each one's exclusion separately** — a filter configured on one collector is a property of that collector, never a property of the underlying event.
- At small sample sizes, a single known internal actor (a person, a script, a monitoring service) can fully explain an aggregate. Check the smallest-N metrics first; they are the ones a handful of internal events can flip entirely.

Related: [[scope-a-broken-finding-to-the-measured-path]], [[bucket-by-the-other-systems-calendar]], [[monitor-default-target-is-part-of-the-finding]].
