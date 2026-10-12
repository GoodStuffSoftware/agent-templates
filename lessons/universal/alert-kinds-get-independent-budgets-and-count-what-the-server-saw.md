---
id: alert-kinds-get-independent-budgets-and-count-what-the-server-saw
title: Give each alert kind its own bounds, count what the server observed rather than what a client claimed, and fire from the write that crosses the threshold
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
An error-alerting design started with one global daily cap on alert emails. A run of one kind of alert could then hold back another, more important kind. It also trusted a client-reported occurrence count, so one forged report could claim a million.

**How to apply:**
- Bound each alert kind only by its own rules (levels per fingerprint per day; a cooldown with an escalation override). No kind shares a counter or a state document with another, and a test proves twelve of one kind do not block another kind.
- A shared downstream quota (an email provider's daily limit) still couples kinds. State it in the design and runbook and decide the mitigation separately.
- Threshold on server-observed events (one report per fingerprint per request at ingest, repeats within a request counted once), never on a count the client claims. A write the server cannot see (client-direct) is recorded by the trigger itself with exactly one increment, and its own follow-up event must provably not loop.
- Fire from the event that warrants it, not a timer; if you cannot name that event, the design is not ready. "Something stopped happening" has no event and needs its own heartbeat design.

Related: [[alarm-on-the-runway-not-the-failure]], [[a-cap-counter-fails-closed-on-a-malformed-read]].
