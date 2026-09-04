# agent-companion

Guardrails and calibration for agent teams. Every feature is independently
toggleable, and every guard fails open.

## Why

Orchestration rules written in `CLAUDE.md` are *aspirational*. They are delivered
as a user message competing with the user's latest request, and adherence drops
as the file grows. A rule about restraint — "delegate instead of doing it
yourself" — is the weakest kind, because the alternative is always more
convenient.

This plugin converts the rules that matter into structure.

It was built after two observed failures:

1. **Four premium-tier agents ran on a task that did not warrant one.** Nothing
   had gone wrong with the *choice* — subagents inherit the lead's model when
   nothing specifies one, so no choice was ever made. A better-worded rule could
   not have caught it. Only a default or a gate could.
2. **A routing table went stale without anyone noticing.** It was calibrated for
   a previous model generation, priced one tier ~33% too high, and had no row at
   all for the tier that was quietly costing the most.

## Features

| Toggle | Does | Blocks? |
|---|---|---|
| `delegation_guard` | Fires when the **main thread** runs `delegation_threshold` execution-class tools in a row. Inert inside every subagent. | nudge, with cooldown |
| `premium_cap` | Caps concurrent premium-tier subagents at `premium_max_concurrent`. | yes, at the cap |
| `warrant_required` | Premium spawns must carry a `WARRANT:` line stating task weight and why a cheaper tier will not do. | yes |
| `memory_budget` | Warns when always-loaded instruction files exceed `memory_budget_tokens`, and writes a ready-to-run refactor prompt. | no |
| `memory_doctor` | Detects memory files on disk that the index does not link — **unreachable rules** — plus broken index links. Repairs non-destructively. | no |
| `spawn_telemetry` | Records every spawn (model, agent type, effort) for the calibration routine. | no |
| `scout_surface` | At session start, surfaces unresolved signals from the last locally scheduled scout run. Silent on a quiet day. | no |
| `auto_update` | When Claude Code's own auto-updater is off (`DISABLE_AUTOUPDATER=1`), refreshes the marketplace and updates the plugin in the background once a day. Always says when a newer version is installed but not yet loaded. | no |

Premium tiers are **capped and audited, never banned**. The failure mode was
unexamined defaults, not the model itself.

## Memory doctor

The index is the source of truth for what is persisted, so a memory file the
index does not link **can never be recalled**. For a dated finding that is
harmless housekeeping. For a standing rule it is a correctness bug: you believe
it is in effect and it silently is not — the same failure shape as a guard that
stopped matching.

Run it against the current project, or any memory directory:

```bash
node scripts/memory-doctor.mjs                 # report only
node scripts/memory-doctor.mjs --fix           # repair
node scripts/memory-doctor.mjs --json          # for the calibration scout
```

Repairs are strictly non-destructive:

- files matching `memory_archive_prefixes` are **moved** to `archive/`, never deleted
- everything else is treated as a live rule and **re-linked** into the index
- the index is backed up before it is touched, and entries are only ever added

Consolidating overlapping memories is deliberately **not** automated. That needs
judgement, and doing it wrong loses knowledge permanently.

Note the tradeoff: re-linking unreachable rules makes the index *larger*.
Reachability and size are separate problems, and this tool only fixes the first.

## Model tiers are data, not code

Which models count as premium, and how they rank against each other, lives in
[`config/model-tiers.json`](config/model-tiers.json) — not in the guards. A tier
table compiled into code goes stale the moment a lineup changes, and it goes
stale **silently**: the guards keep running and simply stop classifying
correctly. This plugin exists partly because a routing table sat wrong for a
whole model generation without anyone noticing.

Override without waiting for a release by writing a file of the same shape to
`$CLAUDE_PLUGIN_DATA/model-tiers.json`. It merges **by alias**, so adding one
model needs one entry, not a restatement of the table — a table you have to
retype is a table you will not update:

```json
{ "tiers": { "newtier": { "rank": 2, "premium": false, "match": "newtier" } } }
```

**An unrecognised model is treated as premium and flagged.** Defaulting an
unknown model to cheap would let a newly released top tier bypass the warrant
and the fan-out cap during exactly the window in which nobody has updated the
table yet. So it fails toward the expensive assumption, and the audit tells you
the table needs an entry rather than quietly applying the strict path.

## Telemetry (optional, off by default)

**With no `telemetry_endpoint` set, this plugin makes no network calls at all.**
Setting one is the single action that turns sending on. Everything else — the
guards, the audit, the memory doctor — is entirely local and always will be.

