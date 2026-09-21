---
id: a-checkout-hook-makes-a-fresh-tree-dirty
title: A post-checkout hook can make a brand-new tree dirty before you touch it — and block the merge you came to do
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A repository's post-checkout automation copies shared configuration and documentation files from the integration branch into every new worktree. A worktree freshly created on the production branch is therefore dirty immediately, before any edit happens — and a subsequent merge, the promotion step the worktree was created for, refuses with "local changes would be overwritten." It reads as a broken promotion process when nothing about the promotion logic is wrong.

**Why:** the diagnosis is non-obvious precisely because the dirt predates any human action. Whoever hits this has done nothing yet — created a worktree and immediately tried to merge — so the instinct is to suspect the merge tool or the target branch's state, not a hook that ran silently during checkout.

Because the merge would install the same content the hook already wrote (both are pulling from the same integration branch), the hook-written changes can simply be discarded and the merge retried — with a checkout-restore, not a stash. A stash leaves state to reconcile later, in a worktree nobody will remember to come back to; a checkout-restore just throws the redundant copy away.

**How to apply:**
- When a fresh checkout is unexpectedly dirty, check the repository's checkout automation (`post-checkout` hook, bootstrap scripts) before anything else — before suspecting the merge tool, the branch state, or your own setup.
- Discard hook-written files only after confirming the blocked operation would install the same content anyway — diff the hook's output against what the merge is trying to bring in.
- Promote the specifically named release commit, not "whatever the integration branch's tip happens to be right now" — the two can differ if anything landed on the integration branch after the release commit was cut ([[a-recorded-commit-id-dies-at-rebase]], [[promoter-strategy-must-match-target-history]]).
