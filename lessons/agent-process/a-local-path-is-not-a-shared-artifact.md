---
id: a-local-path-is-not-a-shared-artifact
title: A filesystem path is a same-box pointer — hand a remote peer the content, not the location
scope: [agent-process]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
In a fleet mixing local subagents and remote peers (a cloud session, an agent on another operator's machine), a filesystem path is not a shared artifact. It resolves for whoever shares the disk and is an opaque string to everyone else.

The incident: a reviewer wrote its findings to `{{LOCAL_TASKS_DIR}}/REVIEW-{{FEATURE}}.md`. The follow-up brief told a remote builder *"read it first — the reviewer already validated a fix shape, don't rediscover it."* The builder could not open the path. It said so, then built the fix blind from the brief's one-line summary — which meant the later delta review had to add a whole axis just to check whether the two independently-derived fix shapes had converged. The pointer cost more than the content would have.

**Why:** The path convention is correct and load-bearing for same-machine teammates — it is exactly what keeps a lead's context from filling with report bodies ([[teammate-reports-to-files]]). The failure is applying it across a boundary where the referent does not exist. The tell is that nothing errors: the brief is well-formed, the recipient is cooperative, and the only symptom is work done without the input it was supposed to have.

**How to apply:**
- Before sending a path, ask where the recipient runs. Same machine → a pointer is right. Remote, or you cannot tell → the pointer is worthless.
- Three ways to actually deliver, in order of preference: **paste the load-bearing content into the message**; **commit the artifact to the shared repository** and cite it by repo-relative path plus branch; or **publish it where the peer's own surface serves it** (a shared board, an issue, a hosted page).
- Paste the load-bearing part, not the whole file. "The reviewer validated this fix shape: `{{SHAPE}}`, because `{{REASON}}`" is three lines and removes the entire failure.
- **Apply the translation in reverse.** When a peer hands you one of ITS local paths, do not silently fail on it — say you cannot resolve it and ask for the content. Reading past an unresolvable pointer is how a brief quietly loses its most important input.
- Default to delivering when the audience is unknown. A pasted paragraph that the recipient could also have opened costs a few lines; an unresolvable path costs a rediscovery and a review axis.
