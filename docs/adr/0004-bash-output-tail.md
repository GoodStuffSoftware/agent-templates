# ADR 0004: send a long-runner's Bash output to a file and return its tail

**Status:** Accepted (2026-10-03). Not yet released.
**Date:** 2026-10-03
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

> Numbering follows ADR 0001's convention. ADR 0002 sits on an unmerged
> branch, so this one is 0004.

## Context

Every character a tool returns becomes part of the conversation, and the
conversation is re-read from the prompt cache on every later call of that
agent. A 3,000-line test run, a verbose build or an install log is paid for
once when it is written and again, at the cache-read price, on every call
after it, until the agent is compacted or ends. Test, build and install runs
are the largest single outputs a coding agent produces, and the part that
matters (the failure summary, the final count) is at the end.

The 2026-10-02 plan-unit measurement put 78% of plan units in subagents, so the
fix has to reach subagents as well as the main thread.

**Requirements** (from the brief):

1. Failures are never hidden, and the exit code is preserved exactly.
2. The full-output path appears in the returned text.
3. Short, piped, redirected, interactive and git-plumbing commands stay untouched.
4. Works in Git Bash on Windows and on POSIX; PowerShell handled or ruled out.
5. An opt-out, and a way for the 2026-10-16 routing review to measure the effect.

## What the hooks interface allows (verified)

Sources: the hooks reference at code.claude.com/docs/en/hooks, and the
installed Claude Code 2.1.283 binary (its bundled hook-output validation and
`sdk-tools.d.ts`), read on 2026-10-03.

- **PreToolUse** can return `hookSpecificOutput.updatedInput`, optionally with
  `permissionDecision` (`allow`/`deny`/`ask`/`defer`), `permissionDecisionReason`
  and `additionalContext`. `updatedInput` with **no** `permissionDecision` is
  applied and the call continues through the normal permission flow. This is
  the shape `spawn-guard.mjs` already uses.
- Permission checks run on the **rewritten** input. A `Bash(npm test:*)` allow
  rule does not match a wrapped command.
- Several PreToolUse hooks on one tool may each return `updatedInput`. The docs
  do not say how they combine; treat it as last-wins. Another plugin that
  rewrites Bash `command` would therefore conflict.
- **PostToolUse** can return `updatedToolOutput`. In 2.1.283 it works for every
  tool (not only MCP; `updatedMCPToolOutput` is the older MCP-only form) and is
  validated against the tool's output shape. For Bash that shape is
  `{ stdout, stderr, interrupted, ... }`. Hooks for one event run in parallel on
  the ORIGINAL output, so two rewriters are last-write-wins.
- **A Bash command that exits non-zero fires PostToolUseFailure, not
  PostToolUse.** PostToolUseFailure's `hookSpecificOutput` accepts only
  `additionalContext`; it cannot replace the output. So a PostToolUse rewrite
  can shrink only SUCCESSFUL runs.
- Hooks fire inside subagents too; the payload carries `agent_id`/`agent_type`.
  The common input includes `permission_mode`.
- PreToolUse fires before the command runs, so it can see the command but not
  its output. PostToolUse sees the output but cannot see a failure's output
  rewritten (above).

## Decision

A **PreToolUse hook on `Bash`** (`hooks/bash-tail.mjs`, rules and generated
shell in `hooks/lib/bash-tail.mjs`) rewrites a known long-running command so
that its combined stdout and stderr go to a file, and prints a tail with the
file's path. It returns `updatedInput` and never a `permissionDecision`.

### The wrapper

```
{ <original command>
} > "$file" 2>&1          # a group, not a subshell: cd and variables persist
rc=$?                     # captured at once
... if lines <= 80 and bytes <= 8000: cat the file, delete it
    else: header "[ac-bash-tail] exit N; L lines, B bytes ...; Full output: <path>"
          + last 60 lines (failed run) or last 20 (passing run), each cut to 1000 chars
(exit "$rc")              # re-raises the status without ending the shell
```

