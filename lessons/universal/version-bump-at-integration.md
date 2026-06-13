---
id: version-bump-at-integration
title: Version bumps happen at the integration point, not on feature branches
scope: [universal, stack:git]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
Version numbers are assigned at the commit that integrates a feature branch into the integration branch (e.g. the merge commit onto staging). Feature branches never bump the version. Changelog notes accumulate under an `[Unreleased]` section on feature branches; the integration commit promotes them into a dated versioned section.

**Why:** Parallel feature branches that each bump the version will claim conflicting version numbers — two features that ship in the same integration window would both try to be `v1.5.0`. The only point in the workflow where exactly one version is assigned to exactly one change set is the integration commit. Moving the version bump there eliminates conflicts by construction.

**How to apply:**
- On feature branches: write changelog entries under `## [Unreleased]`. No version bump in `package.json` (or equivalent).
- On the integration/staging merge commit: choose the bump magnitude (patch/minor/major based on what the feature contains), bump the version, and promote `## [Unreleased]` to `## [vX.Y.Z] — YYYY-MM-DD`.
- The pre-commit hook or CI can enforce this by only running the version-bump check on the integration branch, not on feature branches.
- Single source of truth: the version lives in ONE file (`package.json` or equivalent). No hardcoded versions in manifests, docs, about pages, or build-time strings that aren't injected from that single source.
- Related to [[branch-what-deploys]] (both are about what happens at the integration point) but covers versioning specifically.
