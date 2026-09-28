---
id: cross-tab-side-effect-needs-a-write-then-reread-claim
title: Two same-origin tabs can both pass a check-then-act gate — dedupe with a write-then-reread claim token, not a plain flag
scope: [universal, stack:web]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Two same-origin browser tabs can both read a "has this already happened" state, both see it unset, and both proceed to fire a side effect meant to happen once per event — because neither has persisted the result yet when the other reads it. An ordinary check-then-act guard (read a flag, act if unset, then set the flag) has a race window between the read and the write, and two tabs racing through that window both win.

The fix pattern: a dedicated storage key (e.g. a `localStorage` entry, shared by every code path that could trigger the effect) holding a write-then-reread CLAIM token. Each tab that reaches the gate generates a token, writes it to the shared key, then reads the key back. Only the tab whose reread returns its OWN token proceeds — any tab that reads back a different token (because another tab's write landed in between) treats the effect as already claimed by someone else and skips it.

```
function claim(key):
  token = randomToken()
  storage.set(key, token)
  return storage.get(key) == token   // true only for the tab that "won" the race
```

**Why this beats a plain flag:** a plain boolean flag still has the same read-then-write race a claim token is built to close — reading `false` and then setting `true` is exactly the pattern that lets two tabs both pass. The claim token turns the race into a last-write-wins contest with a built-in verdict: whichever write is followed by a reread of ITSELF proves it landed after any competitor's write, because the reread happens after both writes have had a chance to land.

**How to apply:**
- Wire every code path that could independently trigger the effect through the SAME claim key — a partial rollout (some paths gated, some not) reopens exactly the race the claim exists to close.
- Keep any effect that is already naturally idempotent (e.g. keyed by a stable, externally-deduplicated id) OUTSIDE the claim gate — gating something that doesn't need it makes the fix broader than the bug and can suppress a legitimate second firing that was never the problem.
- This is a browser-tab instance of a general check-then-act race; the same write-then-reread shape applies to any two actors sharing one piece of mutable state with no lock, not only tabs.
