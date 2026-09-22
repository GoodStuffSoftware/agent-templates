---
id: enoent-names-the-lookup-not-the-cause
title: ENOENT names the failed lookup, not why the path is missing — check what should have created it first
scope: [universal]
requires: {}
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms: [no such file or directory]
sessions: 90
---
`ENOENT` / "no such file or directory" is Node and POSIX's generic wrapper for "a path lookup did not resolve to anything." It names the mechanism, never the reason — a wrong `cwd`, a step upstream that was supposed to create the file and either has not run yet or failed silently, a path built from an unset or wrong environment variable, a case mismatch on a case-sensitive mount, a directory deleted out from under a still-running process, or a path assembled with the wrong separator for the platform. Measured across this operator's own session corpus: the single largest recurring tool-failure signature by a wide margin (90 distinct sessions, 77 projects, 2,800+ occurrences) — a strong signal this gets re-diagnosed from first principles far more often than it needs to.

**Why:** the message reports the OUTCOME of a lookup (nothing was there), not the upstream fact that made it true. Treating "no such file or directory" as if it meant "this file categorically does not exist" skips the more useful question: what step was supposed to put it there, and did that step actually complete? The same wrapper text covers "never created," "created somewhere else," "created but already cleaned up," and "created, but this process is looking in the wrong place" — four different bugs with the identical symptom.

**How to apply:**
- Before treating it as "the file doesn't exist," identify what step (a previous command, a build output, a generated config) was supposed to create it, and confirm that step actually ran to completion — a silently-failed or still-in-flight predecessor is a more common cause than a genuinely absent file.
- Print the fully resolved absolute path the failing call actually used, not the relative one you passed in — the mismatch is very often in *resolution* (wrong `cwd`, an unexpanded variable, a relative path evaluated against the wrong base) rather than in existence.
- On a case-sensitive filesystem, check case before assuming the path is wrong in some other way — code developed on a case-insensitive platform can carry a casing mismatch invisibly for a long time (see [[a-case-insensitive-platform-hides-a-case-sensitive-bug]]).
- If the path points into a directory an agent or a cleanup step may have removed mid-task (a worktree, a temp dir), check whether that removal — not a missing file — is the real cause.

Related: [[absence-observed-is-not-absence-explained]] (the same discipline one level up: don't let an observed absence stand in for a diagnosed mechanism).
