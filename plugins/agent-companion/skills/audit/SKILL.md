---
name: audit
description: Run a composable agent-hygiene audit over a directory, project, or repo — memory-index reachability, always-loaded instruction budget, sub-agent model/effort routing, harness drift, and a canary proving the guards still fire. Use when asked to audit a project's agent setup, check why rules are not being followed, investigate context or token cost, verify guardrails still work after a Claude Code update, or clean up a memory directory.
---

# Agent-hygiene audit

A registry of independent checks with one runner. Checks are selectable and
chainable; the runner knows nothing about any individual check, so new checks
(or a new vendor's worth of checks) are additive.

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

## Run it

```bash
node "$AC/scripts/audit.mjs" --list
node "$AC/scripts/audit.mjs" --dir <path>
node "$AC/scripts/audit.mjs" --dir <path> --only memory-index,agent-defs
node "$AC/scripts/audit.mjs" --dir <path> --skip guard-canary
node "$AC/scripts/audit.mjs" --dir <path> --fix
node "$AC/scripts/audit.mjs" --dir <path> --json     # for scripting
```

`--dir` defaults to the current directory. Add `--strict` to exit non-zero on
any failure (use in CI). Add `--vendor <id>` to run only one ecosystem's checks.

## Reading the result

| Status | Means |
|---|---|
| `PASS` | the check ran and found nothing |
| `WARN` | real finding, not urgent |
| `FAIL` | something is broken or unenforced right now |
| `SKIP` | **the check could not run** — this is not a pass |
| `ERR` | the check threw |

`SKIP` is the one to read carefully. A check that cannot determine its answer
says so rather than reporting success, because "could not tell" and "fine" being
indistinguishable is the failure this whole plugin exists to prevent. If a check
you expected to run reports `SKIP`, find out why before concluding anything.

## The checks

- **memory-index** — files on disk that the index does not link. These can never
  be recalled. A dated finding in that state is harmless; a standing *rule* in
  that state is a correctness bug, because it is believed to be in effect and
  silently is not. **Fixable.**
- **instruction-budget** — always-loaded files over budget, plus the documented
  200-line guidance for `CLAUDE.md`. Every token here is paid on every session.
- **agent-defs** — sub-agent frontmatter. Flags a missing `model` hardest: an
  omitted model inherits the *lead's* tier, which is the most expensive default
  available and the mechanism behind unexamined premium fan-out. An omitted
  `effort` likewise inherits the lead's effort; the fix for both is to spawn
  the ladder agent (`ac-<model>-<effort>`) that
  `node "$AC/scripts/recommend.mjs" --type <type>` routes to.
- **harness-drift** — Claude Code version changes and unrecognised agent types.
  A renamed tool or matcher does not error; the guards just stop firing.
- **guard-canary** — provokes each guard and asserts it responded. This is the
  only check that distinguishes "no violations" from "not running".
- **spawn-audit** — recorded spawn mix; flags inherited-model spawns and an
  unused cheap tier.
- **memory-index-ceiling** — Claude Code's native memory loader only reads the
  first 200 lines or 25KB of `MEMORY.md`, whichever hits first, and drops
  everything past that SILENTLY on the next load. Measures every project's
  index against that cliff (with a margin: WARN/FAIL trigger a bit inside the
  real limit) and names the worst offender. Read-only; not fixable — trimming
  an index is a judgement call, not a mechanical repair.
- **memory-store-forks** — the memory directory is keyed by an encoding of the
  working-directory path, so the same project opened from two paths (a
  Windows drive letter, a WSL mount, a native Linux path) becomes two
  unlinked stores. Groups stores by a normalised project name, picks the
  newest-modified as live, and byte-compares the rest against it: file-set
  overlap, identical counts, and — the only ones worth a human's time — files
  where the OLDER store's copy is *larger*. Proposes only; never merges or
  archives.
- **memory-near-duplicates** — reuses the BM25 engine from
  `hooks/lib/memory-index.mjs` to find chunks in *different* files that score
  above a tuned similarity threshold, capped to the top matches. High lexical
  similarity means near-duplication, not contradiction — two memories that
  disagree about the same fact can score just as high as two that agree, so
  this only flags a pair as worth a human or model look. Read-only; not
  fixable — consolidating overlapping memories needs judgement.
- **cache-ttl** — would a 1-hour `subagentPromptCacheTtl` save or cost this
  operator money, measured against their own transcripts (default 30-day
  window, not the audit's usual 7)? Reports totals, a band table, the sanity
  check that proves the 5-minute cache cliff, gap-cause and tool-wait
  breakdowns, per-model and per-agentType×model deltas, a three-way policy
  comparison (all-5m / all-1h / 1h-for-opus-and-fable-only), and a one-line
  verdict. Purely informational — the finding itself never fails or warns;
  only the check's ability to run is graded. Read-only; not fixable — this
  never writes a setting or an agent definition, and never will. Runs
  standalone too: `node "$AC/scripts/cache-ttl.mjs" --days 30 [--json]`. See
  `plugins/agent-companion/README.md#cache-ttl-analysis` for the method.
- **cache-advisor** — the auto-compact window that costs least for each model,
  and the one value for the operator's model mix, from a replay of their own
  transcripts (default 30-day window, reading bounded by the
  `cache_advisor_max_ms` option, newest files first). Warns only when the
  window in effect costs more than 5% above the cheapest. Advice only: it never
  writes a setting; the operator applies it with `/autocompact <value>`. Runs
  standalone too: `node "$AC/scripts/cache-advisor.mjs" [--days 30] [--json]`.
  See `plugins/agent-companion/README.md#cache-advisor-the-auto-compact-window`.

## Fixing

`--fix` runs only on checks marked fixable, and only when they failed or warned.
Repairs are non-destructive by design: files are **moved** to `archive/`, index
entries are only **added**, the index is backed up first, and nothing is ever
deleted.

**Consolidating overlapping memories is deliberately not automated.** Merging
needs judgement and doing it wrong loses knowledge permanently. If the index is
over budget after a fix, that is expected — re-linking unreachable rules makes
the index larger. Reachability and size are separate problems and `--fix` only
addresses the first. Propose a consolidation plan and get it approved before
touching content.

## When reporting to a human

Lead with `FAIL` and unexpected `SKIP`. Give counts, not file dumps. Say plainly
what is unenforced right now versus what is merely untidy — those warrant very
different urgency, and conflating them buries the one that matters.

## Other ecosystems

Every check currently shipped reads Claude Code's own layout (hooks,
`.claude/agents`, `~/.claude/projects`), so all are tagged `vendor: anthropic`.
The enforcement machinery does not port — hooks are a Claude Code feature. What
ports is the knowledge: inheritance defaults are the expensive case, unreachable
knowledge is worse than missing knowledge, and a guard measured by non-events
needs a canary. Add a vendor's checks when there is a real project on it, not
speculatively.
