---
name: usage-analysis
description: Read, compare and extend the daily usage analysis. Use for "analyze yesterday", "compare today with", "add a scenario", "explain this result", or "/ac usage".
---

# usage-analysis: yesterday against the baseline, and your own scenarios

The analysis turns the facts the daily checkup scans into per-day results and a dated report: units by day and week, and each scenario's comparison against a baseline (prior day, trailing 7, same weekday, a named window). It runs inside the calibration scout at 04:10 local, after the fixed 08:00Z day close (04:00 EDT, 03:00 EST from 2026-11-01). It makes **zero model calls and costs zero tokens**. Only the opt-in rater (`environment.llm.enabled`, off by default, ships in 0.31.19) would spend any. Full reference: `docs/USAGE-ANALYSIS.md`.

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

## Commands that exist today

| Ask | Run |
|---|---|
| analyze yesterday | `node "$AC/scripts/usage-analysis.mjs" status`, then read the report path it prints (3 lines: units, regressions, report). Not computed yet: `node "$AC/scripts/usage-analysis.mjs" run --quiet`. |
| a specific day | `node "$AC/scripts/usage-analysis.mjs" report --day 2026-10-12 --dry-run` (re-renders the stored result, no scan) |
| compare today with ... | today is open and is never computed; compare closed days: report each day and read the delta lines. A named window comparison is a scenario (below). |
| explain this result | `node "$AC/scripts/usage-config.mjs" explain <scenario-id>` shows each field, the layer it came from, refusals and the metric it needs. `list` shows every scenario and its state. |
| check the config | `node "$AC/scripts/usage-config.mjs" check` |

`--root DIR` is the state root; `--dry-run` writes nothing at all (it skips the scan and analyses the facts on disk); `--scheduled` is bounded (`--max-seconds` 120, `--max-days` 14) and honours the `usage_analysis` option; `--scenario a,b` is a restricted look that persists nothing. Say what the report says: a **gap** is data that is missing (never a zero), **deferred** is a day not settled yet, label **M** is measured and **E** is an estimate.

## The three layers (user > project > shipped)

- **Shipped** `config/usage-analysis.defaults.json`: global scenarios. Do not edit it.
- **User** `<state root>/config/usage-analysis.json`: yours. Plan size, windows, exclusions, thresholds, your own scenarios (ids `u.*`), `disable` and `overrides` for any shipped id. `usage-analysis.mjs init --from-register` proposes it from your decision register; it writes only when the file is absent and otherwise prints a diff.
- **Project** `<repo>/.claude/agent-companion/usage-analysis.json`, committed in that repo: scenarios scoped to that repo, shown as `project:<label>/<id>`. It cannot set `environment`, `llm`, plan values, session ids or regexes; the user layer always wins.

## Add a scenario

1. Pick a metric id and the comparison. `list` prints scenario id, layer, severity and state only; metric ids are in `explain <shipped-id>` and in `config/usage-analysis.defaults.json`.
2. User scenario: add to `scenarios` in the user file, id `u.<name>`:
   `{ "id": "u.myCheck", "title": "...", "metric": "day.units", "compare": ["prior-day"], "threshold": { "direction": "up-is-worse", "relPct": 25, "minSample": 15 }, "severity": "info" }`.
   To retune a shipped scenario use `overrides.<id>` instead of copying it.
3. Project scenario: the same object in the project file with a plain id (`myCheck`); it appears as `project:<label>/myCheck`. The label is the repo folder name, or set in `environment.projects`.
4. `node "$AC/scripts/usage-config.mjs" check`, then `explain <id>`. A bad scenario is dropped alone and named; it never disables the rest. Bump `revision`.
5. The next run recomputes the affected days with the reason `config: scenario <id> changed`.
