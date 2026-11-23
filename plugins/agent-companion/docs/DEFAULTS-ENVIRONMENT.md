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
| Other option defaults measured on that machine | `api_review_soft_usd` 1 / `api_review_hard_usd` 2 (29 real reviews, 2026-11-03 to 11-07); `capacity_per_agent_mb` 350 (process memory of live sessions, 2026-09-23); `resume_guard_min_tokens` 50000 (idle-expiry resume average); `keep_warm_max_minutes` 180 (gap distribution); `project_route_guard` (three measured weeks); `subagent_ceiling_tokens` 0 (2026-10-09); `coordinator_message_gate` `block` (replay of 452 real child-to-coordinator messages, 2026-11-11 to 11-14: the tag check stopped 79 and one that mattered; the stricter rules stopped dozens that did) | The option text of each one states its measurement | `/ac settings set <option> <value>`, or the settings home file `config/settings.json` | `scripts/api-spend.mjs` (review cost), `scripts/capacity.mjs` (live sessions), `scripts/transcript-report.mjs` (resume after idle), `scripts/cache-ttl.mjs` (gaps), `telemetry/coordinator-messages.jsonl` (what the gate allowed and denied); you compare, then set the option | Local measurement |
| API review routing (`api_review_route`, `api_credits_review_ratio`, `api_credits_shares`) | Shipped: routing `off`, ratio 0.5, shares review 0.5 / workers 0.3 / overflow 0.1 / rater 0.05 / reserve 0.05. This environment: `api_review_route` `all`, `api_credits_review_ratio` 1.0, shares review 0.65 / workers 0.15 / overflow 0.05 / rater 0.05 / reserve 0.10 | Usage root-cause of 2026-11-22: about 40% of reviews are lead-spawned and 60% writer-spawned, 65% of writer reviews are RISK high (kept on the plan) and about 12% of API runs fall back, so the eligible share is 0.40 + 0.60 x 0.35 = 0.61 of reviews; 0.61 x r x 0.88 >= 0.5 needs r >= 0.93, so r = 1.0. About 21 eligible reviews a day at about $0.25 is about $5.3 a day, so the review share must be 0.65 ($130 a month) or the pace cap sends the rest to the plan by itself | `/ac settings set <option> <value>`, or the settings home file `config/settings.json`; never changed in code | `node scripts/api-credits.mjs status` (API share of all reviews, today and 7 days), `node scripts/api-credits.mjs reviews`, `telemetry/review-verdicts.jsonl` (`route`, `route_reason`) | Local measurement |
| Knowledge check (`knowledge_check`, `knowledge_check_types`) | On, for the builder task types: bounded-feature, bounded-feature-small, integration, debug-root-cause, critical-change, novel-design, large-refactor, long-autonomous-run | 3,760 worker briefs, 2026-11-01 to 2026-11-16: builder types searched early in 0-4% of cases; research and lookup searched in 19% and 8% because searching is their task; no worker reported the check changing or contradicting its brief (`docs/adr/0007-knowledge-check-by-type.md`) | `/ac settings set knowledge_check false`, `/ac settings set knowledge_check_types <list>`, or the settings home file `config/settings.json` | The clause asks each worker to open its report with `Knowledge check <date>: confirmed` or `changed: ...`: count those lines in your own worker reports | Local measurement |
| Release watch evidence floors (`release_watch_min_spawns`, `release_watch_min_workers`, `release_watch_min_bash`, `release_watch_ack_ttl_minutes`) | Shipped and this environment alike: 30 spawns, 20 workers, 200 worker Bash calls per watch window below which a check is `inconclusive` and the watch keeps going; a reply candidate unconfirmed after 10 minutes is rejected | One busy single-operator machine (about 300 spawns a day): 12.6 spawns/h over 7 days (2,116 spawns), the 0.31.63 +1h window had 26; 17-26 workers per hourly window; 44,992 worker Bash calls over 7 days = 268 an hour; the 10 is the scheduled tick cadence. A lighter user gets more `inconclusive` checks and longer watches, which is the intended failure mode | `/ac settings set <option> <value>`, or the settings home file `config/settings.json` | `node scripts/release-watch.mjs status` (the metric rows show the counts each check saw), then compare with your own hourly volume | Local measurement |
| Built-in standing rules | The fourteen rules in `hooks/lib/rules.mjs` | One operator's experience; each rule's `note` says what is known of its origin (`node scripts/rules.mjs show <id>`) | `node scripts/rules.mjs enable\|disable\|add\|remove`, or `config/standing-rules.json` (a built-in is disabled, not removed) | Not measurable; the rule wording is a policy, not a number | Local experience |

Not listed because they hold no measured default: `config/usage-analysis.defaults.json`
(generic thresholds; machine-specific settings go in your own `usage-analysis.json`) and the
`*.example.json` files (examples).
