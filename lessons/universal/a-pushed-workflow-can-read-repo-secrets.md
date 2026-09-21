---
id: a-pushed-workflow-can-read-repo-secrets
title: Repository secrets are readable by a workflow pushed to any branch — scope them to a protected environment
scope: [universal, stack:github-actions]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Letting an automated agent push to a restricted branch namespace feels bounded — it can only land code where you said it could. It is not bounded with respect to secrets: if a principal can push a branch, it can push a WORKFLOW FILE on that branch, and a push-triggered run executes the pushed branch's own copy of the workflow, with the full set of repository-wide secrets available to read and exfiltrate.

The incident: an agent was granted push access scoped to a branch-name prefix, on the theory that this limited its blast radius to that namespace. A push-triggered CI workflow, however, is not sandboxed to the state of the target branch at grant time — it runs whatever workflow file the pushed commit contains, and that workflow can print or upload any repository secret the job's token can see. Branch-namespace restrictions constrain WHERE code lands; they say nothing about WHAT a workflow running from that branch may subsequently read.

**Why:** the mental model "push access is scoped to a branch pattern" quietly substitutes for "push access is scoped to a set of files or effects." A workflow file is just another file in the branch, and CI does not distinguish "code the agent wrote" from "code that reads secrets" — both execute with the same job-level credentials.

**How to apply:**
- Put privileged credentials in a deployment **environment** restricted to the default branch (or another protected ref), never in repository-wide secrets that any workflow run can see.
- Trigger the privileged job by schedule or from a run on the default branch, never directly from the branch the automated agent can push to.
- When threat-modelling an automated contributor, treat "can push any branch" as equivalent to "can read every repository-wide secret" — because it is, the moment that branch can trigger a workflow.
- Related, for a model-in-the-loop job on a PUBLIC repository: CI logs are themselves public, so a leak-detection gate that echoes the offending text to explain itself publishes the very leak it just caught. Report the CATEGORY of the finding only when running in CI (detect via the CI environment variable), and reserve the actual matched text for a local-only run ([[credentials-never-reach-an-error-path]]).
- See also [[an-omitted-scope-defaults-to-everything]] (a scope left unset defaults to the maximal grant), [[under-a-denylist-deploy-order-is-a-security-property]] (the order two controls run in can itself be the difference between blocked and not), and [[withhold-at-the-payload-not-in-the-prompt]] (withhold secrets at the point of use, not by asking nicely upstream).
