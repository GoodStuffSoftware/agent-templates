# ADR 0005: the 0.30.0 token-saving trial (four toggled changes)

**Status:** Accepted (2026-10-04), shipped in 0.30.0 as a trial.
**Date:** 2026-10-04
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

## Context

The 2026-10-02 usage postmortem found that most plan units go to repeated reads
of the same context: text injected into every session and subagent, git state
re-read with `git status` / `git fetch` / `git rev-list` (about 5,100 git-read
Bash calls in a 7-day count), repeat `Read` calls of already-read lines, and
`gh` / `sleep` polling loops while waiting for CI.

## Decision

Ship four changes together, each behind its own toggle and each writing its own
telemetry stream, so any one can be switched off and measured on its own:

1. **Trimmed injected text** (no toggle; the standing-rules and scout settings
   already switch parts off). Keeps every rule, shortens rationale; the small
   requirements the trims dropped are listed in the CHANGELOG known limits.
2. **Git brief** (`git_brief`, `telemetry/git-brief.jsonl`): one line of git
   state at session and subagent start, and `scripts/git-brief.mjs`
   (`landed <sha|branch>`) as the single refresh command.
3. **Read dedupe** (`read_dedupe`, `telemetry/read-dedupe.jsonl`): a PreToolUse
   hook that denies a repeat Read of lines the same agent already read from an
   unchanged file; state is per agent; fails open.
4. **PR and CI wait** (`pr_wait`, `telemetry/pr-wait.jsonl`): `scripts/pr-wait.mjs`
   waits inside one script, bound to the PR head SHA, with a settle rule so a
   late-registering check set cannot give an early PASS.

## Why a trial, not a plain release

The savings are estimates from transcript counts. A cheaper behaviour that
forces a retry or a re-check is not a saving, so the measure is net of retries
and re-checks. The trial window is the first full week after release, compared
with the 2026-09-27..2026-10-04 baseline. Per-feature toggles keep a failing
feature from taking the others with it.

## Accepted costs

- The pr-wait hint is about 200 characters under a typical install, not 150:
  an absolute path cannot be shortened (wording is capped at 125 characters,
  path excluded, and tested).
- Known limits (parallel fetch stamps, late-registering checks, `NO-CHECKS`
  exiting 0, ctime on attribute changes, the scout detail moved to a file) are
  listed in the CHANGELOG under 0.30.0.

## Reverting

Each feature off: `git_brief`, `read_dedupe`, `pr_wait` options set to `false`
(or the matching `CLAUDE_PLUGIN_OPTION_*=0`). The trims are reverted by
restoring the 0.29.32 wording in the hooks and skills.
