---
id: look-up-a-version-in-the-step-that-writes-it
title: Never pin a version from memory — the lookup belongs in the step that writes the pin
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A version number written from recall is stale by construction: training data has a cutoff, and the current release does not. The lookup that would have caught it is one command, so the fix is to make the lookup part of writing the pin, not a later audit.

The incident: a CI workflow was authored with a runtime version already deprecated on the runners it would execute against, and a dependency range pinned 57 minor versions behind current — both chosen from recall, in the same session that had correctly looked up OTHER identifiers it used elsewhere in the same file. The staleness was invisible at write time because a wrong-but-plausible version installs and runs without complaint until something downstream depends on a feature or fix that only exists in a later release, or until the platform finally drops support for the pinned one.

**Why:** a remembered version number carries no signal that it is wrong. It parses, it resolves, it usually still works — right up until it doesn't, at a moment disconnected from when the pin was written. Nothing about the authoring process forces a check, because writing a plausible-looking number feels indistinguishable from writing a correct one.

**How to apply:**
- No version literal enters a file without a lookup performed in the same step: the package registry's version query, the runtime's own release index, or the release API for a repository.
- For runtimes with long-term-support lines, treat "current" as the newest LTS unless told otherwise, and state which you chose and why in the same place you wrote the pin.
- Record the lookup date beside any pin that is expected to drift, so a future reader can tell how stale it might already be.
- When auditing someone else's pin, re-run the lookup yourself rather than reasoning about whether the number "looks recent" — a plausible-looking number is exactly the failure mode this lesson describes.

Related: [[probe-behaviour-not-version-stamps]], [[a-checkout-is-not-the-running-system]], [[verify-a-citation-before-it-becomes-an-assumption]].
