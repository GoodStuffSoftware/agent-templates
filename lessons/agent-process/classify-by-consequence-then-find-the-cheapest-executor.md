---
id: classify-by-consequence-then-find-the-cheapest-executor
title: Classify a task by its true consequence, then find the cheapest executor at that tier — which is often the agent you already have
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 2
---
Deleting a handful of failed CI run records was first classified "low" — a handful of commands — and evaluated as a fit for the cheapest tier. Re-classified honestly as a destructive operation, the routing table asked for the top tier. The resolution was NOT to spawn a premium worker for five commands: the lead was already running at that tier, so it did the one destructive step itself with a per-item check before each delete, and pushed everything else down.

**Why:** effort and volume are the convenient axis and consequence is the correct one; an agent sizing a task by how much typing it involves will systematically under-provision exactly the operations that cannot be undone. And once the classification is honest, "the cheapest executor at that tier" frequently already exists in the session — spawning a new premium worker just to satisfy a tier requirement pays twice, once for the classification and again for a worker that duplicates capability the lead already has.

**How to apply:**
- Classify first, on consequence and reversibility — not on line count, command count, or estimated effort. "Five commands" and "five commands that each permanently delete a record" are different tiers even though they look identical on a task board.
- Once the tier is set, ask who already runs at that tier before spawning anyone. A lead sized for destructive work does not need a delegate to perform destructive work; it needs to do the consequential step itself and delegate everything else down.
- Split a mixed task so only the consequential steps ride the expensive executor — don't drag reversible, low-consequence work up to the same tier just because it shares a batch with something dangerous.
- Gate each irreversible item individually (a per-item confirmation or check before each delete), rather than gating the batch as a whole — a batch-level gate lets one bad item hide behind nine good ones.

**Two further drifts into doing the work at too high a tier, corroborated separately.**

**(a) A coordinating role erodes one cheap command at a time.** A release coordinator drifted into grepping a deploy log, curling an endpoint to settle a version discrepancy, listing processes to check for orphans, and hand-writing a small script — each individually cheap, defensible, and faster to just do than to delegate. Together they turned the coordinator into the technician, and the attention that belonged on release state went into diagnosis instead. **"It's only one command" is the exact rationalization every time, because it is always only one command.** The fix is delegating even single-command diagnosis when the role's job is coordinating, not doing — take the evidence an agent produces and decide; producing the evidence is not the coordinating job.

**(b) Holding a capability a cheaper teammate lacks is not a reason to use it yourself.** A lead was corrected twice in the same session for doing browser verification and screenshot checks itself, specifically because it held tools a validation teammate did not. Possessing a tool that a cheaper executor is missing is a delegation gap to close — unblock the cheaper agent or spawn one with the tool — never a justification for the expensive tier doing the DOING work merely because it happens to have the access. The same test applies as above: if the task's difficulty is in the doing rather than the deciding, it is not work for the tier that already classified it as needing a decision-maker.

Related: [[an-omitted-worker-tier-inherits-the-leads]], [[team-vs-subagent-gate]], [[reviewer-matches-the-tier-it-reviews]].
