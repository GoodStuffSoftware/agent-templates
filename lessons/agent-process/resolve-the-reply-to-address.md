---
id: resolve-the-reply-to-address
title: Don't hardcode the reply-to address in a briefing template — resolve it, or make the brief self-healing
scope: [agent-process]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Briefing doctrine likes to end with a required closing line: "report back via {{MESSAGE_TOOL}} to {{ORCHESTRATOR_NAME}} when done." The instruction is right. The hardcoded name in it is a bet that every future session has the same topology, and that bet loses quietly.

Orchestrator addressing is environment state, not doctrine. Depending on how a session was created, the parent may be a named teammate ({{ORCHESTRATOR_NAME}}) or a distinguished built-in endpoint ({{MAIN_ENDPOINT}}). The spawning tool's own description usually says which — e.g. if it documents the team parameter as deprecated or ignored, there is no named lead to address.

The incident: a doctrine file instructed, verbatim, that every subagent brief must end with a report addressed to a named lead. In a session where the team was implicit, no agent by that name existed. Four agents were spawned with the stale wording; each independently discovered the address was unreachable and fell back, one of them reporting "no agent by that name is reachable — messaging you as {{MAIN_ENDPOINT}}." Cost was one wasted turn per spawn. The latent cost is worse: an agent that does not think to fall back drops its report entirely.

**Why this is worth a rule rather than a shrug** is the shape of the failure. A bad address raises nothing the orchestrator can see. The worker believes it delivered; the orchestrator receives nothing; and "nothing received" is the same signal as "still working." So the error does not present as an error — it presents as patience. Any doctrine that tells a lead to wait on a report is, in this state, telling it to wait forever.

**How to apply:**
1. **Resolve before briefing.** Read the spawn tool's description once at session start and use the address it implies for every brief that session.
2. **Write self-healing briefs when unsure.** "Report to the orchestrator — address it to {{MAIN_ENDPOINT}}; if that does not resolve, use {{ORCHESTRATOR_NAME}}." Costs one clause, removes the whole failure class.
3. Generalises past addressing: **whenever a template embeds an identifier that is resolved at runtime — an address, a branch, a port, a path, a channel — either resolve it at the point of use or make the instruction degrade gracefully.** Prefer the failure that is loud over the one that looks like waiting.

Related: [[static-instructions-teach-discovery]] (the same rule for capability surfaces), [[recovery-from-silent-teammates]] (what to do once a report never arrives), [[teammate-reports-to-files]].
