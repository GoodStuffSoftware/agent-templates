---
id: absence-must-not-authorize-a-destructive-remedy
title: An inference from absence must never authorize a destructive remedy — and the authorizing signal must be attributable to the target
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
An inference built from absence of evidence is the weakest kind of evidence there is. It must never, on its own, authorize an irreversible remedy.

The incident: a fleet component's "this machine is silent" state was inferred from absence of evidence — no held connection observed — and that inference recommended a destructive remedy: rotating the machine's credential. A review proved a false-silence chain could revoke a live listener's credential out from under it. Two hardenings followed, and the second is the subtle one.

First: require corroboration from independent signals — absence of **both** a held socket **and** any write originating from that machine — before the silent state is even asserted, and remove the destructive recommendation from the bare silent state entirely. Only a server-refused credential refresh may suggest rotation.

Second: the destructive branch must fire only when the server **recognises** the refused credential as that target's own (a reuse-revoked or wrong-client refusal), never on a garbage or unknown token — otherwise a stranger holding only the victim's public identifier can trigger a rotation against them by presenting nonsense.

**Why:** an unrecognised refusal carries no information about the target at all. Treating "someone failed to authenticate as you" as evidence about you turns your own recovery path into an attack surface — the remedy becomes reachable by anyone who can name you, not just by you.

**How to apply:**
- Separate the states DETECTED / SUSPECTED / UNKNOWN in code, and let only DETECTED reach a destructive branch.
- Name, in the code and in the log line, which party's action produced the authorizing signal — a refusal the server attributes to the target is a different fact than a refusal the server cannot attribute to anyone.
- Prefer reporting to an operator over self-healing whenever the remedy is irreversible; require two independent negative signals before even raising the suspicion, not one.

Related: [[absence-observed-is-not-absence-explained]], [[a-silent-guard-needs-a-canary]], [[fail-open-on-the-action-never-on-the-record]].
