---
name: evaluate
description: Evaluate whether the agent currently running — or one about to be spawned — is provisioned correctly for its task. Verdict is over-provisioned (paying for a tier the work does not need), under-provisioned (the task exceeds the tier), or fit, with the action for each. Use when asked "is this the right model for this", "am I over-provisioned", "should this have been sonnet", "is fable overkill here", when a task turns out heavier or lighter than it was briefed, or before spawning a reviewer to check its parity with the writer.
---

# Evaluate the running agent's fit

`recommend` is the question *before* the spawn: what should this run on?
This is the question *during*: is what is running right for what the task
turned out to be? Same table, read the other way. The difference between the
two answers is where money and mistakes come from — a task briefed at weight 2
that became a weight-4 debug, or a Fable session spending the afternoon on
renames.

## Locate the plugin first

`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks. Resolve the root explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

PowerShell (forward slashes on purpose):

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
```

## Step 1 — state what is actually running

- **model** — from your own system prompt ("You are powered by the model
  named …"). Give the alias: `fable`, `opus`, `sonnet`, `haiku`.
- **effort** — only if you know it (a brief or agent definition said so).
  Otherwise omit it; model dominates the verdict.
- **the task as it turned out**, not as it was briefed — a task type from
  `recommend.mjs --list`, or weight / kind / consequence. That gap is the
  whole point of asking.

## Step 2 — run it

```bash
node "$AC/scripts/evaluate.mjs" --model sonnet --effort high --type debug-root-cause
node "$AC/scripts/evaluate.mjs" --model opus --effort xhigh --weight 3 --kind mechanical
node "$AC/scripts/evaluate.mjs" --model sonnet --effort high --type code-review --writer opus/xhigh
```

Exit code 0 is fit, 1 over-provisioned, 2 under-provisioned.

## Step 3 — act on the verdict, honestly

- **OVER** is a cost problem, not a correctness problem. Finish the current
  step, then hand the remainder down to the model it printed (the `ho`
  skill exists for this). Premium only: if a cheaper tier genuinely cannot do
  the rest, say so with a `WARRANT:` line — and if you cannot write that line
  honestly, hand off. "It's already running, may as well" is the reasoning
  the premium cap exists to interrupt.
- **UNDER** is a correctness problem. Escalate to the model it printed (with
  a `WARRANT:` line if premium). Treat what you have already produced as
  suspect wherever it needed the missing capability, and say so in the
  handoff rather than letting it pass as reviewed.
- **FIT** — continue. One line if asked.
- **UNKNOWN** — the model is not in the tier table; the guards treat it as
  premium. Add it to `config/model-tiers.json`.

## Spawns are evaluated automatically

The spawn guard runs the same comparison on every brief that declares
`WEIGHT:` (or `WARRANT: weight N`): it records the fit in telemetry and warns
when a spawn is under-provisioned for its declared weight. Declaring weight on
every brief — not only premium ones — is what makes that data exist; the
`spawn-audit` check reports how often spawns land over, under, or fit.
