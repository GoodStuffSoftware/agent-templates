---
id: brief-for-the-decision-not-your-conclusion
title: Brief for the decision, not for your conclusion — and name the research that already exists
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A lead researching a question, reaching an answer, and then writing that answer into a worker's brief as an instruction is not delegation — it is handing over typing. Two harms, both observed in one session:

1. **The lead's conclusion can be stale where fresh research would not be.** The prescribed transport was copied from a working internal codebase whose pattern predated a spec revision. A worker told to "use what {{PRECEDENT_REPO}} uses" cannot discover that; a worker told to "verify what the spec calls for now" can.
2. **The precedent may not transfer, and only the brief can flag that.** Here a single-operator internal tool was offered as the template for multi-tenant consumer software — same protocol, materially different problem.

**Write it as:** requirements and constraints; then local precedent offered explicitly as *evidence to be sceptical of*, with a stated reason it might not transfer; then a required decision record listing the alternatives actually evaluated. Judgement stays with the worker; acceptance criteria stay with the lead.

**Corollary that saves more time than the rule itself: name the research that already exists.** A brief sent a worker to determine platform capabilities that a dozen dated, sourced files in the project's own research directory already answered. Scope fresh work only to what is genuinely time-sensitive — and check status headers before citing, because one of those files read `Status: IN PROGRESS` and had been treated as complete for a week ([[verify-a-citation-before-it-becomes-an-assumption]]).

**The test:** if the brief tells the worker what to conclude, the worker cannot discover that the conclusion is wrong. Ask what you actually need from it — a decision, or a transcription.

Related: [[order-the-brief-so-parking-is-harmless]], [[write-target-in-initial-brief]], [[teammate-reports-to-files]].