- The threshold is checked **at run time**, on what the command actually wrote.
  A command we guessed was long but that printed ten lines prints those ten
  lines, whole, so nothing is hidden and nothing is saved-and-lost.
- A failed run keeps 60 lines, a passing run 20: every runner on the list puts
  its failure summary last, and a failure is the case where more context pays.
- If the output file cannot be created (`mkdir`/`: >` fails), an `else` branch
  runs the original command exactly as written.
- `cygpath -m` turns the file's path into `C:/...` form on Git Bash so the
  printed path works with the Read tool; elsewhere the path is printed as is.
- stdout and stderr are merged into one stream, as they are in the Bash tool's
  own result text. A caller that distinguishes them loses that, only for the
  tailed runs.
- On finishing, the wrapper appends one `result` row (exit code, lines, bytes,
  characters returned) to `telemetry/bash-tail.jsonl`. This is the measurement
  hook for the 10-16 review: `scripts/bash-tail-report.mjs`.

### Trigger: an allowlist of runners, with blockers

Wrap only when a **known runner** is present in the command and **no blocker**
is. The runner list is conservative (package-manager test/build/install/ci
verbs and test-like script names, `vitest`, `jest`, `pytest`, `cargo`, `go`,
`dotnet`, `make`, `gradle`, `mvn`, `tsc`, `node --test`, `docker build`, and
similar). Blockers, found with a small quote-aware lexer:

- a pipe, any redirect (`>`, `<`, `&>`, `2>&1`, heredocs), `&` (background),
  a subshell `( )`, command substitution (`$( )`, backticks), an unterminated quote;
- a compound statement (`if`, `for`, `while`, `case`, `{`, `!`);
- a word that ends or replaces the shell or reads input (`exit`, `exec`,
  `trap`, `eval`, `sudo`, `ssh`, `read`, `watch`, `tee`, editors, `set -x`);
- a flag that means watching, interactivity or machine-readable output
  (`--watch`, `--json`, `--message-format`, `--reporter=json`, `--collect-only`,
  `--version`, `--help`, `--dry-run`, and similar);
