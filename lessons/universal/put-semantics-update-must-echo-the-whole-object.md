---
id: put-semantics-update-must-echo-the-whole-object
title: A PUT-semantics API update must echo every field the live object actually has
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Updating one field of a remote object through a PUT-style API (send the whole object, not a patch) silently deletes any field you fail to include, even one you never intended to touch. The trap compounds when a field is ABSENT from the live object for a specific status rather than holding a default value: reconstructing it with what looks like the natural default is itself a change, not a preservation, and can reintroduce behavior to an object that deliberately no longer carries it.

The incident: adding release notes to an already-shipped release meant re-PUTting the release object. The obvious mental model of that object was "version + status + rollout percentage," and the object's `name` field — easy to omit under that model — would have silently vanished from a naive re-PUT. Worse, the rollout-percentage field is genuinely ABSENT once a rollout completes, not present at `100%`; "helpfully" writing it back in would have reintroduced a staged-rollout concept to an object that no longer carries one, changing its meaning rather than preserving it.

**Why:** a PUT contract makes "the fields I didn't think about" and "the fields I intend to delete" indistinguishable to the server. There is no partial-update path to fall back on, so any gap between your mental model of the object and its actual current shape becomes data loss or an unintended reintroduction, and both fail silently — the call still succeeds.

**How to apply:**
- Read the current object back first (a GET or equivalent) and echo every key it actually holds, rather than rebuilding the payload from what you believe the object should contain.
- Never fill in a field that is absent from the live read with what looks like its natural or default value — absence for a given state is frequently deliberate, and writing a default back in is a state change, not a preservation.
- Prefer copying an existing, working read-modify-write sequence for that endpoint over hand-assembling the payload from documentation or memory.
