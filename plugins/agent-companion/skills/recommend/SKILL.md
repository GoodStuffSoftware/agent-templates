---
name: recommend
description: Recommend the model and effort for the task - classifies it, resolves the routing table, states model, effort, premium warrant and reviewer tier. Use for "what model should I use for this", "should this be opus or sonnet", "does this need fable", "what effort for this", or before spawning a subagent for non-trivial work.
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

## Quick answer for a named task type (no shell needed)

When the task clearly matches one of these types, this table IS the answer —
the same resolution `recommend.mjs --type <name>` prints, generated from the
config. Use it directly when no shell is available (a read-only session, an
eval sandbox); use the script for anything that needs `--weight`, `--kind`,
`--consequence` or `--writer`.

<!-- routing-table:task-types BEGIN (generated from config/model-tiers.json by scripts/routing-table.mjs --sync-skill; do not edit by hand) -->
Config v8 (updated 2026-10-02). **Premium** = the spawn brief needs a `WARRANT:` line. Fable never appears here: it is a warranted exception, not a route.

| Task type | Route | Premium | What it is |
|---|---|---|---|
| `explore` | `haiku` (routing trial, review by 2026-10-16) | no | read-only search: where is X, what touches Y, does Z exist |
| `mechanical-edit` | `sonnet/low` (routing trial, review by 2026-10-16) | no | rename, config edit, reformat, apply a known migration recipe; spawn it only for a mechanical job of about 15+ calls or parallel work (lean worker shape), else the writer edits itself |
| `bounded-feature` | `opus/medium` (routing trial, review by 2026-10-04) | yes | a feature against a clear spec, 1-3 files, known shape |
| `integration` | `opus/medium` (routing trial, review by 2026-09-30) | yes | multi-file, cross-referencing, touches shared config or things other agents depend on |
| `debug-root-cause` | `opus/medium` (routing trial, review by 2026-10-04) | yes | a specific failure, unexplained regression, flaky test - the answer exists and must be found |
| `large-refactor` | `opus/high` (routing trial, review by 2026-10-16) | yes | large-scale refactor across a module or subsystem; the target shape is known, the surface is wide |
| `novel-design` | `opus/xhigh` (routing trial, review by 2026-10-04) | yes | a protocol, concurrency or sync/merge logic, a message bus, a new abstraction with no known-good shape |
| `critical-change` | `opus/xhigh` | yes | production data, migrations, destructive ops, auth, billing, secrets - regardless of size |
| `code-review` | writer's model, floored to opus/xhigh if critical and never fable; effort ≥ writer's | as writer (opus if critical or fable) | adversarial review of a diff; sized to the writer it gates |
| `long-autonomous-run` | `opus/high` (routing trial, review by 2026-10-16) | yes | an agent session expected to run for hours with minimal supervision |
| `subagent-worker` | `sonnet/low` (routing trial, review by 2026-10-16) | no | a delegated worker doing a bounded, well-specified piece of a larger task; spawn it only for a mechanical job of about 15+ calls or parallel work (lean worker shape), else the writer edits itself |
| `verify` | `haiku` (routing trial, review by 2026-10-16) | no | confirm a claim against reality: read a file, check a value, take a screenshot, does X exist/match Y — reports back, changes nothing |
| `operate` | `sonnet/low` (routing trial, review by 2026-10-16) | no | execute an ordered procedure or change a live system — even when every individual step looks trivial in isolation |

**Self-review:** a writer spawned as `bounded-feature`, `integration`, `debug-root-cause`, `large-refactor`, `novel-design`, `critical-change`, `long-autonomous-run` reviews its own work before it returns (it commits, spawns ONE foreground parity reviewer on its own rung, runs one fix round, and returns the verdict line verbatim), unless its brief carries the line `REVIEW: lead`. The protocol is in the body of `agent-companion:ac-opus-medium`, `agent-companion:ac-opus-high`, `agent-companion:ac-opus-xhigh`; on any other ladder rung (a routing profile or a local copy of the table can put a listed type there) the spawn guard appends the same text to the brief. A built-in or project agent does not self-review unless its own definition says so (give it the protocol and the `Agent` tool); until then the lead reviews it.
<!-- routing-table:task-types END -->

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

