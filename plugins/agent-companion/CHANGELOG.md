# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

## Unreleased

Token-saving trial: four changes shipped together, each with its own on/off toggle and telemetry stream, so the trial can be switched off per feature and measured per feature (injected-text numbers below).

### Trimmed injected text

Trimmed the text the plugin adds to every session, keeping every requirement. Source: `plugin-overhead-2026-10-04.md` (usage postmortem), trims 1 to 4.

- Scout surface (SessionStart): the main session gets a pointer line (signal count, kinds, path to `scout-latest.json`, "mention only if asked") instead of the full signal list; subagents get nothing (the hook already skipped them: `sessionIsSubagent`). The CI-red line is unchanged.
- Standing rules: subagents get none (every built-in session-start rule is `audience: lead`; no rule that governs a worker's own tool use exists to keep). Main session wording tightened, every rule kept: the delegate-first rationale clause "omitted inherits this tier" is dropped (the instruction to set the model explicitly stays); other rules lose filler words only.
- Reporting contract (SubagentStart/spawn brief): tightened, every requirement kept (STATUS line, blockers uncompressed, outcome shape, omit list, long output to a file, peer messages one screen).
- Skill descriptions: the 11 plugin skills cut by about a third, trigger phrases kept.
- Not done: hiding the 10 `ac-*` ladder agents from subagents. Claude Code has no supported mechanism (only a per-agent `tools: Agent(a, b)` allowlist, which would mean editing every other agent).
- Measured by chars of injected text, via the same scripts' inputs as the report (static run of each hook, clean config dir; scout with a 3-signal result, so the real scout block is larger):

| Item | Before | After |
|---|---|---|
| Main session-start text (scout + standing rules) | 1,499 | 867 |
| Subagent session-start text (scout + rules + contract) | 758 | 473 |
| Skill descriptions, total (11) | 5,360 | 3,656 |

  Per item: scout main 567 -> 290 (report averaged 2,907 on real multi-signal results, and it grows with signals; the pointer does not), subagent 0 -> 0; rules main 932 -> 577, subagent 0 -> 0; contract subagent 758 -> 473. The report's 3,924 (scout) and 2,011 (rules) per-subagent figures predate the subagent skip already in 0.29.29.

### Git brief (option `git_brief`)

One line of git state at agent start, and one script instead of a dozen git reads.

- New `scripts/git-brief.mjs`: prints `branch | ahead/behind origin's default branch | uncommitted N | worktree | last commit | unpushed N`; `landed <sha|branch>` prints `ON main (sha)` (an ancestor of the default branch), `ON main (cherry-picked)` (every commit is patch-equivalent to one on it, the way `git cherry` decides, so a rebase or cherry-pick merge counts) or `NOT on main (ahead N; a squash merge wouldn't show)` (a squash merge produces a different patch and cannot be detected reliably, so the answer says so instead of claiming the branch is unmerged). Fetches origin's default branch at most every 5 minutes per repository (shared by linked worktrees), 1.5 s cap, never prompts; a failed fetch is not retried for 1 minute. Prints nothing and exits 0 outside a git repository or on any error. Flags `--no-fetch`, `--fresh`, `--cwd`.
- New hook `hooks/git-brief.mjs` on SessionStart (every source) and SubagentStart: injects that line as `additionalContext`, with the refresh command, so agents stop running `git status` / `git fetch` / `git rev-list`. Motivated by about 5,100 git-read Bash calls (882 of them `git fetch origin`) in a 7-day transcript count.
- Option `git_brief` (default on for the trial; off with `false` or `CLAUDE_PLUGIN_OPTION_GIT_BRIEF=0`, which makes the hook do nothing at all).
- Telemetry stream `telemetry/git-brief.jsonl`: one row per injection and per script run (chars injected or returned, whether a fetch ran, duration). Documented in `docs/TELEMETRY.md`.
- Tests: `tests/git-brief.test.mjs` (real throwaway repositories with a local bare origin).

### Read dedupe (option `read_dedupe`)

A PreToolUse hook that denies a repeat Read of lines the same agent already read, when the file is unchanged and the read would return 2,000 characters or more. Fills the gap Claude Code's own "File unchanged" stub leaves (a range inside an earlier larger read, A-B-A alternation, ranges spanning two earlier reads; 551 of 654 measured repeat reads in 7 days were partial). The denial is one sentence and the identical call, repeated, runs. State is per agent; cleared by an edit, any mtime or size change, `PreCompact` and `SessionStart` `compact`/`clear`; fails open. Option `read_dedupe` (default on; `CLAUDE_PLUGIN_OPTION_READ_DEDUPE=0`); telemetry in `read-dedupe.jsonl`.

### PR and CI wait (option `pr_wait`)

One call that waits inside a script instead of repeated `gh` and sleep polls.

- New `scripts/pr-wait.mjs`: `pr-wait <pr-number|branch> [--repo owner/repo] [--timeout 20m]` waits until a PR's checks finish or it merges or closes; `--run <run-id|branch>` does the same for a GitHub Actions run. It prints one start line, then one final line (state, checks passed/failed/total, elapsed) and up to nine failed-check lines with log URLs. Exit codes: 0 passed or merged, 1 failed or closed unmerged, 2 timeout, 3 usage or gh error. Polls gh inside the script with backoff (5s to 30s), never prompts, and is safe under `run_in_background`.
- Bound to the commit, not the branch: PR mode reads the PR's head commit (`headRefOid`) on every poll and counts only the check runs and statuses of that commit, so the previous commit's checks (still reported for a few seconds after a push) never answer for it; a head with no checks yet is waited on. `--run <branch>` takes the newest run whose head SHA equals the branch's current remote tip and keeps waiting within the timeout while there is none; a run id is used as given. Each poll is three `gh` calls, all inside the process.
- New option `pr_wait` (default on; `CLAUDE_PLUGIN_OPTION_PR_WAIT=0` turns it off) and standing rule `pr-wait-hint`: one session-start line (150 characters or fewer) naming the script. Off hides only that line; the script still runs.
- Telemetry stream `telemetry/pr-wait.jsonl`, one row per run: mode, polls, duration, outcome, exit code (`docs/TELEMETRY.md`).
- Tests: `tests/pr-wait.test.mjs` (gh stubbed, including a previous-commit-green PR and a run list holding only the commit before the push), plus the rule-count updates in `tests/standing-rules.test.mjs`. The standing-rule hint is written in the trimmed style (one line, 150 characters or fewer).

### Injected text with all four changes

Same method as the trim table (static run of every SessionStart and SubagentStart hook, clean config dir, 3-signal scout; chars of `additionalContext`). Main = scout pointer + standing rules + git brief; the machine-specific capacity line (about 120) is left out. Subagent = what SubagentStart injects (reporting contract + git brief); standing rules and scout add nothing for a worker. `read_dedupe` injects nothing at start (it only denies a repeat Read), so its row never moves.

| Toggles | Main session start | Subagent start |
|---|---|---|
| all on | 1,354 | 820 |
| `git_brief` off | 1,007 | 473 |
| `pr_wait` off | 1,218 | 820 |
| `read_dedupe` off | 1,354 | 820 |
| all three off (the trimmed baseline) | 871 | 473 |

So the three trial features add 483 characters to a main session start (git brief 347, pr-wait hint 136) and 347 to a subagent start (git brief); each is gone with its own switch.

## 0.29.32 — 2026-10-04

Removed the top-level `$schema` key from `plugin.json`: the Claude desktop app warned that it is an unrecognized key (stripped, the SDK ignores unknown top-level fields).

## 0.29.31 — 2026-10-04

Bash output tail: the hook that sends a long runner's output to a file and returns its tail.

- New PreToolUse hook `hooks/bash-tail.mjs` (matcher `^Bash$`): a known long-running command (test, build, install) has its combined output sent to a file, and only the tail plus the file's path comes back into context. The exit code is preserved exactly; output of 80 lines / 8,000 bytes or less prints whole; piped, redirected, backgrounded, watch-mode, machine-readable-output, compound and git commands are never touched. Applies in `bypassPermissions` only by default, because allow rules are checked against the rewritten command and stop matching it. Deny and ask rules apply in every mode, `bypassPermissions` included, and match the helper commands the wrapper adds, so the hook also reads `permissions.deny` / `permissions.ask` from user, project, local and managed settings and leaves a command alone when a rule could match the original or a helper.
- Review fixes: a line naming the output file is printed before the command runs (a run killed by the tool timeout still names its file); with `set -e` active the original command runs unchanged (and `source` / `.` are blockers, since they can switch it on mid-command); dev servers, watchers and interactive tools (`npx vite`, `next dev`, `wrangler dev|login`, `--ui`, `playwright show-report|codegen`, `cypress open`, `-w`, `*:watch` scripts, `pytest -f|--pdb`, `make run|serve|dev`, `bootRun`, `spring-boot:run`) are never wrapped and a chain with any such segment, or any segment that is not a known runner, passes through; separate-argument format flags (`--reporter json`, `-f json`, `--junitxml x`) pass through; a failed run also shows up to five summary-looking lines from earlier in the output; the tail is capped by characters and keeps the END of a long line; the wrapper no longer calls `mkdir`, `tr`, `cut` or `cygpath`.
- Hardening: with noclobber (`set -C`) on, the original command now runs unwrapped (the wrapped form never ran it: rc=1, no output). The settings reader strips a leading UTF-8 BOM before parsing, so a BOM-prefixed settings file's deny and ask rules are seen; a settings file that still cannot be parsed (JSONC comments, a syntax error, no read access) means the command is not wrapped at all for that call, logged as skipped with reason `permission-rule:unreadable-settings`. The ADR now says the wrapper is bash, not plain POSIX sh.
- Options `bash_tail` (default on; opt out with `false` or `CLAUDE_PLUGIN_OPTION_BASH_TAIL=0`) and `bash_tail_permission_modes` (default `bypassPermissions`; `any` lifts the limit).
- Telemetry stream `telemetry/bash-tail.jsonl` and `scripts/bash-tail-report.mjs` for the routing review: runs wrapped, bytes produced vs characters returned, runners left alone and why.
- Decision record: `docs/adr/0004-bash-output-tail.md` (repo root), with the alternatives considered (a standing rule, a PostToolUse rewrite, a threshold-only wrapper) and what was verified against the Claude Code docs and the installed 2.1.283 binary.
- Tests: `tests/bash-tail.test.mjs` (trigger logic, the generated shell run in a real bash for exit-code preservation, the hook).
- Takes effect after the plugin update and a session restart.

## 0.29.30 — 2026-10-03

Subagents are back on the default 5-minute prompt cache. The operator chose this on 2026-10-03.

- Removed `experimental: { cacheTtl: "1h" }` from `ac-opus-medium`, `ac-opus-high`, `ac-opus-xhigh` and `ac-opus-max` (added in 0.29.17), and the matching `cacheTtl: "1h"` on rungs 7-10 of `ladder` in `config/model-tiers.json`. All ten ladder workers now use the 5m default. Those four were the only 1h setting in the plugin.
- Why: from 2026-10-02T16Z to 2026-10-03, 1h cache writes cost 242 plan units, 23% of the total. Agents run continuously and compact often, so the 1h TTL never paid off (it only pays when an agent sits idle for more than 5 minutes), and each rewrite costs 1.6x a 5-minute write.
- `ladderCacheTtlNote` and `cacheTtl.ladderWorkersExcludedNote` in the config, the ladder section of `docs/ROUTING.md` (regenerated) and the "Which ladder rungs use the 1-hour cache" paragraph of the README now state the 5m policy and the numbers above.
- Kept on purpose: the optional per-rung `cacheTtl` field and its generator/check (`--sync-agent-descriptions`), the agent-defs advisory, and the cache-ttl verdict's "already on 1h" split. They are config-driven and generic, so a rung can go back to 1h with a one-line config edit. To reverse: re-apply the 0.29.17 change (the agent frontmatter blocks and the four ladder `cacheTtl` fields).
- Tests: `agent-description-drift` pins that no shipped rung carries a cacheTtl and that a stray 1h block is drift; `cache-ttl-advisory` now expects ac-opus-high at 1h to be flagged (and keeps the config-exception path via a per-machine override); `cache-ttl` and `resume-guard` use fixture definitions instead of the shipped ladder rungs.
- Takes effect after the plugin update and a session restart.

## 0.29.29 — 2026-10-02

Four "strange messages from gates", from a scan of every hook message since 2026-10-02T21:30Z.

- Standing rules, the scout block and the capacity line no longer go to subagents. SessionStart fires inside a worker that compacts, and 23 of 38 injections in the scan went to workers: the whole standing-rules block (including "if this session will orchestrate agents ... ask with AskUserQuestion", which a worker cannot act on), the scout drift block and the capacity line. A worker is recognised the way the other hooks do it (`agent_id`, or a transcript under `.../subagents/`; `sessionIsSubagent` in `hooks/lib/context.mjs`). Rules gain an `audience` field: `lead` keeps a rule out of a worker's SessionStart; the five orchestration built-ins carry it, and an unmarked rule (every operator rule by default) still reaches workers. `scout-surface.mjs` (drift block and main-CI note) and `capacity-probe.mjs` are silent for a worker.
- One list of rungs, with its source. The ladder agents' descriptions are generated from the shipped table, so `ac-opus-medium` claimed bounded-feature and integration while the delegation guard and `recommend.mjs` (which use your routing profile) sent them to `ac-sonnet-high`. Each description now says "Base-table default routing for: ..." (or "Not the base-table default ...") and "your routing profile may route differently, see /ac routing". The delegation guard's "Rungs now:" list and the spawn guard's "Current routes:" list add "(your routing profile)" to any type your profile moved.
- The under-provisioned wording for a matching model with a low effort is now "right model, effort too low: medium where the table says high" instead of "right tier; effort medium is below high".
- `subagent-context.mjs` (a PreToolUse hook on every tool call of every subagent, 5 s limit): it was cancelled at 10-14 s twice at the same instant in two different projects. The code was already tail-bounded (the last 1 MB, widened once to 8 MB) and could not be reproduced as slow: 110-150 ms wall on a 60 MB transcript, about 30 ms over a bare `node` start. The two cancellations were simultaneous, on transcripts of 1.3 and 1.6 MB, so the stall was the host (process start under load), not the read. Added a regression test on a ~64 MB, 300K-token transcript that fails if the read stops being tail-bounded. No behaviour change.
- Tests: `tests/gate-messages.test.mjs` (the four defects); `agent-description-drift` and `code-review-critical-floor` updated for the new wording.
- Takes effect after the plugin update and a session restart.

## 0.29.28 — 2026-10-02

- Fix: the `lead-effort-check` rule's option 1 ("Raise to xhigh (Recommended)") told the lead to load and call `set_session_effort` on its own sessionId, which the desktop app refuses for the calling session (a session must not silently re-price its own turns), so the step always failed. Option 1 now tells the operator to raise it with the app's effort control for this session and wait, and makes no spawn until `get_session` "self" shows xhigh or the operator says to continue. The ToolSearch and `set_session_effort` instructions are removed. Everything else is unchanged (unattended runs do not ask, header "Lead effort", option 2 "Stay at <current>", never max, never lower).
- Tests: `lead-effort-check.test.mjs` pins the new option-1 wording and asserts the old self-set path is gone.
- Takes effect after the plugin update and a session restart.

## 0.29.27 — 2026-10-02

- New built-in standing rule `lead-effort-check` (session start), off by default. Turn it on with `{"id":"lead-effort-check","enabled":true}` in `standing-rules.json`; the wording then ships with the plugin instead of living in the operator's file (a full `then` in the file still wins). When the session will orchestrate and its effort is below xhigh, the lead asks the operator with the AskUserQuestion options selector (header "Lead effort"; "Raise to xhigh (Recommended)" or "Stay at <current>") and makes no spawn or other tool call until it is answered. "Raise" loads `set_session_effort` with ToolSearch and sets the session to xhigh; if that tool is missing or fails, the operator is told to use the app's effort control. Unattended sessions (a `scheduledTaskId`, headless or `-p`, no AskUserQuestion) are never asked: they continue and state the effort once. It never raises to max and never lowers. Checked before the first spawn and again after a resume or compaction, as before. This replaces the older prose ask ("say so in one line and ask them to raise it").
- `standing_rules_max_chars` default 2000 -> 3000, in the option, the rule renderer and the spawn-guard call, so the new rule is not dropped beside the other session-start rules. Eight rules now ship built in.
- Tests: `lead-effort-check.test.mjs` (default off, the enable override, the exact wording pins, an operator file's own wording winning, the block fitting under the default cap, and the session-start hook output); `standing-rules.test.mjs` built-in list updated.
- Takes effect after the plugin update and a session restart.

## 0.29.26 — 2026-10-02

- `scripts/version.mjs` no longer says "Desktop copy: none found" when the desktop app has no copy of its own. It now prints "no separate desktop copy; desktop sessions load the CLI cache copy", and `--json` has a new top-level `desktopCopy: { present, count, usesCliCache }` field (`desktop` stays the array it was). The verdict logic is unchanged; a desktop copy that exists and lags is still STALE. Verified 2026-10-02: after the operator disabled and re-enabled agent-companion in the desktop app's plugin manager, the stale 0.29.22 desktop copy was gone and desktop Code-tab sessions loaded the plugin from the CLI cache.
- The desktop refresh path is now the verified one everywhere it was described: disable, then re-enable, agent-companion in the desktop app's plugin manager (not `claude plugin uninstall`, which wipes the plugin options), then idle desktop sessions pick up the current copy on their next turn (a session that is mid-turn, after that turn); confirm with `/ac version`. Afterwards the desktop session runs the CLI cache copy, so a later `claude plugin update` covers it. Updated in `scripts/version.mjs` (the STALE verdict and fix text), the `version` and `setup` skills, the `plugin_copy_stale` and `stale_copy_loaded` scout signals and routine, the ladder-check recovery message, the README stale-state table and CONTRIBUTING's release gate. The old "unverified" and "Sync on claude.ai is untested" wording is gone.

## 0.29.25 — 2026-10-02

- New `version` skill (`/ac version`) and `scripts/version.mjs`: say which agent-companion is running and whether every installed copy is current. Claude Code keeps several copies that drift apart: the CLI cache (what `installed_plugins.json` records and CLI sessions run), the desktop app's own copy under `local-agent-mode-sessions/<acct>/<org>/rpm/plugin_<id>/` (what Desktop Code-tab sessions run), and the marketplace clone. On 2026-10-02 the desktop copy was 0.29.22 while the CLI copy was 0.29.24, and desktop sessions kept the old routing with nothing saying so.
  - The report: THIS copy (resolved from the script's own location) and its kind; the CLI cache entry (version, `gitCommitSha`, `lastUpdated`); every desktop rpm copy whose manifest names agent-companion (version, path, mtime); the marketplace clone's version and when it was published; with `--remote`, origin/main's version (`gh api`, else the commit from `git ls-remote`; time-boxed by `--timeout`, a failure only adds a note); and one verdict line, `all copies current` or `STALE: <copy> is <ver>, latest is <ver>`, naming the sessions affected (CLI or Desktop) and the fix. A `Note:` line says what the verdict rests on (without `--remote`, the latest is the local marketplace clone). `--json` prints the same data. Windows first; macOS and Linux desktop paths are handled. No token is read or printed: child-process error text is redacted and credentials in a marketplace source URL are stripped.
  - THIS copy is judged too. A session started before `claude plugin update` runs an older cache folder that is no longer the installed one; the verdict says "this session's copy ... is 0.29.22" and to restart, instead of calling everything current.
  - What refreshes the desktop copy is only partly known, and the report says so. Established: the app's remote-plugin sync (every 20 minutes, per the app's own log) fills it from claude.ai, not from the CLI cache, so `claude plugin update` never touches it; a full app restart alone did not move a stuck copy (2026-09-12); removing and re-adding the plugin in the DESKTOP plugin manager did (2026-09-12, 2026-09-24). The fix the report leads with is that. Untested, and labelled so: pressing Sync on the agent-templates marketplace in claude.ai and waiting for the app's sync. Not established: how soon claude.ai picks up a release.
- New scout signal `plugin_copy_stale`: any installed copy (CLI cache or desktop rpm) that has been behind the marketplace version for more than 6 hours. It names the copy and the fix; dispatch `plugin-update` for the CLI copy, `desktop-plugin-refresh` for the desktop one. The lag is counted from the oldest marketplace release newer than the copy: the release commit's date when the clone has history, else the date in the plugin's CHANGELOG heading (the marketplace clone `claude plugin marketplace add` makes is SHALLOW, one commit, so the CHANGELOG is what works there; it is day-level, so the signal can trail a release by up to a day), else the latest release's date. For a CLI copy it overlaps `plugin_version_behind`, which fires at once; this one adds the age. Not fired in the cloud, and never for the session's own older cache folder (that is `session_outdated`).
- `/ac version` is added to the user-level forwarder (`shims/ac/SKILL.md`) and to the setup skill's list. The forwarder at `~/.claude/skills/ac` is refreshed by re-running the setup skill's copy step.
- Release procedure (CONTRIBUTING.md, README "stale-state traps" row 6): after `claude plugin update`, check every copy with `version.mjs`. A release has landed for CLI sessions when the CLI copy matches; the desktop copy's state is recorded separately.
- Fix: the test suite no longer reads the operator's real `~/.claude`. Tests that skipped `makeFixture` resolved `AGENT_COMPANION_STATE_DIR` to the real state root, so a live routing profile with rows (rev 10) broke over a dozen routing tests on the operator's machine while CI passed. Every test process now gets its own sandbox home through `tests/isolate.mjs` (imported by `helpers.mjs`, and as the first import of every test that does not use it); `makeFixture().cleanup()` restores that sandbox, never the real home; an fs tripwire throws on any call under the real Claude home and fails the file even when the plugin code swallows the error. New `tests/isolation-guard.test.mjs` fails the suite if a test file stops opting in or the tripwire stops firing. The tripwire found one more real-home read, in the publication-sweep tests (`~/.claude/projects`); the sweep now defaults to `claudeDir()/projects`, which is the same path outside tests. The operator's real routing profile was not read or changed.
- Tests: `version.test.mjs` (fixture machines with mismatched CLI/desktop/marketplace versions, THIS-copy resolution, lag clock with a real git history, origin/main fallbacks and redaction), `plugin-copy-stale.test.mjs` (the scout signal), `version-skill.test.mjs` (the skill, the forwarder, the setup list, the docs).
- Takes effect after the plugin update; the desktop copy follows when the desktop app next syncs it.

## 0.29.24 — 2026-10-02

- New advisory: session budget notice. `session_budget_units` (default 350; 0 is off) is checked on each lead prompt and each foreground Agent return. It adds up the plan units the whole session has used, the lead plus every subagent (tokens at Sonnet 5 rates times the model's plan multiplier: the existing `planPriceSpecFor`, now in `scripts/lib/pricing.mjs` and re-exported from the cache advisor), reading only the transcript bytes appended since the last call. Each time the total crosses another multiple of the threshold the lead gets one notice, through the runaway-notice path: finish the phase, update SESSION-STATE.md, offer a hand-off, never mid-release or with agents running. Rows in `session-budget.jsonl`; the percentage uses `weeklyPlanUnits` (1900) in `config/session-budget.json`.
- New advisory: subagent context notice. `subagent_context_notice_tokens` (default 300000; 0 is off). A PreToolUse hook (`hooks/subagent-context.mjs`) inside each subagent reads the subagent's own context size from its latest request. When it passes the threshold, or the subagent has just compacted (a `compact_boundary` just behind it), the subagent is told once, mid-run, to finish the step, return its results and say what is left. Mid-run injection works: a PreToolUse `additionalContext` reaches a subagent (checked with a headless run on 2026-10-02). SubagentStop adds a line to the lead's notice next to the runaway flag, and catches a worker the hook never reached. Rows in `subagent-context.jsonl`.
- New scout signal `budget_notices`: counts both notices over 24 hours (dispatch none).
- Both are advice only: nothing is blocked or denied. `runaway-notice.mjs` hook timeout 5 -> 10 s for the budget scan; one more `node` start per tool call for the subagent hook (the lead's exits at once).
- Takes effect after the plugin update and a session restart.

## 0.29.23 — 2026-10-02

- Behaviour change (routing trial v4, operator-approved): the base routing table is corrected. The 0.29.18 routing sent `explore`, `verify`, `mechanical-edit`, `operate` and `subagent-worker` to opus/low on the premise that opus/low costs about the same as Sonnet on the plan. That was wrong: cache reads cost the same on Opus 5.5 and Sonnet 5, so opus/low runs about 1.2-1.55x Sonnet 5 medium, and the gap against sonnet/low and haiku is wider.
  - `explore` and `verify` now route to haiku (`ac-haiku`); `mechanical-edit`, `operate` and `subagent-worker` to sonnet/low (`ac-sonnet-low`). Haiku is limited to reads and checks: it validates, it does not operate.
  - `large-refactor` and `long-autonomous-run` go from opus/xhigh to opus/high (`ac-opus-high`). Last week's plan data: xhigh 17.7 units per spawn with 21% re-spawned, against high at 16.6 with 10%. `novel-design` and `critical-change` stay on opus/xhigh. Every other type is unchanged, in particular `bounded-feature`, `integration` and `debug-root-cause`.
  - The seven moved rows carry `trialVersion: 4`, `trialSince: 2026-10-02` and `reviewBy: 2026-10-16`. Their reason strings state the corrected cost; no shipped text claims opus/low costs the same as Sonnet.
  - `selfReview.types` narrows to `novel-design` and `critical-change` (a parity reviewer cost 9.85 plan units per spawn on xhigh against 3.78 on opus/medium). `large-refactor` and `long-autonomous-run` writers go back to a lead-routed review; the protocol text is regenerated into the rungs that still carry it.
- Haiku retirement is flag-driven. Anthropic says Haiku 4.5 retires "no sooner than" 2026-10-15, so `tiers.haiku.retiresAfter` now drives warnings only. The routing table falls back to `tiers.haiku.replacement` (sonnet/low) only when `tiers.haiku.retired` is true, which the operator sets after confirming haiku no longer resolves (`{"tiers":{"haiku":{"retired":true}}}` in the state dir's `model-tiers.json`). `retirement()` reports `pastDate` and `retired` separately. The scout's `model_retirement_approaching` signal keeps firing daily after the date until the flag is set, and says "set retired: true once haiku stops resolving". The `ac-haiku` description and body say the same. A tier flagged `retired: true` counts even if its `retiresAfter` is later removed. With the flag set on a machine, `--check-agent-descriptions` expects the swapped "Currently the default routing for" lists, so it reports expected drift there.
- The state-dir `model-tiers.json` now merges per tier, one level deep, so a one-key override such as `retired: true` keeps the rest of the shipped tier (it used to replace the whole tier).
- Fix: the delegation guard's block message and the inherit guard's example spawn no longer hard-code `ac-opus-low`; they name the rung the routing gives `subagent-worker` (the guard fires on execution work, which haiku does not do). `routedRung()` and the guard's common-route list now find haiku's rung (it has no effort). New tests assert the example's rung equals `recommend.mjs --type explore`.
- Tests: new `haiku-retired-flag.test.mjs` (no fall-back with the date passed and the flag unset; scout text; flag silences the warning). The route-golden live gate and the architecture differential now run on two clocks before the haiku date, because the vendored reference still retires by date. Regenerated: rung agent descriptions, `docs/ROUTING.md`, the recommend skill's task-type block.
- Takes effect after the plugin update and a session restart. The interim operator routing profile covering the five base types should be rolled back once this is installed.

## 0.29.22 — 2026-09-29

- Fix: claude.ai refused to register the plugin. It packages the plugin folder and requires exactly one `.claude-plugin/plugin.json`, and since 0.25.0 the folder held a second one: the `real-opt-fallback` benchmark fixture's own manifest. The fixture now keeps it at `bench/fixtures/real-opt-fallback/plugin-manifest.json`, and the task's `setup()` writes it to `src/.claude-plugin/plugin.json` in the sandbox. The sandbox is byte-identical to before, so its `task_fixture_sha256` is unchanged and earlier benchmark rows stay comparable.
- New test `tests/plugin-package-shape.test.mjs`: fails when the plugin's committable files (tracked, plus untracked and not ignored) include anything under a `.claude-plugin/` directory other than the root `plugin.json` (a nested `marketplace.json` included), or a top-level `bin` (directory or file), which claude.ai also refuses. `claude plugin validate --strict` accepts both, so it did not catch this.
- No hook or script behaviour changes; nothing to restart.

## 0.29.21 — 2026-09-28

- New: writer self-review protocol. `selfReview.types` in `config/model-tiers.json` names the task types whose writer reviews its own work: `novel-design`, `large-refactor`, `critical-change` and `long-autonomous-run`. The writer spawns one foreground parity reviewer (its own model and effort) and does one fix round before it reports. The protocol text is appended to the ladder rungs' agent definitions.
- For a nested review, the reviewer's `WRITER` is inferred from the caller (the spawning writer's model and effort), so the writer does not need to write a WRITER line.
- New deny: a reviewer that tries to spawn its own reviewer is blocked, so reviews do not recurse.
- Opt-out: a brief carrying `REVIEW: lead` skips the self-review; the lead reviews instead.
- `spawns.jsonl` rows carry three new fields: `parent_agent_id`, `self_review` and `caller_tool_use_id`.
- Fixes from the parity review of this feature (nested opus/xhigh review): all five should-fix items.
- Known limits: the recursion check looks only one level up; project and built-in agents carry the protocol only if their own definition says so; a warning when the reviewer-recursion guard goes inert is deferred to the card "Warn when the reviewer-recursion guard goes inert".
- Takes effect after the plugin update and a session restart.

## 0.29.20 — 2026-09-27

- Fix: the delegation guard now actually fires. It only acted on `agent_type === 'main'`, which real main-thread payloads never carry, so it never ran outside its tests. Main-thread detection is now shared (`hooks/lib/context.mjs`: `agent_id` absent means main thread) and used by the delegation guard, spawn-guard and runaway-notice.
- Behaviour change: `delegation_guard` is now `"off"` | `"warn"` | `"block"`, shipped default `warn`. Warn lets the call run and hands the model the instructions; block denies. Old booleans still read (`true` -> warn, `false` -> off; `"none"`/`"disabled"` read as off).
- New option `delegation_guard_scope`: `"attended"` (default) | `"all"`. Under `attended`, a call whose hook env has `CLAUDE_CODE_SESSION_ATTENDED` exactly `"0"` (claude -p, SDK, woken/dispatched and background workers) is neither counted nor blocked. New scout signal `attended_env_missing`: a day of counted calls never saw the variable.
- The delegation streak resets only on a main-thread Agent spawn or SendMessage that ran (PostToolUse), never on a denied spawn or a subagent's own.
- Agent, SendMessage, ToolSearch, AskUserQuestion, TaskStop and every `mcp__` tool are never counted or blocked.
- SECURITY: no hook returns permissionDecision `"allow"` any more. poll-guard, resume-guard and spawn-guard used to return it, skipping the permission prompt; their hints and autofills now carry no decision (`updatedInput` still applies), so spawns go through the normal permission flow. A new test enforces it.
- Stale-lock handling: the streak lock breaks a lock older than 3 s whoever owns it, and the streak file waits at most 1 s; stale sessions are pruned after 7 days.
- Takes effect after the plugin update and a session restart.

## 0.29.19 — 2026-09-27

- Spawn-time reviewer parity: a `code-review` brief can name its writer with a `WRITER: <model>/<effort>` or `WRITER: <agent-name>` line (also `opus xhigh`, `Claude Opus 5.5 at xhigh`, backticked or bold). The spawn guard compares the reviewer with that writer and WARNS when it is below; it does not block this release. A reviewer with no model inherits the writer's pair. The verdict names what it compared against: the writer, the F1 critical-review floor (opus/xhigh), or the parity route after floor F2 (fable is never a routing destination). An effort word that is not an effort level is reported as "not understood" and parity is checked on the model alone; a line read only in part never autofills a model.
- Code-review messages: a `TYPE: code-review` spawn with no WRITER line gets a note asking for one instead of a generic "no TYPE or WEIGHT" message. Fix: a writer-less review carrying a `WARRANT: weight N` was fit-denied against the grid with an empty route ("sends to . ..."); a WARRANT's weight no longer triggers that check. The premium-cap deny no longer says "run at sonnet"; it says how to route (add a TYPE, spawn a ladder rung, add a WRITER line, or the parity rung).
- Behaviour change: the premium fan-out cap no longer counts deliberate opus choices: a typed spawn whose route is opus, `ac-opus-*` rungs other than `ac-opus-max`, the project's own and user-level agent definitions that pin opus, and a reviewer matching its writer. It still counts fable, `ac-opus-max`, other plugins' agents, definitions named like a built-in, and unrouted opus. A spawn that inherits the lead's model is still not counted (`inherit_guard` covers that shape).
- `spawns.jsonl` rows carry `routed`: whether the spawn's model came from the routing table or a definition pin. The scout's unrouted-premium count reads it.
- New option `inherit_guard` (default `warn`, `block` available): flags a spawn that names no model and whose definition states neither model nor effort, so it silently runs on the lead's pair; `block` denies it under a premium lead. A TYPE the table knows, or a WEIGHT, lifts it; an unknown TYPE is named in the message.
- New runaway flag: at SubagentStop a worker past `runaway_turns` (default 300) or `runaway_usd` (default $40) is recorded, and the lead gets a notice on its next prompt or Agent result. Detection and deny behaviour elsewhere are unchanged.
- Project agents may declare `routingType:` in frontmatter; the drift check compares the agent's model/effort with that task type's route, and counts reviewers below their writer's parity.
- New scout signals: `session_churn` (correction-heavy sessions, harvested offline by `transcript-harvest.mjs --churn`; flagged when the harvest is stale), `inherited_effort_spawns`, `project_agent_drift` and `runaway_spawns`.
- Eval canaries are keyed by task type (`evals/route-<type>/`); their graders are generated from the routing table by `scripts/sync-eval-graders.mjs`, and the suite fails when one is stale.
- Fix: the compaction advisor's plan-usage figure. Opus plan usage is its tokens priced at Sonnet rates x 1.5, not API dollars x 0.75.
- Fix: namegate autofilled names always match the Agent tool's name pattern (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`). A dotted description ("release 0.29.19") or a project directory starting with `_` or `.` produced a name the tool rejected; uniqueness suffixes are checked too, falling back to `worker-<suffix>`.
- Takes effect after the plugin update and a session restart.

## 0.29.18 — 2026-09-27

- Behaviour change (routing trial v3, operator-approved amendment): `bounded-feature` and `debug-root-cause` now route to opus/medium (`ac-opus-medium`, was opus/low), and `large-refactor` and `novel-design` to opus/xhigh (`ac-opus-xhigh`, was opus/high). Nothing routes to max. Every other route is unchanged.
  - Why: an operator-local live study (789 real subagent spawns, 2026-09-21 to 09-27), a hard architecture benchmark task and Artificial Analysis. Low to medium is Opus 5.5's largest cheap capability step (+9 index points; Terminal-Bench 0.31 to 0.53), and opus/low passed the hard task's hidden tests only 2/4. Only xhigh passed the subtle-rule architecture task 4/4 and was perfect on both the hidden tests and the design judge; max adds +2 index points over xhigh for 1.73x the cost.
  - Cost: about $1 more per bounded-feature spawn (opus/low averaged about $1.29); about 2x high for the xhigh rows.
  - The four moved rows carry `trialVersion: 3`, `trialSince: 2026-09-27` and `reviewBy: 2026-10-04`, so their review sees a week of data. Every other trial row still reviews on 2026-09-30.
- Corrected the cost claim on the rows that stay on opus/low (`explore`, `mechanical-edit`, `subagent-worker`, `verify`, `operate`): real-world tasks measured Opus 5.5 low at 1.05-1.53x Sonnet 5 medium at API prices (median 1.28x), so it is not cheaper than Sonnet. Its case is capability (Artificial Analysis index 42 vs 28).
- Reviewer parity is unchanged: `recommend` and `evaluate` size a reviewer to the writer's model and effort, so a writer at xhigh gets an xhigh-or-above reviewer. `docs/ROUTING.md` now shows the live review evidence (xhigh reviews clean 26/26 vs 18/21 at high, suggestive, p≈0.08). Spawn-time parity enforcement is not implemented yet; the spawn guard still checks only the critical-change floor for a review.
- The routing eval canaries are renamed to `debug-routes-opus-medium` and `architecture-routes-opus-xhigh`, and expect the new routes.
- Takes effect after the plugin update and a session restart.

## 0.29.17 — 2026-09-26

- Behaviour change: `ac-opus-medium`, `ac-opus-high`, `ac-opus-xhigh` and `ac-opus-max` now use a 1-hour prompt cache (`experimental.cacheTtl: "1h"` in their generated frontmatter, from `config/model-tiers.json` `ladder[].cacheTtl`). `ac-opus-low` and every sonnet/haiku rung stay on the 5-minute default.
  - Why: architecture and review work on these rungs waits on long tool calls inside a task, and the measured 1h saving came from long-lived Opus architects/reviewers.
  - Takes effect after the plugin update and a session restart; an already-running session keeps the definitions it loaded.
- Resume doctrine: these four rungs stay warm for up to an hour between turns, so resuming one within that hour is cheap; the others still go cold after 5 minutes.
- `routing-table.mjs --check-agent-descriptions` / `--sync-agent-descriptions` also check and generate that `experimental.cacheTtl` block (new `cache-ttl-drift` problem). `docs/ROUTING.md`'s effort-ladder table has a Cache TTL column.
- The agent-defs check and the `cache-ttl.mjs` verdict treat these four rungs as intended: the check no longer flags them, and the verdict lists a rung already on 1h as "already on ... (no action needed)" instead of recommending it again. The per-rung data floor still applies first.

## 0.29.16 — 2026-09-26

- Behaviour change: `cache-ttl.mjs` totals and `audit --only cache-ttl` now exclude experiment projects by default — the benchmark projects plus any project inside the system temp dir (a real repo merely named like `temp-tools` is not excluded). Both outputs say how many projects were excluded; `--include-experiments` counts them.
- `cache-ttl.mjs` has a per-rung table: each rung's 5-60 min gaps split by what connected them (message, tool result, meta i.e. harness-injected, other), with resume-after-idle rewrite counts and sample sizes.
  - Each gap kind shows its contribution to the 1h net saving and its share of it. A no-saving baseline (the 2x write premium with no gap credited) is shown; the contributions sum to the overall saving minus the baseline.
  - Only the rung's overall line gets a verdict (PAYS / COSTS / NEUTRAL / TOO LITTLE DATA); a rung below 10 files, 500 requests or 30 gaps of 5-60 min reads TOO LITTLE DATA.
- The per-agent `experimental: { cacheTtl: "1h" }` recommendation no longer names an agent whose rung is below that data floor; such agents are listed as "too little data" instead.

## 0.29.15 — 2026-09-26

- Added the `compact_window_drift` scout signal. It fires when the recommended global auto-compact window moves more than `compact_window_drift_pct` (default 20; invalid values fall back to 20) from the anchored full-read recommendation, then re-anchors, so it fires once per material move.
  - Only full reads are recorded; a partial read never touches the history. The detector reads only the history file (no transcript scan).
  - The history is numbers-only, capped at 90 entries, and written atomically with a mirror copy. A corrupt file is kept aside (`.corrupt-<time>`) with a warning rather than reset, and the scout's anchor update no longer drops a concurrent advisor entry.

## 0.29.14 — 2026-09-26

- Added `scripts/cache-advisor.mjs`, the break-even auto-compact window advisor. It finds the window that costs least for each model, and the one value for your model mix, from a replay of your own transcripts. Benchmark transcripts are excluded from real traffic.
  - It shows a 1% and a 5% band, the same result with the rework term off, a closed-form cross-check and a fit check.
  - It prints the recommendation as the value to type: `/autocompact 275k`, or the settings.json integer `275000`. A window W set this way compacts at about W − 33K.
  - It also shows where each model's cache money goes and the cold first-request cost of each subagent type.
  - Dollar figures are API list price. It is advice only and never writes settings.json.
- The advisor reports the window Claude Code actually applies, resolved the way Claude Code does: the environment variable first, then managed, local project, shared project and user settings. A settings value must be an integer from 100000 to 1000000; anything else (for example the string `"400k"`) is silently ignored by Claude Code and the default applies. The advisor warns loudly when a value you configured is ignored.
- Added the `cache-advisor` audit check. Its reading is bounded by the new `cache_advisor_max_ms` option (20 s by default, newest files first).
  - It warns when the window in effect costs more than 5% above the cheapest, or when a configured value is ignored.
  - A read cut short by the time budget is labelled PARTIAL with what it covers, and never replaces a saved full-read summary.
- `/ac recommend` now prints an `auto-compact:` line quoting the last advisor run for the model the alias resolves to, with the run's date and whether it was a full or partial read.
- Added `config/compaction.json`: context windows, default auto-compact points (about 967K on 1M models, about 167K on 200K models) and the 33K compaction reserve, with sources.

## 0.29.13 — 2026-09-26

- Added the polling-wakes guard (cache-advisor guard b), a PreToolUse hook on ScheduleWakeup and Monitor. It is advisory only and never blocks. It names the doctrine "one completion wait, never per-item wakes" when recent wakes look like a short-interval poll producing no new work:
  - ScheduleWakeup: a streak of at least `poll_guard_noop_streak` (default 2) `noop` wakes at or below `poll_guard_short_delay_seconds` (default 600). The hint fires only while harness-tracked background work (a background Agent/subagent, Bash/PowerShell or Monitor call) is still in flight; polling external state the harness cannot track, such as CI or a merge gate, is left alone.
  - Monitor: at least `poll_guard_monitor_rearm_streak` (default 2) re-arms of the identical watch. A re-arm counts only if it happens before the previous arm could have timed out, and only when that arm's `timeout_ms` was at or below `poll_guard_monitor_short_timeout_ms` (default 600000); re-arming a watch after it naturally expired is not flagged.
  Kill switch: `poll_guard: false`. `poll_guard_tail_bytes` (default 131072) bounds how much of the transcript it reads.
- Added the standing rule `poll-guard-doctrine` (session start). Seven rules now ship built in.
- Added `scripts/poll-guard-report.mjs`, a read-only report of polling-wake episodes (wake count and context re-read size) from your own transcripts. A continuous escalating watch is reported as one episode.

## 0.29.12 — 2026-09-26

- Added the resume guard, a PreToolUse hook on SendMessage. It is advisory only and never blocks. It speaks up when all of these hold:
  - the target is a background subagent this session spawned;
  - the target's own last activity is older than the cache TTL that applied to it;
  - the target's last context was at least `resume_guard_min_tokens` (default 50000).
  It then names the doctrine (resume only while the cache is warm; otherwise spawn fresh from a file handoff) and estimates the rewrite size. The TTL comes from the last record in the target's transcript that actually wrote a split cache entry (1h or 5m bucket); if there is none, from the target's agent definition `experimental.cacheTtl`; else 5m. A turn that only read the cache no longer hides a 1h TTL. Kill switch: `resume_guard: false`.
- Added the standing rule `resume-doctrine` (session start). It states the same doctrine for cases the hook cannot see, such as a peer in another session. Six rules now ship built in.
- Added to `scripts/transcript-report.mjs`'s `resumeAfterIdle`: `idleExpiryRewriteTokens`, `idleExpiryRewriteUsd` and `idleExpiryUnpricedTokens`, priced the same way as every other dollar figure in that report, with tests.

## 0.29.11 — 2026-09-25

- Added `scripts/transcript-report.mjs`, a read-only report of transcript tokens. It shows:
  - price-derived cost;
  - compactions;
  - the gap between requests, split by what connected them (tool result, prompt, message from another agent, harness record) and the cache TTL that applied, with each rewrite's cause (cache expired while idle, prompt prefix changed, compaction);
  - the resumes after idle;
  - the spawn baseline per subagent type;
  - context growth.
  `--json` gives the full object. `--max-ms` reads the newest transcripts first and reports how many it skipped.
- Added `scripts/lib/transcripts.mjs`, the one transcript reader. cache-ttl, transcript-harvest, the telemetry-coverage check and the model-mismatch check all read through it. Its dedup rules are written down and tested.
- Changed (behaviour): cache-ttl's main-session request count drops. It used to count three things wrongly:
  - a request re-logged later in the same transcript counted as an extra request with a negative gap;
  - a request copied into a resumed or forked transcript counted once per copy;
  - a request with no prompt or tool result of its own reused the previous one's start time.
  Within-file re-logs and cross-file copies are now counted once. On one measured 30-day window, 26,815 main-session requests became 25,364; subagent figures were unchanged. A copied request now belongs to its original transcript and carries the largest usage of any copy.
- Changed (behaviour): transcript-harvest now fills trigger and token counts for compaction summaries it used to leave empty (attachment records sitting between a compaction boundary and its summary).
- Fixed: a transcript that starts with a UTF-8 byte-order mark no longer loses its first record.
- Added prices for claude-opus-4-7 ($5 in / $25 out) and claude-sonnet-4-6 ($3 / $15), both at 0.1x cache read, from a live read of Anthropic's pricing page on 2026-09-25 (provenance in `config/model-pricing.json`). Their requests were previously left out of every cost total.
- Pricing moved to `scripts/lib/pricing.mjs`. cache-ttl.mjs re-exports it, so its API is unchanged.

## 0.29.10 — 2026-09-25

- Added: optional "Compact instructions" block for CLAUDE.md (`scripts/install-compact-instructions.mjs`, offered by `/ac setup`, which shows the exact block and asks first). It tells automatic compaction to keep the current task, open decisions, file paths and branches, and where the session's handoff/state file lives. Flags `--print`, `--status`, `--dry-run`, `--uninstall`, `--force`, `--target`. Defaults to the user-level CLAUDE.md and says plainly that the docs describe the project-root CLAUDE.md (`--target <repo>/CLAUDE.md`). Install then uninstall restores the file byte for byte, and removes it if install created it. No PreCompact hook ships: per the hooks docs a PreCompact hook can only block compaction, not steer the summary.
- Changed: the opt-in installers (compact instructions, and 0.29.8's re-inject hook) name their backups `<file>.bak-agent-companion-<timestamp>` and keep only the newest 3 of those; any other backup, including plain `.bak-<timestamp>` files written by 0.29.8, is never touched. They check the target is writable before backing up, and do nothing when imported.

## 0.29.9 — 2026-09-25

A background worker spawned from the main session with no name now gets one.
When a main-session Agent spawn sets `run_in_background: true` and gives no
`name`, the spawn guard fills one in: `<project>-<type>-<slug>`, unique within
the session, and never `main` or `team-lead`. To turn autofill off, set the
plugin option `namegate_autofill` to false (you then get only an advisory);
`namegate` set to false turns the gate off entirely. Only spawns that set
`run_in_background: true` explicitly are affected; a spawn with no
`run_in_background` field, a foreground spawn, a named spawn, and a spawn from
inside a subagent are left alone.

### Spawns
- Added Gate 4, "namegate". A main-session spawn with `run_in_background: true` and no `name` gets an advisory (never a block); by default the guard also sets a unique `<project>-<type>-<slug>` name via `updatedInput` (sanitised to `[A-Za-z0-9._-]`, at most 60 characters) and adds a short note to the worker's brief naming the worker, `main` as its lead, and this session's other already-named workers as peers. The harness was shown to honour the rewritten name by a live probe outside this repo. New options `namegate` and `namegate_autofill` (both default on). New `spawns.jsonl` fields: `gate4_applicable`, `gate4_action`, `name_autofilled`, `name_effective`.
- Each autofilled name is reserved atomically per (session, name) with an exclusive-create marker under the plugin state directory (`namegate-names/`, swept after 24 hours), so concurrent background spawns in one message never get the same name. If the state directory is unusable it falls back to an unreserved unique pick. Reserved addressing names (`main`, `team-lead`, compared case-insensitively) are never chosen.
- Fixed: Gate 3 (shared-tree notice) no longer fires for a spawn that namegate just gave a name.

## 0.29.8 — 2026-09-25

`/ac setup` can now install an optional hook that restores a session's saved
state after compaction.

### Added
- Optional compaction re-inject hook. `/ac setup` offers `scripts/install-reinject-hook.mjs`, which installs a user-level SessionStart (matcher `compact`) hook that re-injects the session's saved state (the session scratchpad's SESSION-STATE.md, else HANDOFF.md) after compaction. It finds the scratchpad through the hook input's transcript_path, caps injected state at 9,500 characters (under Claude Code's 10,000-character hook context cap) keeping the end, and never splits a surrogate pair. It is never auto-installed; the installer refuses when an equivalent hook is already configured (user settings.json or settings.local.json, matched by name), refuses to rewrite a wrong-shaped settings.json, and `--uninstall` / `--status` manage it.

## 0.29.7 — 2026-09-25

Memory-vault git commands no longer read git configuration from outside the
vault, apart from a few of your settings that read-only lookups pass on, and
ignore inherited variables that named a program for git to run. The
`copyable-prompt` rule fires when you ask for a prompt, not whenever a message
mentions one.

### Memory vault
- The vault's git housekeeping now finishes before a sync lets go of its lock, so it can no longer run on into the next sync. Automatic housekeeping is still on.
- Memory-vault git commands, reads and writes alike, no longer read git configuration from outside the vault, apart from the settings lookups described in the next item.
  - Each command runs with GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM set to the null device (NUL on Windows, /dev/null elsewhere), GIT_CONFIG_NOSYSTEM=1 and GIT_ATTR_NOSYSTEM=1, and HOME and XDG_CONFIG_HOME set to the null device, however an inherited name is capitalised.
  - As in 0.29.1, inherited GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n, GIT_TEMPLATE_DIR, GIT_DIR and the other repository-locating variables, and GIT_AUTHOR_*/GIT_COMMITTER_* are ignored.
  - Inherited GIT_ATTR_SOURCE and GIT_EXEC_PATH, and on Windows GIT_REDIRECT_STDIN, GIT_REDIRECT_STDOUT, GIT_REDIRECT_STDERR and GIT_ASK_YESNO, are now ignored by every git command the vault runs, lookups included. git uses its own programs instead of the ones in an inherited GIT_EXEC_PATH, which git itself sets for every hook it runs.
  - A parent process can no longer inject a setting or a program into a vault command through any of these. Examples: an excludes file that left memory files out of the backup; a filter program that ran on every sync and on `memory-vault status`; an attributes tree under which a CRLF memory file was stored as LF; a redirect that sent git's output to a file outside the vault; a `git` in an inherited GIT_EXEC_PATH that ran on every vault commit; a GIT_ASK_YESNO program that ran over and over, and kept a sync waiting, while a file in the vault's .git was held open.
- The vault still uses a few of your own git settings. They come from one read-only `git config` lookup per run, plus one read-only `git rev-parse` when that lookup finds a system or global safe.directory entry. Each lookup has a 15-second timeout, and the values are passed to git with -c:
  - core.autocrlf, core.eol, core.safecrlf and core.quotepath, so line endings and the file names in commit messages come out as before;
  - whether your own git trusts the vault. The `git rev-parse` runs in the vault with the environment 0.29.1's vault commands had (less the variables named above), so git itself checks the vault's owner against your safe.directory entries, exactly as those commands did. A vault it trusts is then trusted by every vault command through one `-c safe.directory=` entry naming the vault, however many entries your config has; a vault it refuses is refused. So an entry inside an `includeIf "gitdir:…"` or `"onbranch:…"` block does not count, and `~` and `~/…` entries are expanded against your home directory, because that is what git does.

    A vault owned by another account is trusted or refused as it was in 0.29.1.
  - user.name and user.email, used for a commit only when the vault's own config sets none. Failing those, git's EMAIL variable is used, and then the vault's built-in identity.

  The lookups read your config through HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM, as 0.29.1's vault commands did, and take only these values. Nothing is written into the vault's config. core.longpaths=true is now always passed.
- Your global and system author.name, author.email, committer.name and committer.email no longer change the author or committer of vault commits. In 0.29.1 they did, even when the vault's own user.email was set. user.useConfigOnly no longer stops a vault commit from using git's EMAIL variable.
- Your global excludes and attributes files no longer apply to the memory vault. That covers:
  - core.excludesFile and core.attributesFile from your global or system config;
  - git's default per-user ignore and attributes files ($XDG_CONFIG_HOME/git/ignore and git/attributes, or ~/.config/git/ when XDG_CONFIG_HOME is unset);
  - the system gitattributes file.

  A vault may now back up memory files those rules used to leave out, and the next sync commits them. Other global settings no longer affect vault commands either. For example, a global status.showUntrackedFiles=no no longer hides untracked files from `memory-vault status`.
- If the `git config` lookup fails or times out (for example, your global config file cannot be parsed), a vault whose .gitattributes is not the plugin's `* -text` refuses to commit, so it never stores bytes under line-ending settings it could not read. A vault with the plugin's own .gitattributes keeps syncing. If the `git rev-parse` lookup fails or times out, no safe.directory entry is passed on: a vault owned by another account is refused, and one you own is unaffected.

### Standing rules
- The built-in `copyable-prompt` rule now fires when a message asks for a prompt in one of the ways it recognises: a verb such as write, draft, craft, prepare, make, give, compose, generate or "send me", or "I need", "I'd like" (with any apostrophe, so "I’d like" too) or "can I get", followed within a few words by "prompt". Examples: "write me a prompt", "make me a prompt", "draft a prompt for the reviewer", "can I get a prompt", "I'd like a prompt for the reviewer", "rewrite this prompt". It also fires on a message that opens with "a prompt for …", and on "write me a brief for …".
  - It no longer fires when a message only mentions a prompt, as in "the prompt field is empty", "Prompt for confirmation before running migrations", "the CLI shows a prompt for the password" or "I get a UAC prompt every time I run the installer".
  - It no longer fires on a mention of a brief, such as "the brief for the builder was too long".
- User-prompt standing rules now ignore the text inside `<teammate-message>`, `<command-message>`, `<command-name>`, `<command-args>`, `<local-command-stdout>` and `<local-command-caveat>` blocks, as they already ignored `<system-reminder>` blocks. A teammate's message, a slash command's arguments and a command's output no longer trigger them. A wrapper tag name you type in your own message with no ">" after it, as in "the <command-args flag is ignored", no longer hides the rest of the message when a real block follows it.
- Removing those blocks now takes time linear in the message length. A 1 MB message of nested blocks used to take up to about 30 seconds in the UserPromptSubmit hook; it now takes milliseconds.

### Known limits
- On Windows, when a lookup times out (for example, your git config includes a named pipe that never answers) and `git` on your PATH is Git for Windows' `cmd\git.exe` launcher, the launcher is stopped but the real git it started keeps running until the include answers. It is one of the read-only lookups: it takes no lock, writes nothing into the vault and does not block the next sync, but while it runs the vault directory cannot be renamed or deleted. Stopping the real git on a timeout is follow-up work.
- When git refuses a vault owned by another account, the refusal says the vault "has no git repository of its own" and shows git's command line, not that ownership was the reason. 0.29.1 said the same.
- `copyable-prompt` still fires on a few messages that are not asking for a prompt, such as "overwrite the prompt file", "decompose the prompt into steps", "can I get a prompt to confirm deletes?" and "the prompt says to write it in Rust".
- An inherited GIT_DEFAULT_HASH still makes a new vault use SHA-256, and GIT_LITERAL_PATHSPECS and GIT_ICASE_PATHSPECS set together make a sync fail, as in 0.29.1.

## 0.29.6 — 2026-09-25

A session-start check names the exact recovery steps when the ladder is
broken or a stale copy is loaded. The scout tells a stale copy from a session
that was simply left open. Ladder spawns take model and effort from the rung.

### Ladder check
- Added a session-start ladder check. It names the exact recovery steps when an `ac-*` agent file is missing or broken, or when a session loaded a copy older than the install for its scope: an orphaned plugin-cache copy, or an older copy from outside the cache such as a desktop app bundle. It stays quiet after a normal update, across projects, for a newer dev checkout, and on `/resume` inside a running session.
- An in-process `/resume` is recognised by the SessionEnd "resume" the same process raises just before it. A fresh `claude --resume` that gets an earlier process's id is treated as a fresh load and no longer gets a false "updated after this session loaded" notice.
- When a ladder agent can't be spawned, an opt-in fallback (`node scripts/install-ladder-agents.mjs --yes`, never automatic) registers the ladder as user-level agent definitions. It rejects malformed arguments and never deletes anything outside the agents folder.

### Scout
- The daily scout's version check now reports two different things:
  - `stale_copy_loaded` (high): a session loaded after a newer agent-companion was installed, yet runs the older guard, so it loaded a stale copy. Remedy: remove the stale agent-companion entry in the desktop plugin manager, `/reload-plugins`, and verify with a trivial ladder spawn.
  - `session_outdated` (low, informational): a session loaded before the latest update and still runs the version installed then. Remedy: restart or `/reload-plugins` that session. It is shown only for sessions loaded at least 24 hours that have missed two or more updates.
  - A session left open across updates is never reported as a stale copy. Sessions whose load time is unknown are reported only as a count ("N sessions with unknown load time"), with no remedy.
- The 2026-09-24 stale-copy incident itself would NOT have been flagged by this release. Its 0.22.0 guard recorded no load time this version trusts, so the scout shows it only as "4 sessions with unknown load time". Future stale copies are caught: guards from this release on record their version and load time, and a stale copy is flagged whenever its session's load time is known (`CLAUDE_PID`, or self-update on).
- Rows from guards older than 0.29.0 are dated by the fields they carry (a row without `effective_effort` comes from a guard older than 0.23.0) and are judged against the user-scope install.
- `plugin_version_behind` compares against the latest available release, not whichever checkout ran the scout. The scout no longer reports the ladder's own agent types as unknown.

### Spawns
- Ladder spawns (`agent-companion:ac-*`) now read model and effort from the rung's own file. They no longer draw a false "no effort stated" note, and no routing model is written over the rung.
- When best-fit autofill picks a model for a general-purpose spawn, it now also switches the spawn to the matching ladder agent so effort is pinned. It does this only once a ladder agent has started in that session; otherwise it says which rung to use. The `fit_autofill_ladder` option turns this off.
  - If the harness runs a switched spawn as its original type anyway, the guard records that and stops switching for the rest of the session. A start is tied to a switch only when that is certain: never for a plain spawn of the same type in the same fan-out, and never for a worker continued with SendMessage.
- A repeated SubagentStart (a worker resumed with SendMessage) no longer counts toward premium_cap.
- Spawn advisories now call out a non-ladder worker given an explicit model different from the lead's own, which silently inherits the session's effort.
- `ac-opus-low`'s description no longer calls opus/low "rare". Agent descriptions are generated from the routing config and checked against every rung, including new or renamed ones (`node scripts/routing-table.mjs --check-agent-descriptions`); `ac-haiku`'s retirement notice comes from the config.

### Known limits
- Guards from 0.29.0 through 0.29.5 write no version stamp, so their rows are never checked, including a stale copy only one release behind.
- A stale copy one update behind, in a session that loaded before that update, is recognised only while the plugin cache still shows its version was replaced before the session loaded.
- Ignored-switch detection needs the session to have recorded spawns for 3 minutes; a switch inside that window is never judged, and switching carries on (the quiet side).
- With `spawn_telemetry` off, an agent that started before the session was armed and is continued during a pending switch, 3 or more minutes after arming, is not recognised as a repeat start.

## 0.29.5 — 2026-09-25

The pre-push gate scans every pushed commit and every pushed ref name for
leaks and private names, on every branch, before anything leaves the
machine. ci-local reports held and flaky tests exactly.

### Pre-push gate
- The pre-push gate now scans every commit you push, on every branch including `wip/` and `backup/` branches, and the name of every branch and tag you push (the local name as well as the remote one), for leaks and for names on your private denylist (`~/.claude/agent-companion/config/private-names.txt`). It checks what each commit adds, its message and any new paths. Binary files, files marked `-diff` and UTF-16 files are scanned too. So is text behind JSON or JavaScript escapes (`\n`, `\uXXXX`) or URL percent-encoding (`%2F`). When the scan finds something, it blocks the push and shows the commit and where the problem is, never the matched text. A printed path or ref name has each match replaced by `[redacted]`; one that can't be cleaned that way (for example, a name split by an invalid UTF-8 byte) is shown as `[redacted path]` or `[redacted ref]`.
- A commit is skipped only when the remote you are pushing to already has it: it is reachable from the tips git reports for the refs you push, or from that remote's own remote-tracking refs that it still advertises, checked with at most one `git ls-remote` per push. So merging that remote's `main` doesn't block on `main`'s own history while your remote-tracking refs are current. Commits that only another remote, a hand-made ref or a stale tracking ref has are scanned. A tracking ref is stale when the remote no longer advertises its commit: the branch was deleted or rewritten, or has moved on since your last fetch. If that makes a push re-scan history that is already public, run `git fetch --prune` and push again. If `git ls-remote` fails, or gives no answer within 30 seconds, a warning says so and more history is scanned. A push to a URL rather than to a named remote trusts only the tips git reports.
- `git replace` and `.git/info/grafts` don't change what the gate scans: it reads the commits the push actually sends.
- A denylist entry matches case-insensitively on word boundaries, including inside camelCase and next to digits: `ann` matches `getAnnName` and `ann2`, but not `annotation`. An entry starting `re:` is a regex.
- Denylist lines may end in LF, CRLF, CR alone, U+2028 or U+2029. A denylist file that exists but can't be used blocks the push instead of being ignored: a directory, an unreadable file, a file saved as UTF-16, invalid UTF-8, a `re:` entry that isn't a valid regex or that matches empty text, or an entry with a control character inside it, such as a TAB. The message says what is wrong (for a bad entry, its line number), never what the file contains. A missing denylist only warns, and the warning shows its location as `~/...` or through the variable that set it, never your expanded home directory.
- A file over 16 MiB (`PUSH_SCAN_MAX_FILE_BYTES` changes this) is not scanned. A warning names it as "not scanned (size)", its path is still checked, and the push goes on.
- A compressed file (a zip such as `.docx`, gzip, bzip2, xz, zstd, 7z, a PNG with compressed text, or a PDF with filtered streams) is scanned only as raw bytes. A "compressed content not scanned" warning names it, and the push goes on.
- `.githooks/pre-push` passes git's remote name and URL on to `ci-local.mjs --pre-push-hook`. A custom hook that calls `--pre-push-hook` without them gets the strictest boundary: only the tips git reports count as already public.
- Known limits: compressed content is not inflated; a name right next to a CJK, kana, Thai or Arabic letter, a combining mark or an invisible character is not matched (so a ref named that way is pushed and printed); an annotated tag's message and a ref to a blob or tree are not scanned; matching is per line, so an entry split across a line break is missed; homoglyphs are not normalised and UTF-32 is not decoded; ci-local's temp-dir warnings and a crash on a `main` or `release/**` push can print your home path, and on a push that runs the suites, leak-check prints the text of what it finds in the working tree, untracked files included.

### Test runner (ci-local)
- Held (`todo`) tests are no longer shown as failures. Each suite's summary now reads `pass N · fail N · todo N · skipped N`.
- A test file that fails is re-run once on its own. If it then passes, it is reported loudly as "flaky on isolated re-run". This does not block a local run or an ordinary push, but it does fail `--ci-parity` and pushes to `main` or `release/**` branches.
- `ci-local` runs at most half your CPU count of test files at once, from 1 up to 8. Set `CI_LOCAL_TEST_CONCURRENCY` to change it.
- `scripts/setup-hooks.mjs` sets the hook path in the repository you run it in, even when it is launched from inside another git process.

## 0.29.4 — 2026-09-25

The memory nudge finds a worktree's main repository without `git`, and says
so plainly when it can't. The routing-profile timing check leaves the test
gate.

### Memory
- Fixed: in a git worktree, a spawned subagent's memory nudge no longer needs `git` to find the worktree's main repository, so a slow or unavailable `git` can't make it report "no memory here". When a linked worktree's main repository genuinely can't be found, the nudge now says "memory scope unresolved (git unavailable)" instead of "0 here", and `memory-search --here` warns. Submodules, bare-repo worktrees and `--separate-git-dir` checkouts behave as before.

### Tests
- Changed: the routing-profile timing check is no longer part of the test gate. Run it on demand with `AGENT_COMPANION_PERF=1` (see CONTRIBUTING.md).

## 0.29.3 — 2026-09-25

Skills stop hard-coding routing answers and point at the routing config and
the `ac-*` ladder agents instead.

### Skills
- evaluate, recommend (prose), calibration-scout and audit now take tiers, models and effort from the routing config (`config/model-tiers.json` via `recommend.mjs`) instead of hard-coding them, and tell you to spawn the matching ladder agent (`agent-companion:ac-<model>-<effort>`) so the routed effort is pinned rather than inherited from the lead. evaluate now always passes `--effort`, and notes that the spawn guard's autofill sets the model only. calibration-scout no longer lists the eval suite's expected routes. evaluate notes that `haiku` retires on 2026-10-15.

## 0.29.2 — 2026-09-25

The `integration` routing trial moves to opus/medium, and a new floor, F6,
keeps architecture-class task types off opus/low.

### Routing
- The `integration` trial moves from opus/high to opus/medium, on an operator decision that is reviewed on 2026-09-30. The trial row carries its own F5 waiver, so the elevated-consequence effort floor stays at high for every other route. `large-refactor` and `novel-design` stay at opus/high, and `critical-change` stays at opus/xhigh (F1).
- A shipped routing-trial row can now carry the same F5 waiver a routing-profile row already could (`waivesFloor: "elevated"` with `source: "operator-observed"`). The waiver covers only that row's task type. `integration` is the only trial row that carries one, and a test pins that.
- New floor F6: an architecture-class task type (`integration`, `large-refactor`, `novel-design`, `critical-change`) never resolves to opus/low, and no F5 waiver gets around it. At the trial and grid layers F6 raises the effort to medium. A routing-profile row naming opus/low for one of these types is refused by `routing-profile set` and ignored if hand-edited; only that row is skipped, and the rest of the profile still applies.
- A local task type in a routing profile can set `architectureClass: true` to get the same F6 protection. Any value other than true, false or null makes the type invalid.
- `docs/ROUTING.md` and the recommend skill's task-type block are regenerated. `docs/ROUTING-RATIONALE.md` now describes F6, trial-row waivers, and why integration sits at medium.

## 0.29.1 — 2026-09-24

An incident fix for the memory vault, hardening for the spawn guard's locks
and brief parsing, a new `main_ci_red` scout signal, and benchmark evidence
families that never pool real and synthetic results.

### Memory vault (incident fix, 2026-09-24)
- Every vault git call strips the repo-locating GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY and the others), matched case-insensitively. The bug: an inherited GIT_DIR made `git init` re-initialise the project's own .git with `core.bare=true` and a vault identity, which broke every worktree.
- `ensureInit` refuses any target inside an existing repo, work tree, .git or bare repo, and writes nothing. The location is checked before any write, on sync, init and status.
- A vault's .git must be a real directory, not a junction or symlink, and must not contain `commondir`.
- A marker is honoured only if the vault's history is rooted in "memory-vault: initialize". A changed or unset user.email is still accepted, with a note.
- A refusal never advises deleting a directory that holds commits or files; it says to move it aside instead.
- A half-made vault (marker present, no commits) is finished rather than refused.
- Vault commits are never signed and never run hooks: hooksPath is overridden, `--template=` is set, fsmonitor is off, and inherited GIT_CONFIG_* and author/committer env are ignored.
- New `AGENT_COMPANION_VAULT_DIR` moves the vault only. It must be an absolute path and must not overlap the state root. Set it persistently, so the scout and the drift check see it too.
- On Windows, vault paths over 246 characters are refused up front (Git for Windows' MAX_PATH limit).
- `status` is read-only: its guards run first, it uses `--no-optional-locks`, and a refused vault makes `status` exit 1 and the drift check fail.
- Test and gate git spawns strip the repo-locating GIT_* variables too: leak-check parity, bench hidden tests, the canary and the publication sweep.

### Spawn guard and locks
- Stale-lock breaking is serialised, so racing waiters never both hold the lock.
- A future-dated lock, or one that isn't a regular file, no longer blocks until timeout.
- Crash debris is swept only when its owner process is dead.
- Transitional: while upgrading, a 0.29.0 helper racing a 0.29.1 helper can still overlap once.
- Brief declarations ignore HTML comments and read nested list items. A BOM, NBSP or zero-width character before a header is normalised. A declaration-shaped line right after a quote still counts.
- The guard loads the premium window only for premium spawns, which makes every other spawn faster.
- Routing profile store: the depth scan is iterative, so huge strings no longer cause a RangeError; adopted external edits are validated. A grammar error in the routing table is fixed.
- Haiku retirement (2026-10-15): `ac-haiku` is marked RETIRING, with sonnet/low as the fallback. After that date, advice and audit text no longer name haiku.

### Scout
- New `main_ci_red` signal, controlled by `ci_status_signal` (default on). Using `gh`, it flags a default branch whose latest completed CI run is red. Suggestion-only.
- Scope is the current project plus known-public repos. It shows as a cache-only SessionStart note and stays silent without `gh`. A `default_branch` lookup that answers "null" or nothing counts as no answer.

### Benchmark
- Evidence families: every row and summary carries `evidence_family` (real, synthetic or unknown) plus a finer label.
- Summaries, estimates and cost comparisons never pool families. Cost indices compare only within the same fine family, and unknown rows never feed estimates.
- External harnesses can label their tasks via `task.evidenceFamily`, `--evidence-family` (on `scripts/benchmark.mjs` and on the runner), or `AGENT_COMPANION_BENCH_EVIDENCE_FAMILY`.
- Historical rows can be labelled through a local mapping file at `<stateRoot>/config/evidence-families.json`.
- An unknown label is rejected before any spend, and a real pack can't claim a synthetic label. The unrecognized-legacy-label warning prints once per label per process, not once per rebuilt summary.
- Estimates use `cost_usd`, because price-weighted token indices understated Opus. They draw on local history keyed by fine family.
- Judge-vote cost comes from local history; otherwise a measured $0.81 per vote at fable/high, scaled by tier.
- Judge diffs are git-based: a small change to a large file stays small, and output is ordered source, then tests, then docs, and capped.
- The judge prompt goes via stdin, which fixes ENAMETOOLONG on Windows.
- The judge allows xhigh, and its effort is at least the author's, applied per cell: calibration, votes and the `judge_effort` column all use the raised effort.
- Docs: the judge is a design-quality signal only, never a correctness check.
- New `docs/ROUTING-RATIONALE.md` explains why the routing table is shaped the way it is.

### Fixes
- Standing rules: a `user-prompt` rule matches only the user's own text. Cross-session-message, task-notification, agent-message and system-reminder blocks are stripped first, so a turn carrying only those no longer fires "The user is asking for a prompt".

## 0.29.0 — 2026-09-24

Ships the routing resolver layer stack and per-user routing profiles
(ADR-0003 slices 1, 1b and 2), a parallel-safe benchmark runner with a
pre-run cost gate, and a hardened premium-window lock.

### Routing: layer stack and per-user routing profiles (ADR-0003, slices 1, 1b and 2)
- New `resolveRoute()` resolves every route through one layer stack: per-user profile row, then shipped trial, then shipped grid. Floors F1–F5 now apply AFTER whichever layer wins, so shipped trials are floored too. `resolveExpected()` keeps its shape.
- `recommend --explain` and `/ac routing why <type>` print the full stack: what each layer would give, the winner, the floors that fired (including those raised inside the grid), and the winning row's provenance.
- New per-user routing profile at `<stateRoot>/config/routing-profile.json`:
  - Schema v1, with an append-only journal (`routing-profile.journal.jsonl`).
  - `/ac routing set | unset | show | why | rollback --row | rollback --to`.
  - Kill switch: the `routing_profile` option (default on; with no file, nothing changes).
  - Rows that break F1–F4 are refused at write time and ignored at read time. The elevated floor (F5) can be waived only by an operator-observed row with `--waive-floor elevated`. A model that takes no effort (haiku) counts as below F5 on elevated types.
  - Rollback restores any journalled revision the resolver accepts.
  - An invalid file fails open to the shipped table and leaves a marker.
  - Writes are atomic and locked.
- `spawns.jsonl` gains `route_layer` and `route_profile_rev`; row content is never logged.
- Reviewer parity (code-review): the reviewer is max(writer, the F1 critical floor), capped by F2 (fable is never a destination; a fable writer gets an opus reviewer and still needs a warrant). An unknown writer, or an effort that isn't a level, is refused (recommend exits 2, evaluate exits 3). An effort a haiku writer states is dropped. Effort case is normalised.
- An explicit weight, kind or consequence that EQUALS the type's preset no longer bypasses the trial.
- A task type named after an Object.prototype member (`constructor`, `toString`, and so on) now resolves as unknown.

### Spawn guard
- Brief directives (TYPE, WEIGHT, KIND, CONSEQUENCE, WARRANT, EFFORT) are read only from their own lines, and never from fenced code, indented code or `>` blockquotes. The first declaration of each label wins, even if its value is invalid, so pasted logs can't override the header. Markdown-bold `**TYPE:**` is accepted. A warrant needs a declaration line.
- A `TYPE: code-review` spawn that declares `CONSEQUENCE: critical` below opus/xhigh is reported as under-provisioned (F1).
- The premium_cap window is locked and written atomically, so the cap is exact under concurrent spawns. It counts a spawn only once SubagentStart confirms it has started, matched by agent type. An allowed spawn the harness then rejects stops counting after 3 minutes. (Counting routed opus by tier, ADR-0003 OQ8, is HELD pending an operator decision.)
- The premium-window lock's stale time is lowered from 5000ms to 1000ms, at or below its 2000ms wait. The comments describing the lock's guarantee are corrected: a live pid's lock is never judged stale — not that a live writer's lock can never be removed. A rare put-back race can still let two holders coexist after a crashed holder's lock is broken, when 3 or more contenders are racing it; that race is tracked for 0.29.1.
- Transitional: an older plugin version running concurrently in another session rewrites the premium window without the new fields.

### Benchmark harness
- Parallel-safe runner, `scripts/benchmark.mjs --concurrency N`:
  - One global pool across cells, gated on free RAM.
  - Each run gets its own TMP and `BENCH_PORT_BASE`.
  - Pack `resources: {fixedPorts, lockFiles, exclusive}` declarations are respected across cells.
  - When a run that ran alongside others fails, the SAME sandbox is re-scored solo, without re-running the model, which keeps pass rates unbiased.
  - `--resume` dedupes by attempt family.
  - Windows-safe sandbox cleanup with retries (`cleanup_error` never changes a result).
- Pre-run cost and time estimate:
  - Covers wall time, tokens by class, API $, and weekly plan points as a low–high range. 5-hour points show as "unknown" unless you have a measured anchor.
  - It is built from local history, with a labelled fallback.
  - Confirmation gate above N weekly points (default 2), for any fable cell, or when a run would cross the weekly ceiling. `--dry-run` makes no model calls.
  - The ceiling stop is checked between batches.

### Fixes
- The publication-leak sweep never prints a repo's raw identity in clone or fetch errors.
- CI: full-depth checkout; the alias-floor test skips when no `claude` CLI is present; push runs skip `wip/**` and `backup/**`.

## 0.28.0 — 2026-09-24

Folds proven evaluation practice into the model x effort benchmark. It
compares against skill-creator's eval mode, `claude plugin eval`,
Anthropic's develop-tests guidance, and SWE-bench practice.

### Added

- **Confidence intervals and pass@k** (`bench/stats.mjs`,
  `rebuildSummary()`). Each cell x task row and a new cell x task-family
  rollup (`summary-by-family.json`, plus a table in `summary.md`) carry
  **pass@1** (the mean single-trial rate, formerly labelled `pass_rate`,
  which `summary.json` keeps as an alias), a **95% Wilson interval**, and
  **pass@k** with k = reps (the unbiased estimator). Family groups under 5
  runs are flagged **"n too small to separate"**.
- **Reproducibility metadata on every `results.jsonl` row**, including the
  row written when `runOne()` throws: `claude_cli_version`, requested and
  resolved model, requested effort, `task_family`, and sha256 hashes of the
  prompt, the starting fixture tree, the task pack (manifest, brief,
  held-out test, rubric), the rubric, and all of them combined
  (`task_content_sha256`).
- **Optional rubric judge** (`bench/judge.mjs`, `--judge-model`) for design
  quality a hidden test cannot see. The rubric lives in the task (a pack's
  `rubric.md`). The judge must be different from, and at least as strong
  as, the model under test; it is checked per cell before the batch and
  against the resolved model after each run. Three independent no-tool
  `claude -p` calls, pass on 2 of 3, reasoning before the verdict. Blind:
  no producer channel exists, and self-identification is scrubbed. Effort
  and per-vote budget are capped, and temperature is never sent (current
  models reject it). Results go to separate `judge_*` columns and their own
  summary table, never merged into pass/fail.
- **Judge calibration gate** (`--calibrate-judge`). A judge is trusted on a
  task only after it passes the pack's real fix commit and fails both the
  unchanged parent and every planted broken variant
  (`manifest.judgeCalibration.plantedBad`). The trust record is keyed on
  task content, rubric, judge model, effort and prompt template.
  `scripts/benchmark.mjs` and `runOne()` refuse an uncalibrated or
  ineligible judge before any model call (exit 2, or `JUDGE_REFUSED`, which
  aborts without writing a row). The example pack ships a rubric and two
  planted variants.
- **Routing canaries as a `claude plugin eval` suite** (`evals/`, five
  cases): debug to opus/low, architecture to opus/high, never fable for a
  trivial read, a WARRANT for a fable request, and no routing skill on an
  unrelated question (`arm: both`). Free graders only. Documented with an
  opt-in CI invocation; the calibration scout suggests it after a
  routing-relevant signal and never runs it. `tests/evals-suite.test.mjs`
  checks the suite statically, including that each canary still matches
  `config/model-tiers.json`.

### Fixed

- **The recommend skill had no routing data in a session without a shell.**
  The first eval run found that in a sandbox with no shell and no reads
  outside the working directory, neither `recommend.mjs` nor
  `docs/ROUTING.md` was reachable, and the architecture canary answered
  opus/xhigh. The skill now carries a generated task-type table
  (`routing-table.mjs --task-type-block` / `--sync-skill`). The
  `routing-doc` audit check flags it when stale and re-syncs it on `--fix`.

### Docs

- `docs/BENCHMARK.md`: statistics, reproducibility fields, the rubric judge
  and calibration, the routing eval suite, and the operating rules for
  benchmark agents. Those rules: run cells in the foreground with no
  background jobs or monitors; never `git stash`; budget caps scale with
  model price; use at least 3 reps before comparing adjacent efforts (Opus
  5.5 high 5/7 vs low 7/7 was variance). The same rules are folded into the
  `model-benchmark` skill.
- `bench/task-packs/FORMAT.md`: private, extract-at-runtime packs are a
  deliberate contamination control. Re-verify packs when a new model
  generation ships. Documents `rubric.md` and `judgeCalibration`.

## 0.27.2 — 2026-09-23

Fixes a live spawn-guard bug surfaced by routing trial v2 (0.27.1): most task
types now route to opus, and the premium-warrant machinery had not caught up.

### Fixed

- **`hooks/spawn-guard.mjs`: the premium-tier set is now derived from the
  spawn's OWN resolved routing, not hard-coded to the tier table's
  classification alone.** Under routing trial v2 (`config/model-tiers.json`
  v7), a spawn declaring `TYPE: integration` (or any other type the trial
  routes to opus) still demanded a `WARRANT: weight N — ...` line and was
  BLOCKED without one — even though the routing table itself prescribed
  opus for that exact spawn. Fix: a model is premium FOR THIS SPAWN unless
  the same resolved routing that answers "what should this run on" (a
  declared `TYPE` with its trial override, or the plain grid for an
  explicit `WEIGHT`) also names it. Fable is excluded from this exception on
  purpose — nothing routes to fable, so no route can ever justify it; it
  stays a warranted exception on every spawn regardless of `TYPE`/`WEIGHT`.
- **A `WARRANT:` line's own stated weight no longer overrides a declared
  `TYPE`'s preset or its routing-trial override.** `WARRANT: weight 4 —
  <reason>` and `WEIGHT: 4` were parsed by the same regex, so a warrant
  justifying an opus spawn under `TYPE: novel-design` (type weight 5, trial
  override `opus/high`) had its own "4" silently treated as an EXPLICIT
  weight declaration — bypassing the type's own preset and override,
  falling back to the plain grid's weight-4 answer, and denying the exact
  spawn the trial prescribes for a manufactured "over-provisioned"
  mismatch. Fix: only a genuine `WEIGHT:` line counts as an explicit
  deviation from a named `TYPE`'s preset now; a warrant's own weight is
  still captured for `declaredWeight`/telemetry (unchanged, per
  `docs/TELEMETRY.md`), but never bypasses a declared `TYPE`. Precedence:
  explicit `TYPE` (with its trial override) > a real `WEIGHT:` line > a
  warrant's own stated weight.
- **A premium spawn with neither `TYPE` nor `WEIGHT` declared now WARNS
  instead of BLOCKING when its `WARRANT:` line is missing.** The guard has
  no routing information to confirm the tier either way in that shape, so a
  missing warrant is now a `systemMessage`, not a denial — the base
  tier-table classification (the same default the guard already used for
  every undeclared spawn) still applies, but a false block here would stop
  legitimate work the guard cannot actually judge. Fable, and any spawn
  where routing IS known and disagrees, still block on a missing warrant
  exactly as before.
- New `tests/premium-warrant-routing.test.mjs` (6 tests) reproduces both
  bugs directly against a live routing-trial config: an opus + `TYPE:
  integration` spawn with no warrant is now allowed; an opus + `TYPE:
  novel-design` spawn with a weight-bearing warrant is now allowed and
  judged `fit` against the type's own override, not the plain grid; a
  fable spawn (with or without a `TYPE`) with no warrant is still blocked;
  an opus spawn with neither `TYPE` nor `WEIGHT` and no warrant is now
  warned rather than blocked; and a genuine `WEIGHT:` line still explicitly
  overrides a declared `TYPE` (proving the fix changed only `WARRANT`
  parsing, not `WEIGHT` precedence). Full suite: 523/523 (was 517/0
  baseline + 6 new).

### Added

- **`bench/runner.mjs`: `CELLS` gains `fable51-{low,medium,high,xhigh}`**
  (`claude-fable-5-1`, the current Fable tier) **and `fable5-high`**
  (`claude-fable-5`, the superseded dated id, for a direct 5-vs-5.1
  comparison at the same effort).
- **Per-run budget caps now scale with the cell's model price relative to
  Sonnet 5.** `--max-budget-usd` (both each task's own calibrated default
  and `scripts/benchmark.mjs`'s global ceiling) is the only working per-run
  runaway guard this CLI honours, and it kills a run once its ACTUAL API
  dollar cost crosses the cap — not once a token count does. Every cap was
  calibrated in Sonnet dollars, so a pricier model doing the identical
  amount of real work hit the SAME dollar cap sooner: Fable failed 7
  real-task runs purely this way (2026-09-23), cut off while still working
  because its cap was sized for a model at a fifth of its price. Fix: new
  `bench/runner.mjs` exports `modelPriceRatioToSonnet()` (reads
  `config/model-tiers.json`'s own `tiers.*.resolvesTo.pricing`, checking
  `classifyReferenceModel()` first so a dated id like `claude-opus-5` uses
  its own historical price rather than the current alias tier's) and
  `scaledMaxBudgetUsd()` (scales a base cap by that ratio, floored at 1x so
  a cheaper model's cap is never tightened). `runOne()` applies it to both
  the task default and the global ceiling before taking the tighter of the
  two, logs the actual scaled cap used as `max_budget_usd` on every results
  row, and `scripts/benchmark.mjs --dry-run`'s preview shows the same
  scaled number. Documented in `docs/BENCHMARK.md`. New
  `tests/bench-budget-scaling.test.mjs` (13 tests) plus two new
  `tests/bench-dry-run.test.mjs` cases.

## 0.27.1 — 2026-09-23

Folds in the `cache-read-weight-2026-09-23` experiment's findings and an
operator-endorsed routing trial v2. No schema/behavior changes beyond the
benchmark summary and the routing table's data.

### Added

- **Benchmark: per-cell cache HIT RATE column.** `bench/runner.mjs`'s
  `cacheHitRate()` computes `cache_read_tokens / (cache_read_tokens +
  cache_creation_tokens + input_tokens)`, medianed per (cell, task) into a new
  `cache_hit_rate` field in `summary.json` and a `hit_rate` column in
  `summary.md`, sitting next to `med_cache_read_tok` and `med_turns`. Any cell
  whose median hit rate falls under 0.85 is marked `cache_anomaly: true`, gets
  a `⚠` marker in the table, and is called out in a `CACHE ANOMALY: check
  harness` block above the table — a low hit rate usually means the harness
  broke prompt-cache sharing for that run, not that the model or task
  genuinely re-read more context. New `tests/bench-cache-hit-rate.test.mjs`.
- **`docs/BENCHMARK.md`: new "Caching" section.** Documents the cross-process
  caching gotcha found while running `cache-read-weight-2026-09-23` (separate
  `claude -p` processes, including `--resume`, do not reliably share prompt
  cache even with byte-identical content), the fix (a single persistent
  process via `--input-format stream-json --output-format stream-json
  --verbose`, one turn fed at a time, for any probe that measures across
  turns), and the plan-usage read/write weight finding below.
- **`skills/model-benchmark/SKILL.md`: two new preconditions.** "One process
  per measured conversation" (link to the Caching section) and "check the
  cache hit rate before trusting a batch's cost numbers" (the new
  `cache_hit_rate`/`CACHE ANOMALY` output).
- **`config/model-tiers.json`'s `costDrivers.planUsageWeighting` moves from
  `UNDOCUMENTED` to `MEASURED-PARTIAL`.** Plan metering of cache reads is
  roughly API-price-proportional (low-to-moderate confidence): 40.1M Sonnet 5
  cache reads moved the 5-hour usage meter ~2 points (~0.05 pts/1M reads,
  range 0.025-0.075); ~3.95M cache writes moved it ~4 points, so per token
  writes cost roughly 20x reads — the same direction and a similar order of
  magnitude as the API list-price ratio (~12.5x). Conclusion recorded:
  **cache MISSES (re-writes) are the expensive event, not reads.** The Opus
  5.5-vs-Sonnet-5 per-read ratio stays UNMEASURED — the Opus arm of the
  experiment hit the cross-process caching anomaly above before a clean
  reading could be taken. `planUsageMultipliers` keeps Opus 5.5 = 1.5x Sonnet
  5 (in-app tooltip, undocumented, unchanged) with a new note that this is an
  aggregate token-mix index, not a read-specific weight.
- **ROUTING TRIAL v2 (operator-endorsed, same window: since 2026-09-23,
  review by 2026-09-30).** Opus 5.5 at low effort measured cheaper than every
  Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low
  0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly
  half the turns, and equally correct; cache reads cost about the API ratio.
  This plan carries no separate Opus weekly usage window, so there is no
  separate-bucket reason to keep routing these types to Sonnet:
  - `explore`, `mechanical-edit`, `subagent-worker`, `verify`, `operate` move
    from v1's `sonnet/low` to `opus/low`.
  - `bounded-feature` and `debug-root-cause` were already `opus/low` (v1) and
    are unchanged.
  - `integration` (previously unmeasured, grid-resolved `sonnet/high`) gets
    its own override to `opus/high` — model only, not effort, since the
    elevated-consequence floor already puts effort at `high`. Reason:
    operator first-hand evidence that Sonnet struggles on some of the
    operator's multi-file technical work, not a benchmark finding.
  - `large-refactor` (grid `opus/xhigh`) and `novel-design` (grid `opus/max`
    via its kind's +2 delta) both move down to `opus/high`, the trial's
    middle ground: real-task data showed `xhigh` costing roughly 3.1x `low`'s
    tokens for no quality gain over `low`, and effort scaling specifically on
    architecture/novel-design work is itself unmeasured, so `max`/`xhigh`
    isn't paid for on an unverified assumption.
  - `critical-change` (consequence floor: `opus/xhigh`) and
    `long-autonomous-run` (already grid-resolves to `opus/xhigh`) are
    deliberately left alone.
  - A new **operator routing note** — "architecture and deep technical work
    stay on Opus; Sonnet gets confused on some of the operator's
    technical/architecture work (operator-observed 2026-09-23); do not route
    architecture off Opus on benchmark evidence alone" — is attached to
    `novel-design`, `large-refactor`, and `integration`.
  - `docs/ROUTING.md` regenerated from the updated config.
  - `tests/routing-trial.test.mjs` and `tests/verify-vs-operate.test.mjs`
    updated for the new resolved (model, effort) pairs; `tests/
    trial-fit-resolver.test.mjs`, `scripts/evaluate.mjs`, and
    `hooks/spawn-guard.mjs`'s fit check pick up every override automatically
    through the shared `resolveExpected()` resolver (no code changes needed
    there).

## 0.27.0 — 2026-09-23

Consolidated release folding in the routing lineup re-base, the ordered
effort ladder, the operator-approved routing trial (`review by
2026-09-30`), the SPAWNING RULE, cache-TTL guidance (measure gap bands
before flipping the subagent prompt-cache TTL), the model x effort
benchmark's move into the plugin, the Windows flashing-console-window fix,
and cache reads surfaced as the headline benchmark/routing cost-driver
metric. Windows fix is hardening only — no behavior change on any platform
where a hidden console was never visible.

### Added

- **Cache-read tokens, turns, and derived cost-driver stats are now HEADLINE
  columns in the benchmark summary**, not buried in the token breakdown.
  `bench/runner.mjs`'s `rebuildSummary()` computes, per (cell, task):
  `median_context_rereads` (`cache_read_tokens / num_turns`, an estimate of
  the average context size re-sent every turn) and `read_share_of_cost`
  (`cache-read $ / total $`, using the model's tier cache-hit price from
  `config/model-tiers.json`) — both `null`/`n/a` when the tier's cache-hit
  price is unmeasured, never a guessed number. `summary.md`'s columns are
  reordered so `med_cache_read_tok`, `med_turns`, `ctx_rereads`, and
  `read_share_cost` sit next to `pass_rate` and `cost_per_correct`.
  `summary.json` gains the same two new fields on every row. Reasoning:
  across this machine's real sessions, cache reads are the largest cost
  bucket — reads = context size x number of requests, so turn count and
  context size drive cost more than output tokens do.
- **`config/model-tiers.json`: new `costDrivers` block.** States the reads-
  dominate finding, the two actual cost levers (turn count, context size),
  that cache TTL only decides re-read vs re-write pricing after an idle gap
  (not a substitute for cutting turns/context), the per-tier cache-read
  price table, and that plan-usage weighting of cache reads is
  **UNDOCUMENTED**, pending experiment `cache-read-weight-2026-09-23`.
  Rendered into `docs/ROUTING.md`'s new "Cost drivers" section by
  `scripts/routing-table.mjs` (generated, not hand-edited).
- **`docs/BENCHMARK.md`: new "Reporting guidance: cache reads are the
  headline cost, not output tokens" section**, telling a human writing or
  reading a benchmark report to lead with cache-read tokens, turns, context
  re-reads, and read share of cost, ahead of output-token commentary.
- **New `tests/bench-summary-cost-drivers.test.mjs`.** Unit-level coverage of
  the two new `rebuildSummary()` fields: correct math for a measured tier
  (sonnet), `null`/`n/a` for a tier with no measured cache-hit price
  (mythos), and `null`/`n/a` when a row is missing turns/cache-read tokens.

### Fixed

- **`scripts/checks.mjs`, `scripts/detect.mjs`, `scripts/memory-vault.mjs`:
  every `execSync`/`execFileSync` call now carries `windowsHide: true`.**
  These are CLI/audit-tool call sites (`claude --version`, `claude plugin
  validate`, `git`, self-probing a hook script via `node`), not on the
  SessionStart/PreToolUse-Agent hook path itself -- that path
  (`hooks/lib/memory-index.mjs`'s `runGit()`, reached from `spawn-guard.mjs`
  on every subagent spawn) already carried the flag. Added for the same
  reason regardless: on Windows, whichever process actually allocates a
  console does not honor a flag set on an ancestor process, and these
  scripts run via `/audit`, the calibration scout, and memory-vault sync --
  all of which can run unattended.
- **New `scripts/lib/proc.mjs`.** Thin `execSyncHidden`/`execFileSyncHidden`/
  `spawnSyncHidden` wrappers, one place that hardcodes the flag, used by all
  three files above.
- **New `tests/no-visible-windows.test.mjs`.** Statically asserts every
  `spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync` call under
  `hooks/`, `scripts/`, and `bench/` carries `windowsHide` in its own
  argument list, so a future call site cannot silently reopen this. Verified
  against a real regression (removing the existing flag from
  `memory-index.mjs`'s `runGit()` made the test fail with the exact call
  site and line). Scope extended to `bench/` when this landed alongside the
  0.25.x benchmark port, which spawns dozens of `claude` processes per batch.

## 0.25.1 — 2026-09-23

Fixes a HIGH finding from adversarial review of 0.25.0's benchmark port: the
live path (`node scripts/benchmark.mjs` without `--dry-run`) could not make
a real model call for an operator authenticated the normal way (OAuth via
`claude /login`), and nothing told you why — every run silently reported a
0%-pass, $0-cost "completed" batch instead of an auth error. Patch bump —
bugfix, no new capability beyond the opt-in flag below.

### Fixed

- **`bench/runner.mjs` no longer redirects `HOME`/`USERPROFILE` by
  default.** The previous unconditional redirect (added in 0.25.0 for
  transcript-isolation reasons) stripped OAuth credentials, which live
  under `HOME` (`~/.claude/.credentials.json`) — every live run failed
  authentication before reaching the model. The default now matches the
  proven pre-port harness (`bench/effort-grid`, 300+ live runs): a
  sandboxed working directory per run, `--setting-sources ""`, and the
  operator's real, inherited env. Session transcripts (needed for effort
  proof) now land under the operator's REAL `~/.claude/projects/**` by
  default — each `results.jsonl` row carries `transcript_home`,
  `sandbox_cwd`, and `session_id` so the exact transcript path is always
  derivable, never guessed.
- **`--isolate-home`** (new, opt-in): redirects `HOME`/`USERPROFILE` to a
  fresh throwaway dir per run, same mechanism as the old default. Only
  works with `ANTHROPIC_API_KEY`-based auth (an env var survives the
  redirect; an OAuth credentials file does not) — `scripts/benchmark.mjs`
  refuses to start with `--isolate-home` when `ANTHROPIC_API_KEY` isn't
  set, rather than silently producing a batch of auth failures.
- **Auth/login failures are now a distinct `auth_error` status, not a
  silent task failure.** `bench/runner.mjs`'s new `isAuthError()` detects
  the failure shape (`"Not logged in"`/`"Please run /login"`/`401` text, or
  an `api_error` terminal_reason/subtype at `$0`/null cost) from either the
  run's own JSON or raw stdout. `scripts/benchmark.mjs` (and
  `bench/runner.mjs`'s own `main()`) abort the batch immediately on the
  first `auth_error` row with a clear message
  (`authErrorAbortMessage()`), instead of burning the rest of the plan.
  `rebuildSummary()` excludes `auth_error` rows from pass-rate and every
  other stat, and flags the excluded count at the top of `summary.md`. The
  per-run console line now shows `status=ok` / `status=auth_error` /
  `status=error(<terminal_reason>)` (`formatRunLine()`) instead of a bare
  `pass=false cost=$0`, so an auth failure can never be misread as the
  model failing every task at a glance.
- **`--dry-run --resume` now honors the resume marker.** Previously the
  `--dry-run` branch exited before `--resume`'s cell-filtering logic ran at
  all, so it always showed the full original grid, including cells already
  marked complete — misleading as a "what's left" preview mid-batch.
  Resume filtering now happens before the dry-run branch, and a dry run
  with `--resume` prints the same `Resuming: N/M cell(s) remaining (...)`
  line the real run does, then plans only the remaining cells.
- `docs/BENCHMARK.md` and `skills/model-benchmark/SKILL.md` updated to
  match: a new "Preconditions: authentication for a LIVE run" section,
  corrected "Effort is proven via the transcript" (real home by default)
  and "Sandbox isolation" (HOME redirection is opt-in) sections.
- Tests: `tests/bench-auth-error.test.mjs` (new — `isAuthError()`
  classification including the exact reproduced shape, `checkIsolateHomePreflight()`
  refusal/acceptance including at the CLI layer, `formatRunLine()`/
  `authErrorAbortMessage()` distinct-status output, `rebuildSummary()`'s
  pass-rate exclusion math); `tests/bench-dry-run.test.mjs` (new cases for
  `--dry-run --resume`, `--dry-run --resume` with nothing left, and
  `--dry-run` without `--resume` being unaffected by a stale marker).
  Suite: 323/0 (was 302/0).

## 0.25.0 — 2026-09-23

Moves the model x effort benchmark (previously `bench/effort-grid` on a
separate branch, never in the plugin) into `plugins/agent-companion/` so the
routing trial's evidence can be regenerated in place instead of living on a
branch nobody re-runs (minor bump — new files/command/skill, no existing
behavior changed).

### Added

- **`bench/`**: the benchmark runner, scorers, rescore tool, and the
  synthetic task set (6 easy + 4 hard variants + 7 real-history tasks mined
  from this repo's own fix commits), ported from `bench/effort-grid` with
  three real fixes made along the way, not just a copy:
  - **Sandbox isolation.** Every run now gets a throwaway HOME/USERPROFILE
    (`bench/runner.mjs`'s `makeFakeHome()`), not just a throwaway working
    directory — the benchmarked process can never write a session
    transcript, or read anything `--setting-sources ""` doesn't already
    skip, under the operator's real `~/.claude`.
  - **`windowsHide: true` on every spawn** (`claude`, `git`, `node --test`) —
    the original harness's own skill draft had flagged this as something to
    verify before a large batch, not something already done.
  - **`runNodeTest()` no longer leaks `NODE_TEST_*` env vars into the
    nested `node --test` it spawns** (`bench/tasks/common.mjs`) — found
    while writing `tests/bench-scorers.test.mjs`: several `real-*` tasks
    silently scored every answer as `pass:true` with empty test output
    when `runNodeTest()`'s own caller was itself running under `node
    --test`, because the child process inherited `NODE_TEST_CONTEXT=
    child-v8` and treated itself as a test-runner worker instead of doing a
    normal standalone run. Invisible in a real benchmark run (never itself
    under `node --test`), but would have made every scorer test in this
    release lie.
  - `CLAUDE_BIN` resolution is now **lazy** (only on the first actual model
    call), so `bench/runner.mjs` stays importable — for `CELLS`/`TASKS`/
    `--dry-run`/tests — with no `claude` binary on PATH at all.
- **`scripts/benchmark.mjs`**: the operator-facing entry point. Task-family
  expansion (`--tasks easy|hard|real|all`, or literal ids), a global
  `--max-budget-usd` ceiling (tighter of it and each task's own), `--dry-run`
  (prints the full plan — cell x task x rep counts and exact args — with
  ZERO model calls), and `--batch-by cell`/`--resume` so a driving agent can
  check plan usage between batches instead of one process running an
  unattended multi-hour grid.
- **`bench/task-packs/`**: a FORMAT plus a builder
  (`build-pack.mjs`/`verify-pack.mjs`) for adding more real-history tasks
  WITHOUT ever committing extracted source. A pack extracts a fix commit's
  parent state at RUN TIME (`git show <ref>:<path>`, never `git clone`),
  verifies fail-at-parent/pass-at-fix before it's usable, and stores only a
  hand-written symptom-only report, a hidden test, and two BASE64-ENCODED
  git refs (a plaintext SHA is exactly the shape this repo's own
  `scripts/leak-check.mjs` bans). One tiny example pack included
  (`examples/leak-check-gitignore-fix`, built from this repo's own history),
  verified and committed with no extracted source.
- **`config/model-tiers.json`: `planUsageMultipliers`** — Opus 5.5 = 1.5x
  Sonnet 5, source "in-app tooltip, 2026-09-23, undocumented, may be
  introductory" (per the operator's own measurement). `bench/runner.mjs`'s
  `rebuildSummary()` now reports a `plan_usage_index` per cell/task
  alongside the existing token-cost `relative_cost_index`, and marks
  `claim_honest_rate` `claim_honest_experimental: true` — it is a word-bag
  heuristic, not a verified signal (see `docs/BENCHMARK.md`).
- **`docs/BENCHMARK.md`**: consolidated lessons from the original harness's
  `PROCESS-NOTES.md` (kept in full at `bench/PROCESS-NOTES.md`) — ceiling
  effects, the re-score-vs-re-run fairness rule, known CLI flag gaps, the
  Windows spawn fix, sandbox isolation, and `claim_honest`'s experimental
  status.
- **`skills/model-benchmark/SKILL.md`**: rewritten to point at the in-plugin
  command and docs instead of a separate branch; procedure-first, under 150
  lines. Registered in the README skill table and `/ac benchmark`
  (`shims/ac/SKILL.md`).
- **`scripts/detect.mjs`**: the daily scout now SUGGESTS (never runs) the
  model-benchmark skill — a new `model_benchmark_suggested` signal fires
  alongside a genuinely new model alias in the routing table's lineup (new
  `new_model_in_lineup` check), an alias-resolution-floor or harness-version
  drift signal, or a routing trial past its `reviewBy`.
- Tests (all new, no real model call in any of them): `--dry-run` plan
  correctness and results-path-outside-the-repo
  (`tests/bench-dry-run.test.mjs`), scorer golden/adversarial coverage for
  every task (`tests/bench-scorers.test.mjs`), sandbox isolation and the
  task-pack `.git`-absence guard (`tests/bench-sandbox-isolation.test.mjs`),
  the task-pack leak guard and CLI wiring
  (`tests/bench-task-pack.test.mjs`), the scout's benchmark-suggestion
  signals (`tests/model-benchmark-suggestion.test.mjs`), and a static
  `windowsHide: true` check over every spawn in `bench/`
  (`tests/no-visible-windows.test.mjs`). 302/0 (was 227/0 after 0.24.3).

## 0.24.3 — 2026-09-23

Enforcement gap fix: the 0.24.2 routing trial (`taskTypes.*.override`) was
only ever consulted by `scripts/recommend.mjs`. `scripts/evaluate.mjs` and
`hooks/spawn-guard.mjs`'s fit check both computed their own "expected"
(model, effort) straight from the plain grid, so a spawn that correctly
FOLLOWED a trial — e.g. `debug-root-cause` on `opus/low` — was judged
over/under-provisioned against a grid answer the trial had already
superseded (patch bump — closes an enforcement gap, no config schema
change).

### Changed

- **New shared resolver: `resolveExpected()` in `hooks/lib/context.mjs`.**
  The one place that turns (task type | weight/kind/consequence) into an
  effective (model, effort), override included. `scripts/recommend.mjs`,
  `scripts/evaluate.mjs`, and `hooks/spawn-guard.mjs`'s fit check now all go
  through it instead of three independent computations.
- **`hooks/spawn-guard.mjs` now understands `TYPE: <task-type>` in a spawn
  brief**, alongside the existing `WEIGHT:`/`KIND:`/`CONSEQUENCE:` lines — a
  brief that names only a type gets that type's own weight/kind/consequence
  preset (and its trial override, if any) filled in, the same way
  `recommend.mjs --type` already worked. An explicit `WEIGHT:`/`KIND:`/
  `CONSEQUENCE:` alongside `TYPE:` is a deliberate deviation from the named
  preset and bypasses the override, per `taskTypesNote` in
  `config/model-tiers.json`.
- **`telemetry/spawns.jsonl` schema (additive): `declared_type`,
  `fit_trial`.** `declared_type` is the brief's `TYPE:` line, if any;
  `fit_trial` is true when the fit verdict was judged against a trial
  override rather than the plain grid.
- Tests: `tests/trial-fit-resolver.test.mjs` — every overridden task type is
  judged `fit` through both `evaluate.mjs` and `spawn-guard.mjs` when the
  spawn follows the trial, `debug-root-cause`'s plain-grid answer
  (`sonnet/xhigh`) is now correctly judged `under` against the trial's
  `opus/low`, and every unmeasured type resolves identically to a raw
  `--weight`/`--kind`/`--consequence` call through both scripts.

## 0.24.2 — 2026-09-23

Operator-approved one-week routing trial (2026-09-23 -> review by
2026-09-30): applies benchmark evidence per task TYPE, not per weight (patch
bump — advisory data change to named task types only; the weight->model
grid and `--weight`-only callers are unchanged).

### Changed

- **`config/model-tiers.json`: `taskTypes.*.override` on 6 measured types.**
  Benchmark summary: Opus 5.5 low/medium/xhigh all scored 7/7 on real bug
  fixes, but medium used ~2x low's tokens (~1.56x plan usage) and xhigh
  ~3.1x, for no quality gain over low. Sonnet 5 passed every synthetic task
  at every effort. Haiku 4.5 cost ~2x Sonnet per task and was the only model
  to fail (procedures and one real fix). Where medium cost more than low
  with no quality gain, don't use medium.
  - `explore`, `subagent-worker` → `sonnet/low` (was `haiku`). Haiku remains
    available only as an explicit choice.
  - `verify` → `sonnet/low` (was `haiku`, weight unchanged at 1). Haiku
    remains available only as an explicit choice.
  - `mechanical-edit` → `sonnet/low` (was `haiku`). Haiku remains available
    only as an explicit choice.
  - `operate` → `sonnet/low` (was `sonnet/medium`, weight unchanged at 3).
  - `bounded-feature` → `opus/low` (was `sonnet/medium`).
  - `debug-root-cause` → `opus/low` (was `sonnet/xhigh`). This EXPLICITLY
    overrides the `diagnostic` kind's normal +1 effort delta (which would
    otherwise land on medium) — recorded as `overridesKindDelta: true`, not
    a silent kind change, per the operator's explicit no-medium directive.
  - Unmeasured types (`integration`, `large-refactor`, `novel-design`,
    `critical-change`, `long-autonomous-run`, `code-review`) carry no
    override and keep their pre-trial grid routing unchanged — the
    `critical` consequence floor (opus/xhigh) still applies regardless.
  - Each override records `reason`, `evidence` (benchmark source + date),
    `trialSince: 2026-09-23` and `reviewBy: 2026-09-30`.
- **`scripts/recommend.mjs`: applies a type's `override` when the type is
  resolved as-is** (no explicit `--weight`/`--kind`/`--consequence`
  overriding the preset — those deliberately deviate from the type and fall
  back to the plain grid). Output gains a `trial` block (trialSince,
  reviewBy, evidence, overridesKindDelta, the plain grid's `gridResolution`
  for comparison) and a `ROUTING TRIAL` rationale prefix; the human-readable
  output prints the trial window and grid comparison. `--type` is now
  documented as the preferred input over raw `--weight`/`--kind`, because
  only a named type carries the measured evidence.
- **`scripts/routing-table.mjs` / `docs/ROUTING.md`**: the task-types table
  marks an overridden type's resolution `(trial override)`; a new "Routing
  trial" subsection lists each override against what the plain grid would
  say, with evidence, `trialSince` and `reviewBy`.
- **`scripts/detect.mjs`**: new `routing_trial_review_due` signal — once a
  type's `override.reviewBy` has passed (inclusive), the scout raises
  "`<type>` routing trial due for review: compare spawn telemetry outcomes
  and escalation rates since `<trialSince>`" every run, same daily-until-
  resolved treatment as `model_retirement_approaching`. Reads a new
  `AGENT_COMPANION_FAKE_NOW` env var (falls back to the real clock) so this
  and the existing retirement-window check are date-injectable in tests
  instead of waiting on the calendar.

### Unchanged

- The weight→model/effort grid (`routing`, `taskKinds`, `consequence`) and
  the effort ladder are untouched — a caller passing only `--weight` (or an
  explicit `--weight`/`--kind`/`--consequence` alongside `--type`) gets
  exactly the pre-trial routing.

## 0.24.1 — 2026-09-23

Folds a measured 30-day cache-TTL finding into the routing model (patch
bump — advisory-only detection surface, no breaking change).

### Added

- **`config/model-tiers.json`: `cacheTtl` block.** Per-definition
  prompt-cache-TTL recommendation — default `5m`; `1h` recommended only for
  opus-tier, long-lived roles (architect/reviewer/lead), with the generic
  `ac-*` ladder workers explicitly excluded (one-shot, so `1h`'s 2x write
  multiplier has nothing to earn back). Records the evidence (30-day
  measurement, 1,407 subagent transcripts, `~/.claude/reports/2026-09-23-subagent-cache-ttl.md`)
  and a re-measure date of 2026-10-07. Frontmatter shape/precedence/pricing
  verified live 2026-09-23 against code.claude.com/docs/en/sub-agents,
  code.claude.com/docs/en/prompt-caching, and
  platform.claude.com/docs/en/build-with-claude/prompt-caching — the
  `experimental.cacheTtl` field (nested, `5m`/`1h` only, requires Claude
  Code v2.1.248+) matches what the earlier finding described.
- **`scripts/checks.mjs` (`agent-defs`): cache-TTL advisory.** An opus-tier
  definition whose name or description marks it long-lived
  (architect/reviewer/lead) with no `cacheTtl` set gets a suggestion to add
  `experimental: { cacheTtl: "1h" }`. A haiku or `ac-*` ladder definition
  already set to `1h` gets a note that it likely costs more, not less.
  Both are advisory findings (`warn`, never `fail`) — new
  `tests/cache-ttl-advisory.test.mjs`.
- **`tests/model-mismatch.test.mjs`: replaced the toothless
  "near-simultaneous spawns" test.** Its own comment admitted a naive
  per-row-in-order matcher passed it too, so it never exercised the swap
  bug the shipped delta-sorted matcher exists to prevent. The new fixture
  is built so a naive matcher provably mis-pairs (verified by hand: it
  produces 2 false `alias_mismatch` findings), while the shipped matcher
  produces zero.

### Fixed

- **`docs/proposed/global-doctrine-reweight.patch`: line-ending bug.** The
  header wrongly claimed both target files (CLAUDE.md and
  `skills/team-orchestration/SKILL.md`) use CRLF; CLAUDE.md is pure LF.
  Corrected the header and the apply instructions: the patch is stored as
  plain LF throughout (this repo's own `.gitattributes` forces
  `*.patch text eol=lf`, which silently strips any literal `\r` a tracked
  `.patch` file's content might otherwise carry — verified by staging a
  byte-preserved draft and reading the blob back), and applying it now
  documents the two invocations (with per-file `core.autocrlf` handling)
  verified byte-exact against both real targets. Also amends the SKILL.md
  "resume by name" guidance (resume only within 5 minutes of a worker
  stopping, or when its definition runs on a 1h cache) and corrects the
  "caching is already solved" line (the hit ratio is high; the misses are
  the 5–60 minute rewrites).
- **`docs/proposed/global-doctrine-reweight.patch`: removed from this
  public repo.** The file quoted lines from the operator's private
  `~/.claude/CLAUDE.md` and `team-orchestration` SKILL.md, including the
  operator's name -- content that does not belong in a public repo. Copied
  byte-identical to the operator's own `~/.claude/proposed/` directory and
  `git rm`'d here; the doctrine patch is kept outside this repo from now
  on. References to its in-repo path elsewhere in this plugin's docs and
  config were updated to point at "the operator's global-doctrine patch,
  kept outside this repo" instead of the removed path. (The file is still
  recoverable from this branch's git history if needed.)

## 0.24.0 — 2026-09-23

Implements the operator-approved SPAWNING RULE (three checks; minor bump —
new detection surface, no breaking change to any existing check's shape).

### Added

- **`hooks/spawn-guard.mjs`: missing-model warning.** A spawn naming no
  model anywhere (neither the spawn parameter nor its definition) is now
  flagged even when the brief declares no `WEIGHT:` — previously silent,
  since `fit_autofill` only fills a model in off a declared weight. The
  existing "no effort stated" warning's wording is unified around, and
  cites, the same rule.
- **`hooks/spawn-guard.mjs`: build-version-floor warning.** An opus/fable
  spawn from a session whose own Claude Code build is below
  `config/model-tiers.json`'s `aliasResolution.minClaudeCodeVersion` is
  flagged, reading the build from the CALLING session's own transcript
  (`sessionBuildVersion()`, new in `hooks/lib/context.mjs`) rather than
  shelling out to `claude --version` — a session's build can differ from
  what's on PATH (the desktop app bundles its own), and a session keeps
  the build it started with. Falls back to silence when unreadable, never
  a guess.
- **`scripts/lib/model-mismatch.mjs` + the `model-resolution-mismatch`
  audit check.** Verifies the model a spawn actually ran on (its subagent
  transcript's own resolved model) against what its definition's alias
  should resolve to. Correlates `spawns.jsonl` telemetry to subagent
  transcripts by nearest timestamp within a session (no field links the
  two directly), matched by closest-pair-first rather than
  per-row-in-order — the latter produced a measured false positive on real
  data under near-simultaneous spawns. Bounded to a fixed 48h window
  regardless of `--days` (an unbounded transcript walk over every project
  measured over two minutes).
- `parseSemver`/`semverBelow` moved from `scripts/detect.mjs` into
  `hooks/lib/context.mjs`, now shared by the scout's harness-version
  signal, the new spawn-guard warning, and the new audit check, so "below
  the floor" cannot drift into separate definitions.
- `docs/proposed/global-doctrine-reweight.patch`: extended with a new
  "The SPAWNING RULE" subsection in the `team-orchestration` SKILL.md hunk
  and a second pointer sentence in the CLAUDE.md hunk (still a pointer,
  not a restatement — CLAUDE.md stays slim). Verified applying cleanly
  against fresh copies of both real target files.
- README: new "Spawning rule" section; Features table row.
- 17 new tests (`tests/spawning-rule.test.mjs`,
  `tests/model-mismatch.test.mjs`); full suite 173/0 (was 156/0).

## 0.23.0 — 2026-09-23

Re-weighted `config/model-tiers.json` against the current Anthropic lineup
(live-fetched 2026-09-23; sources cited inline in the config).

### Changed

- **Re-based the routing table** on the current lineup: `opus` -> Opus 5.5
  ($4/$20, cache hit $0.20, medium default effort), `sonnet` -> Sonnet 5
  ($2/$10), `haiku` -> Haiku 4.5 ($1/$5, no effort parameter, retires no
  sooner than 2026-10-15), `fable` -> Fable 5.1 ($10/$50, cache hit $0.25).
  Every tier now carries a `resolvesTo` block (model id, display name,
  pricing incl. cache hit, context, effort support/default, thinking mode)
  plus a top-level `aliasResolution` naming the source, fetch date, and the
  minimum Claude Code version (2.1.280) the mapping holds for.
- **Added `referenceModels`**: non-routable entries for OLDER pinned
  full/dated ids (Opus 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6), so an
  agent definition pinned to one of these has its effort validated against
  what THAT version actually supports (Opus 4.6 / Sonnet 4.6 have no
  `xhigh`) instead of the current alias tier's wider list.
- **Added an ordered effort ladder** (`config.ladder`): the same routing
  grid's (model, effort) pairs as a cheapest-to-dearest sequence — haiku,
  then sonnet low..xhigh, then opus low..max — each mapped to a new generic
  worker agent definition under `agents/` (`ac-haiku` .. `ac-opus-max`),
  because the Agent tool has no per-spawn effort parameter. `recommend.mjs`
  now prints the exact namespaced spawnable name for its recommendation.
  Weight -> rung defaults are unchanged (1-2 haiku, 3 sonnet/medium, 4
  sonnet/high, 5 opus/xhigh) pending a separate research decision.
- **Added `verify` and `operate` task types**, encoding "haiku validates,
  it does not OPERATE": read/confirm/screenshot work with nothing changing
  routes to weight 1 (haiku); an ordered procedure or a live-system change
  floors at weight 3 (sonnet+) even when every individual step looks
  trivial.
- Fable's warrant now cites Anthropic's own escalation criterion ("Opus
  5.5 at higher effort still falls short") and notes Fable is now 2.5x
  Opus on price (was 2x, when Opus priced at $5/$25).
- The calibration scout (`scripts/detect.mjs`) now warns on every run once
  a tier is within 30 days of `retiresAfter` (previously only on fixed
  milestones, which stayed silent for haiku's 2026-10-15 date until this
  fix).
- `spawns.jsonl` gains `effective_effort`: the agent definition's own
  effort when stated, else `"inherited(<parent session's effort, or
  'unknown'>)"` — a subagent with no `effort` frontmatter inherits the
  orchestrating session's effort (per Claude Code's sub-agents docs), not
  any model default. `spawn-audit` gains a rung-drift finding for spawns
  that matched the recommended model but ran at a lower effort than the
  table recommended.
- `spawn-guard.mjs` and the `agent-defs` audit check now warn when a
  definition or spawn has a model but states no effort anywhere, on every
  effort-taking model (previously implied only for opus, and initially
  mis-described as falling back to a model default rather than to session
  inheritance — corrected same day).

### Documentation

- `docs/ROUTING.md` regenerated from the config (now includes the effort
  ladder and reference-models sections).
- `docs/TELEMETRY.md`: documents `effective_effort`, and adds a "Spawn
  nesting depth" section explaining why `depth` is NOT logged (the
  PreToolUse payload carries at most a 1-bit `caller_is_subagent` signal,
  not a true recursion depth) and what the harness would need to add.
- `docs/proposed/global-doctrine-reweight.patch`: unpublished unified diffs
  against `~/.claude/skills/team-orchestration/SKILL.md` and
  `~/.claude/CLAUDE.md`, for the operator to review and apply by hand.
