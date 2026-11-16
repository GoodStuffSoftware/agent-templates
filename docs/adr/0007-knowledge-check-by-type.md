# ADR 0007: the knowledge check is per task type, with a dated line the lead can pass down

**Status:** Accepted (2026-11-16), shipped in agent-companion 0.31.57.
**Date:** 2026-11-16
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

## Context

Before 0.31.57 the knowledge check was two hand-written user rules: a spawn rule that put a "run one quick
search" clause on every brief it matched, and a session-start rule. Aggregate numbers for 2026-11-01 to
2026-11-16, from one developer's workstation (Windows 11, Claude Code on the highest individual plan):

- 3,760 worker briefs; 2,459 carried the spawn clause, about 1.48M characters of brief text in total.
- Builder types (bounded-feature, integration, debug-root-cause and the like) searched early in 0-4% of cases.
  Research searched in 19% and lookup in 8%, because searching is their job anyway.
- No worker reported the check changing its plan or contradicting its brief.
- 112 briefs carried a lead-written dated "Knowledge check" line. `critical-change` workers searched late, so a
  dated line from the lead suits them better than a clause they act on after the first edit.
- The session-start rule was the first one dropped when the session-start block went over its character cap, so
  it did not reach the model in those sessions.

## Decision

1. **The check is a spawn clause, by TYPE.** A brief whose `TYPE:` is in the option `knowledge_check_types`
   (default: bounded-feature, bounded-feature-small, integration, debug-root-cause, critical-change,
   novel-design, large-refactor, long-autonomous-run) gets one clause of at most 350 characters
   (`hooks/lib/knowledge-check.mjs`, appended by the spawn guard). Every other type, every reviewer and every
   brief with no TYPE gets nothing: the clause costs characters on every brief and the data shows it buys
   nothing there.
2. **Reuse.** A brief with a line `Knowledge check YYYY-MM-DD:` dated today or yesterday (local date) gets no
   clause; the worker uses the lead's check. Lines in code fences, blockquotes and HTML comments do not count.
3. **A lead nudge, once per session.** The first spawn that gets the clause also tells the lead to run one check
   for the whole body of work and pass it down as a dated line. It is held until the spawn is allowed, so a
   denied spawn does not use it up.
4. **How-to asks.** A built-in lead rule, `knowledge-check-howto` (user-prompt scope), fires on a request for steps
   to set up, configure, install, enable, connect, deploy or upgrade something, and tells the lead to read the
   current official docs and say the date. The pattern is narrow on purpose (near-misses are tested).
5. **No session-start rule.** It cost budget in the block that was already over its cap and added nothing the
   spawn clause and the how-to rule do not.
6. **One option turns it all off:** `knowledge_check` (default on, with its environment stated in
   `docs/DEFAULTS-ENVIRONMENT.md`, as the other shipped defaults are).
7. **Migration.** The two old user rules (`knowledge-check-spawn`, `knowledge-check-session`) are held off while the
   option is on, so nothing is doubled. They stay in the user's file and work as written when the option is off.
   The changelog tells users to remove them after updating.

## Consequences

- A builder brief is 349 characters longer unless the lead passed a dated line down. Briefs for other types are
  unchanged, which is most of the 1.48M characters of the old clause.
- The worker's report line (`Knowledge check <date>: confirmed|changed|none needed`) makes the effect measurable
  from transcripts without new telemetry.
- `scripts/rules.mjs` now prints a warning when an edit makes a session-start rule drop, and has a read-only
  `budget` subcommand; the daily scout raises `standing_rules_overflow`. This is what hid the old session rule.

## What would have to be true for this to be wrong

- A builder that searched early would have changed course. The report lines show the rate of `changed:`; if it
  stays at zero for builder types over a longer window, narrow the default list further.
- Lead-written dated lines get stale inside a day (a library releases between the check and the build). The
  today-or-yesterday window is the bound; shorten it if reports show otherwise.
