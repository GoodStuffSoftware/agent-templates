---
name: calibration-scout
description: Daily calibration scout for agent-companion. Runs deterministic drift detectors, then dispatches heavier calibration routines only when a signal fires. Use when running the daily agent-companion calibration, checking for Claude Code harness drift, auditing model routing against the current lineup, or investigating whether guardrails have silently stopped firing.
---

# Calibration scout

Runs daily. **Costs almost nothing on a quiet day and says nothing on a quiet
day.** A routine that reports "no change" every morning trains the reader to
ignore it, and then it is useless on the morning that matters.

## Locate the plugin first

`${CLAUDE_PLUGIN_ROOT}` is set **only inside hooks**. In an ordinary shell it
is empty, so a command written with it collapses to `/scripts/audit.mjs` and
fails to resolve — quietly, and in a way that reads like the tool is missing
rather than the path being wrong. Resolve it explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
[ -n "$AC" ] || AC="$(ls -d "$HOME"/.claude/plugins/cache/*/agent-companion/* 2>/dev/null | tail -1)"
[ -n "$AC" ] || { echo "agent-companion not found — is the plugin installed?"; }
```

PowerShell:

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
```

(Forward slashes on purpose — PowerShell accepts them on Windows, and they
survive being copied through shells and JSON without backslash mangling.)

Every command below assumes `$AC` is set.

## Step 1 — detect (deterministic, no judgement)

```bash
node "$AC/scripts/detect.mjs"
```

Returns `{ changed, signals[], baseline }`. Each signal names its own `dispatch`.

**If `changed` is false: stop. Emit nothing.** Do not summarise, do not confirm,
do not report that you checked. Silence is the success case.

## Step 2 — dispatch

Only for signals that fired:

| Signal | Run |
|---|---|
| `harness_version_changed` | harness-surface diff, then the canary |
| `new_agent_type` | harness-surface diff |
| `zero_denials` | canary — guards may have stopped matching |
| `inherited_model_spawns` | routing review |
| `spawn_activity` with `spend-deep-dive` | spend attribution |
| `harness_version_unreadable` | report to the operator; do not guess |

### harness-surface diff

Claude Code ships as a compiled binary, and its hook surface is greppable from
it. This is how a renamed matcher gets caught — it produces no error, the guards
simply stop firing.

Locate the binary (`which claude` / `Get-Command claude`), then confirm each
still exists:

- the hook event list
- the `Agent` tool name (the spawn matcher; **not** `TaskCreate`, which is the
  to-do tool — these have been confused before)
- `agent_type`, `agent_id` in the hook payload builder
- `userConfig`, `pluginConfigs`, `CLAUDE_PLUGIN_OPTION_`
- the main-thread test (`agentType === "main"`)

Anything missing or renamed is a **break, not a curiosity** — open a fix
immediately, because the guards are already silently inert.

### guardrail canary

Confirm the guards still *fire*, not merely that the config still exists:

```bash
echo '{"session_id":"canary","agent_type":"main","tool_input":{"model":"claude-fable-5","prompt":"no warrant here"}}' | node "$AC/hooks/spawn-guard.mjs"
```

Expect `permissionDecision: "deny"`. Anything else means the guard is broken.

Then confirm it stays inert for workers — this must **never** deny:

```bash
echo '{"session_id":"canary","agent_type":"subagent","tool_name":"Bash"}' | node "$AC/hooks/delegation-guard.mjs"
```

### roster sweep — run this whenever a routing signal fires

The drift detectors above watch the harness. This watches the rosters, and it is
where new routing problems actually surface. Run the roster checks across every
project you know of:

```bash
node "$AC/scripts/audit.mjs" --dir <project> --only agent-defs,instruction-budget
```

It will report, in rough order of how much they cost you:

- a reviewer sized **below** the writer it gates, in model or in effort
- an agent with **no model**, silently inheriting the lead's tier
- an effort a model **does not accept** (haiku takes none at all)
- a model the tier table **does not recognise** — treated as premium, and a sign
  the table needs an entry rather than that the agent is wrong
- a pin to a model marked **unavailable** on this account
- always-loaded instruction files over budget

Treat a NEW finding as the interesting one. A standing finding you have already
decided to live with is noise; a finding that appeared since the last run means
something changed — a new agent, a new model, or a table that has gone stale.

### routing review

Fetch the current model lineup and pricing. Compare against the routing table in
the orchestration doctrine. Check specifically:

- models present in the lineup with **no row** in the table (this is how a
  premium tier went unbudgeted for months)
- prices that have moved (a tier silently getting cheaper changes the routing
  maths as much as one getting dearer)
- effort levels and thinking semantics that changed meaning

Open a PR against the doctrine on any divergence. Do not silently correct it —
the diff is the record.

### spend attribution

Aggregate transcripts by model and by agent type. Report cost share, tier mix,
and whether the cheapest tier is actually being used. A near-zero share at the
bottom tier means the routing table's lower rows are decorative.

## Step 3 — report

Only if something fired. Lead with what changed and what you did about it. One
screen maximum. Link to detail; do not paste it.
