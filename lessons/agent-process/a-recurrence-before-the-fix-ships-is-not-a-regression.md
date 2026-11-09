---
id: a-recurrence-before-the-fix-ships-is-not-a-regression
title: A recurring error is a regression only if its fix has shipped — check the fix against the release branch first
scope: [agent-process]
requires: {}
status: active
since: 2026-11-09
provenance: [contrib-2]
corroborated: 1
---
A monitoring routine that reopens a closed issue, files a task and alerts whenever a "resolved" error group reappears will cry regression for every fix that is merged but not yet released. The recurrence is just the old build still running.

**How to apply:**
- Record the fixing commit(s) on the group when it is marked resolved.
- On recurrence, check each commit against the release branch (`git merge-base --is-ancestor <sha> origin/{{RELEASE_BRANCH}}`).
- Not on the release branch: label it FIX-NOT-SHIPPED. No reopen, no task, no alert; one digest line; close any duplicate issue the run just opened.
- On it, or no ref recorded: REGRESSION as before. A sha that can't be found: REGRESSION plus a warning.

**Incident:** a daily digest raised regression alerts for errors whose fix sat on the staging branch awaiting release.
