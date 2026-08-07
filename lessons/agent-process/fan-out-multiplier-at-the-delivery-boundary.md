---
id: fan-out-multiplier-at-the-delivery-boundary
title: Fan-out cost is one worker per recipient — put the liveness filter at the boundary every send path crosses
scope: [agent-process]
requires: { substrate: coordination-bus }
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 2
---
Before addressing a notice to recipients, ask what happens on the CONSUMER side. If anything starts a worker per message — a listener that spawns a fresh session for each recipient with queued mail — then the cost of one notice is (recipients) x (worker startup), and every dead or ephemeral registry row is pure waste.

Two rounds of the same incident, and the second is the important one. First: a coordinator sent one mesh-wide advisory by addressing each registry row individually instead of broadcasting once. On a host running a spawn-per-recipient listener, that single message became dozens of serial full sessions, each paying startup, reading the same body, and re-deriving the same conclusion; several recipients were placeholder rows whose processes had exited hours earlier. Second, after the fix: the broadcast primitive learned to skip rows flagged short-lived and to report how many it dropped, while a DIRECT send to such a row still delivered — reasoning that "fan-out is where the amplification lives". Within the hour the same coordinator, deliberately avoiding broadcast precisely to avoid the amplification it had just fixed, addressed rows individually again and reproduced the entire cost through the path the fix did not cover.

**Why:** The multiplier is one-worker-started-per-recipient. It does not live in the broadcast call — every way of producing that effect costs the same. So a mitigation attached to the highest-level convenience wrapper is not a mitigation; a considerate caller routes around it by being polite. The filter belongs at the delivery boundary all paths cross.

**How to apply:**
- Put the liveness filter on DELIVERY, not on the fan-out wrapper. If a direct send to a stale row must stay deliverable — it usually should, since a human or agent addressing one name on purpose means it — model that as a default-on filter the caller explicitly opts out of, never as an unguarded parallel path.
- Prefer one broadcast to N addressed sends; and when per-recipient addressing is genuinely needed, filter to rows marked durable/live first. Both halves matter — following only the first is what produced the second incident.
- Verify the fix from the CONSUMER side: count workers started or messages delivered over the window. The mitigation's own skip counter reads zero both when the harm is absent and when it is arriving via the unfiltered path ([[verify-at-destination-prove-the-target]]).
- When placing any default or filter, trace every entry point first and put it at the single choke point they all funnel through — verified by enumeration, not by assumption.
- **Don't discard failure signals that carry information.** A dispatcher that tries to resume a known worker and gets a non-zero exit has just proven that registry row outlived its process; reap or flag the row instead of silently respawning.
- Related: [[registry-identity-and-liveness-honesty]] (why the dead rows exist) and [[no-self-waking-bus-poller]] (the other half of the token budget).
