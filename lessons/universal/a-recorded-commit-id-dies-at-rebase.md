---
id: a-recorded-commit-id-dies-at-rebase
title: A recorded commit id dies at rebase — verify shipped work by branch tip and commit subject
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A board audit checked whether three finished work items had shipped by asking whether each item's recorded commit id was an ancestor of the integration branch. All three answered **no**. All three had shipped, some of them to production. Every branch had been rebased before merge, so the recorded ids existed only on pre-rebase backup refs.

**The failure is silent and confident, which is the worst combination.** An audit that trusts the ancestry check will "discover" that shipped features never landed, and may reopen or re-implement them.

**How to verify instead, in descending order of reliability:**
1. **The branch TIP on the remote** — resolve the branch by name, then test ancestry on that.
2. **The commit SUBJECT** — a rebase preserves the message, so grepping the integration branch's log for the subject finds the landed copy.
3. **The merge commit**, which names the source branch.
4. **File presence on the ref** — but note that paths move during review (a design directory renamed to a specs directory on two of the three items above), so an absent file is not proof of absent work either.

**The adjacent trap, from the same audit:** a branch claimed "fully absorbed, safe to delete" was not. Three branches each carried a commit with an identical subject but different content lineage, and a subject-level comparison read that as absorption. **Subject matching proves a rebase landed; it does NOT prove a branch is redundant.** Before any branch delete, run the tool that compares patch content against the branch you believe absorbed it.

**How to apply when writing the record:** name the BRANCH and the commit SUBJECT, not just an id — and if you rebase before merging, update the record. An identifier that your own process rewrites is not an identifier ([[match-ids-not-dates]]).

Related: [[promoter-strategy-must-match-target-history]], [[verify-at-destination-prove-the-target]], [[a-checkout-is-not-the-running-system]].
