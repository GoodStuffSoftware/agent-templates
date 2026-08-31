---
id: reviewer-matches-the-tier-it-reviews
title: A reviewer runs at the tier of what it reviews, adversarially, and often at higher effort
scope: [agent-process]
requires: {}
status: active
since: 2026-08-28
provenance: [contrib-1]
corroborated: 1
---
Size a reviewer to the **writer it gates**, never below it. Whatever tier the task's type and weight justified for the architect or builder, the reviewer gets the same model. Task type and weight set the tier once; both roles inherit it. Effort may go **higher** for the reviewer — refutation is a search problem, and a reviewer that must find a subtle flaw benefits from more thinking than the writer needed to produce it.

**Why:** The tempting argument is that verification is easier than generation, so a cheaper reviewer suffices. It fails exactly where it matters. A weaker reviewer reliably catches the errors it would itself have avoided, and waves through the ones it would itself have made — which is precisely the class of *novel* error a stronger writer produces. So the saving is taken at the one point the gate was supposed to pay for itself, and what gets through is the expensive kind: the subtle, the architectural, the plausible-but-wrong. A gate calibrated below the thing it guards is a formatting check wearing a reviewer's name.

The failure is invisible in the usual metrics. A cheap reviewer approves faster and complains less, which reads as an efficient pipeline right up until a defect it was never equipped to see reaches production.

**How to apply:**
- Match the model: haiku writer → haiku reviewer; sonnet → sonnet; opus → opus. A warranted premium-tier writer gets a premium-tier reviewer, and the warrant covers both.
- Effort may differ, and when it does it should differ **upward**. A reviewer at `xhigh` against a writer at `high` is a deliberate, defensible choice; the reverse is not.
- Frame the pass adversarially — "try to refute this" — and require concrete work: run the tests, grep the consumers, trace the call path. A reviewer that only reads the diff adds latency, not assurance.
- Escalate blast radius on **both** roles together. Production data, migrations, destructive operations, security or permission boundaries, and subtle-correctness territory (concurrency, sync/merge, money) raise the writer *and* the reviewer. Escalating only the gate leaves a weaker writer still producing the risky change — the gate was never the part that needed to be smarter.
- When the orchestrator already runs at the matching tier, it can serve as the adversarial pass itself at no extra spawn cost.
- Audit rosters for this directly: any agent whose name marks it a reviewer, pinned below the highest-tier writer in the same roster, is a finding. It is mechanical to check and easy to let drift, because nothing about a cheap reviewer looks wrong until it misses something.
- Audit the OMISSIONS in the same pass. A reviewer with no tier set is not "matched by default" â€” it inherits the orchestrator's, which is a different rule that happens to agree sometimes ([[an-omitted-worker-tier-inherits-the-leads]]).
