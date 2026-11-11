# Where the shipped defaults come from

Many defaults in this plugin are numbers somebody measured. They were measured in one
environment, and yours may differ. The defaults stay, and every one of them can be changed.
This page says what that environment was, and, per item, where the value came from, how to
change it and how to measure it yourself.

## The environment the defaults come from

- One developer's Windows 11 workstation with 64 GB of RAM.
- Claude Code desktop app and CLI on the highest individual subscription tier. Plan-usage
  figures were read on that tier.
- Several long-running lead sessions at once, each spawning helper agents, across a handful of
  app projects (web apps, an Android build with an emulator, Playwright end-to-end tests,
  Firebase tooling).
- Measured between September and November 2026. Each item below gives the dates its file
  carries; where none is recorded, the file says "not recorded".

Each shipped config file that holds such values carries one `environment` block with the same
keys: `kind` (`local-measurement`, `public-fact` or `mixed`), `describes`, `measured`, `method`
and `remeasure`. The block is documentation only. No loader reads it, and no value depends on it.

## Re-measuring is by hand today

Nothing re-measures these values for you on a schedule. The one tool that can write a fitted
value for you is `scripts/calibrate-weights.mjs --apply` (plan weights); you run it yourself.
For everything else you read your own numbers (the commands below), then change the value in
your own files. The scout may tell you that a signal moved; it does not rewrite your config.

Your own files live in your state folder (`~/.claude/agent-companion/`, or where
`AGENT_COMPANION_STATE_DIR` points), under `config/`. See the README "Settings" section.

## The items

| Item | What it is | Where the value came from | How to change it | How to re-measure it today | Kind |
|---|---|---|---|---|---|
| Plan weights (`config/plan-weights.json`) | Plan units per 1% of the weekly limit, a weight per model, the cache-read factor, median cost per call | Weight fit of 2026-11-03 on official weekly readings (2026-10-02 to 2026-11-03) against local transcripts. How the per-call medians were produced: not recorded | `config/plan-weights.json` in your state folder (merged by key); option `weekly_limit_units` (`/ac settings`) replaces the limit | `node scripts/calibrate-weights.mjs` shows the fit; `--apply` writes it | Local measurement |
| Task-type routing (`config/model-tiers.json`) | Model and effort per task type, reviewer parity, plan-usage multipliers | One operator's decisions, each dated in its own entry (study of 2026-09-21 to 2026-09-27; decisions of 2026-10-13 and 2026-10-17) | `/ac routing set\|unset\|show\|why\|rollback` (writes `config/routing-profile.json`, journaled), or a `config/model-tiers.json` override | `scripts/transcript-report.mjs` and the `model-benchmark` skill give your own numbers; deciding the rows is by hand | Local measurement and decisions |
| Resource rules (`config/resource-rules.json`) | Memory, hold time and ports per class of heavy run (end-to-end, emulator, Gradle, Firebase) | Values tagged M were measured by hand on that workstation, E are estimates; no dates or procedure recorded | `config/resource-rules.json` in your state folder, or `AC_RESOURCE_RULES`. The settings home does not cover it | Watch peak memory and run time of your own runs; no tool records them | Local measurement and estimates |
| Compaction (`config/compaction.json`) | Context windows and default compaction points per model | Public documentation read 2026-09-25; the 167K-174K figure on 200K models and the plan-usage note are local (2026-09-27); the date of the 167K-174K measurement: not recorded | `config/compaction.json` in your state folder; the window itself is a Claude Code setting (`/autocompact`) | `node scripts/cache-advisor.mjs` (advice only) reads your last 30 days of transcripts | Mostly public facts, two local items |
| Pricing (`config/model-pricing.json`) | Dollar list prices per model | Public pricing pages, read 2026-09-25, rows added 2026-10-12 | `config/model-pricing.json` in your state folder | Nothing local to measure; read the public pricing page | Public fact |
| `memory_brief_min_score` (25) | Cut-off score for the memory brief, used only in `memory_brief_mode: "pointers"` (the default mode, `nudge`, uses no score) | Calibrated on one operator's memory corpus; the option text says no fixed threshold separated on-topic from off-topic briefs there. No date | `/ac settings set memory_brief_min_score <n>` | `scripts/memory-search.mjs` on your own corpus; no tool scores the separation for you | Local measurement |
| Other option defaults measured on that machine | `api_review_soft_usd` 1 / `api_review_hard_usd` 2 (29 real reviews, 2026-11-03 to 11-07); `capacity_per_agent_mb` 350 (process memory of live sessions, 2026-09-23); `resume_guard_min_tokens` 50000 (idle-expiry resume average); `keep_warm_max_minutes` 180 (gap distribution); `project_route_guard` (three measured weeks); `subagent_ceiling_tokens` 0 (2026-10-09) | The option text of each one states its measurement | `/ac settings set <option> <value>`, or the settings home file `config/settings.json` | `scripts/api-spend.mjs` (review cost), `scripts/capacity.mjs` (live sessions), `scripts/transcript-report.mjs` (resume after idle), `scripts/cache-ttl.mjs` (gaps); you compare, then set the option | Local measurement |
| Built-in standing rules | The twelve rules in `hooks/lib/rules.mjs` | One operator's experience; each rule's `note` says what is known of its origin (`node scripts/rules.mjs show <id>`) | `node scripts/rules.mjs enable\|disable\|add\|remove`, or `config/standing-rules.json` (a built-in is disabled, not removed) | Not measurable; the rule wording is a policy, not a number | Local experience |

Not listed because they hold no measured default: `config/usage-analysis.defaults.json`
(generic thresholds; machine-specific settings go in your own `usage-analysis.json`) and the
`*.example.json` files (examples).
