---
id: look-up-a-version-in-the-step-that-writes-it
title: Never pin a version from memory — the lookup belongs in the step that writes the pin
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 2
---
A version number written from recall is stale by construction: training data has a cutoff, and the current release does not. The lookup that would have caught it is one command, so the fix is to make the lookup part of writing the pin, not a later audit.

The incident: a CI workflow was authored with a runtime version already deprecated on the runners it would execute against, and a dependency range pinned 57 minor versions behind current — both chosen from recall, in the same session that had correctly looked up OTHER identifiers it used elsewhere in the same file. The staleness was invisible at write time because a wrong-but-plausible version installs and runs without complaint until something downstream depends on a feature or fix that only exists in a later release, or until the platform finally drops support for the pinned one.

**Why:** a remembered version number carries no signal that it is wrong. It parses, it resolves, it usually still works — right up until it doesn't, at a moment disconnected from when the pin was written. Nothing about the authoring process forces a check, because writing a plausible-looking number feels indistinguishable from writing a correct one.

**How to apply:**
- No version literal enters a file without a lookup performed in the same step: the package registry's version query, the runtime's own release index, or the release API for a repository.
- For runtimes with long-term-support lines, treat "current" as the newest LTS unless told otherwise, and state which you chose and why in the same place you wrote the pin.
- Record the lookup date beside any pin that is expected to drift, so a future reader can tell how stale it might already be.
- When auditing someone else's pin, re-run the lookup yourself rather than reasoning about whether the number "looks recent" — a plausible-looking number is exactly the failure mode this lesson describes.

**A pin that already exists needs a different audit than a pin being newly written: it can be EOL while it still resolves.** Refreshing a pinned CI runtime version by asking only "what's the newest release?" answers the wrong question for an existing pin — it says what to move *to*, never how urgent the move is. An audit of a Node pin, done as part of an otherwise routine bump, turned up a release line that had already reached end-of-life almost five months earlier. Nothing was failing, so nothing had surfaced it: a version index lists every release line that ever shipped, including dead ones, and has no opinion about support status. The support window lives in a SEPARATE artifact — the project's release schedule, with per-line `lts`/`maintenance`/`end` dates. Fetch both and cross-reference: an `end` date in the past means the pin is on an unsupported runtime and the bump is a security item, not housekeeping. This generalizes past runtimes to any dependency with a published support calendar — database engines, distro base images, and framework LTS lines all split "what exists" from "what is still supported" the same way.

**A secondary gotcha from the same kind of audit: sort a tag list on the TAG, not on the line `git ls-remote` prints it as.** Confirming a floating major-version tag exists before pinning to it is a common step in this same audit. `git ls-remote` output starts with the SHA, so a naive version-sort over the raw output sorts hex, and a `head`/`tail` slice of that result is an arbitrary subset — absence from that subset proves nothing about whether the tag exists. Query the specific ref directly (`git ls-remote origin refs/tags/{{TAG}}`) instead of sorting-and-slicing the full list.

Related: [[probe-behaviour-not-version-stamps]], [[a-checkout-is-not-the-running-system]], [[verify-a-citation-before-it-becomes-an-assumption]].
