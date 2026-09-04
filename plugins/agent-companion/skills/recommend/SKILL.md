---
name: recommend
description: Recommend which model and effort to use for the task at hand. Classifies the work by task type (or weight, kind, and consequence), resolves it through agent-companion's routing table, and states the model, the effort, whether a premium warrant is required, and the reviewer tier that should gate it. Use when asked "what model should I use for this", "should this be opus or sonnet", "does this need fable", "what effort for this", or before spawning a subagent for anything non-trivial.
---

# Recommend a model and effort

The routing table exists so this decision is made once, as data, instead of by
taste at every spawn. This skill is the front door to it.

## Locate the plugin first

`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks. Resolve the root explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

PowerShell (forward slashes on purpose — they survive copy-paste):

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
```

## Step 1 — classify the task

Pick the closest named task type:

```bash
node "$AC/scripts/recommend.mjs" --list
```

If none fits, classify directly on three axes:

- **weight 1–5** — how much *capability* the task needs. 1–2 lookups and one-step
  transforms; 3 bounded multi-step; 4 multi-file and cross-referencing; 5
  architecture, novel reasoning, migrations. **Round down when unsure** and
  escalate on failure — over-provisioning is a rule violation, not a margin.
- **kind** — how much the answer *benefits from search*. `mechanical` has one
  right shape (a rename, a routing table). `bounded` has a known shape to fill
  in. `diagnostic` is a search for an answer that exists. `novel-design` has no
  known-good shape to copy (a message bus, a protocol, concurrency).
- **consequence** — how bad it is if this is wrong. `routine` is reversible.
  `elevated` costs other people time (shared config, pipelines, public API).
  `critical` is expensive or irreversible (production data, migrations, auth,
  billing, secrets). **Consequence is a floor and cannot be undercut by kind** —
  a one-line prod migration is mechanical AND critical, and the floor wins.

## Step 2 — resolve it

```bash
node "$AC/scripts/recommend.mjs" --type debug-root-cause
node "$AC/scripts/recommend.mjs" --type bounded-feature --consequence critical
node "$AC/scripts/recommend.mjs" --weight 4 --kind diagnostic
node "$AC/scripts/recommend.mjs" --type code-review --writer opus/xhigh
```

Explicit flags override a task type's preset, so `--type` plus one flag is the
common case.

## Step 3 — act on the result, honestly

State the recommendation and the rationale it printed. Then:

- **If it names a premium tier, the spawn brief needs a `WARRANT:` line** —
  the guard denies premium spawns without one. The script prints the template.
  A warrant you cannot write honestly is a downgrade in disguise; take it.
- **If it names `fable`, try the cheaper alternative first.** The best-sourced
  finding on Fable is that its edge is *procedural discipline*, not
  intelligence: stating a hypothesis before editing, labelling claims
  VERIFIED / REASONED / ASSUMED. A brief that carries that checklist on `opus`
  closes most of the gap. Fable also prefers whole-file rewrites and over-infers
  beyond explicit limits — a poor fit for scoped work even when warranted.
- **Pair the reviewer it printed.** Same model as the writer; effort may
  exceed, must not drop. A reviewer sized below the writer catches the errors
  it would itself have avoided and waves through the ones it would itself have
  made.
- **Do not route on "this model sticks to instructions better."** That claim is
  not in Anthropic's docs and first-hand reports contradict it. Route on
  capability needed, search benefit, and consequence.

## When the table is wrong

It will be — lineups change. If the recommendation looks off, say so with the
task in hand, and change the config (`config/model-tiers.json`), not the
answer. `docs/ROUTING.md` regenerates from it, and the `routing-doc` audit
check fails if it is left stale. A judgement that leaves no trace cannot be
calibrated; one that changes the table improves every future call.
