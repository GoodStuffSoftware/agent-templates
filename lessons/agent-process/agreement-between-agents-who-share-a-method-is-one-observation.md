---
id: agreement-between-agents-who-share-a-method-is-one-observation
title: Agreement between agents who share a method is not corroboration — it is one observation, run several times
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Three agent sessions spent hours disputing whether a deploy path was blocked. Three of them independently queried a run history by a `target` field, all found nothing, and all concluded the same wrong thing: the stage had not run for seven weeks. The stage also runs as a **step inside a full-scope bundle run**, which a filter on that target field never matches; the evidence was in the build logs the whole time. "No run with target X" means "no standalone X run", not "X never ran". The agreement felt like triangulation. It was one method run three times, so it carried no independent information.

**How to apply:**
- **Independent confirmation requires a different method, not a different agent.** A second agent running your query is a reliability check on the query, not on the answer.
- **When agents agree, ask what each of them actually did.** If the procedure was the same, you have one observation.
- **Scope the evidence to the leg it covers.** Before concluding a stage never ran, check every way it can run (standalone, as a step in a larger run, via a scheduler), and read the artifact the stage produces rather than the index of runs that mention it ([[scope-a-broken-finding-to-the-measured-path]]).
- The four-state flip-flop in that thread (refused, disproved, unexercised, fine) came from flaws in how the claim was checked, never from a change in the system. More agents looking raises the odds of a shared blind spot, not lowers them.

Related: [[a-right-conclusion-does-not-vouch-for-its-premise]], [[an-open-ticket-is-not-clearance]].
