---
id: a-checkout-hook-makes-a-fresh-tree-dirty
title: A post-checkout hook can make a brand-new tree dirty before you touch it — and block the merge you came to do
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 2
---
A repository's post-checkout automation copies shared configuration and documentation files from the integration branch into every new worktree. A worktree freshly created on the production branch is therefore dirty immediately, before any edit happens — and a subsequent merge, the promotion step the worktree was created for, refuses with "local changes would be overwritten." It reads as a broken promotion process when nothing about the promotion logic is wrong.

**Why:** the diagnosis is non-obvious precisely because the dirt predates any human action. Whoever hits this has done nothing yet — created a worktree and immediately tried to merge — so the instinct is to suspect the merge tool or the target branch's state, not a hook that ran silently during checkout.

Because the merge would install the same content the hook already wrote (both are pulling from the same integration branch), the hook-written changes can simply be discarded and the merge retried — with a checkout-restore, not a stash. A stash leaves state to reconcile later, in a worktree nobody will remember to come back to; a checkout-restore just throws the redundant copy away.

**How to apply:**
- When a fresh checkout is unexpectedly dirty, check the repository's checkout automation (`post-checkout` hook, bootstrap scripts) before anything else — before suspecting the merge tool, the branch state, or your own setup.
- Discard hook-written files only after confirming the blocked operation would install the same content anyway — diff the hook's output against what the merge is trying to bring in.
- Promote the specifically named release commit, not "whatever the integration branch's tip happens to be right now" — the two can differ if anything landed on the integration branch after the release commit was cut ([[a-recorded-commit-id-dies-at-rebase]], [[promoter-strategy-must-match-target-history]]).

**Independently confirmed on a second, later promotion, with the exact mechanism identified this time.** A different fresh worktree, a different set of files (agent-definition files this time, rather than the top-level docs and shared config from the first occurrence), same root cause: a developer bootstrap hook that runs on checkout — copying shared config, running installs, and syncing a directory of files from the integration branch — leaves the new tree dirty as one of its ordinary steps, not as a fault. A tool that builds throwaway worktrees for its own automated purposes had already independently discovered the same hazard and deliberately disables that bootstrap step for its own checkouts, which is corroborating evidence that this is a known, systemic property of the hook rather than a one-off.

**Do not confuse this benign dirt with genuine divergence.** A promotion's empty-diff guard can fail for two different reasons that need opposite responses: hook-written dirt (discard it, per above) or real content divergence between the branches (which must be reconciled on its merits, never resolved by assuming one branch simply wins). Clean the hook's dirt first, then evaluate whatever diff remains on its own terms.
