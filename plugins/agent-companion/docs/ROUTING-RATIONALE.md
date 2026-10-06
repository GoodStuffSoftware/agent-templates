# Why the routing table is shaped this way

`docs/ROUTING.md` is generated from `config/model-tiers.json` and cannot carry
hand-written prose — regenerating it would wipe anything typed directly into
it. This is the companion doc that carries the reasoning: not what the table
says (ROUTING.md, live), but why it says it. Update this file by hand when the
reasoning changes; update the config (then regenerate ROUTING.md) when the
answer changes.

## Lowest sufficient tier, not the strongest available one

The table's one governing rule: score the task's **weight** on a 1–5 scale
and route to the *lowest* tier that can do the work, not the one most likely
to impress. Over-provisioning — reaching for a heavier model "to be safe" — is
treated as a rule violation, not a safety margin, because the cost is not
symmetric: a model too weak for the task fails visibly and gets escalated; a
model too strong for it just burns budget silently, every time, forever. The
weight scale runs from a single read or lookup (1) through a bounded,
well-specified feature (3) to genuinely novel design or architecture work (5).
Round down on uncertainty and escalate on a demonstrated failure, rather than
rounding up on a guess.

## Effort is a second, orthogonal lever

Model tier answers "how much capability does this need." **Effort** answers a
different question: "how much does the answer benefit from search." The two
are genuinely independent — a mechanical, one-right-answer change (a rename, a
config edit, applying a known migration) and a hard diagnostic search (a flaky
test, an unexplained regression) can touch the same number of files and
deserve completely different amounts of thinking. The table captures this as
a **kind** axis (mechanical, bounded, diagnostic, novel-design) that shifts
effort up or down independently of the model the weight already picked.

The important operational fact: **effort scales the model's entire output**,
not just its visible reasoning — thinking tokens, the answer itself, and every
tool call it makes all inflate together as effort rises. This is why a
routing table needs the axis to be explicit and deliberate rather than
"however much the model feels like doing": an unconsidered `max` on a
mechanical task is not more careful, it is the same answer produced more
slowly and at several times the cost.

## Fable is an exception, never a routing destination

