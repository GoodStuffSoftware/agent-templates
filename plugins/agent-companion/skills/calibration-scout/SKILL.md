---
name: calibration-scout
description: Daily calibration scout for agent-companion. Runs deterministic drift detectors, then dispatches heavier calibration routines only when a signal fires. Use when running the daily agent-companion calibration, checking for Claude Code harness drift, auditing model routing against the current lineup, or investigating whether guardrails have silently stopped firing.
---

# Calibration scout

Runs daily. **Costs almost nothing on a quiet day and says nothing on a quiet
day.** A routine that reports "no change" every morning trains the reader to
ignore it, and then it is useless on the morning that matters.

## Step 1 — detect (deterministic, no judgement)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.mjs"
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
echo '{"session_id":"canary","agent_type":"main","tool_input":{"model":"claude-fable-5","prompt":"no warrant here"}}' | node "${CLAUDE_PLUGIN_ROOT}/hooks/spawn-guard.mjs"
```

Expect `permissionDecision: "deny"`. Anything else means the guard is broken.

Then confirm it stays inert for workers — this must **never** deny:

```bash
echo '{"session_id":"canary","agent_type":"subagent","tool_name":"Bash"}' | node "${CLAUDE_PLUGIN_ROOT}/hooks/delegation-guard.mjs"
```

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