Add `--explain` to see HOW it was resolved: what each layer of the stack
(routing profile > shipped routing trial > grid) would give, which layer won
and why, which consequence floors fired, and the winner's provenance in one
line. An explicit weight, kind or consequence that departs from the type's
preset skips the profile and trial layers and answers from the grid; one
equal to the preset just restates the type. Use it when the answer surprises you or
someone asks why.

## Step 3 — act on the result, honestly

State the recommendation and the rationale it printed. Then:

- **Spawn the ladder agent for it** — `agent-companion:ac-<model>-<effort>`
  (e.g. `opus/low` → `ac-opus-low`). A bare `model:` with no effort runs at
  the lead's effort, not the routed one.
- **If it names a premium tier, the spawn brief needs a `WARRANT:` line** —
  the guard denies premium spawns without one. The script prints the template.
  A warrant you cannot write honestly is a downgrade in disguise; take it.
- **If it names `fable`, try the cheaper alternative first.** The best-sourced
  finding on Fable is that its edge is *procedural discipline*, not
  intelligence: stating a hypothesis before editing, labelling claims
  VERIFIED / REASONED / ASSUMED. A brief that carries that checklist on `opus`
  closes most of the gap. Fable also prefers whole-file rewrites and over-infers
  beyond explicit limits — a poor fit for scoped work even when warranted.
- **Pair the reviewer it printed.** At least the writer's model and effort
  (effort may exceed, must not drop); a critical change raises it to
  opus/xhigh whatever the writer (F1), and a fable writer's reviewer is capped
  to opus, which still needs a WARRANT (F2). A reviewer sized below the writer
  catches the errors it would itself have avoided and waves through the ones
  it would itself have made. **Name the writer in the review brief** on a line
  of its own next to `TYPE:` — `WRITER: <model>/<effort>` (`opus xhigh` and
  `opus at xhigh` read the same) or `WRITER: <agent-name>` (a ladder rung or
  project agent):

  ```
  TYPE: code-review
  WRITER: opus/xhigh
  ```

  The spawn guard then sizes the reviewer the same way and notes one below,
  above, or with an effort it cannot verify; a reviewer on its parity route's
  model (the writer's, after the floors) needs no WARRANT and is not counted
  by the premium cap. Without the line the guard cannot size a review at all
  — unless a subagent is spawning it, when the writer is read from that
  subagent's own definition and a note says so; a line with no effort, or an
  effort it cannot read, is checked on the model alone, and the note says so.
- **Self-reviewing types review themselves; `REVIEW: lead` opts out.** A
  writer of a listed type on a ladder rung (see the **Self-review** line
  above; `recommend.mjs` prints a `self-review:` line for these) commits,
  spawns its own parity reviewer, does one fix round, lands its own work and
  returns the reviewer's verdict line, so the lead does not spawn the reviewer
  printed above. Leave that alone unless the lead must review this one itself: then
  add a line of its own to the writer's brief —

  ```
  TYPE: novel-design
  REVIEW: lead
  ```

  The writer lands and verifies its own work (the repo's release gates stay);
  the lead settles the findings the writer disputes and spot-checks the review: the review file's first line should
  be the verdict the writer relayed, and the reviewer's real brief is the
  first user record of its transcript. A reviewer never spawns a reviewer:
  the spawn guard denies it.
- **An `auto-compact:` line is cost advice for long-running work.** It quotes the
  last cache-advisor run: the auto-compact window that breaks even for the
  recommended model on the operator's own transcripts, and the one value for
  their model mix (the setting is global), with the date of that run and
  whether it was a full or PARTIAL read. Relay it when the work is a long or
  resumed session; it is advice only, and the operator applies it with
  `/autocompact <value>`. No line means no advisor run yet
  (`scripts/cache-advisor.mjs`).
- **Do not route on "this model sticks to instructions better."** That claim is
  not in Anthropic's docs and first-hand reports contradict it. Route on
  capability needed, search benefit, and consequence.

## When the table is wrong

It will be — lineups change. If the recommendation looks off, say so with the
task in hand, and change the config (`config/model-tiers.json`), not the
answer. `docs/ROUTING.md` regenerates from it, and the `routing-doc` audit
check fails if it is left stale. A judgement that leaves no trace cannot be
calibrated; one that changes the table improves every future call.
