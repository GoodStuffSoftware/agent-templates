---
id: an-open-ticket-is-not-clearance
title: Auto-filing a ticket is "noticed", not "triaged" — an open ticket prevents duplicate filing, it never clears a gate
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Filing a tracking issue for a problem records that the problem was noticed. It says nothing about whether anyone has judged the problem acceptable to ship past, and a gate that treats "a ticket exists" as "cleared" has quietly deputized the automation to triage on the operator's behalf.

The incident: a daily automated job's first live run found two items blocking a release gate and, as designed, filed tracking issues for both. The gate then went immediately green, because its logic counted an open ticket as clearance. Nobody had looked at either item; the automation had triaged them itself, on nobody's authority, in the same breath that it noticed them.

**Why:** filing and clearing look like the same action from the gate's point of view — both produce a ticket reference the gate can check for — so it is easy to collapse them into one boolean without noticing the two events mean opposite things. One says "a human has not yet seen this." The other says "a human looked and decided it's fine to proceed."

**How to apply:**
- Separate the two questions explicitly in code: an open ticket exists to prevent DUPLICATE FILING of the same problem on the next run, nothing more.
- Only a closed ticket, an explicit status change made by a person, or an explicit acknowledgement recorded by a person should be able to CLEAR a gate. Never the mere existence of a ticket, open or otherwise.
- When building an auto-filing step, name its output something that cannot be mistaken for approval in code — a ticket ID paired with a boolean `acknowledged: false`, not a field that reads as done once a reference exists.
- Related: [[calibrate-a-bound-against-the-real-distribution]], [[gate-the-write-not-the-aftermath]], [[did-not-run-is-a-third-outcome]].
