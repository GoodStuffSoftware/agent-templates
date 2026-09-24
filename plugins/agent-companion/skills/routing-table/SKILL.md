---
name: routing-table
description: Show the current model routing table — tiers, effort levels, the weight × kind decision grid, consequence floors, reviewer parity, named task types, and open calibration questions — rendered live from the plugin's config, and manage the operator's own routing profile (/ac routing set, unset, show, why, rollback). Use when asked to show, print, or explain the routing table, which model handles which weight or task type, what effort a task kind gets, to set or undo a personal routing row ("route integration to sonnet for me"), or why a type routes where it does.
---

# Show the routing table

The table is **data** (`config/model-tiers.json`) and the display is **generated
from it**. Never type the table by hand — a typed table goes stale the moment
the config changes, which is the failure the whole design exists to prevent.

Resolve the plugin root (`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks):

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
node "$AC/scripts/routing-table.mjs" --profile
```

PowerShell:

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
node "$AC/scripts/routing-table.mjs" --profile
```

For machine-readable output of the shipped table, run it with `--json` in place of
`--profile` (the two cannot be combined: it exits 2). The committed copy is
`docs/ROUTING.md`; the `routing-doc` audit check fails if it drifts from the
config, and `--fix` regenerates it. That default output is the SHIPPED table
only. Add `--profile` to render it as this machine resolves it, with any row
from the operator's routing profile marked — use that when showing the table
to the operator (`/ac routing` with no arguments).

## Your routing profile (`/ac routing set|unset|show|why|rollback`)

When the arguments start with one of these subcommands, run
`scripts/routing-profile.mjs` with them unchanged:

```bash
node "$AC/scripts/routing-profile.mjs" set <type> --model <alias> --effort <effort> [--because "<what you observed>"] [--waive-floor elevated]
node "$AC/scripts/routing-profile.mjs" set code-review --effort <effort>   # review rows: a minimum effort only
node "$AC/scripts/routing-profile.mjs" unset <type>
node "$AC/scripts/routing-profile.mjs" show
node "$AC/scripts/routing-profile.mjs" why <type> [--writer <model>/<effort>]
node "$AC/scripts/routing-profile.mjs" rollback --row <type>
node "$AC/scripts/routing-profile.mjs" rollback --to <revision>
```

- `set` writes an `operator-observed` row in state `trial`, review date 90
  days out. Ask for `--because` when the operator gives a reason; it is kept
  locally and never logged.
- A refusal (exit 1) names the floor it breaks. Relay it; do not look for a
  way around it. F1-F4 cannot be waived. F5 (the elevated effort floor) can be
  waived only with `--waive-floor elevated`, and only when the operator asks
  for it.
- `why` prints the same explain stack as `recommend --explain`.
- `rollback --to` takes a revision from `show`'s recent changes.
- The `routing_profile` option is the kill switch. Off, only the shipped
  table routes and the file is left as it is.

## Presenting it

Show the whole rendered output — it is already organised. If the person asked
a narrower question ("what does weight 4 diagnostic get?"), answer that line
directly and point at the grid rather than pasting everything.

If the table looks wrong for the task in hand, say so and change the **config**,
not the answer. Then regenerate. A judgement that changes the table improves
every future call; one that overrides it silently leaves the table lying.