- `run_in_background` (its output already goes to the task's own file);
- any command that is not a known runner, including every `git` command.

Everything else passes through with no output at all. A command that pipes
(`npm test 2>&1 | tail -30`) is the operator's own opt-out and is respected.

### Permission modes

Because permission rules are checked against the rewritten command, the
rewrite applies only when `permission_mode` is `bypassPermissions` by default
(`bash_tail_permission_modes`; `any` lifts the limit). In that mode no rule is
consulted, so the rewrite cannot turn an allowed command into a prompt or a
denial. Outside it the hook logs a `skipped` row with the reason and does
nothing. This is the conservative default; the setting exists so an operator
who knows their allow rules can widen it.

### Opt-out and measurement

- `bash_tail: false`, or `CLAUDE_PLUGIN_OPTION_BASH_TAIL=0` in the environment.
- `telemetry/bash-tail.jsonl`: `wrapped`, `skipped` (with reason) and `result`
  rows; `scripts/bash-tail-report.mjs` summarises them. Documented in
  `docs/TELEMETRY.md`.

### PowerShell: out of scope

The `PowerShell` tool has different syntax (no `{ }` group with `$?` the same
way, different redirection and exit-code rules). The hook's matcher is
`^Bash$` and it does nothing for PowerShell. Claude Code on this machine uses
Git Bash for the Bash tool, and the wrapper is plain POSIX sh. A PowerShell
wrapper can be a later ADR if the measurement shows PowerShell runs are a
meaningful share.

## Alternatives considered

**A. A standing rule or injected instruction ("redirect long output to a file
and tail it").** Costs tokens in every session whether or not a long command
runs (the standing-rules block already has a 4,000-character cap), and relies
on the model complying every time, in every subagent, including after
compaction. The failure mode is silent: the output simply comes back whole.
Rejected as the mechanism. It stays available as a complement for commands the
hook deliberately leaves alone (a piped command, a PowerShell run).

**B. PostToolUse `updatedToolOutput`.** Attractive because it sees the real
output and so needs no guess about length. Rejected as the main mechanism: a
Bash command that exits non-zero fires PostToolUseFailure, which cannot rewrite
output, so exactly the biggest outputs (a failing test run) would not be
covered; sibling rewriters are last-write-wins; and the output has already been
produced and is already in memory (nothing is saved on the run itself). It
remains a candidate for the SUCCESSFUL-run half if the measurement shows that
class is worth the second hook. It does not conflict with this design.

**C. Wrap every Bash command, shrink by size at run time.** Simplest rule and
no list to maintain. Rejected: it rewrites `git`, `ls`, `cat` and interactive
commands, which breaks the requirement that those stay untouched, it changes
the shape of every result, and it turns every permission rule into a miss.
The allowlist keeps the blast radius to commands where the saving is large and
the failure summary is known to be at the end.

**D. A threshold-only hook that denies a long command and asks for a redirect.**
Cannot know the length before running. Rejected.

**E. Claude Code's built-in truncation of long Bash output.** It exists as a
backstop on a single result (the `BashOutput` shape carries a
`persistedOutputPath` field for output saved to disk), but its limit is a
safety limit, far above what is worth re-reading hundreds of times, and the
exact cut was not measured here. It does not stop a 20,000-character test log
from being carried in context. It is the backstop, not the answer.

**F. Do it in a wrapper binary on PATH.** Cannot reach the harness's own call
and does not exist in a subagent's environment unless installed per machine.
Rejected.

## Consequences

- A failing test run now returns 60 lines plus a path instead of thousands of
  lines; a green run, 20 lines. If the failure is not in the last 60 lines, the
  agent reads the file at the printed path. That is one extra call in the case
  where the tail was not enough; the header says how big the output was so the
  agent knows to look.
- Output is no longer in the transcript, so a later session reading the
  transcript sees only the tail. The file persists for 3 days under
  `<tmp>/ac-bash-tail/`.
- `Bash` calls now run through a shell wrapper whose text appears in the
  permission prompt in any mode that allows it to apply (only `any`, or a
  list the operator sets).
- Another plugin's Bash `updatedInput` hook and this one are last-wins. No such
  hook is installed here; flagged for the operator.
- The runner list is a maintenance cost: a new build tool is not wrapped until
  it is added. The failure is benign (the command runs as it did before).

## Unverified (honest limits)

- **No live end-to-end probe.** A nested `claude -p` run to observe the
  rewritten command, the PostToolUse path and the permission interaction in the
  real harness could not authenticate in the authoring session (the OAuth
  session had expired). The `updatedInput`/`permissionDecision` shapes, the
  rewritten-input permission check, the PostToolUseFailure limitation and the
  `permission_mode` field are verified from the docs and the installed 2.1.283
  binary, not by observation. The generated shell, its exit-code preservation
  and the hook's output are tested directly (`tests/bash-tail.test.mjs`, which
  runs the wrapper in a real bash).
- The multi-hook `updatedInput` combination rule is not documented; last-wins
  is an assumption.
- Windows Git Bash and POSIX bash are the shells covered. zsh is expected to
  work (POSIX constructs only) but is not tested here.

## How to reverse

Set `bash_tail` to `false` (immediate, per user), or delete the `^Bash$` entry
from `hooks/hooks.json`. Nothing else depends on it: the telemetry stream and
report are read-only, and the files under `<tmp>/ac-bash-tail/` are pruned
after 3 days.

## What would show this was wrong

The 10-16 review should read `bash-tail-report.mjs`: (a) a high share of
`result` rows where an agent immediately re-ran the same command or read the
whole file (the tail was not enough); (b) a large `skipped` share for
`permission_mode:*` (the default gate leaves most of the saving on the table,
so widen it); (c) any non-zero-exit command whose failure text was missing from
the returned tail.
