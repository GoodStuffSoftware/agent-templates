---
id: choose-branch-model-deliberately
title: Choose a branch/deploy model deliberately to fit the project's shape; don't assume a staging tier
scope: [universal]
status: active
since: 2026-06-12
provenance: [contrib-1, contrib-2]
corroborated: 2
---
Two valid deploy models exist; choose deliberately based on release cadence and team size rather than defaulting to the heavier one:

- **Feature-branches + per-branch previews** — each feature branch gets an automatic preview URL from the hosting platform; there is no staging branch. Simpler, fits small teams and content-heavy sites with continuous deployment.
- **Three-tier (feature then staging/integration then production)** — a long-lived staging branch accumulates shippable features before they reach production. Fits apps with coordinated multi-feature releases, longer QA windows, or strict version-tagging cadences.

**Why:** Imposing a staging tier on a simple site adds merge-back busywork and a new class of "stale branch" failures with no benefit — per-branch previews give the same isolation without the overhead. Conversely, going directly feature-to-production on a complex app with coordinated schema migrations and mobile releases loses the integration buffer that prevents partial-state deploys. The choice has significant architectural consequences (worktree patterns, version-bump timing, how dev-config lands) — making it explicitly is the lesson.

**How to apply:**
- Decide the model at project inception and record it in the deploy doc or CLAUDE.md.
- Per-branch preview projects: features merge directly to `main`; preview URLs provide isolation; no staging branch.
- Staging-tier projects: feature branches merge to staging only when fully complete (no per-slice merges); staging merges to main on a cadence; version bump happens at the staging-merge commit (see [[version-bump-at-integration]]).
- Either model must still obey [[branch-what-deploys]] (deployed code gets its own branch; dev-config commits straight to the integration branch).
