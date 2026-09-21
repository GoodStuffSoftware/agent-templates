---
id: a-fresh-grant-403s-during-propagation
title: An access error immediately after setup is not proof the setup was wrong — and a name inferred from the wrong identifier 404s like a missing resource
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Two different-looking failures share one root mistake: reading an infrastructure error as a verdict on your configuration before you have separated "not yet reachable" from "actually wrong."

**Face one — propagation lag.** A freshly granted service-account permission can return an authorization error for up to roughly a day while the grant propagates through the provider's backing systems. An agent that reads that error as misconfiguration re-issues the grant, changes the role, or rebuilds the credential — undoing correct work and adding a second, unrelated variable to whatever investigation follows, so that when the original grant finally does propagate, the fix gets credited to the wrong change.

**Face two — the wrong identifier class.** A cloud storage bucket, or any resource whose name is derived from an identifier, may be keyed to a different identifier class than you assumed — a developer-account identifier rather than an application identifier, for instance. Guessing the name from the wrong identifier class produces a not-found that looks exactly like "the resource does not exist" or "the feature isn't enabled for us," when the resource is sitting right there under a different, correctly-derived name.

**Why:** both failures present as unambiguous negatives (`403`, `404`) that invite an equally unambiguous read — "denied" or "missing" — when the truer state is "not yet visible from here" or "misaddressed." Acting on the unambiguous read is strictly worse than waiting, because it adds churn on top of a system that was already going to resolve itself.

**How to apply:**
- Before re-issuing a grant, record when it was made and wait out the documented propagation window (check the provider's own docs for the number — treat "roughly a day" as a starting guess, not a rule), testing periodically rather than changing anything else in the meantime.
- When a resource name is derived from an identifier, confirm which identifier class the provider's documentation actually specifies before constructing the name, and verify by LISTING at the parent scope rather than guessing and testing individual names.
- State either failure as "not yet reachable as of {{TIME}}" rather than as a configuration verdict — see [[scope-a-broken-finding-to-the-measured-path]] for the general form of scoping a finding to what you actually measured, and [[absence-observed-is-not-absence-explained]] for the same discipline applied to "it's not there" claims.
- Apply [[read-which-error-fired-before-theorising]] before either fix: a `403` and a `404` are different observables that rule out different theories, and neither one, on its own, proves the grant or the name was wrong.
