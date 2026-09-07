---
id: a-checkout-is-not-the-running-system
title: A working copy or an unmerged branch describes what could ship, never what is running — fetch, or query the live system
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
A local checkout answers "what does this tree contain", which is a different question from "what is deployed". Two incidents in one project, three weeks apart, both from reporting a working copy as the running system:

- A schema file was read out of a **stale local clone** and used to assert that an analytics pipeline "discards query strings, so no campaign tag can ever reach us, and there are no campaign columns". Both claims were false: the columns had shipped and deployed weeks earlier, the live handler read them, and rows were already populated. The wrong claim was written into durable notes, and — worse — it was used to "correct" an older document that had been right all along.
- A retirement (deleting a dead service and its auto-registered tool config) was recorded as done. The deletion existed **only on an unmerged branch**. The integration branch still shipped the dead config, so every session still got tools that could never connect, and two agent definitions still granted a capability that did not exist.

**Why:** a checkout is the most available evidence and it looks authoritative — it is real code, on disk, in the right repository. Nothing about reading it announces that it is behind, and the two failure directions are symmetric: a stale tree makes a shipped thing look absent, and an unmerged branch makes an absent thing look shipped. Both then propagate, because the wrong claim gets written down where the next session trusts it.

**How to apply:**
- **Fetch before treating any local file as ground truth about a deployed system**, and read the file at the deployed ref (`git show origin/{{DEPLOY_BRANCH}}:{{PATH}}`), not at your working tree.
- **Prefer querying the live system** over reading any checkout: hit the endpoint, read the store, list what the platform reports. A file says what could run; the system says what does.
- State the ref you read in the finding itself. "Absent on `origin/{{DEPLOY_BRANCH}}` as of {{DATE}}" is checkable; "not in the repo" is not.
- Before recording a removal as complete, confirm it is **merged into what deploys**, and follow the removed thing's dependants — configs that auto-register it, agent definitions that grant it ([[a-pure-wrapper-dies-with-its-service]], [[branch-what-deploys]]).
- When you discover an earlier durable note was wrong, overturn it **explicitly and in place** ([[correct-a-durable-record-explicitly]]) — including any document it wrongly "corrected", which is the part that gets forgotten.
- Distinct from [[grep-the-shipped-artifact-not-the-docs]]: that lesson says the installed artifact outranks documentation. This one says **your checkout is not the installed artifact** — the same discipline one step earlier, and the reason a confident grep can still produce a false answer.
