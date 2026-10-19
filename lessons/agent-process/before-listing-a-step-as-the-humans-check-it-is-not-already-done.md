---
id: before-listing-a-step-as-the-humans-check-it-is-not-already-done
title: Before you list a step as the human's, check it is not already done and that no agent can run it
scope: [agent-process]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
Two recurring mistakes: listing a to-do as the human's when they already did it (generated keys), and handing them a manual checklist (a phone test) an agent could run on an emulator.

**How to apply:**
- Before listing ANY step as theirs, check: secret stores by name and date only, leftover files by name only, the vendor console read-only. List only what is still open and say what was checked.
- Run device-only checks on an emulator; report PASS, FAIL or NOT-RUN with evidence and name the gap.
- When you do need them, the ask carries a clickable link and one line on what to look at.
- Never navigate a tab the human is working in.

Incident: a one-time key download was lost when an agent navigated the human's tab.

Related: [[a-local-path-is-not-a-shared-artifact]], [[outcome-level-reporting]].
