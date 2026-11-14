# ADR 0006: no Opus writers; Opus plans, root-causes and reviews, Sonnet writes

**Status:** Accepted (2026-11-13), shipped in agent-companion 0.31.54.
**Date:** 2026-11-14
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

## Context

Operator data of 2026-11-13: Opus subagents were doing their own edits, tests, builds and git, at Opus
prices and with large contexts. Execution calls were 37% of Opus worker cost. The work that needs Opus is
the thinking: designing, root-causing, planning, reviewing. The typing does not.

## Decision

1. **A spawn that would run on Opus and whose brief says it writes is rewritten, silently, to the Sonnet
   writer rung** (`hooks/lib/opus-writer.mjs`). "Says it writes": `ROLE: writer`, `fixer` or `lander`;
   with no usable ROLE line, a writing TYPE, and also the two-leg types `novel-design` and
   `debug-root-cause` (the write leg is the one a bare TYPE names).
2. **Two legs.** A type whose config row carries `legs` is split into a read-only PLAN leg (the row's own
   Opus route; `ROLE: other` or `ROLE: plan`, or a brief that names a `<task>-plan.md` output and says
   read-only) and a WRITE leg (Sonnet, the rung that carries the self-review protocol). The plan leg gets
   no writer clauses (scope, writer, tier) and no self-review protocol; Opus never writes without self-review.
3. **The policy outranks a routing profile.** ADR 0003 makes a per-user profile the user's recorded choice
   of route. This ADR carves one exception out of it: a profile (or `--weight` / `--kind`) that puts a
   writer type on Opus still routes the PLAN leg there, but the WRITE leg is Sonnet. The recommender prints
   both legs; the spawn guard enforces the write leg. A user who wants the old behaviour sets the option
   `opus_writer_policy` to `allow`, which turns the rewrite off and leaves the profile in full control.
4. **Read-only spawns are never moved.** Reviewers, lookups, plan legs and the built-in Explore, Plan and
   claude-code-guide agents keep their model.

## Consequences

- The recommender and the guard agree: `recommend.mjs` shows `plan leg:` and `write leg:` for a two-leg type.
- A rewrite is silent (no message); each one writes a row to `telemetry/opus-writer-rewrites.jsonl`.
- A project agent whose own file pins Opus is the operator's deliberate tier and is left alone.
- The 110,000-token size notice is role-aware: writers, fixers and landers are told to commit and hand
  off; reviewers, lookups, plan legs and other read-only spawns are told to write their findings so far to
  the detail or plan file and return, and never to commit or push.

## What would have to be true for this to be wrong

- Sonnet writers redo enough Opus-planned work that the saving is net negative (rework counts). The
  rewrite telemetry rows plus the spawn rows measure it.
