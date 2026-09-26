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
<marketplace>`, then `claude plugin update agent-companion@<marketplace>`, then
`/reload-plugins` — verified 2026-09-18 to load an updated version (hooks,
skills, and config) into a RUNNING session on both desktop and CLI, no restart,
as long as Claude Code is >= 2.1.260; a restart is the fallback where the
command is unavailable. Re-run the canary. Prefer update-then-reload over
uninstall-and-reinstall: a CLI `claude plugin uninstall` wipes this plugin's
`pluginConfigs`, so any chosen options silently revert to defaults. If the
plugin is also used from claude.ai, its marketplace cache is separate and has
to be removed and re-added there — the local update sequence above does not
reach it. The README's "five stale-state traps" section covers the variants.

## 1. Choose options

Every feature is a toggle under `pluginConfigs.<qualified-plugin-id>.options`
in `settings.json` — the `options` wrapper is required, omitting it fails
silently, and `pluginConfigs` only takes effect in user or managed scope; the
defaults are the recommended ones. Two are worth a conscious decision:

- `telemetry_endpoint` — empty means telemetry stays on this machine. Set it
  only if an Agent Audit ingest exists to receive it; the token goes in the
  `AGENT_AUDIT_TOKEN` environment variable, never in plugin config.
- `premium_max_concurrent` — the Fable/Opus instance cap. Default 2.
- `capacity_probe` — a session-start line estimating how many concurrent Claude Code SESSIONS (not individual subagents/teammates, which run in-process) THIS machine can carry, from free memory and cpu count, with a policy of idle-teammates-ok or stop-between-rounds. Useful alongside `premium_max_concurrent` when sizing fan-out width: `node scripts/capacity.mjs --text`.
- `publication_leak_sweep` — EMPTY/OFF BY DEFAULT (fully disabled, silent,
  zero git/API activity). The master switch for the daily scout's
  after-the-fact backstop against a real-name leak reaching origin — not a
  substitute for a local pre-push gate. `publication_leak_repos` (extra/
  exclude list), `publication_leak_strict_repos` (opt in to derived-name/
  prefix + git-sha-like, and — combined with `publication_leak_owners` — the
  only way a swept repo's own script is ever executed), `publication_leak_owners`
  (trusted owner override when `gh` is unavailable), and
  `publication_leak_token_file` are all related options. See
  "Publication-leak sweep" below before turning this on.

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
- `session_context.model`: take it from the route, not from this page. The
  scout runs deterministic scripts and reads their output, which is an
  `operate` task, so run `node "$AC/scripts/recommend.mjs" --type operate`:
  it prints a (model, effort) pair, and the model's full id is that tier's
  `resolvesTo.modelId` in `config/model-tiers.json`. Name BOTH halves to the
  user. If the routine API has no effort field, the routine runs at the
  model's own default effort (the same tier's `resolvesTo.defaultEffort`),
  so tell the user that effort, not the route's
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

## If ladder agents won't spawn — user-level fallback (documented, never auto-run)

Observed (2026-09-24): `agent-companion:ac-opus-low` (or the bare `ac-opus-low`)
can fail with "Agent type not found" even right after a `/reload-plugins` that
itself reported success. In the observed case the session had loaded ONLY a
stale 0.22.0 copy (no `agents/` folder), not the installed one, so nothing
inside that session could say so. Two checks cover it:

- **Across sessions (daily scout):** the spawn guard stamps its own version,
  install scope and the session's plugin-load time into every `spawns.jsonl`
  row, and the scout judges each session by the version it LOADED against
  what was installed WHEN it loaded. Only rows from the last 24h, written
  after the latest update for their scope, by a guard older than that
  install, are judged. Two signals, with different remedies:
  - `stale_copy_loaded` (high): the session loaded after a newer version was
    installed, yet runs the older guard, so it loaded a copy that was not the
    install. Proven either by a load at least 5 minutes after its scope's
    latest update, or by the plugin cache showing the guard's own version
    had already been replaced (`.orphaned_at`) before the session loaded.
    Remedy: remove the stale entry in the desktop plugin manager (below).
  - `session_outdated` (low, informational): the session loaded before the
    latest install and still runs what was installed then. That is an old
    session, not a stale copy. Remedy: restart or `/reload-plugins` that
    session; never the remove-entry remedy. It stays quiet until the session
    has been loaded for 24 hours (at its latest spawn) AND has missed two or
    more updates; updates within 5 minutes of each other count as one. At the
    current pace of a patch per track (about 8 updates in 43 hours), a
    session younger than a day says nothing.
  - A session whose load time is unknown is neither: it is reported only as
    a count, "N sessions with unknown load time", with no remedy.

  Rows from a guard older than 0.29.0 carry no stamp. The keys they do carry
  bound their version: a row without `effective_effort` is from a guard
  below 0.23.0. They are judged against the user-scope install, whatever else
  is installed.
- **In session (`hooks/ladder-check.mjs`, SessionStart):** a missing or broken
  `agents/ac-*.md` file, and a loaded copy older than the install for this
  session's scope: an orphaned plugin-cache copy, or a copy from outside the
  cache that is not a source checkout (for example a desktop app bundle).
  Judged only when the process just loaded it: a startup, or a resume in a
  fresh process. An in-process `/resume` is never judged. It is recognised by
  the `CLAUDE_PID` the harness gives hooks together with the SessionEnd
  "resume" that the same process raises, for the session it was running,
  just before the new SessionStart. A resume that cannot be tied to one that
  way, such as a fresh process that got a reused pid, is treated as fresh.
  With no `CLAUDE_PID`, no resume is judged. A newer copy or a source
  checkout is never called stale.

**Known limits (not covered):**

- A guard from 0.29.0 through 0.29.5 writes no version
  stamp, so its rows are never judged by the scout. That includes a stale
  0.29.x copy only one release behind its install, such as a 0.29.2 copy
  running while 0.29.3 is installed: only guards that stamp (this release on)
  can be proven stale one release behind.
- A stale copy is proven only with a known load time. With the load time
  unknown (self-update off and no `CLAUDE_PID`, or a load record from a
  version before this one), it is only counted.
- The 2026-09-24 stale-copy incident itself would NOT have been flagged. Its
  0.22.0 guard wrote no version stamp and recorded no load time this version
  trusts, so the scout shows it only as "4 sessions with unknown load time".
  Future stale copies are caught: guards from this release on record their
  version and load time, and a stale copy is flagged whenever its session's
  load time is known (`CLAUDE_PID`, or self-update on).
- A stale copy one update behind its install, whose session loaded before
  that update, cannot be told from an old session unless the plugin cache
  still shows its version had been replaced before it loaded. With no
  `.orphaned_at` marker, or a cleaned cache, it is at most `session_outdated`.
- A copy outside the plugin cache is recognised as a bundle only by where it
  runs; a `--plugin-dir` copy that is not a git work tree also counts as a
  bundle, and a bundle whose own guard predates the stamp is judged only by
  its version bound (or not at all, if it is 0.29.0 through 0.29.5).

Recovery for a stale copy: remove the stale agent-companion entry in the
desktop plugin manager, `/reload-plugins`, verify with a trivial ladder spawn,
and start a fresh session if that still fails.

If that still does not register the ladder, `scripts/install-ladder-agents.mjs`
is the fallback: it copies the ladder's `agents/ac-*.md` files to **user-level**
agent definitions at `~/.claude/agents/`, a separate registration path from a
plugin's own `agents/` directory. **This session never runs it for you and
never installs anything without your explicit yes** — offer it, and only run
`--yes` after you say to:

```bash
node "$AC/scripts/install-ladder-agents.mjs"          # plan only — writes nothing
node "$AC/scripts/install-ladder-agents.mjs" --yes    # copy/update per the plan, only on your say-so
```

What it guarantees, enforced by the script itself, not just documented here:

- **No write without `--yes`.** The default (or `node install-ladder-agents.mjs`
  alone) only prints a plan.
- **Name collisions are never overwritten.** A file already at
  `~/.claude/agents/ac-opus-low.md` that this script did not itself install —
  or one it installed that you have since hand-edited — is always SKIPPED and
  listed separately in the plan, never silently replaced.
- **Update path:** re-running with `--yes` refreshes only the files it
  installed before AND that still match what it wrote (tracked in
  `~/.claude/agents/.agent-companion-ladder-manifest.json`) — the way a plugin
  update that regenerates a rung's description reaches a user-level copy.
  Anything you changed since is left alone.
- **Uninstall path:** `--uninstall` (plan) / `--uninstall --yes` (apply) removes
  only manifest-tracked files whose content still matches what was installed;
  a hand-edited copy survives uninstall untouched, on purpose. Uninstalling
  the PLUGIN does not remove these — they are a separate, user-level path, and
  this script (or a manual `rm`) is the only way to take them back out.

**UNVERIFIED, recorded here rather than assumed:** whether a user-level agent
definition actually registers **mid-session** (without starting a fresh one)
is not confirmed by this track — the script only makes the files exist in the
right place. Test that separately: after `--yes`, try a trivial spawn of the
BARE `ac-opus-low` in the SAME session first (a user-level copy registers
under its bare name; `agent-companion:ac-opus-low` exercises the plugin copy,
not this fallback); if it still fails, start a fresh session before
concluding the fallback did not work. The spawn guard's best-fit autofill
rewrites a spawn to a BARE rung only once that exact bare rung has started in
the session and its file is at user or project scope, so a partial install
never makes it name a rung that is not registered. The script refuses any manifest entry
that is not a plain `ac-*.md` name inside the agents folder, and rejects
unknown or value-less arguments (`--agents-dir` must be followed by a path).

## Staying current

Updating is the harness's job, and there are two built-in paths. Terminal
sessions: Claude Code's own plugin autoupdater runs at startup. Desktop
sessions: the app runs them with the auto-updater switched off, so the daily
local scout runs the two built-in commands (`claude plugin marketplace update`,
`claude plugin update`) at the start of each run. The plugin adds only a
notice (`version_notice`, default on): at session start, and again on the
first prompt after, it says when ANY installed plugin — not just this one —
was updated after this session last loaded its plugins, because "installed"
and "loaded" differ by a `/reload-plugins` (or restart) nobody is reminded to
run — and a stale parent session's sub-agents inherit its stale hooks too. A
second install of the same plugin at project scope shadows the user-scope one
and never updates; `claude plugin list` shows both if so.

### Install the global hook — makes the checker itself un-stale-able

`version_notice`'s checker lives inside the plugin, so — like every other
hook — it is bound to whichever installed-plugin-cache folder a session
loaded at startup: a stale session runs a stale checker. One command installs
it instead as a user-level hook at a fixed path
(`~/.claude/hooks/agent-companion-staleness.mjs`) that never needs updating,
because it re-resolves the currently installed agent-companion fresh on every
run rather than running whatever copy this session happened to load:

```bash
node "$AC/scripts/install-global-hooks.mjs"
```

Idempotent (safe to re-run), backs up `settings.json` first, and `--dry-run`
previews the change without touching anything. `--uninstall` removes it.
Optional — `version_notice` already works without it, just one
`/reload-plugins` behind on the one thing only a fresh load can see.

### Optional: re-inject saved state after compaction (ask first)

Not installed by default. OFFER it and run it only after the operator says
yes. It adds a user-level SessionStart hook (matcher `compact`) that, after a
compaction, re-injects the first non-empty file of: the session scratchpad's
`SESSION-STATE.md`, `<cwd>/HANDOFF.md`, `<cwd>/.claude/HANDOFF.md` —
capped at 9,500 chars (Claude Code caps hook context at 10,000), keeping
the end. Run `--status` first: if an equivalent personal hook is already
configured, the installer says so and installs nothing (no double injection).

Detection limits: it matches by NAME (a command mentioning `reinject`,
`SESSION-STATE` or `HANDOFF` on a compaction matcher) and reads only the
user-level `settings.json` and `settings.local.json`, not project-level
`.claude/settings*.json`. Ask the operator whether they already have a
hook that restores state after compaction under another name or in a
project; if they do, do not install this one.

```bash
node "$AC/scripts/install-reinject-hook.mjs" --status
node "$AC/scripts/install-reinject-hook.mjs"              # after a yes; --dry-run previews
node "$AC/scripts/install-reinject-hook.mjs" --uninstall  # removes it again
```

`--file <template>` (repeatable; `{cwd}`, `{session_id}`, `{scratchpad}`,
`{home}`) replaces the candidate list; `--max-chars <n>` changes the cap.

Releasing: bump `version` in **both** `plugin.json` and the plugin's entry in
`marketplace.json` — Claude Code reads the first, the claude.ai plugin
directory keys on the second, and the manifest check fails if they differ.

## Publication-leak sweep (optional)

Off by default via the `publication_leak_sweep` master switch — this feature
clones/fetches repos and, locally, calls the GitHub API, so it needs an
explicit opt-in. Once on, the daily scout checks what is actually
PUBLISHED — not the local working tree — for a real-name leak that slipped
past a local pre-push gate, across repos it finds FOR YOU:

- every public repo you can push to (owned + org-member), via `gh` if
  installed and authenticated — archived repos and forks are skipped;
- every path in `~/.claude.json`'s `projects` map that resolves to a git
  repo with a public GitHub origin AND whose owner is you or one of your
  orgs (see `publication_leak_owners` below — a repo merely cloned locally
  is never swept just because it sits on disk), worktrees deduping to their
  main checkout — falling back to a dev-root walk only if `~/.claude.json`
  is missing or unparseable.

You never have to list repos by hand. `publication_leak_repos` is now an
extra/exclude list ON TOP of that discovery: a plain entry (`owner/repo`, a
URL, or a local path) adds one discovery missed; a `!`-prefixed entry
(`!owner/repo`) excludes one discovery found. Leave it empty to sweep
exactly what discovery finds.

**A swept repo's own code is NEVER executed by default.** Locally, the scout
clones each covered repo's default branch AS PUBLISHED into a throwaway dir
and scans it with the PLUGIN's own generic checker only — that is the only
checker that runs unless you opt a repo in twice: it must be listed in
`publication_leak_strict_repos` AND the URL it is actually cloned from (a
local checkout's real `origin`, never the configured text or a directory
name) must be an `https://` or ssh (`ssh://git@github.com/…` or
`git@github.com:…`) github.com URL owned by you or one of your orgs
(`publication_leak_owners`) — `http://`, `git://`, `file://` and a bare
`github.com/owner/repo` (which git treats as a local path) never qualify.
Only then does that repo's own `scripts/leak-check.mjs` also run. **That
listing plus the verified https/ssh github.com owner is the only control —
there is no isolation.** The script gets a trimmed environment (PATH/TEMP/
SYSTEMROOT-style vars and the sweep's own LEAK_CHECK_* only) and a HOME that
points at an empty temp dir, but it runs as you and can read anything you
can, credential files under your real home included. Only list repos whose
code you would run anyway. In the cloud, target-script execution is
unaffected by that gate (the cloud only ever scans the session's own
checkout in place, never a clone of anything — see below), but nothing there
executes a SECOND repo's code either.

**Local and cloud sweep differently, and it matters.** In the cloud, cloning
a second copy of a repo and executing a script from it is exactly the "code
from external" shape the cloud sandbox's classifier denies — confirmed live,
the clone-based approach was blocked outright there. So the cloud sweep
never clones: with no `publication_leak_repos` entry given, it defaults to
sweeping the session's OWN checkout IN PLACE, but only if that checkout is
actually public; with an entry given, it scans, in place, whichever ONE
entry IS this session's own checkout (after confirming `HEAD` matches
origin's default branch), always with `--no-derived` (no dev root in the
cloud to derive real project names from anyway). Any other entry is reported
once as `skipped`, not fetched or cloned. Cloud auto-discovery never runs at
all — there is no dev root and gh is not assumed available there.

