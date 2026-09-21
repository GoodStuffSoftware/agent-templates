---
id: never-put-user-config-under-a-wipeable-dir
title: Never put user-authored config under a directory you have told people is safe to delete
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A tool's state directory carried documented advice that it was safe to wipe in order to reset history and telemetry — a reasonable thing to say about derived, regenerable state. Operator-authored settings then landed in that same tree, because it was already "the tool's directory" and nobody re-checked the promise before writing into it. The documented reset instruction, followed exactly as written, started destroying user work that had never been derived from anything and could not be regenerated.

**Why:** "safe to delete" is a promise about a DIRECTORY, and it gets made once, in documentation, long before anyone decides where a new setting should live. Derived state and user-authored configuration drift into the same tree because both are, informally, "the tool's files" — the categories are obvious in the abstract and invisible at the point someone is choosing a path for a new setting.

**How to apply:**
- Separate derived state and telemetry from user-authored configuration by DIRECTORY, not by filename convention — a naming rule is something a future writer has to remember and will eventually skip.
- State the deletion guarantee for each directory explicitly, in a README beside it: this one is safe to wipe, this one is not, here is why.
- Before adding a new setting or writing a new file, check whether the directory you are about to write into already carries a documented deletion promise — if it does, that promise now applies to what you're about to add, whether or not you intended it to.
- When writing "safe to delete" advice for any directory, scope it explicitly to what is currently in there, and treat any future addition to that directory as something that must re-satisfy the promise, not something the promise automatically covers.

Related: [[record-intentional-absence]], [[docs-living-or-historical]].
