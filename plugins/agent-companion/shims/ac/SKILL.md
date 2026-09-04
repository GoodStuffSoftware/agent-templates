---
name: ac
description: Short entry point for the agent-companion plugin — "/ac recommend …", "/ac evaluate …", "/ac routing", "/ac audit …", "/ac setup", "/ac scout". Forwards to the matching agent-companion skill and passes the arguments through. Installed at user level (~/.claude/skills/ac) by the plugin's setup skill, because a skill inside a plugin is always namespaced by the plugin's name.
---

# ac — agent-companion, short form

Plugin skills are namespaced by the plugin name, so the full form is
`/agent-companion:<skill>`. This user-level skill exists only so that
`/ac <subcommand> [args]` works instead. It is a pointer, not a copy: never
re-implement a skill here.

## Dispatch

Take the first word of the arguments as the subcommand and pass the rest
through unchanged.

| `/ac …` | Forwards to the skill | Direct fallback |
|---|---|---|
| `recommend <args>` | `agent-companion:recommend` | `node "$AC/scripts/recommend.mjs" <args>` |
| `evaluate <args>` | `agent-companion:evaluate` | `node "$AC/scripts/evaluate.mjs" <args>` |
| `routing` or `table` | `agent-companion:routing-table` | `node "$AC/scripts/routing-table.mjs"` |
| `audit <args>` | `agent-companion:audit` | `node "$AC/scripts/audit.mjs" <args>` |
| `setup` | `agent-companion:setup` | — |
| `scout` | `agent-companion:calibration-scout` | — |
| *(nothing)* | print this table | — |

Invoke the plugin skill with the Skill tool when it is loaded in this session.
If it is not — an older plugin version, or a session that started before an
update — use the Direct fallback, resolving the root first:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

A subcommand that matches nothing above is an error: say which subcommands
exist rather than guessing.

## Arguments

$ARGUMENTS
