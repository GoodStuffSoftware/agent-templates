---
id: fix-the-doc-not-the-security-matcher
title: Do not broaden a security matcher to fix a documentation bug
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
When a piece of written guidance and a security matcher disagree about the same fact, only one of them is safe to widen. Fix the guidance; leave the matcher's narrowness alone unless a separate review says otherwise.

The incident: onboarding instructions and an approval hook both hardcoded the same tool-name prefix as the way to recognize a particular capability. The prefix turned out not to be stable — the identical endpoint, reached through a different registration path, arrived under an arbitrary per-installation identifier that no fixed string could match. The tempting fix was to widen the hook's auto-approval pattern so it also accepted the other prefix shape. That identifier carries no marker of which component issued it: a generic match would auto-approve ANY server that happened to expose a same-named tool, not just the intended one. The correct fix was to update the instructions to teach discovery instead of a fixed prefix ([[static-instructions-teach-discovery]]), and to leave the approval surface as narrow as it was — recording the rejected alternative as a decision so the next person who notices the same mismatch does not re-propose widening the matcher.

**Why:** an approval pattern and a piece of documentation can both be "wrong about the same fact" at the same time, and only one of them fails safe when you widen it. The pressure to edit the matcher comes from it being the thing that visibly misbehaves — the doc's staleness is silent, the hook's rejection is loud. Loud does not mean at-fault.

**How to apply:**
- When a security matcher and a document disagree with observed reality, fix the document first, and ask **separately** — as its own decision, not a side effect of the doc fix — whether the matcher's narrowness is actually a defect.
- Never widen a matching pattern whose new members you cannot enumerate in advance. If you cannot list what else would now match, you cannot bound what you just approved.
- Record the rejection, with its reasoning, next to the matcher (a comment, a decision log entry) — an unrecorded "we considered and declined this" is exactly what gets silently undone by the next well-meaning pass ([[record-intentional-absence]]).
- Treat a duplicate or oddly-shaped entry surfaced by an unauthenticated or per-installation listing as expected noise, not as grounds to loosen a gate — see [[an-unauthenticated-duplicate-entry-is-not-an-outage]] for the sibling mistake of over-reacting to a listing artifact.
- Before trusting any fixed-string enumeration of a capability surface at all, check whether that surface is scope-filtered per caller ([[guard-coverage-enumerate-issuing-surfaces]]) — a lot of these mismatches start from an implicit assumption that "the" prefix is universal.
