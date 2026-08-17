---
id: scope-a-broken-finding-to-the-measured-path
title: Record what you measured, not what it implies about the category — scope every finding to the path you actually touched
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 3
---
Before generalizing a capability failure, enumerate the delivery paths that capability actually has. An instrument observes only the path it was built for, and a second path that works shows up as SILENCE in the first path's log — which is often the healthy steady state for a pull-based transport.

The incident: a coordinator found zero successful deliveries in a wake/notify dispatch log and concluded the capability was dead fleet-wide, then shipped a fix that derived "reachable" from that log. There were two delivery paths — a push path (measured, genuinely broken) and a pull path where a per-host proxy holds a long-poll from inside the network and starts a local worker on a delta. The pull path cannot appear in a push log by construction, so zero rows was its healthy state, and the fix was about to mark every working host unreachable.

**Why:** An availability error that UNDER-reports is more dangerous than one that over-reports: it stops people using the endpoints that answer. And the mistake is invisible from where you are standing — the log is complete, the query is correct, the number is real. Only the enumeration of transports exposes it.

**The deeper cost is not that the claim is wrong — it is that it CLOSES the question.** A wrong *answer* invites correction: someone re-runs it and disagrees. A wrong *scope* removes the reason to run anything, because it reads as settled. Measured in a second incident: several days and multiple agents routing around a blocker that existed in exactly one tool, because a true observation about that tool had been filed as a property of the whole class of tools. A third: a search that covered two of three possible locations was published as "it most likely never existed," and the thing was in the third location — the one the same report had explicitly flagged as unchecked.

**And do not expect awareness to protect you.** In that second incident, the agent that corrected someone else's over-generalisation committed the identical one in the same message. Knowing the failure mode is not a control for it. What works is a mechanical habit that operates on the artifact rather than on your attention:

    MEASURED:          {{TOOL}} at {{VERSION}} does not {{BEHAVIOUR}}.
    INFERRED (untested): other {{CATEGORY}} tools may share this — not checked.

The split costs one line and preserves the reason to look.

**When scope and evidence diverge, narrow the SENTENCE — do not widen the search.** A fourth incident: an agent removed a stray keyword from one file, grepped the single directory it was working in, found nothing else, and reported "I closed the class rather than the instance." A reviewer checked repo-wide and found three more. The three were dormant and harmless; the overclaim was the actual defect. The agent's own diagnosis — "I should have run the repo-wide grep" — is the weaker lesson, because widening the search may be expensive, unbounded, or impossible. Narrowing is always available and always cheap: "closed within {{DIRECTORY}}; unverified elsewhere" is the same length and is exactly true. Under time pressure, shrinking the claim is the move that is always affordable.

**How to apply:**
- State the finding as "broken via {{PATH}}", never "broken". If you cannot name the path your instrument covers, you are not ready to publish a number an operator will act on.
- Name the places you actually searched before publishing a negative. "Not found in the two places I can see" and "probably never existed" are different claims, and only one of them is one you measured.
- Check whether a working path exists before shipping a fix that encodes the negative result as data (a `reachable: false` field, a health score, a filter).
- Absence of evidence in a push-side log is not evidence of absence for a pull-side transport. Confirm the negative from the consumer side — did anything downstream actually happen? — as in [[verify-at-destination-prove-the-target]].
- Watch these phrasings, which almost always outrun their evidence: "nothing else uses this", "this is the only caller", "no other instances", "the class is closed", "it's not used anywhere", "the suite is green".
- Apply it to your own inertness proofs. A guard justified by "no current caller does X, so this refusal changes nothing" is the same shape: state what the enumeration covered (statically visible literal call sites) and what it could not (specs built at runtime, values arriving from variables, injected fakes that bypass the real implementation, callers added after the grep ran).
- Related: [[proxy-mediated-liveness-measures-the-proxy]] covers the specific case where the working path's participants never appear in the server's registry at all.
