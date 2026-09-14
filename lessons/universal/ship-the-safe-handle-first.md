---
id: ship-the-safe-handle-first
title: When the same mistake recurs across independent authors, fix the affordance — and ship the safe handle before the work that needs it
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 2
---
Three separate identity bugs landed in one codebase in one week, each one an author deriving identity from a convenient string instead of from an authenticated credential: a transport class treated as an ownership signal; a garbage-collection tombstone's actor field read as the record's owner; a requested name treated as proof of the caller. A fourth was caught *before* it was written — the proposed fix for the third would have had to parse an identifier out of a token name, because the object carrying the real identity was dropped before reaching the request context.

That is the finding: **the codebase had made the wrong implementation the only available one.**

**Why:** when the correct approach requires a handle the code does not expose, every implementer independently reaches for the incorrect one — and each looks locally reasonable in its own review. Recurrence across independent authors is evidence about the API surface, not about the people.

**How to apply:**
- When the same class of mistake recurs across independent authors, stop treating it as a discipline problem. Ask what handle the correct implementation needs and whether the code exposes it at the call site.
- **Ship the safe handle FIRST, as its own change, before the work that needs it.** If it lands as an acceptance criterion *inside* the risky change, the implementer still starts from the unsafe path and has to climb out. Landing it first makes the correct implementation the path of least resistance instead of the one requiring vigilance.
- Watch for context objects that DROP the field carrying real identity — a normalizer returning a hand-picked subset. The drop is usually invisible and is what forces every downstream caller into a string parse.
- **A distinction between two similar bug shapes is useless without a search handle.** When filing "these are different problems," give each one a concrete grep target — otherwise a sweep for one silently misses the other and the distinction was decorative.
- Derive identity from the authenticated credential, never from a parameter naming the subject. A filter like `?subject={{ID}}` read off the request is not a restriction; it is a lookup by any caller. If it must exist, validate it against the authenticated identity rather than trusting it.

Related: [[safeguard-the-operation-not-the-entry-point]] is about WHERE a check goes; this one is about whether the correct call is *possible* at the call site. See also [[externally-asserted-fields-are-not-self-reportable]].

**Second case, the safety-critical form: a hazard and its guard ship in the SAME release.** A change added a server-trusted field whose protection depended on a policy deploy; the verifier that would prove the protection was live had been split into a separate tracking item, to land later. Splitting them leaves a live gap for exactly as long as the second item waits — the guard for a window that the first change opens is not follow-up work, it is part of the change. The tell was a reviewer asking *"why are there more items?"*: proliferation of tracking items after a review is often evidence that one change was cut along the wrong seam. See [[stack-work-behind-a-serialized-gate]] and [[under-a-denylist-deploy-order-is-a-security-property]].
