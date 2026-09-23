# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

## 0.23.0 — 2026-09-23

Re-weighted `config/model-tiers.json` against the current Anthropic lineup
(live-fetched 2026-09-23; sources cited inline in the config).

### Changed

- **Re-based the routing table** on the current lineup: `opus` -> Opus 5.5
  ($4/$20, cache hit $0.20, medium default effort), `sonnet` -> Sonnet 5
  ($2/$10), `haiku` -> Haiku 4.5 ($1/$5, no effort parameter, retires no
  sooner than 2026-10-15), `fable` -> Fable 5.1 ($10/$50, cache hit $0.25).
  Every tier now carries a `resolvesTo` block (model id, display name,
  pricing incl. cache hit, context, effort support/default, thinking mode)
  plus a top-level `aliasResolution` naming the source, fetch date, and the
  minimum Claude Code version (2.1.280) the mapping holds for.
- **Added `referenceModels`**: non-routable entries for OLDER pinned
  full/dated ids (Opus 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6), so an
  agent definition pinned to one of these has its effort validated against
  what THAT version actually supports (Opus 4.6 / Sonnet 4.6 have no
  `xhigh`) instead of the current alias tier's wider list.
- **Added an ordered effort ladder** (`config.ladder`): the same routing
  grid's (model, effort) pairs as a cheapest-to-dearest sequence — haiku,
  then sonnet low..xhigh, then opus low..max — each mapped to a new generic
  worker agent definition under `agents/` (`ac-haiku` .. `ac-opus-max`),
  because the Agent tool has no per-spawn effort parameter. `recommend.mjs`
  now prints the exact namespaced spawnable name for its recommendation.
  Weight -> rung defaults are unchanged (1-2 haiku, 3 sonnet/medium, 4
  sonnet/high, 5 opus/xhigh) pending a separate research decision.
- **Added `verify` and `operate` task types**, encoding "haiku validates,
  it does not OPERATE": read/confirm/screenshot work with nothing changing
  routes to weight 1 (haiku); an ordered procedure or a live-system change
  floors at weight 3 (sonnet+) even when every individual step looks
  trivial.
- Fable's warrant now cites Anthropic's own escalation criterion ("Opus
  5.5 at higher effort still falls short") and notes Fable is now 2.5x
  Opus on price (was 2x, when Opus priced at $5/$25).
- The calibration scout (`scripts/detect.mjs`) now warns on every run once
  a tier is within 30 days of `retiresAfter` (previously only on fixed
  milestones, which stayed silent for haiku's 2026-10-15 date until this
  fix).
- `spawns.jsonl` gains `effective_effort`: the agent definition's own
  effort when stated, else `"inherited(<parent session's effort, or
  'unknown'>)"` — a subagent with no `effort` frontmatter inherits the
  orchestrating session's effort (per Claude Code's sub-agents docs), not
  any model default. `spawn-audit` gains a rung-drift finding for spawns
  that matched the recommended model but ran at a lower effort than the
  table recommended.
- `spawn-guard.mjs` and the `agent-defs` audit check now warn when a
  definition or spawn has a model but states no effort anywhere, on every
  effort-taking model (previously implied only for opus, and initially
  mis-described as falling back to a model default rather than to session
  inheritance — corrected same day).

### Documentation

- `docs/ROUTING.md` regenerated from the config (now includes the effort
  ladder and reference-models sections).
- `docs/TELEMETRY.md`: documents `effective_effort`, and adds a "Spawn
  nesting depth" section explaining why `depth` is NOT logged (the
  PreToolUse payload carries at most a 1-bit `caller_is_subagent` signal,
  not a true recursion depth) and what the harness would need to add.
- `docs/proposed/global-doctrine-reweight.patch`: unpublished unified diffs
  against `~/.claude/skills/team-orchestration/SKILL.md` and
  `~/.claude/CLAUDE.md`, for the operator to review and apply by hand.