When an endpoint *is* configured, emitted JSONL is POSTed to it:

| Fires on | Behaviour |
|---|---|
| `Stop` (turn boundary) | sends only if the interval has elapsed since the last successful send |
| `SessionEnd` | always sends — there may be no next turn |

The interval defaults to **10 minutes in cloud sessions** and **60 locally**.
Cloud sessions are shorter because their filesystem is destroyed with the
session and there is no later sweep; local runs keep the JSONL on disk, so a
missed send costs nothing. Cloud is detected via `CLAUDE_CODE_REMOTE_SESSION_ID`.

**Why a throttled hook rather than a background timer.** A detached daemon
either outlives its session (orphan) or dies with it (useless), and inside a
cloud sandbox it is fragile besides. Letting an already-firing hook carry the
work and rate-limiting it means nothing to schedule, nothing to leak, and no
need to know how long a cloud session lives — the worst case is losing one
interval whenever it disappears. Below the interval the hook exits after a
single file read.

**The token comes from the `AGENT_AUDIT_TOKEN` environment variable, never from
plugin config.** `userConfig` values live in `settings.json` in plaintext and
project-scoped settings get committed; a shared ingest secret does not belong
there.

Sending is always **fail-silent** with a 3-second timeout. A telemetry endpoint
being down must never surface as an error in someone's session, and must never
lose data: the cursor only advances on success, and the local JSONL stays on
disk to be swept up later.

`SessionEnd` fires on deliberate endings only — its reasons are `clear`,
`resume`, `logout`, `prompt_input_exit`, `other`, `bypass_permissions_disabled`.
There is no idle-timeout reason, and a crashed or killed process cannot run its
own hook. So cloud coverage is a sample, not a census. Treat a gap as unknown
rather than as quiet.

## Design rules

**A hook must never break a session.** Every guard wraps in try/catch and falls
through to allow. Unparseable payload, unreadable state, unrecognised agent
type — all allow.

**Enforcement fails open; detection does not.** The main-thread test is a
positive allowlist (`main`, `main-session`). An agent type we do not recognise is
never blocked — but it *is* recorded to `unknown-agent-types.jsonl`, so a new
type introduced by a harness update surfaces in the next calibration run instead
of silently changing behaviour.

**Under-enforcement is the safe failure.** A guard that stops matching looks
identical to a guard that was never tripped, so the calibration routine treats a
denial count of **zero** as a signal to run the canary — not as good news.

## Configuration

Toggles are declared as `userConfig` and set per-user without editing plugin
files:

```json
{
  "pluginConfigs": {
    "agent-companion": {
      "delegation_guard": true,
      "delegation_threshold": 4,
      "premium_max_concurrent": 2,
      "memory_budget_tokens": 3000
    }
  }
}
```

## State

Written under `${CLAUDE_PLUGIN_DATA}` (survives upgrades, removed on uninstall):

| File | Contents |
|---|---|
| `spawns.jsonl` | every `Agent` spawn: model, subagent type, effort |
| `subagent-starts.jsonl` | post-spawn confirmation |
| `unknown-agent-types.jsonl` | agent types not in the known set |
| `delegation-streak.json` | per-session main-thread streak counter |
| `premium-window.json` | rolling window used to approximate premium concurrency |
| `refactor-prompt.md` | generated when an instruction file is over budget or memory is unreachable |
| `baseline.json` | previous harness version + counters, for daily drift detection |

## Install

Installing turns on the hooks. It does **not** schedule the scout — that is a
separate, two-environment step (a desktop scheduled task for the stateful
signals, a claude.ai routine for the web-facing lineup diff). The `setup`
skill walks it: `Run /agent-companion:setup`.

Add the marketplace once per machine, then install:

```bash
claude plugin marketplace add GoodStuffSoftware/agent-templates
```

```bash
claude plugin install agent-companion@agent-templates
```

**Desktop app:** install from the plugin directory UI. It shells out to the same
CLI and reads the same `~/.claude/plugins/` cache, so everything below applies.

**Cloud sessions:** install there too — cloud clones fresh, so it always gets
the current version of `main`.

**Development, without installing** (never self-updates — use only for testing):

```bash
claude --plugin-dir ./plugins/agent-companion
```

### Updating — read this before debugging a "broken" fix

`marketplace add` clones **once and then pins**. An installed plugin does *not*
track `main` on its own. Push a fix and every machine keeps running the old code
until its marketplace cache is refreshed:

```bash
claude plugin marketplace update agent-templates
```

