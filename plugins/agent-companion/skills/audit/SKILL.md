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
  available and the mechanism behind unexamined premium fan-out.
- **harness-drift** — Claude Code version changes and unrecognised agent types.
  A renamed tool or matcher does not error; the guards just stop firing.
- **guard-canary** — provokes each guard and asserts it responded. This is the
  only check that distinguishes "no violations" from "not running".
- **spawn-audit** — recorded spawn mix; flags inherited-model spawns and an
  unused cheap tier.

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
