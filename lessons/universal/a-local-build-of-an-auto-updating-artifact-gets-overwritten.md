---
id: a-local-build-of-an-auto-updating-artifact-gets-overwritten
title: A locally built fork of an auto-updating artifact carries a placeholder version — the updater will overwrite it
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A locally built fork of software that auto-updates itself can carry a version number that reads as OLDER than the official release, even though the fork's code is newer — and the artifact's own updater will then silently replace the fork with the official build.

The incident: a project's release pipeline stamps the real version into the build artifact at release time, in a step that a plain local build never runs. A locally built fork therefore ships with the repository's checked-in placeholder version. That placeholder compares as older than the live release, so the auto-updater — which only compares version numbers, not content or build provenance — treats the fork as out of date and quietly replaces it with the official build on next launch. The maintainer, seeing their patch gone, concludes "it did not work," when in fact it worked and was then overwritten by design.

**Why:** the version-stamping step is part of the release pipeline, not part of the build — a local build has no reason to know it needs to run it, and nothing about a successful local build signals that the artifact's self-identification is wrong. The updater is doing exactly what it is supposed to do; the bug is a mismatch between what a build produces and what an update check trusts.

**How to apply:**
- Before deploying any locally built fork of an auto-updating artifact, either stamp the real upstream version the way the release pipeline does, or disable the updater for that component first.
- Keep the updater on afterward as a safety net rather than leaving it off indefinitely, but pair it with a pre-launch step that rebases, rebuilds, and redeploys the fork with backups — falling back to the official files on conflict — so the safety net doesn't silently erase the patch again.
- Determine the actual installed version from the artifact's own metadata at runtime, never from a task description, a tag, or what you last remember deploying — a stale version hint can also send a maintenance branch off the wrong base entirely ([[probe-behaviour-not-version-stamps]]).

Related: [[a-version-bump-does-not-invalidate-every-cache]], [[one-switch-two-effects-autoupdate]].
