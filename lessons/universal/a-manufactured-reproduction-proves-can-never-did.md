---
id: a-manufactured-reproduction-proves-can-never-did
title: A manufactured reproduction proves a failure CAN happen, never that it DID — label everything downstream as a hypothesis
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
An agent that explains why it could not safely run the suspect command, then hand-builds the call shape to reproduce the error anyway, has produced a different kind of evidence than the one being asked for. A hand-built reproduction of a failure's SHAPE shows the shape CAN occur; it says nothing about whether the system DID produce it, under what conditions, or how often.

The incident: a diagnostic subagent was asked why a test hung at its timeout under one caller but passed quickly alone. It stated plainly that it did not run the real test, because doing so would touch shared state other sessions depended on — a correct refusal — and instead reconstructed the failing call by hand, producing a deterministic error. The lead relayed the mechanism as fact to the operator, to a peer session, and into a memory file. A later writer who actually ran the suspect test eight times measured zero occurrences of that error.

**Why:** the tell was in the original report and got skimmed past. "I did not run the real thing, I reproduced the shape by hand" is a plain statement that everything past that point is a hypothesis, not a finding — but a confident, deterministic-looking result reads like a finding regardless of how it was produced. Relaying it drops the qualifier the source report already gave.

**How to apply:**
- When a report says it could not run the real thing and constructed a stand-in instead, mark every claim built on that stand-in as a HYPOTHESIS in your own relay — to the operator, to a peer, into a memory file. Do not let a deterministic-looking manufactured result read as an observed one.
- Ask directly: "did you run the real path, or build a shape that produces the same error?" before repeating a mechanism as fact.
- A hand-built reproduction is still useful — it can surface a real, separate bug worth fixing on its own merits ([[sanity-check-a-mechanism-against-a-known-invariant]]) — but its evidentiary status stays "this shape is possible," never "this is what happened here."
- Related: [[read-which-error-fired-before-theorising]] (mining evidence you already have, rather than manufacturing new evidence, is the cheaper and more trustworthy first move).
