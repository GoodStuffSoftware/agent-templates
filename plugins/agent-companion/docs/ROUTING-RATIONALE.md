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

## Consequence floors: five things that never depend on difficulty

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
  floors — may be waived by a per-user profile row when the waiver's own
  evidence is first-hand and observed, never by default and never touching
  F1.

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
dollar-cost-aware one. That reading is treated as **unconfirmed and possibly
introductory** (a plan's own metering can change, and observing it once does
not establish it as permanent), so it informs a routing trial rather than
becoming a hard-coded assumption in the grid itself. Re-verify before relying
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
again, per operator, per machine; and the five floors (F1-F5) apply **after**
whichever layer wins, so no layer — trial or profile — can produce a route
that violates one of them. See `docs/ROUTING.md` for the live table these
rules currently resolve to, and `config/model-tiers.json` for the data they
are computed from.
