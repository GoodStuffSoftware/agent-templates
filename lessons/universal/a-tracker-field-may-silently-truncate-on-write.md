---
id: a-tracker-field-may-silently-truncate-on-write
title: Progress-tracker fields are not documents — check for a silent write-time cap before putting load-bearing prose in one
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A coordinating agent wrote long-form guidance into a task board's step and subtask label fields — a not-in-scope list, and "four ways the verified state differs from this card" — then told its successor that **the steps mattered more than the card description**. The board capped every label at 200 characters **at write time**, silently: no error, no warning, no truncation marker. Three of the four stated contradictions were never stored. The successor was pointed at content that did not exist, and burned a subagent proving the remainder was unrecoverable rather than merely hard to fetch.

**How to apply:**
- **Before putting load-bearing prose into any field of a tracker, wiki, issue label, commit trailer or API metadata blob, check whether the field has a length cap and whether it is enforced on WRITE (lossy) or on DISPLAY (recoverable).** Short structured fields are usually the former.
- **Progress fields track progress.** Long-form content belongs in a description, an attachment, or a file under version control.
- **Handoff authors:** never tell a successor one container outranks another without verifying the content survived the write. Read your own handoff back through the same interface the successor will use.
- **Handoff readers:** a field ending mid-sentence is evidence of a write-time cap, not of a fetch problem. The remainder is gone; ask the author instead of hunting.

Related: [[deliver-the-judgment-not-a-pointer-to-it]], [[prove-the-mutation-landed]].
