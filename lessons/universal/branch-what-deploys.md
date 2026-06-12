---
id: branch-what-deploys
title: Branch what deploys; commit dev-config straight to the integration branch
scope: [universal]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
Feature/experiment code that ships to users gets its own branch (and a worktree when parallel isolation helps). Dev-config that is *read from the working tree but never deployed* — the agent-tool config dir, rules files (`CLAUDE.md` and friends), docs, tooling scripts — commits straight to the working branch and lands on the integration branch promptly, typically as a `chore`.

**Why:** Branching non-deployed config for "isolation" buys nothing — nothing reads it from a preview — and only creates merge-back busywork. Worse, dev-config stranded on a long-lived feature branch goes stale and isn't coupled to that feature's review/merge timeline, so it blocks on the wrong gate.

**How to apply:**
- If a change alters what users get → branch it.
- If it only changes how agents/tooling behave locally → commit it on the working branch and land it on the integration branch right away as a `chore`.
- If the working branch has **diverged** from the integration branch (integration moved ahead), do NOT merge the whole branch to land dev-config — that would revert shipped work. **Cherry-pick only the dev-config commits** onto the integration branch instead. See [[verify-merge-direction]].
