---
id: discovered-staleness-in-scope
title: Staleness discovered while doing a task is in scope — fix it, and prefer de-hardcoding over re-editing the value
scope: [universal]
status: active
since: 2026-07-13
provenance: [contrib-2]
corroborated: 1
---
When a task surfaces something stale — a doc count, a dead status line, a superseded branch, an orphaned process, a rotted note — cleaning it is part of the task, even if the rot predates the task. "Pre-existing, out of scope" is not an acceptable disposition for a KNOWN-stale artifact: stale text is exactly how the next session (human or agent) inherits a wrong fact with full confidence.

The durable fix for a stale count or enumeration is not to correct the number — it will just rot again — but to **de-hardcode**: replace the literal with a pointer to the source of truth (the file/registry/command that computes it) so the doc can't drift. Exact values stay pinned only in test assertions, where a mismatch failing the build is the intended behavior.

Fix the CLASS, not the instance: before declaring done, grep for siblings of the stale string and repair all of them. A teammate flagging "that wasn't in my checklist" is a pointer to a sibling you now own, not a reason to defer it.

**Why:** Stale docs and dangling state are load-bearing lies — downstream automation reads them as truth. The cost of leaving one is paid later and by someone else, at higher confidence and lower context. De-hardcoding is strictly better than renumbering because it removes the failure mode instead of resetting its timer; and sweeping the class prevents the whack-a-mole where the same stale value survives in three other files you didn't look at.

**How to apply:**
- Fix discovered staleness in the same commit group, or as a rider commit on the active branch — not a deferred ticket.
- Prefer de-hardcoding: point the doc at the source of truth; keep exact values only in test assertions.
- Sweep the class: grep for siblings of the stale string; fix every hit.
- Non-repo staleness (superseded branches, orphaned processes, rotted memory/notes) gets the same treatment, under the usual safety gates (back up before deleting, verify the target).
- Exempt: immutable history — changelog entries, dated decision logs, versioned known-issues notes. Those are corrected by prepending a dated reconciliation note, never by retro-editing (see [[docs-living-or-historical]]).
