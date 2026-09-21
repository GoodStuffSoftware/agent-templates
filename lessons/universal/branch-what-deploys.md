---
id: branch-what-deploys
title: Branch what deploys; commit dev-config straight to the integration branch
scope: [universal]
requires: {}
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 2
---
Feature/experiment code that ships to users gets its own branch (and a worktree when parallel isolation helps). Dev-config that is *read from the working tree but never deployed* — the agent-tool config dir, rules files (`CLAUDE.md` and friends), docs, tooling scripts — commits straight to the working branch and lands on the integration branch promptly, typically as a `chore`.

**Why:** Branching non-deployed config for "isolation" buys nothing — nothing reads it from a preview — and only creates merge-back busywork. Worse, dev-config stranded on a long-lived feature branch goes stale and isn't coupled to that feature's review/merge timeline, so it blocks on the wrong gate.

**How to apply:**
- If a change alters what users get → branch it.
- If it only changes how agents/tooling behave locally → commit it on the working branch and land it on the integration branch right away as a `chore`.
- If the working branch has **diverged** from the integration branch (integration moved ahead), do NOT merge the whole branch to land dev-config — that would revert shipped work. **Cherry-pick only the dev-config commits** onto the integration branch instead. See [[verify-merge-direction]].

**The same principle shows up in a neighbouring shape: which REF a runner reads, not which branch a change lives on.** A scheduled cloud runner clones the repository's default branch fresh on every run. Anything the scheduled job needs — its scripts, its configuration, the tooling it invokes — has to exist on that default branch, not on the feature branch where it was developed and tested, because the schedule never checks out anything else. Interactively, running the same script from a feature-branch checkout works fine, since the interactive checkout already has the branch. On a schedule it fails, in a way that looks like an environment problem rather than a branch-topology one.

A routine that works when run by hand and fails only when run on a schedule is usually this exact shape.

**How to apply (continued):**
- Before assuming a scheduled or automated runner sees your change, identify which ref it actually checks out (default branch, a pinned tag, a specific SHA) — a scheduler's checkout target is rarely "whatever branch I'm working on."
- If a scheduled job's own tooling needs a fix, land that fix on the ref the schedule reads, the same way dev-config lands on the integration branch promptly rather than waiting on a feature branch's merge.
