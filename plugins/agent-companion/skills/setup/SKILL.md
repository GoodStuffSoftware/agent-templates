---
name: setup
description: One-time setup of agent-companion on a machine or account — verify the install, choose options, schedule the daily calibration scout BOTH locally (desktop scheduled task) and in the cloud (claude.ai routine), and prove the guards fire. Use when installing the plugin on a new machine, when asked "how do I set up agent-companion", "schedule the scout", "is the scout running", or whenever the routing table or guards seem to have stopped being checked.
---

# Set up agent-companion

Installing the plugin turns on the hooks. It does **not** schedule the scout —
the daily check that notices when the harness, the model lineup, or the guards
drift. That has to be scheduled, and scheduled **twice**, because the two
places it can run see different data. Setup is the four steps below; each is
idempotent, so re-running this skill on a machine that is half set up is safe.

## 0. Verify the install

`${CLAUDE_PLUGIN_ROOT}` exists only inside hooks. Resolve the root explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
[ -f "$AC/scripts/audit.mjs" ] && echo "plugin ok: $AC" || echo "NOT INSTALLED"
node "$AC/scripts/audit.mjs" --only plugin-manifest,guard-canary
```

`guard-canary` must PASS. If it SKIPs, the hooks are not wired — usually a
stale marketplace cache. The fix, in order, is `claude plugin marketplace update
<marketplace>`, then `claude plugin update agent-companion@<marketplace>`, then a
restart (desktop) or `/reload-plugins` (CLI). Re-run the canary. The README's
"four stale-state traps" section covers the variants.

## 1. Choose options

Every feature is a toggle under `pluginConfigs` in `settings.json`; the
defaults are the recommended ones. Two are worth a conscious decision:

- `telemetry_endpoint` — empty means telemetry stays on this machine. Set it
  only if an Agent Audit ingest exists to receive it; the token goes in the
  `AGENT_AUDIT_TOKEN` environment variable, never in plugin config.
- `premium_max_concurrent` — the Fable/Opus instance cap. Default 2.

## 2. Schedule the local scout — desktop scheduled task

**Why local:** the stateful signals (harness version delta, zero denials across
real spawn activity, inherited-model spawns, unknown agent types) live in
`~/.claude/plugins/data/agent-companion-<marketplace>/`. Only a session on this
machine can read them.

Use the desktop app's `scheduled-tasks` MCP — the `schedule` skill wraps it —
with `create_scheduled_task`:

- `taskId`: `agent-companion-scout`
- `cronExpression`: **local** time, e.g. `45 6 * * *` — daily, a little before
  the cloud run so a morning session sees both
- `prompt`: the body of `routines/calibration-scout-daily.md` from the plugin,
  with `{{MARKETPLACE_REPO}}` replaced by the `owner/repo` the plugin ships from

Two facts to tell the user: the task runs **only while the desktop app is
open** (a missed run fires on next launch), and its last result is surfaced at
the start of the next interactive session by the `scout-surface` hook, so a
signal is not lost if nobody reads the run.

If a task with that id already exists, `update_scheduled_task` it — never
create a duplicate.

## 3. Schedule the cloud scout — claude.ai routine

**Why cloud:** the lineup and pricing diff needs the web, and the cloud run
happens whether or not any machine is on. It runs from the repo checkout, so
**no plugin install is needed in the routine's environment**.

Use the Claude Code `schedule` skill, which calls `RemoteTrigger`:

- `name`: `agent-companion-scout`
- `cron_expression`: **UTC**, e.g. `0 11 * * *` (7am America/New_York)
- `job_config.ccr.environment_id`: the account's default cloud environment
- `session_context.model`: `claude-sonnet-5` — the scout interprets
  deterministic signals; it does not need a premium tier
- `session_context.sources`: the marketplace repo (the plugin lives in it)
- `session_context.allowed_tools`: `Bash, Read, Glob, Grep, WebFetch, WebSearch`
- `events[0].data.message.content`: the same hydrated prompt as step 2

**Check `mcp_connections` in the create response.** The API attaches every
connector on the account by default — Gmail, Drive, Calendar, whatever is
connected — to a routine that only reads docs. Clear them immediately with an
`update` carrying `{"clear_mcp_connections": true}`; the scout needs none, and
a prompt rule against sending email is not a substitute for not holding the
handle.

Then `run` it once and read the run log — a first run you can read beats
trusting that tomorrow's will fire. Routines cannot be deleted from the CLI;
that is https://claude.ai/code/routines.

## 4. Prove it

```bash
node "$AC/scripts/audit.mjs" --dir <project> --only guard-canary,routing-doc,agent-defs
```

Then start a fresh session: the `scout-surface` hook should say nothing on a
quiet day and one line per signal otherwise.

## 5. Short form — `/ac`

Plugin skills are namespaced by the plugin's name, so the full form is
`/agent-companion:recommend`. A skill *inside* the plugin cannot escape that.
The plugin therefore ships a user-level forwarder under `shims/ac/`; install it
and `/ac recommend …`, `/ac evaluate …`, `/ac routing`, `/ac audit …`,
`/ac setup`, `/ac scout` all work:

```bash
mkdir -p "$HOME/.claude/skills/ac" && cp "$AC/shims/ac/SKILL.md" "$HOME/.claude/skills/ac/SKILL.md"
```

It is a pointer, not a copy — it forwards to the plugin skill and never
re-implements one. Re-run the copy after a plugin update that changes it.

## Staying current

Updating is the harness's job, and there are two built-in paths. Terminal
sessions: Claude Code's own plugin autoupdater runs at startup. Desktop
sessions: the app runs them with the auto-updater switched off, so the daily
local scout runs the two built-in commands (`claude plugin marketplace update`,
`claude plugin update`) at the start of each run. The plugin adds only a
notice (`update_notice`, default on): at session start it says when a newer
version is installed but this session is still running an older one, because
"installed" and "loaded" differ by a restart nobody is reminded to do. A
second install of the same plugin at project scope shadows the user-scope one
and never updates; `claude plugin list` shows both if so.

Releasing: bump `version` in **both** `plugin.json` and the plugin's entry in
`marketplace.json` — Claude Code reads the first, the claude.ai plugin
directory keys on the second, and the manifest check fails if they differ.

## What "set up" means

A machine is set up when all four are true: canary PASSES, options are a
decision rather than a default, a local task exists with a cron, a cloud
routine exists with a cron and has one readable run. Anything less is
"installed", which is not the same thing — an installed plugin whose scout
never runs is exactly the silent drift it was built to catch.
