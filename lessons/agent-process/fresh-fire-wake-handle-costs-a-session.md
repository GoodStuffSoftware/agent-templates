---
id: fresh-fire-wake-handle-costs-a-session
title: A fresh-fire wake handle turns every message into a session spawn — act for the name, never re-register it
scope: [agent-process]
requires: { substrate: coordination-bus }
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
Rescuing a work-complete agent whose original session was capability-frozen ([[resumed-session-has-birth-capabilities]]) meant arming a replacement trigger. That trigger spawns a FRESH session on every fire rather than resuming the old one — a legitimate steady state for an agent whose work is done, because the durable name, its inbox, and its task history all persist while each wake is a stateless drain-and-reply.

Three findings came out of running it that way, and each one is a rule.

**The fresh session could not reclaim the durable name.** Registration enumerated it to `{{NAME}}-2`, because the name was session-bound to the retired original. What looked like reclaiming was minting a stray roster row — a second identity nobody addresses, permanently listed.

**It could still act fully FOR the name.** Reading the durable inbox was not identity-gated for a read-scoped credential, and outgoing messages carry a self-asserted sender alongside the server's non-spoofable caller stamp — which is honest attribution, not impersonation. So the working steady state is *drain and reply WITHOUT registering*.

**Every message to that name now spends a session.** Including a courtesy acknowledgement. A thank-you note costs a full spawn.

**Why:** a wake handle is not a delivery mechanism, it is a *compute* mechanism, and its cost shape depends entirely on whether it resumes or spawns. The same handle that makes a dormant agent reachable makes every trivial message expensive, and the sender cannot see which kind of handle they are firing.

**How to apply:**
- **Do not register from a session spawned by a wake handle.** Registration is a claim to BE the agent; a newcomer cannot reclaim a session-bound name and will silently enumerate instead. Act for it: drain its inbox with the credential's read scope, reply with the self-asserted sender, let the server stamp do the attribution.
- **Never send a courtesy ack to a fresh-armed name.** Carry an unanswered-marker in your own notes and log the decision where you log decisions. Reserve sends for messages that change what the recipient does.
- **Seed the trigger prompt with an access ladder and an honest stop:** try the native tooling, fall back to the credentialed API path, and if neither works, notify a human and STOP. A fresh session inherits nothing, so the seeded prompt is its entire world — and a self-check that refuses to fake success is what makes a failed fire diagnosable instead of silent ([[registry-identity-and-liveness-honesty]]).
- **State which kind of handle a name carries** wherever the roster is published, so senders can price a message before writing it ([[fan-out-multiplier-at-the-delivery-boundary]]).