The table has exactly three tiers a task can be *routed* to — cheap, mid,
capable — plus one tier that is deliberately not a routing destination at
all. The most expensive available model sits outside the weight ladder on
purpose: it is reserved for a stated warrant ("weight *N* — here is why a
cheaper tier provably cannot do this"), never a default outcome of scoring a
task. Two properties keep it exceptional rather than aspirational: it is
enforced (a spawn requesting it without a warrant is refused, not merely
discouraged), and the warrant has to name a *specific* cheaper-tier failure,
not general task difficulty — "this is hard" is not a warrant, "opus at
higher effort was tried and fell short" is.

## Reviewer parity: max(writer, floor), capped

A reviewer is sized to the change it is gating, never discounted below the
writer that produced it. The reasoning is asymmetric in a way that matters: a
reviewer weaker than its writer catches the errors it would itself have
avoided anyway, and waves through the ones it would itself have made — which
is exactly the class of *novel* error a stronger writer is likely to produce.
Discounting the reviewer saves money precisely where the review was supposed
to earn its keep.

The rule in practice is `max(writer's tier, the change's consequence floor)`,
then capped: the reviewer's model starts at the writer's model and its effort
at the writer's effort; effort may go *higher* than the writer's (refutation
is its own search problem and can need more passes than generation did) but
must never drop below it. A critical-consequence change then raises that
floor further — never below the table's top consequence floor, regardless of
what the writer happened to run at. The cap runs the other way: since the
warranted-exception tier is never a routing destination, a reviewer is never
silently escalated *into* it either — a writer on that tier gets the best
tier that *is* a routing destination as its reviewer, which still demands its
own warrant rather than inheriting the writer's.

## Self-review: an architect-class writer spawns its own parity reviewer

Parity says how big the reviewer is. Self-review says who spawns it. For the
architect-class types listed in `selfReview` (novel-design and
critical-change since 2026-10-02; large-refactor and long-autonomous-run were
listed until then), the writer commits and spawns one
foreground reviewer on its own rung, runs one fix round, and returns the
reviewer's verdict line verbatim with the review path, the post-fix sha and
any findings it disputes. The lead is out of the first review pass, not out
of the decision.

**Why the writer, not the lead.** A lead-routed review costs two extra lead
round-trips: spawn the reviewer, then message the writer for the fixes. Each
waits for the lead to be free. Done by the writer, the fix round needs no
round-trip and no hand-back (the writer already holds the diff), and the lead
sees a reviewed diff instead of an unreviewed one. The
cost is the same reviewer either way, because parity sizes it to the writer
in both cases.

**The risk, and what holds it.** A writer frames its own review: it could
scope the reviewer away from its weak spots, summarise the change in its own
favour, size the reviewer below itself, or paraphrase a `FIX` into a pass.
The writer composes the reviewer's brief and relays the verdict, so none of
that is prevented; what exists is instruction, a few checks, and evidence
the lead can read:

- The instructions are fixed and generated, not written by the writer: they
  tell it to give the reviewer the lead's brief verbatim, the diff range and
  a refute-this instruction, to add nothing that narrows the review, and to
  return the verdict line verbatim.
- The spawn guard checks what it can see at the reviewer's spawn: a
  `WRITER:` line below the writer's own pair gets a note, a critical-change
  writer's review is floored by F1 (opus at xhigh or above), and a writer
  with no `WRITER:` line is sized from its own definition.
- The lead checks the rest: the reviewer's actual brief is the first user
  record of its transcript (`<session>/subagents/agent-<id>.jsonl`), its
  `spawns.jsonl` row joins to the writer's (`caller_tool_use_id` = the
  writer row's `tool_use_id`), and the relayed verdict line should match the
  first line of the review file. A writer that returns with no review file
  skipped its review. The lead also settles disputed findings and lands the
  work.

**Bounded, not recursive.** The protocol says a writer never re-reviews after
its fix round and a reviewer never spawns a reviewer, so the intended chain is
writer -> reviewer and a disagreement ends at the lead. The spawn guard
enforces the second rule only, and only one level up: it denies a
`TYPE: code-review` spawned by an agent whose own spawn row, found by the id
of the Agent call that started it, says it was a review. When the guard
cannot tell, it allows. A false deny would stop a writer's legitimate review,
and the protocol already tells a reviewer not to spawn one. A second review,
a review spawned without a `TYPE:` line, or one routed through a helper are
not caught; they show up in `spawns.jsonl`.

**Why the protocol is generated into the rung.** A writer can only follow a
protocol it can see, and the routing table decides which rung a type lands
on. So the text lives in the body of every ladder rung that is currently the
default for a listed type, generated from the config, and the drift check
fails when a table move leaves it on the wrong rung. It sits with the task
types so the two move together. The shipped files cannot follow a routing
profile or a local table override, so a listed type spawned on any other
ladder rung gets the same generated text appended to its brief at spawn,
sized to that rung. A built-in type pins no effort, so it gets a note
instead, and a project agent keeps its own wording.

**Why not medium-effort writers yet.** The saving is lead round-trips, and
the cost is a parity reviewer spawned on every such task, including ones the
lead would have waved through. For architect-class work a review is always
warranted. For bounded work that is not yet shown, so it is measured first
(`self_review`, `self_review_expected` and `review_by_subagent` in
`spawns.jsonl`).

## Consequence floors: six things that never depend on difficulty

Difficulty and consequence are close to orthogonal — a one-line production
migration is trivial by *kind* (mechanical, small answer space) but severe by
*consequence* (hard or impossible to undo if wrong). A floor applied only by
kind would push effort *down* on exactly the change most likely to hurt, so
the table applies consequence floors **after** the kind adjustment, so they
cannot be undercut by it. Each floor protects a specific failure mode:

- **F1 — critical-consequence floor.** Production data, migrations,
  destructive operations, security/permission boundaries, auth, billing,
  secrets: floor the model and effort at the table's top tier regardless of
  what the raw weight/kind would have picked. Inviolable.
- **F2 — no silent premium routing.** The warranted-exception tier is never a
  destination a layer can land on by default; a candidate naming it is
  skipped rather than honoured. Protects the warrant requirement from being
  routed around.
- **F3 — reviewer parity.** The max(writer, floor) rule above, formalised as
  its own floor so it composes correctly with F1 and F2 rather than being a
  special case bolted on afterward.
- **F4 — availability.** A candidate naming a model that is not in the tier
  table, that is unavailable with no staged replacement, or an effort level
  the model does not accept, is not passed through silently — it is skipped
  or refused, so a bad route fails as a visible finding instead of a spawn
  that breaks at runtime.
- **F5 — elevated-consequence effort floor.** Softer than F1: an elevated
  (not critical) consequence floors *effort* only, and — unlike the other
  floors — may be waived by one row that carries its own waiver whose
  evidence is first-hand and operator-observed, never by default and never
  touching F1. Two kinds of row can carry it: a per-user profile row, and a
  shipped routing-trial row. The waiver covers only the task type on that
  row; the floor itself does not move for any other route. `integration` is
  the only shipped trial row that carries one (see below), and a test pins
  that set.
- **F6 — architecture-class floor.** A task type flagged as architecture work
  (`integration`, `large-refactor`, `novel-design` and `critical-change`
  ship flagged; a user's own local type can carry the flag too) never
  resolves to opus/low, at any layer.
  Architecture work needs sustained reasoning even when an F5 waiver is in
  play, so F6 is not waivable. At the trial and grid layers it raises the
  effort to medium. A profile row naming that route is refused instead,
  when written and when read, so a hand-edited row cannot hide the mistake
  behind a silent raise. The shipped table never reaches F6 today; it is a
  backstop against a future config mistake or an over-broad waiver.

## Trials and per-user profiles

The shipped table is deliberately not the only voice in a routing decision.
Above the plain weight/kind/consequence grid sit two optional layers, each
narrower and more provisional than the one below it:

- A **routing trial** is a benchmark-backed override for one named task type,
  carrying its own evidence, a start date, and a review-by date. It exists so
  a measured finding ("this task type does better at a different model/effort
  than the plain grid would pick") can ship as data immediately, without
  waiting for the grid itself to be re-derived, and so it stays visible as
  provisional rather than being quietly folded into "how things have always
  worked."
- A **per-user routing profile** sits above even a trial: a machine- or
  operator-specific row recording what actually worked for *this* user's own
  tasks, distinct from a generic benchmark. It only applies when it is not
  stale, breaks none of the inviolable floors, and the mechanism is turned
  on — a file that fails to parse or validate is ignored as a whole and the
  shipped table answers, rather than a half-applied override silently
  changing behaviour.

Both layers are explicitly reversible and time-boxed rather than permanent
amendments to the table, which is what makes it safe to try a change before
being sure of it.

**Why `integration` sits at medium.** In 0.29.2 the `integration` trial
moved from opus/high to opus/medium on an operator decision: the operator
judged high heavier than day-to-day integration work needs, and first-hand
experience says the work should stay on opus rather than move to a cheaper
model. Medium is below the elevated-consequence floor (F5, high), so the
trial row carries its own operator-observed F5 waiver. The floor was not
lowered, because that would have moved every other elevated route too.
`critical-change` stays at opus/xhigh under F1. The move is unmeasured by
benchmark and is reviewed on 2026-09-30, the trial's review-by date.

**The 2026-09-27 amendment (trial v3).** An operator-local live study
(789 real subagent spawns, 2026-09-21 to 09-27), a hard architecture
benchmark task and Artificial Analysis moved four rows. Their review-by date
moved to 2026-10-04, so the review sees a week of data on the new routes
rather than three days; every other trial row still reviews on 2026-09-30:

- *Opus low is a capability choice, not a price one.* Synthetic tasks had put
  Opus 5.5 low at 0.75-0.9x Sonnet 5's cost; real-world tasks measured
  1.05-1.53x Sonnet 5 medium at API prices (median 1.28x). (Superseded for the
  five simple types by the 2026-10-02 correction below.)
- *`bounded-feature` and `debug-root-cause` move to opus/medium.* Low to
  medium is the largest cheap capability step on Artificial Analysis (+9
  index points; Terminal-Bench 0.31 to 0.53), and on the hard architecture
  task opus/low passed the hidden tests 2/4 and the blind design judge 1/4.
  At about $1.29 per opus/low bounded-feature spawn in live use, the move
  costs about $1 more per spawn; debug-root-cause had no opus/low spawns in
  the study, so its cost change was not measured live.
- *`large-refactor` and `novel-design` move to opus/xhigh.* (`large-refactor`
  moved on to opus/high on 2026-10-02, see the correction below.) On the
  subtle-rule architecture task only xhigh passed 4/4 (high 2/3, medium 2/3,
  low 2/4) and was also perfect on the design judge. In live use, reviews at
  xhigh were clean 26/26 against 18/21 at high (suggestive, p≈0.08), and
  raising churning
  sessions to xhigh by hand eased the churn in 3 of 6. It costs about 2x high
  per spawn.
- *Nothing routes to max by default.* Artificial Analysis gives max +2 index
  points over xhigh for 1.73x the cost, and +0 on agentic coding.

Reviewer parity follows the writers up: `recommend` and `evaluate` size a
reviewer to the writer, so a writer at xhigh gets a reviewer at xhigh or
above and xhigh reviews are no longer confined to critical changes. Nothing
enforces this at spawn time yet (the spawn guard checks only the
critical-change floor, since a brief names no writer); that is a follow-up.
Live xhigh reviews cost in line with pre-trial xhigh reviews (about 1.25x,
a thin sample); what grew was the number of reviews.

**The 2026-10-02 correction (trial v4).** The 2026-09-27 amendment kept
`explore`, `mechanical-edit`, `subagent-worker`, `verify` and `operate` on
opus/low on the premise that opus/low costs about the same as Sonnet on the
plan. That premise was wrong. Cache reads cost the same on both models, so
opus/low runs about 1.2-1.55x Sonnet 5 *medium*, and the gap against
sonnet/low and haiku is wider. These five types now route to the cheapest
tier that does not cause rework, as a new trial (`trialVersion: 4`, since
2026-10-02, review by 2026-10-16):

- `explore` and `verify` go to haiku. They only read or check and change
  nothing, so a wrong answer is caught by the next step, not shipped.
  Haiku validates; it does not operate, so it is limited to these two.
- `mechanical-edit`, `operate` and `subagent-worker` go to sonnet/low. They
  change things, and Sonnet 5 passed every synthetic task at every effort.
- `large-refactor` and `long-autonomous-run` go from opus/xhigh to opus/high
  (same trial window). Last week's data: xhigh cost 17.7 plan units per spawn
  with 21% re-spawned, against high at 16.6 with 10% re-spawned.
  `novel-design` and `critical-change` stay on xhigh (critical-change on xhigh:
  n=4, no re-spawns).
- Self-review is narrowed to `novel-design` and `critical-change`: a reviewer
  cost 9.85 plan units per spawn on xhigh against 3.78 on opus/medium, 172
  units in the week, so the other two types go back to a lead-routed review.
- Every other type is unchanged, in particular `bounded-feature`,
  `integration` and `debug-root-cause`, whose case is capability.

**Haiku retirement is flag-driven.** Anthropic says Haiku 4.5 retires "no
sooner than" 2026-10-15, so it may stay available longer. `tiers.haiku.retiresAfter`
therefore drives warnings only (the scout's `model_retirement_approaching`
signal, daily once the date has passed). The routing table falls back to the
staged replacement (sonnet/low) only when `tiers.haiku.retired` is `true`,
which the operator sets after confirming that haiku no longer resolves.

## Cost basis: dollars, not a price-weighted token count

An index that weights token counts by list price sounds like a cost measure
but silently misrepresents anything with an unusual mix of thinking vs.
output vs. cached-read tokens — a documented failure of exactly that kind
under-counted a more expensive tier's real cost, because that tier's actual
token mix was worse for a token-weighted index than its retail price alone
would suggest. The fix is to cost every routing decision in **actual dollars
spent** (`cost_usd`, or the closest available proxy), not a proxy that only
resembles cost when the token mix happens to match assumptions baked into the
index.

## Plan usage is not the same currency as API dollars

On a subscription plan, the thing that actually runs out is the plan's usage
allowance, not a dollar figure — and the two do not move at the same rate.
Operator-observed measurement on one plan found a premium tier consuming its
usage window at roughly 1.5x a mid tier per unit of cost-weighted work, while
the same tiers' *API* list prices differ by a larger multiple — meaning a
plan-usage-aware routing choice can legitimately differ from a pure
dollar-cost-aware one. That reading is treated as **a weight to re-verify, not a permanent
fact** (a plan's own metering can change; 2026-10-06: about 1.45-1.5x per token fits
the size of the weekly limit, and nothing shows it is introductory), so it
informs a routing trial rather than becoming a hard-coded assumption in the
grid itself. Re-verify before relying
on any specific multiplier for a long-lived decision.

## Haiku validates; it does not operate

The cheapest tier's natural job is **verification**, not **execution**:
"look at this and report exactly what it says" is bounded, single-pass, and
matches a fast, shallow model well. "Carry out an ordered multi-step
procedure against a live system, checking as you go" is a different shape of
task even when every individual step looks trivial in isolation — the
failure mode is a silently dropped or reordered step, not a wrong answer to a
single question, and that failure compounds across tool-call boundaries in a
way a one-shot check cannot. The table encodes this as two distinct task
types at different weights rather than one, so "this looks simple" is not
mistaken for "this is read-only": a sequence of trivial-looking writes to a
live system floors at a heavier tier than a single read does, specifically
because ordering mistakes and partial failures are the risk, not the
difficulty of any one step.

This distinction matters more, not less, once a tier the table used to route
this validator work to retires — see the retirement note on that tier in
`docs/ROUTING.md` for the mechanics of the staged replacement. The
*replacement* tier inherits the same "validator, not operator" framing; a
successor is not exempt from it just because it is a different model.

## Where this fits in the layer stack

To restate the order these interact in, cheapest layer first: the shipped
grid (weight x kind, floored by consequence) is the baseline; a shipped
routing trial can override one named task type's grid answer, with its own
evidence and a review date; a per-user routing profile can override that
again, per operator, per machine; and the six floors (F1-F6) apply **after**
whichever layer wins, so no layer — trial or profile — can produce a route
that violates one of them. See `docs/ROUTING.md` for the live table these
rules currently resolve to, and `config/model-tiers.json` for the data they
are computed from.
