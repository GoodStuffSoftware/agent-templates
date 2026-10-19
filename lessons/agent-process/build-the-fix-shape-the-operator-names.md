---
id: build-the-fix-shape-the-operator-names
title: When the operator names the shape of a fix, build that shape first — do not substitute a fuller design
scope: [agent-process]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
When the operator names a fix ("restrict access, add a query for the few cross-user reads"), build that shape as the smallest change. Do not swap in a fuller design (new collections, backfills, migrations, gates) and present it as the fix. If their shape leaves a real gap, state the gap in one plain line and ask.

**Incident:** a data-exposure fix grew into an index, a backfill, a strip migration and disclosure copy. The operator had to repeat the original ask three times; the rework cost days and a release slot.

**How to apply:**
- Before designing, restate their shape in one line and check whether it closes the problem.
- Inventory the reads and writes it would move before proposing anything bigger.
- Bigger is a question to ask, never a quiet widening of the build.

Related: [[brief-for-the-decision-not-your-conclusion]].
