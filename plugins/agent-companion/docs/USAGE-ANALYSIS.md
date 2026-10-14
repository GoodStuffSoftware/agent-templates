# Daily usage analysis

A deterministic, zero-token analysis of how the plan was spent yesterday and how that compares with a baseline. It reads the facts the daily checkup already scans from your transcripts, makes no model call and no network call, and writes only below the state root. The skill that drives it is [`skills/usage-analysis/SKILL.md`](../skills/usage-analysis/SKILL.md) (`/ac usage`).

## What it computes

For each closed, settled checkup day:

- **Totals** in plan units (the same unit as the checkup): main and subagent, by class (lead, routine, storm, other), model, project and rung, and the week so far against the weekly limit.
- **Scenarios**: a named comparison of one metric between a day (or a window of days) and a baseline: the prior day, the trailing 7 days, the same weekday over 4 weeks, `level` (no baseline: the day's figure against a fixed zero, for a count that must stay 0 such as drifted routine fires or missed runs; every day above 0 alerts, a day with no figure is a gap), or another named window such as a rollout. Each carries a threshold (relative percent, an absolute floor, a minimum sample) and a severity. A scenario that crosses its threshold is a **regression** and is listed first in the report.
- **Labels**: every figure is **M** (measured) or **E** (an estimate, for example a model weight that is a judgement). The report says how much of the total is priced at E weights.
- **Gaps, never zeros**: a day with no facts, with spawns still open, closed under 5 minutes ago, or only partly scanned is **deferred** and computed on a later run. A baseline day that is partial is reported as a gap. A metric the plugin does not implement yet is recorded as a gap with the reason. That holds on every day, whatever the scenario's cadence. A settled day whose facts file exists and holds zero sessions is a real 0 for a sum-type metric (units, counts); for a ratio metric a zero denominator is a gap, and a day with no facts file, a deferred one or a partial one stays a gap. The one-line summary says `regressions: n/a (0 scenarios evaluated, N gaps)` when nothing could be evaluated, and `regressions: none (E scenarios evaluated, N gaps)` otherwise, so "none" is never read from an all-gap day.

## When a day closes

A day is a fixed 08:00Z to 08:00Z window (`environment.day.boundaryUtcHour`, default 8). The close does not follow your clock: 08:00Z is **04:00 EDT** and, after the US clocks go back on 2026-11-01, **03:00 EST**. A closed day is computed once it has settled, 5 minutes after the close. The scout's 04:10 local run is after the close in both cases (04:10 EDT = 08:10Z, 04:10 EST = 09:10Z).

Re-running with the same inputs gives byte-identical output. A config or facts change gives the day a new revision and a stated reason (`config: scenario u.x changed`).

## Where files live

All paths are under the state root (`--root DIR` moves it).

| What | Path |
|---|---|
| Shipped scenarios | `config/usage-analysis.defaults.json` in the plugin (read-only) |
| Your config (user layer) | `<state root>/config/usage-analysis.json` |
| A repo's config (project layer, committed in that repo) | `<repo>/.claude/agent-companion/usage-analysis.json` |
| Facts | `state/usage-facts/<day>.json` |
| Results | `state/usage-analysis/<day>.json` |
| Report | `reports/usage/usage-<day>.md` (move with `--report-dir` or the option `usage_analysis_report_dir`) |
| 3-line summary | `state/usage-analysis-latest.json` |
| Status (last run, deferred days, errors) | `state/usage-analysis-status.json` |

The layers merge as user > project > shipped. A project file can add scenarios scoped to its own repo (shown as `project:<label>/<id>`) and cannot set `environment`, `llm`, plan values, session ids or regexes. Fields the shipped file does not own are changed through `overrides`. The merge, the refusals and the schema are in `config/usage-analysis.example.json` and `scripts/lib/usage/config.mjs`.

## The knobs

In the user file (`environment.*` unless noted):

| Key | Meaning |
|---|---|
| `plan.weeklyLimitUnits` | your weekly limit in units, the denominator for the week figure |
| `day.boundaryUtcHour`, `week.resetUtc` | where a day starts (default 08 UTC) and when the plan week resets (default `Fri 16:00`) |
| `projects` | labels and paths of repos whose project file to load; `autoload` labels them from the folder name |
| `classes.storm.minSpawnsPerHour` | spawns per active hour at which a session counts as a storm (default 20) |
| `llm.*` | the opt-in rater; off by default, ships in 0.31.19. Everything else costs nothing. |
| `report.keepDays` | how far back a missing day is still computed (default 180) |
| `windows`, `exclusions` | named time ranges and cohorts to leave out, used by scenarios |
| `scenarios`, `disable`, `overrides` | add `u.*` scenarios, switch a shipped one off, retune a shipped one |

`node scripts/usage-config.mjs check | list | explain <id>` validates the layers and shows which layer each field came from. `node scripts/usage-analysis.mjs init --from-register` proposes the user file from the decision register: it writes the file only when it is absent, and otherwise prints a line diff and changes nothing. The proposal names only events your files have: the leads window opens at `rollout:leads-high` when `rollout.json` has that row (else at the register decision), and the xhigh-against-high scenario needs a `leads-xhigh` row; without it the scenario is left under a `$commented-out` key with a one-line reason instead of a permanent gap.

## Plugin options

| Option | Default | Effect |
|---|---|---|
| `usage_analysis` | on | The daily checkup runs the analysis stage, the SessionStart hook shows its summary, and `usage-analysis.mjs --scheduled` (the scout's call) runs. Off: none of the three runs; `--scheduled` prints one line and exits 0. A run you type by hand (no `--scheduled`) still runs. |
| `usage_analysis_report_dir` | empty | Where the dated reports (`usage-<day>.md`) go. Empty = `reports/usage` under the state root. `--report-dir` overrides it. |
| `scout_plugin_update` | on | Whether the scout runs the two plugin update commands (marketplace update, plugin update) after the analysis. Off leaves the update to the app's own auto-update. The scout reads it with `node scripts/detect.mjs --print-option scout_plugin_update`. |
| `decision_register` | on | Also gates the register's `scenario` trigger kind, which reads this analysis' results (see the README's decision register section). |

## The 04:10 scout run

There is no separate routine. The calibration scout, which already runs daily at 04:10 local (after the 08:00Z day close, see above), runs `node scripts/usage-analysis.mjs --scheduled` as its first step, then the plugin update (gated by `scout_plugin_update`), then its own checks. `--scheduled` never waits and always exits 0; a day that is not settled is recorded as deferred in the status file and the next run picks it up. The run holds the checkup's lock, so it never overlaps a checkup.

The scout calls it in a foreground step, so `--scheduled` is bounded unless you say otherwise:

| Flag | With `--scheduled` | Meaning |
|---|---|---|
| `--max-seconds N` | 120 | stop starting new days after N seconds of analysis; the next run resumes the oldest (the first day always runs; the transcript scan before it is not counted) |
| `--max-days N` | 14 | compute at most N days per run; not applied to `--day` or `--from/--to`, which name the days to compute |

Without `--scheduled` neither limit applies unless you pass it. `--dry-run` writes nothing at all under the state root: it does not scan transcripts (so no scan state and no facts), takes no lock, and writes no status or report; it analyses the facts already on disk.

## What reaches you

- **SessionStart summary.** The first attended main session after a day is computed shows the 3-line summary once, and again only when the set of regressed scenarios changes (also to or from none). A summary more than 72 hours past its day's close is not shown. Subagents never see it. Switch it off with `usage_analysis`.
- **Unattended sessions.** A session that nobody is watching (the scout and other scheduled routines: `CLAUDE_CODE_SESSION_ATTENDED=0`, a routine working folder, a pinned routine folder, a scheduled-task session record) neither shows the summary nor marks it shown, so the next attended session still gets it.
- **Scout signals** (in `scout-latest.json`, once per change): `usage_regression` (one per regressed scenario and day), `routine_model_drift` (the routine model-drift scenario regressed), `usage_analysis_stale` and `usage_analysis_config_invalid` (a layer is ignored; `/ac usage check config` names the files).
- **When `usage_analysis_stale` fires.** The settled day (the one before today) is *expected* once its close plus 90 minutes has passed, and only if the analysis had something to plan: the status file has an entry for that day, or a facts file exists for that day or an earlier one. Then it is stale if that day is not `computed` (deferred, or no entry at all), or if no analysis run is recorded for 36 hours. A status file with no entry for a day that predates the first facts file is not stale: facts start the day after the plugin lands, so the first morning has nothing to compute.
- Surfacing a regression uses the scout's signal path; the report is where the detail lives.

## How to read the report

`reports/usage/usage-<day>.md`, top to bottom:

1. **Summary**: three lines (the day's units and the week, the regressions, the report path). This is also what `status` prints.
2. **Totals**: units by class, model, project and rung, with the E share.
3. **Regressions**: each scenario over its threshold, with the value, the baseline, the change, the sample size and the interval. Read the sample size first: a large percent on a few sessions is noise, and the threshold's `minSample` already filters the worst of it.
4. **Scenarios**: every scenario computed that day, including those that passed, were skipped (`not-due` for a weekly scenario on a non-reset day), or are gaps.
5. **Exclusions** and **Windows**: what was left out and why, and the resolved boundaries of each named window.
6. **Unobservable items and gaps**: what could not be known, each with the field it needs.
7. **Revisions**: why this day has been recomputed.

To dig into one result: `node scripts/usage-config.mjs explain <scenario-id>`, then `node scripts/usage-analysis.mjs report --day <day> --dry-run` to re-render without a scan.