Either way, `publication_leak` fires only for hits not already accepted in a
prior run, and a still-present accepted hit re-fires at least once a week
(so a missed notification is never permanently silent) — see the routine's
dispatch table.

**Not every class applies to every repo.** Derived project-name/prefix
matching and git-sha-like only make sense for a repo whose whole PURPOSE is
to be anonymous/generic — this repo, agent-templates, is the example. An
ordinary product repo legitimately names the operator's own product
everywhere (its own README, CHANGELOG, `wrangler.toml`, ...), and applying
those two classes there is mostly noise (measured on 8 real swept repos:
about 90% of hits were exactly this false-positive shape). So a repo only
gets those two classes if it OPTS IN — automatically when it ships its own
`scripts/leak-check.mjs` or carries a `.leak-check-strict` marker file at
its root, or explicitly via `publication_leak_strict_repos` (this is CLASS
SCOPE only — it does not by itself authorize executing that script; see
above). Every repo, opted in or not, still gets the UNIVERSAL classes: private paths (every
shape), the OS user handle, and the private token file. A strict repo also
exempts a pinned GitHub Actions SHA (`uses: owner/action@<sha>`) from
git-sha-like — that's ownership metadata a workflow is supposed to carry.

This is a backstop, not a gate: it never blocks a push, it only notices one
already live. Verify it actually works with the sweep canary before relying
on it:

```bash
node "$AC/scripts/leak-sweep-canary.mjs"            # full mode
node "$AC/scripts/leak-sweep-canary.mjs" --reduced   # cloud-shaped mode
```

Both must print `OK` and exit 0 — that proves the whole pipeline (clone,
run the target's own script, parse hits, dedupe against a baseline) actually
catches a synthetic leak, not just that the option exists. Both routine
templates run this canary automatically whenever the option is set; a
canary failure is reported as "leak sweep broken", never silently dropped.

## What "set up" means

A machine is set up when all four are true: canary PASSES, options are a
decision rather than a default, a local task exists with a cron, a cloud
routine exists with a cron and has one readable run. Anything less is
"installed", which is not the same thing — an installed plugin whose scout
never runs is exactly the silent drift it was built to catch.
