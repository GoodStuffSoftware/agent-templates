---
id: externally-asserted-fields-are-not-self-reportable
title: A field meaning "someone else asserted this about you" must not be settable by its subject
scope: [universal]
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Records carry two kinds of field, and they need different write paths. **Self-descriptive** fields — a name, a declared capability, a project, a kind — are claims the subject makes about itself, and accepting them from the subject's own registration payload is correct. **Externally-asserted** fields — "an operator asked this participant to correct itself and it has not", a trust level, a moderation flag, a verification badge, a quota override — are claims some other authority makes ABOUT the subject. Exposing one of those on the subject's own write path lets any participant set or clear its own flag, which silently converts the assertion into a self-report and destroys the only thing it was for.

The instance: a registry gained a `{{NEEDS_ATTENTION}}` flag, set by a repair process when a participant had been asked to fix its record and had not. It was implemented at the store layer only, and deliberately NOT added to the public registration handler's body parsing alongside the self-descriptive fields, even though every neighbouring field was accepted there.

**Why:** The two kinds look identical in a schema — same type, same table, adjacent lines — so the natural move when adding a field is to wire it up exactly like its neighbours. The distinction is not in the data; it is in who is entitled to make the claim, which lives only in the field's meaning.

**How to apply:**
- Classify each new field as self-descriptive or externally-asserted before wiring the write path. If the field's one-line description contains "an operator", "the system", "a reviewer", or "was observed to", it is externally-asserted.
- Give externally-asserted fields a separate, authenticated write path (an admin route, an internal function, a repair job) and leave them out of the public payload parser entirely — omission, not validation.
- If a caller genuinely needs to clear its own flag, model that as an explicit *self-correction action* whose handler decides, not as a writable field.
- Flag the choice to whoever owns the design when you make it in passing — it is a security decision that looks like a wiring detail.
