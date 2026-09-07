---
id: promoter-strategy-must-match-target-history
title: An automated promoter's merge STRATEGY must match the target branch's history model — and it performs its gate, not your process
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
A "promote branch A into branch B" automation implements one strategy. If it **rebases** and the target's history is built from **merge commits**, the rebase replays your commits over commits that already contain them, and it fails — with a conflict message about renames, deletes or binaries — *before any test runs*. The error names files, so it reads as a content conflict in your change. It is not: it is a strategy mismatch, and no amount of conflict resolution fixes it.

Three things the automation did not do, observed across one release:

1. **Promotion to the production branch was refused** for exactly this reason. The working path was a local `--no-ff` merge in a dedicated worktree, verified by an empty diff against the source, pushed to the target ref, then tagged. The push-time hook ran the full suite once for the merge tree.
2. **A lagging source branch was refused** even though it rebased cleanly by hand. Rebasing locally first — with a backup ref pushed before any force update — made it a descendant, and the same automation then took it straight into the gate.
3. **The gate created none of the process's own side effects.** The release marker commit that downstream version listings key on was never written, so the released version was invisible to every "what shipped?" view until it was pushed by hand.

**Why:** the automation's contract is "run the gate and move the ref", which is a smaller thing than "perform our release process". Both gaps are silent in opposite ways — the strategy mismatch is loud but misdiagnosed, and the missing side effect is completely quiet, because everything the tool promised did happen.

**How to apply:**
- Know your target branch's **history model** (merge commits versus linear) and confirm the promoter's strategy matches it. If it does not, do the merge locally and push the resulting ref; the automation is then only worth using for branches whose shape it fits.
- Read a promoter's conflict error as a **strategy** question first. A rename/delete/binary conflict that appears before any test ran is about replay, not about your diff.
- **Rebase a lagging source branch onto the target's tip yourself**, back it up first, and re-run — a descendant goes straight into the gate ([[push-rebased-branch-before-gates]] where a project has such a rule).
- Enumerate every **side effect your process expects but the tool does not perform** — release markers, tags, changelog promotion, notifications — and either automate them or put them in the runbook. Verify at the destination, never from the tool's success ([[verify-at-destination-prove-the-target]], [[green-means-not-broken]]).
- Before any destructive git against a pushed ref (the force-with-lease in step 2), create **and push** a dated backup ref and confirm the push landed. That is one command and it is the difference between a recoverable and an unrecoverable mistake.