The desktop UI's sync button does the same thing. This bit us on the very first
publish: three install attempts failed against a manifest that had already been
fixed on `main`, because the cache was pinned to the commit before the fix and
the error said nothing about staleness.

**So when a machine shows old behaviour, suspect a stale cache before suspecting
the fix.** Verify what is actually cached rather than assuming:

```bash
git -C ~/.claude/plugins/marketplaces/agent-templates log --oneline -1
```

### Hot-loading into a running session

Skills and hooks load differently, and the difference matters when you are
trying to help an agent that is already mid-task:

- **Skills hot-load on their own.** `audit` and `calibration-scout` become
  available in already-running sessions shortly after install, no restart.
- **Hooks do not.** They are bound at session start, so a session that predates
  the install has no guards — silently, since nothing reports their absence.

Where it is available, bind them into the running session with:

```
/reload-plugins
```

(`--force` also rebuilds the conversation cache rather than reusing it.) A
long-running agent can then gain the guards without losing its context.

**That command is not available in every environment** — some surfaces report
`/reload-plugins isn't available in this environment`. There, the only way to
arm hooks is to start a new session. Skills still hot-load either way, so an
in-flight agent keeps the diagnostics regardless; it is only the *enforcement*
that waits.

### Four separate stale-state traps

Updating this plugin touches four independent caches, and skipping any one
leaves you running old code **with no error at all**:

| # | Step | Symptom if skipped |
|---|---|---|
| 1 | `claude plugin marketplace update <marketplace>` | installs re-run the old commit; a fix that is already on `main` appears not to work |
| 2 | `claude plugin update <plugin>@<marketplace>` | cache is current, installed version is not |
| 3 | `/reload-plugins`, or a new session | new version installed, old hooks still bound |
| 4 | check the running session's own age | a session predating the install never had hooks at all |

Two traps within the traps: `claude plugin update` needs the **fully qualified**
`plugin@marketplace` — the bare name fails with a misleading *"Plugin not
found"*. And `claude plugin details` reads the **cache**, not the installed copy,
so it will happily describe components that are not actually running.

Verify what is real rather than what is reported:

```bash
git -C ~/.claude/plugins/marketplaces/<marketplace> log --oneline -1
claude plugin list
```

### Verifying it is actually running

After installing or reloading:

```bash
ls ~/.claude/plugins/data/agent-companion/
```

Files there mean hooks have fired. A missing or empty directory after real work
means they registered but never ran — which looks exactly like "found no
issues". Confirm with the canary rather than trusting silence:

```bash
node "$AC/scripts/audit.mjs" --only guard-canary
```

## Skills

| Skill | Short form | Answers |
|---|---|---|
| `recommend` | `/ac recommend --type <task-type>` | what should this task run on: model, effort, warrant, reviewer |
| `evaluate` | `/ac evaluate --model <alias> --type <task-type>` | is what is running (or being spawned) right for it: over, under, or fit |
| `routing-table` | `/ac routing` | the current table, rendered from config |
| `audit` | `/ac audit --dir <project>` | the composable hygiene audit; `--fix` for the fixable checks |
| `setup` | `/ac setup` | the setup steps on a new machine, both scouts included |
| `calibration-scout` | `/ac scout` | the daily drift scout, run by hand |

The full form is `/agent-companion:<skill>`. `/ac` is a user-level forwarder
that the setup skill installs from `shims/ac/`; a skill inside a plugin is
always namespaced by the plugin name, so the short form has to live outside it.

## Routines

The skills are the prompt source of record, so a scheduled cloud routine needs
only a one-line prompt — and it updates whenever the plugin does, instead of
drifting in a hand-maintained file the scheduler happens to point at.

| Routine | Cadence | Prompt |
|---|---|---|
| Calibration scout | daily | `Run /agent-companion:calibration-scout` |
| Project audit | weekly, or on demand | `Run /agent-companion:audit for <project path>` |

The scout is deliberately silent when nothing changed — it reports only on a
real signal, so a daily cadence does not become noise you learn to ignore.
Detection is deterministic (version strings, file hashes, counters); the model
only decides which heavier routine a signal warrants.

## Known limits

- Premium concurrency is **approximated** by a 10-minute rolling window, not by
  tracking live agents. A legitimate burst may need the cap raised rather than
  worked around.
- Token counts are estimated at ~4 chars/token. Fine for a budget alarm, not for
  billing.
- The warrant check is deterministic (it looks for the line). It verifies that a
  justification was *stated*, not that it is *good* — the audit does that.
