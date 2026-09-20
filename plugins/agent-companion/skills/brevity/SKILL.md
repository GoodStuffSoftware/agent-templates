---
name: brevity
description: Turn the agent reporting contract on or off — globally, or for one agent type regardless of the global setting — and see which layer is currently winning. Use when asked to make agents less verbose, stop agents writing essays, "quiet the agents down", turn the reporting contract on or off, exempt one agent from it, check whether brevity is on, or find out which agent types are actually producing long reports.
---

# brevity — the agent reporting contract

Subagents narrate. The caller wanted blockers and an outcome and received a
journey, and the journey is billed. This feature appends a short reporting
contract to every spawn brief, and keeps it applied with a hook rather than
hoping a written rule survives a long session.

Resolve the plugin root first; every command below uses it:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

## The switches, and which one wins

Three layers, highest first:

| Layer | Set by | Beats |
|---|---|---|
| per-agent | `brevity on\|off --agent <type>` | everything |
| runtime global | `brevity on\|off` | the plugin option |
| plugin option | `brevity` in settings, or `/config` | — |

**The per-agent layer is bidirectional, and that is the point.** `--agent X on`
turns the contract on for X while the global switch is off; `--agent X off`
turns it off for X while the global switch is on. Exempting one chatty
integration agent never requires giving up the contract everywhere.

## Commands

```bash
node "$AC/scripts/brevity.mjs"                      # status: every layer, and which one is winning
node "$AC/scripts/brevity.mjs" on                   # global on
node "$AC/scripts/brevity.mjs" off                  # global off
node "$AC/scripts/brevity.mjs" default              # drop the runtime override, fall back to the plugin option
node "$AC/scripts/brevity.mjs" off --agent Explore  # exempt one agent type, whatever the global says
node "$AC/scripts/brevity.mjs" on  --agent Explore  # force one agent type on, whatever the global says
node "$AC/scripts/brevity.mjs" clear --agent Explore
node "$AC/scripts/brevity.mjs" show [--agent <type>]  # the exact text that would be injected
node "$AC/scripts/brevity.mjs" --json               # the same status, machine-readable
```

Changes take effect on the **next spawn** — the toggles are read at spawn time,
not cached at session start, so nothing needs restarting.

When someone asks "is this actually on?", run `status` and read the winning
layer back to them. Do not answer from the plugin option alone; a runtime or
per-agent override is exactly the thing that makes that answer wrong.

## What gets injected

`show` prints it verbatim. Two shapes:

- **contract on** — status line, blockers in full and never compressed, outcome
  as facts, no progress narration, long output to a file. It ends with the
  peer-brevity sentence.
- **contract off** — only the peer-brevity sentence, because succinctness
  between agents was asked for unconditionally. `brevity_peer` in the plugin
  options is the separate switch for that clause; turning the contract off does
  not silence it.

## Why it does not drift

Three tie-ins, so a failure of one is not a failure of the feature:

1. **Spawn time** — `hooks/spawn-guard.mjs` appends the contract to the brief
   the subagent receives. This is the primary path.
2. **Subagent start** — `hooks/subagent-brevity.mjs` checks the prompt the
   subagent *actually got*. If the marker is there it stays silent; if the
   rewrite did not take, it injects the contract as context. It cannot
   double-inject, which matters: a brevity feature that paid its own tax twice
   would refute itself.
3. **Subagent stop** — the report's length is recorded per agent type, so the
   claim "this made reports shorter" is checkable rather than believed.

## Who is actually verbose

```bash
node -e "const {readFileSync}=require('fs');const p=process.env.HOME+'/.claude/agent-companion/telemetry/brevity.jsonl';const rows=readFileSync(p,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.event==='report');const by={};for(const r of rows){(by[r.agent_type]??=[]).push(r.report_chars)}for(const[k,v]of Object.entries(by))console.log(k, 'n='+v.length, 'median='+v.sort((a,b)=>a-b)[v.length>>1])"
```

Sort that by median and you have the list of agent types worth a per-agent
override — or worth a better brief, which is usually the real fix.

## The experimental gate

`brevity_stop_gate` (off by default) blocks an over-long final report once and
asks for it again in the contract shape. It is off because the block feeds the
reason back to the *same* subagent, costing a full extra turn — it only pays
where reports are routinely enormous. It is hard-capped at one block per agent
so it can never loop. Recommend it only after the telemetry above shows a
genuine problem.

## Related

- `/agent-companion:standing-rules` — the general "always do X if Y" mechanism.
  The main session's own outcome-level reporting rule lives there, as
  `lead-brevity`, and is gated on this feature being globally on.
