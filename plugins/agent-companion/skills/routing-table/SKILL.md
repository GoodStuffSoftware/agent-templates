---
name: routing-table
description: Show the current model routing table — tiers, effort levels, the weight × kind decision grid, consequence floors, reviewer parity, named task types, and open calibration questions — rendered live from the plugin's config. Use when asked to show, print, or explain the routing table, which model handles which weight or task type, or what effort a task kind gets.
---

# Show the routing table

The table is **data** (`config/model-tiers.json`) and the display is **generated
from it**. Never type the table by hand — a typed table goes stale the moment
the config changes, which is the failure the whole design exists to prevent.

Resolve the plugin root (`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks):

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
node "$AC/scripts/routing-table.mjs"
```

PowerShell:

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
node "$AC/scripts/routing-table.mjs"
```

Add `--json` for machine-readable output. The committed copy is
`docs/ROUTING.md`; the `routing-doc` audit check fails if it drifts from the
config, and `--fix` regenerates it.

## Presenting it

Show the whole rendered output — it is already organised. If the person asked
a narrower question ("what does weight 4 diagnostic get?"), answer that line
directly and point at the grid rather than pasting everything.

If the table looks wrong for the task in hand, say so and change the **config**,
not the answer. Then regenerate. A judgement that changes the table improves
every future call; one that overrides it silently leaves the table lying.
