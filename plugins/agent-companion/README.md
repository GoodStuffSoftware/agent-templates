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
| `delegation_guard` | Fires when the **main thread** makes `delegation_threshold` (default 4) execution-class calls in a row (`Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `Read`, `Grep`, `Glob`) with no delegation in between; an `Agent` spawn or `SendMessage` that runs resets the count, and so does every firing. `"off"` (also `"none"`, `"disabled"`); `"warn"` (default): the guard does not stop the call, and the model is told to delegate; `"block"`: the call is denied, and repeating it once runs it. The message names the next step: an `Agent` spawn of a ladder rung the routing table names, backgrounded, with a `TYPE:` line. Never counts or blocks a subagent's calls, and never blocks `Agent`, `SendMessage`, `ToolSearch`, `AskUserQuestion`, `TaskStop` or any `mcp__` tool. `delegation_guard_scope`: `"attended"` (default) leaves headless sessions (`claude -p`, SDK, woken or dispatched workers) alone; `"all"` counts them too. Legacy `true`/`false` read as `"warn"`/`"off"`. See [Delegation guard](#delegation-guard). | only in `block` |
| `premium_cap` | Caps concurrent premium-tier subagents at `premium_max_concurrent`. Counted: fable always (whatever pins it); `ac-opus-max`; another plugin's agent whose definition pins opus; a definition named like a built-in type (a project `general-purpose.md` pinning opus); and opus that nobody routed — set on a built-in type (general-purpose, Explore, Plan) with no `TYPE:` or `WEIGHT:`, or with a `TYPE:` that routes nothing (a built-in reviewer above its writer's model included). Not counted, because the model was the operator's or the table's choice: a spawn whose route names its model (e.g. a trial routing to opus, which also needs no warrant), an `ac-opus-*` ladder rung below `ac-opus-max` with or without a `TYPE:` line, a project agent (`.claude/agents/`) or user agent (`~/.claude/agents/`) whose definition pins opus, and a reviewer on its parity route (its `WRITER:`'s model after the floors). A model inherited from the lead is unknown at spawn time and is not counted (see `inherit_guard`). The deny says how to route the spawn instead. Only spawns that start count for the full 10-minute window; one that never starts (the harness rejected it) stops counting after 3 minutes. | yes, at the cap |
| `inherit_guard` | A spawn that names no model, on a definition that states neither model nor effort, runs on the lead's own model AND effort. `"warn"` (default): one note naming the lead's pair and the line to add. `"block"`: deny it when the lead is on a premium tier (opus, fable, mythos) and the brief has no `WEIGHT:` line and no `TYPE:` the table knows (an unknown `TYPE:` routes nothing, so it does not lift the block); the deny says to add `TYPE: <task type>` or spawn a ladder rung. Block also stops un-TYPEd Explore, Plan and claude-code-guide spawns from such a lead. A lead whose model cannot be read or classified is never blocked. | only in `block` |
| `warrant_required` | Premium spawns must carry a `WARRANT:` line stating task weight and why a cheaper tier will not do. | yes |
| `memory_budget` | Warns when always-loaded instruction files exceed `memory_budget_tokens`, and writes a ready-to-run refactor prompt. | no |
| `memory_doctor` | Detects memory files on disk that the index does not link — **unreachable rules** — plus broken index links. Repairs non-destructively. | no |
| `spawn_telemetry` | Records every spawn (model, agent type, effort) for the calibration routine. | no |
| `scout_surface` | At session start, surfaces unresolved signals from the last locally scheduled scout run. Silent on a quiet day. | no |
| `ci_status_signal` | Detects a repo's default branch sitting on a red (failure/cancelled/timed_out) latest completed workflow run, via `gh`. Suggestion-only — never re-runs, cancels, or fixes anything. Surfaced two ways: a `main_ci_red` signal in the daily scout (repo, workflow name(s), "red since" timestamp, failing run URL(s)), and a one-line SessionStart note ("main CI red since ...") read from a 10-minute cache only — the SessionStart path never calls `gh` or the network itself. Silent when `gh` is missing, unauthenticated, or offline. Scope: the current project's own repo, plus any repo already confirmed public by `publication_leak_sweep` — see [Main-branch CI status](#main-branch-ci-status) for why. | no |
| `version_notice` | At session start and on the next prompt, says once per (plugin, lastUpdated) pair when ANY installed plugin — not just this one — was updated after this session last loaded its plugins (session start, or the last `/reload-plugins`), catching a stale parent (and everything it spawns) mid-session, not just at startup. Also keeps this plugin's own running-vs-installed self-check, merged into the same notice when both fire, for the one case timestamps alone miss: a desktop session that loaded a stale app-extracted bundle at startup. Updating itself is the harness's job: the native autoupdater in terminal sessions, the built-in `plugin update` commands run by the daily local scout in desktop sessions. Install the global hook (see below) to run this checker itself from a fixed path that is never stale. | no |
| `fit_guard` | Best fit at the spawn, both directions. A brief that declares `WEIGHT:` gets its model graded against the routing table: under- and cheap-over-provisioned spawns are announced; a premium model over-provisioned for its own declared weight is denied with the correction. A review brief names the writer it gates on a `WRITER:` line — `WRITER: <model>/<effort>` (also `opus xhigh`, `opus at xhigh`, `Opus 5.5 xhigh`) or `WRITER: <agent-name>`, e.g. `TYPE: code-review` + `WRITER: opus/xhigh` — and the reviewer is judged for parity with it (below, above, or an inherited effort it cannot verify), in notes only. The line is read only on a parity-sized `TYPE:` (`code-review`); a missing or unreadable effort is said in a note, and parity is then checked on the model alone. When a **subagent** spawns a review with no `WRITER:` line, the writer is taken from the caller's own definition (its `agent_type` -> the agent file's `model`/`effort`), and a note says so. Nothing is inferred for a built-in or missing caller type, for `model: inherit`, or when the caller's own transcript shows it running on a different model than its definition (a model set on its spawn); a definition with no effort takes the effort the caller runs at, and a `WRITER:` line always wins. A [self-reviewing](#self-review-architect-class-writers) writer that names a `WRITER:` below its own pair gets a note, and a critical-change writer's review is floored by F1. A self-reviewing type on a ladder rung without the protocol gets the protocol appended to its brief; on a built-in type, a note. | premium-over only (never on parity) |
| `review_recursion_guard` | Reviewers never spawn reviewers. A parity-sized review (`TYPE: code-review`) spawned by a subagent is denied when that subagent's own spawn row in `spawns.jsonl` is itself a review — found by the id of the `Agent` call that started it (the harness's `subagents/agent-<id>.meta.json` names it; rows record it as `tool_use_id`). Anything short of that positive match — no sidecar, no id, no row, a row from another session, rows that disagree — allows. It looks one level up only, and a reviewer's other spawns (a search, a check) are not affected. The rows are its only input, so it does nothing while `spawn_telemetry` is off, and it relies on that harness sidecar: if the harness renames it, every lookup reads unknown and nothing is denied (`caller_row_found` goes false on every row). Default on. See [Self-review](#self-review-architect-class-writers). | yes, on a positive match |
| `fit_autofill` | A spawn that declares `WEIGHT:` but names no model gets the table's model filled in, instead of inheriting the lead's tier by accident. | no |
| `routing_profile` | Routes a declared `TYPE:` through **your** routing profile ahead of the shipped table (see [Routing profile](#routing-profile)). The kill switch: off means only the shipped table routes, from the next hook invocation, and the file is left untouched. On by default because the file exists only once you write a row. | no |
| *(spawning rule)* | Three operator-approved checks, always on (not a togglable option, same as the no-effort-stated warning below): a spawn naming no model anywhere is flagged even with no `WEIGHT:` declared; an opus/fable spawn from a session on a Claude Code build below the alias-resolution floor is flagged; the audit separately verifies the RESOLVED model against what ran. See [Spawning rule](#spawning-rule-operator-approved-2026-09-23). | no |
| `runaway_turns`, `runaway_usd` | Runaway-spawn flag. When a subagent finishes, its transcript is read (bounded: the last 8 MB, assistant records only) and its API turns counted and priced at list price. Over `runaway_turns` (default 300) or `runaway_usd` (default $40, price-derived, not a bill) it writes one row to `runaway.jsonl` beside `spawns.jsonl` and queues a one-line notice for the lead, delivered once to the lead: on its next prompt, which includes the turn that reports a background worker done, or right after a foreground `Agent` call returns (PostToolUse). A SubagentStop hook's own output is not relied on to reach the lead. Set either to 0 to turn that half off. | no |
| `session_budget_units` | Session budget advisory (default **350**; 0 turns it off). Adds up the plan units this WHOLE session has used, the lead plus every subagent: tokens priced at Sonnet 5 rates times the model's plan multiplier (the same `planPriceSpecFor` the compaction advisor uses, Opus 1.5; a tier with no measured multiplier is counted at its own API list price). It reads only the bytes appended to each transcript since the last call, so it stays cheap. Each time the total crosses another multiple of the threshold, the lead gets ONE notice through the runaway-notice path (its next prompt, or right after a foreground `Agent` returns) saying how many units and what share of a ~1,900-unit week (`config/session-budget.json`), and asking it to finish the phase, update `SESSION-STATE.md` and offer the operator a hand-off to a fresh session, never mid-release or while agents are running. Advisory only: nothing is blocked or denied. A scan that has not yet caught up on a long history (it stops at a 2.5 s deadline and carries on at the next call) announces nothing until it is complete, so the first number is never an understatement. A forked or copied session carries its inherited history in its total, so its first prompt can announce the inherited level. Turns on a tier with no measured plan multiplier (haiku, fable) are counted at their own API list price and reported as `estimated_turns`. One row per crossing in `session-budget.jsonl`. | no |
| `subagent_context_notice_tokens` | Subagent context notice (default **300000**; 0 turns it off). A PreToolUse hook that runs inside every subagent reads that subagent's own context size from its latest request (input + cache read + cache write). When it passes the threshold, or the subagent has just compacted (a `compact_boundary` in its transcript), the subagent is told ONCE, mid-run, to finish the current step, return its results and say what is left so the lead can split it; a compaction is announced once per compaction. With `autoCompactWindow` at 200000 a worker compacts before it reaches 300000, so the compaction signal is the one that usually fires. At SubagentStop the lead gets a line next to the runaway flag, and a worker the mid-run hook never reached is read once more and recorded as caught only at stop. Rows in `subagent-context.jsonl`; the `budget_notices` scout signal counts both logs over 24 hours. Advisory only. One extra `node` start per tool call (the lead's exits at once). | no |
| `bash_tail` | Bash output tail (default **on**). A PreToolUse hook rewrites a known long-running Bash command (test, build, install) so its output goes to a file and only a short tail plus the file's path returns to context; the exit code is preserved exactly. See [Bash output tail](#bash-output-tail). `bash_tail_permission_modes` (default `bypassPermissions`; `any` lifts the limit) sets the permission modes it applies in. | no (rewrites the command, never denies it) |
| `git_brief` | **Trial.** Git brief (default **on**). A SessionStart hook and a SubagentStart hook add ONE line of git state to the agent's context (branch, ahead/behind origin's default branch, uncommitted files, worktree, last commit, unpushed) and name the refresh command, `scripts/git-brief.mjs [landed <sha\|branch>]`, so agents stop running `git status`/`fetch`/`rev-list` by hand. Off with `false` or `CLAUDE_PLUGIN_OPTION_GIT_BRIEF=0`. See [Git brief](#git-brief-trial). | no |
| `read_dedupe` | Read dedupe (default **on**). A PreToolUse hook denies a Read of lines the SAME agent already read, when the file is unchanged since and the read would return 2,000 characters or more; the denial is one sentence and the identical call, repeated, runs. See [Read dedupe](#read-dedupe). | yes, on a covered repeat (never twice in a row) |
| `pr_wait` | PR/CI wait hint (default **on**; `CLAUDE_PLUGIN_OPTION_PR_WAIT=0` turns it off). One standing session-start line (the `pr-wait-hint` rule) pointing agents at `scripts/pr-wait.mjs`, see "PR and CI wait" below. Off hides only that line (as does `standing_rules: false`); the script still runs and still logs telemetry. |
| `brevity` | Appends a short reporting contract to every spawned agent's brief — status line, blockers in full, outcome as facts, no narration — plus a peer-brevity clause on inter-agent messages. | no (an opt-in sub-toggle can block once per agent) |
| `standing_rules` | Injects operator-authored "always do X if Y" rules at session start, on matching prompts, and into matching spawn briefs. | no |
| `memory_vault` | Keeps a local git history of the memory corpus in a separate repository, so a rewrite or truncation is no longer unrecoverable. Strictly read-only against the live corpus. **Off by default** — see [Memory vault](#memory-vault). | no |
| `capacity_probe` | At session start, a one-line estimate of how many concurrent Claude Code SESSIONS this machine can carry right now (free memory / cpu count -> a concurrency budget and an idle-teammates-ok vs stop-between-rounds policy). Counts OS-level session processes (excludes the desktop app); in-process subagents/teammates share their parent session's process rather than counting separately. Read-only, cheap, wrapped so a slow or failing probe never blocks the hook. `scripts/capacity.mjs` also runs standalone (`--text`, `--per-agent-mb`, `--headroom-gb`, `--threshold`). | no |

Premium tiers are **capped and audited, never banned**. The failure mode was
unexamined defaults, not the model itself.

## Delegation guard

`delegation_guard` enforces "the main session delegates" at the tool call rather than in a document. It counts the main thread's execution-class calls (`Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `Read`, `Grep`, `Glob`); an `Agent` spawn or a `SendMessage` that actually runs (PostToolUse, so a spawn another guard denied does not count) ends the streak. When a call brings the streak to `delegation_threshold` (default 4, minimum 2) the guard fires and the streak restarts at 0:

- `"warn"` (the shipped default): the guard does not stop the call, and the model receives the instructions as `additionalContext`. The guard decides nothing on the call, so the normal permission prompt still applies.
- `"block"`: the call is denied with the same instructions. They state the streak and the threshold, and the next step: spawn a ladder rung with the `Agent` tool (`subagent_type` set to the rung the routing table names for `subagent-worker`, or whichever rung it names for the task type, with `run_in_background: true` and `TYPE: <task type>` on its own line in the brief). They warn against a model-less general-purpose, Explore or Plan spawn, which `inherit_guard: block` refuses from a premium lead.
- `"off"` (also spelled `"none"`, `"disabled"`, or the legacy `false`): nothing is counted.

The escape hatch is the restart itself: a lead that genuinely needs one more read on the main thread repeats the denied call, and it runs as call 1 of a new streak. So block is a speed bump every `delegation_threshold` calls, not a wall. Never counted or blocked: any call from inside a subagent, and `Agent`, `SendMessage`, `ToolSearch`, `AskUserQuestion`, `TaskStop`, `TaskOutput` and every `mcp__` tool (an agent bus's messaging and task-board tools included), so a stopped lead can always delegate, message a worker and ask the operator. Every firing increments `fired` in `state/delegation-streak.json`, which makes the [`delegate-reminder`](#delegate-reminder--the-direct-answer-to-my-delegation-rules-stop-being-followed) standing rule due on the next prompt (once per firing), and writes a `denials.jsonl` row (`outcome: "deny"` or `"warn"`).

`delegation_guard_scope` decides which main threads count. Under `"attended"` (the default) a headless session is left alone: a `claude -p` run, an SDK program, a woken or dispatched worker, a background session, a separate-process teammate. It is the delegate, and doing the work itself is its job. Claude Code marks those sessions with `CLAUDE_CODE_SESSION_ATTENDED=0` in every hook's environment ("1" in an attended terminal, desktop or IDE session); the guard passes a call with exactly `"0"` through uncounted. The variable is undocumented, so an absent value counts, as it did before the option existed, and the guard records per session what it saw: if a day of counted calls saw it nowhere, the calibration scout's `attended_env_missing` signal fires, because the harness has stopped setting it and headless workers are being counted again. `"all"` counts every main thread, headless ones included.

Tool calls a remote session has this machine run (hook `session_id` `"served:<caller>"`) are never counted: they are not this machine's lead, and every unknown caller would share one streak.

Until this fix the guard required `agent_type === "main"`, which no real main-thread payload carries, so it never ran outside its own tests. Any mode that acts is therefore new behaviour on every install, which is why the shipped default is `"warn"`.

## Bash output tail

Every character a tool returns is re-read from the prompt cache on every later call of that agent, so a 3,000-line test run is paid for hundreds of times. `hooks/bash-tail.mjs` (PreToolUse on `Bash`, main thread and subagents) rewrites a **known long-runner** so the output goes to a file and only the tail comes back. Rules and the generated shell: `hooks/lib/bash-tail.mjs`. Decision record, with the alternatives it beat: [`docs/adr/0004-bash-output-tail.md`](../../docs/adr/0004-bash-output-tail.md).

- **Wrapped:** `npm`/`pnpm`/`yarn` test, ci, install and build scripts, `vitest`, `jest`, `pytest`, `cargo`, `go`, `dotnet`, `make`, `gradle`, `mvn`, `tsc`, `node --test`, `docker build`, and similar. Never a command the list does not name.
- **Never touched:** a command with a pipe, a redirect, `&`, a subshell, `$( )`, a compound statement (`if`, `for`, `while`), `source` / `.`, `run_in_background`, a watch flag (`-w`, `--watch`, `--ui`, `--continuous`), a machine-readable-output flag including the separate-argument forms (`--reporter json`, `-f json`, `--junitxml report.xml`), `--help`/`--version`; any `git` command; short commands that are not runners. Dev servers, watchers and interactive tools (`vite`, `next dev`, `wrangler dev|login`, `ng serve`, `playwright show-report|codegen`, `cypress open`, `pytest -f|--pdb`, `*:watch` scripts, `make run|serve|dev`, `bootRun`, `spring-boot:run`, and so on) are never wrapped, and a chain is left alone when ANY segment is one of those or is not a known runner (`npm install && npm run dev`, `cargo build && cargo run`).
- **What comes back:** before the command runs, one line names the output file (so a run killed by the tool timeout still tells the agent where its output went). Output of 80 lines / 8,000 bytes or less then prints whole (and the file is deleted). Above that: `[ac-bash-tail] exit N; L lines, B bytes of output; last K lines below. Full output (grep or Read it): <path>` and then the last 60 lines of a failed run or the last 20 of a passing one, capped at 10,000 characters (the END is kept, so one huge line shows its tail). A failed run also gets up to five summary-looking lines (`FAIL`, `failed`, `passed`, `Tests:`, `ERR!`, `SUMMARY`) from EARLIER in the file, for runners that print the summary first. stdout and stderr are merged, as they are in the tool's own result. Files live in `<tmp>/ac-bash-tail/` and are pruned after 3 days. The file is not size-capped (see the ADR).
- **Exit code and failures:** the command runs inside a `{ }` group (so `cd` still sticks) and its status is re-raised with `(exit N)`. If the output file cannot be created, or `set -e` (errexit) is already active in the shell, the original command runs unchanged.
- **Permission rules:** Claude Code checks permission rules against the REWRITTEN command in every mode. Allow rules (`Bash(npm test:*)`) stop matching it, so the rewrite applies only in `bypassPermissions` unless `bash_tail_permission_modes` says otherwise (`"any"`, or a comma list such as `"bypassPermissions,acceptEdits"`). Deny and ask rules apply even in `bypassPermissions` and match the helper commands the wrapper adds (`rm`, `tail`, `grep`, `printf`, and the redirect), so the hook reads `permissions.deny` and `permissions.ask` from user, project, local and managed settings and leaves the command alone when any rule could match the original or a helper (logged as `permission-rule:deny|ask`).
- **PowerShell** is out of scope: different syntax, and the `PowerShell` tool is not matched.
- **Opt out:** `bash_tail: false` (or `CLAUDE_PLUGIN_OPTION_BASH_TAIL=0`). A command can also opt itself out by piping or redirecting, for instance `npm test 2>&1 | cat`.
- **Measure it:** `node scripts/bash-tail-report.mjs [--days N] [--json]` reads `telemetry/bash-tail.jsonl` (see `docs/TELEMETRY.md`): runs wrapped, bytes produced vs characters returned, known runners left alone and why.

## Git brief (trial)

A 7-day transcript count (2026-09-27 to 10-04) found about 5,100 Bash calls that only READ git state, 882 of them `git fetch origin`, each costing a turn. `scripts/git-brief.mjs` answers them in one call, and a hook puts the answer in front of the agent before it asks.

- **The injected line** (SessionStart for the main session, at every source: startup, resume, clear, compact; SubagentStart for every subagent), about 250-450 characters depending on the path lengths:
  `Git: feat/x | ahead 2 behind 0 origin/main | uncommitted 3 | worktree C:/repo/wt | last <sha> chore: release 0.29.32 | unpushed 2 | refresh instead of git status/fetch: node "<plugin-root>/scripts/git-brief.mjs" [landed <sha|branch>]`
  A detached HEAD reads `detached@<sha>`; a repository with no `origin` reads `no origin`; a branch with no upstream reads `unpushed N (no upstream)` (commits no remote has). Outside a git repository, or on any error, nothing is injected and nothing printed.
- **The script:** `node scripts/git-brief.mjs` prints that line without the hint. `node scripts/git-brief.mjs landed <sha|branch>` prints one line: `ON main (<sha>)` (an ancestor of origin's default branch), `ON main (cherry-picked)` (every commit that is not an ancestor has a patch-equivalent on the default branch, the test `git cherry` applies, so a cherry-pick or a rebase merge counts as landed), `NOT on main (ahead N; a squash merge wouldn't show)` (N counts only the commits with no patch-equivalent there), or `UNKNOWN (no such ref X)` (also `UNKNOWN (git timed out)`: a timeout never turns into a NOT). A squash merge cannot be detected reliably (its one commit has a different patch), so the NOT answer says so. **`landed` always fetches first**: it is an explicit question, and a ref up to five minutes old answers it wrongly for a branch merged in that window. A NOT that rests on a failed fetch, or on no remote, says so in the line (`fetch failed; origin/main may be stale`, `local origin/main only`); an ON never needs the note. Flags: `--no-fetch` (local refs only), `--fresh` (accepted; `landed` fetches regardless), `--cwd <dir>`. The default branch is origin/HEAD, else `main`, else `master`.
- **Fetch policy:** only origin's default branch is fetched, at most once per **5 minutes** per repository (linked worktrees share the stamp, `<git-dir>/ac-git-brief-fetch.json`, so ten agents starting together cause one fetch), capped at **1.5 s** and killed past it, with no prompt of any kind (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, ssh `BatchMode`). The 5-minute window applies to the injected line only; `landed` ignores it. A timed-out fetch is killed with its whole process tree (on Windows `taskkill /T /F`; git's `git-remote-http` child would otherwise outlive the parent and keep the connection open), and a slow transfer is also cut by `GIT_HTTP_LOW_SPEED_LIMIT`/`TIME` (1000 B/s for 2 s). A failed or timed-out fetch is not retried for 1 minute, so an offline machine pays the cap once. Each local git call is capped at 1 s, and one run has an overall deadline (the two caps summed, `AC_GIT_BRIEF_DEADLINE_MS`); the whole run is about 0.3 s when the fetch is skipped and held near 2.5 s at worst. `AC_GIT_BRIEF_FETCH_TIMEOUT_MS` / `AC_GIT_BRIEF_LOCAL_TIMEOUT_MS` raise the caps on a slow machine.
- **Switch:** `git_brief` (default **on** for the trial). Off = `git_brief: false` in the plugin options, or `CLAUDE_PLUGIN_OPTION_GIT_BRIEF=0` in the environment: the hook then does nothing, with no git call, no output and no telemetry row. The script itself still works when called by name.
- **Measure it:** every hook injection and every script run appends a row to `telemetry/git-brief.jsonl` (fields in `docs/TELEMETRY.md`): characters injected or returned, whether a fetch ran and how it ended, the outcome (so "nothing to say" is told from "could not say"), time per git step, and for `landed` the answer and whether a NOT survived a fresh fetch. Compare the count of Bash git-read calls per agent with the switch on and off.
- **Not a duplicate of the coordination server's `branch_status` MCP tool:** it reports branch state across machines (and is a deferred tool plus a few KB of result). This reads only the repository the agent is in, locally, in about 100 bytes.

## Read dedupe

Agents re-read unchanged files: a 7-day measurement (2026-10-04) found 654 repeat reads of a file the same agent had already read and nothing had touched, 551 of them partial reads (`offset`/`limit`). Each repeat puts the same text in context again, and every later call of that agent re-reads it from the prompt cache. `hooks/read-dedupe.mjs` (PreToolUse on `Read`, main thread and subagents) denies a repeat that is already in the agent's context. Rules, state and the reasoning behind each threshold: `hooks/lib/read-dedupe.mjs`.

- **What Claude Code's own Read already covers:** it keeps ONE `offset`/`limit` pair per path and answers "File unchanged since last read" only when the new request is exactly that pair and the mtime is unchanged. This hook covers the rest: a range inside an earlier, larger read (read 1-400, then 120-180); a repeat of an earlier range after a different one (A, B, A); a range spanning two earlier adjacent reads. The exact repeat of the last read is left to the built-in.
- **When it denies** (every condition): same agent and same path; the requested lines are fully covered by earlier reads; mtime, size and ctime are unchanged; the earlier read is under 30 minutes old; and the read would return at least **2,000 characters** (estimated from that file's own average line plus the 7-character line prefix). 2,000 characters is about 500 tokens, ten times the denial's own text: below it the denial would cost about what it saves. A repeat read of more than that is paid again on every later turn, so the saving grows with every turn after it.
- **The denial:** `Unchanged since your earlier read (lines a-b). If that content is no longer in your context, repeat this call and it will run.` The same call, repeated, always runs: a denied request is remembered until it runs, so an agent is never trapped. Claude Code can drop OLD tool results from context without a compaction and without any hook; that sentence is the way out.
- **State is per agent:** keyed by session id plus agent id (`main` for the lead). A read by one agent never suppresses another's, and each (session, agent) pair has its own state file and lock, so parallel agents never wait on each other. Stored under `state/read-dedupe/`, pruned after 3 days.
- **What it remembers, and when it forgets:** a read is recorded only after it succeeds (PostToolUse): the lines the tool actually returned, the file's mtime, size and ctime from before the read. Forgotten on an `Edit`, `Write`, `NotebookEdit` or `MultiEdit` of that path by that agent; on any change of the file's mtime, size or ctime (so a Bash edit, a `git checkout` or another agent's edit all count, and so does a same-size edit that put the mtime back; the price is that a chmod or a rename-over also forgets, which only means one allowed read); on `PreCompact` and on `SessionStart` with source `compact` or `clear` (that agent only when the payload names a subagent, the whole session otherwise). A truncated or partial result, a PDF page read and a read of a file that changed while it ran are never recorded.
- **Fails open:** an unreadable or corrupt state file, a lock that cannot be taken (waits up to 0.8 s; a lock older than 3 s is taken over), a missing file or any error lets the read run. It prints a denial or nothing, never an allow. A lock that could not be taken writes a `lock-timeout` telemetry row, so a miss is counted rather than silent.
- **Opt out:** `read_dedupe: false` (or `CLAUDE_PLUGIN_OPTION_READ_DEDUPE=0` in the environment).
- **Measure it:** `telemetry/read-dedupe.jsonl` (see `docs/TELEMETRY.md`): a row per denial, per denied request that was repeated and ran, per repeat-eligible read that was allowed (with the reason, the denominator of the denial rate) and per lock timeout. A high retry share means agents mostly did NOT have the content in context and the threshold or age cap is too loose.

## PR and CI wait

Agents polling a PR or CI with `gh pr checks`, `gh run watch`, `gh pr view` and sleep loops pay for every poll: each result is re-read from the prompt cache for the rest of the session. `scripts/pr-wait.mjs` does the waiting inside a process, where it costs no tokens, and returns the final state in one call.

```
node scripts/pr-wait.mjs <pr-number|branch|url> [--repo owner/repo] [--timeout 20m]
node scripts/pr-wait.mjs --run <run-id|branch>  [--repo owner/repo] [--timeout 20m]
```

- **Output:** one start line, then nothing until the end, so it is safe to launch with `run_in_background`. The final line gives state, checks passed/failed/total and elapsed time; up to nine more lines name the failed checks with their log URLs (on a timeout, the checks still pending).
- **Exit codes:** 0 checks passed or PR merged; 1 a check failed, or the PR closed unmerged; 2 timeout (default 20m; `--timeout` takes `90s`, `20m`, `1h`); 3 usage or gh error. It never prompts; gh is polled with backoff (5s growing to 30s), and a transient gh failure is retried before it gives up.
- **Bound to the commit, not the branch:** PR mode reads the PR's current head commit and counts only that commit's check runs and statuses (re-read every poll, so a push made while waiting is followed); a head whose checks have not registered yet is waited on, never answered from the commit before. `--run <branch>` takes the newest run whose head SHA equals the branch's current remote tip and keeps waiting (within the timeout) while there is none, instead of returning the run before your push. A run id is used as given.
- **A PASS has to hold still (the settle rule):** a green result is not answered on the first poll that shows one. CI registers checks one after another, so a first poll can see only the quick check, finished and green, with the slow one not yet listed. The script reports PASS only when the same check set (head commit, check names and verdicts) is seen on two polls at least 20 s apart (`PR_WAIT_SETTLE_MS`); a check that registers meanwhile restarts the clock, and a failure is reported at once, with no settling. The final line carries the head commit it is bound to (`PASS @abcdefa`), so a PASS can be matched to the commit that was pushed.
- **Limits:** a PR with no checks at all returns `NO-CHECKS` (exit 0) after 90 seconds (`PR_WAIT_NO_CHECKS_GRACE_MS`); read it as "no CI was observed and nothing failed", not as a pass. Each PR poll is three `gh` calls (PR head, check runs, statuses), all inside the process. `not a git repository` and the other permanent gh errors stop at once (exit 3) instead of retrying.
- **Discoverability, and the trial toggle:** the plugin adds one standing line at session start, to the lead session (the `pr-wait-hint` rule), with the script's real absolute path and the advice that matters: launch it with `run_in_background`, because a foreground call dies at the two-minute limit. The wording is 125 characters or fewer; the whole line is longer by the length of the plugin path. `pr_wait: false` or `CLAUDE_PLUGIN_OPTION_PR_WAIT=0` hides that line, and so does `standing_rules: false` (the hint is a built-in standing rule, so the master switch removes it too); the script itself keeps working either way.
- **Measure it:** each run appends a `start` and an `end` row to `telemetry/pr-wait.jsonl` (mode, polls, cycles, settle waits, duration, outcome, exit code, head commit; see `docs/TELEMETRY.md`). A `start` with no `end` is a run the harness cut off. Compare the `gh` and sleep call counts in transcripts with the line on and off.

## Brevity — the reporting contract

The operator's token spend is dominated by subagents narrating their journey — tool-by-tool recaps, resolved dead ends, restatements of the brief — when the caller wanted a status line, blockers, and an outcome stated as fact. `brevity` appends a short reporting contract to every spawned agent's brief: STATUS (done/blocked/partial), blockers in full and never compressed, then the outcome as facts, with long output moved to a file instead of inlined. A separate peer-brevity clause covers agent-to-agent messages: one screen at most, no recap of context the recipient already has.

### Precedence, and why it is bidirectional

Three layers, most specific first:

| Layer | Set by | Beats |
|---|---|---|
| per-agent | `agents.<type>` in `config/brevity.json` | everything |
| runtime global | `global` in the same file | the plugin option |
| plugin option | `brevity` in settings | — |

The per-agent layer resolves in **both directions**: an override can force one agent type ON while the global switch is off, or force it OFF while the global switch is on. A switch that can only ever mute cannot express "brevity everywhere except the one agent type that still needs to narrate" — or its mirror, "brevity nowhere except this one noisy type."

### Three tie-in points

1. **Spawn time** (`hooks/spawn-guard.mjs`) — the primary path. The contract is appended to the brief the subagent actually receives, merged into the same `updatedInput` rewrite that fills in the routing table's model; spawn-guard owns the single `PreToolUse` response for the `Agent` matcher, so a second hook writing its own `updatedInput` would silently clobber this instead of adding to it.
2. **SubagentStart self-heal** (`hooks/subagent-brevity.mjs`) — checks the prompt the subagent actually received for the exact contract marker. If it is present, the spawn-time rewrite worked and nothing more happens; if it is missing — a different hook's rewrite won, or a stale plugin copy ran — it injects the contract as `additionalContext` instead. That marker check runs before the telemetry write below it, because injecting the same text twice would double the token cost of a feature whose only job is cutting it.
3. **SubagentStop telemetry** (`hooks/subagent-brevity.mjs`) — every stop appends one row to `telemetry/brevity.jsonl`: agent type, report length, whether the contract was on, whether it was gated. This is what makes "brevity made reports shorter" a checked claim rather than a believed one.

### Peer brevity is deliberately separate

`brevity_peer` stays on even when the reporting contract is off for a given agent, because succinct agent-to-agent messages were asked for unconditionally — exempting one noisy agent type from the reporting contract should not also license it to write long messages to its peers.

### The experimental stop gate

`brevity_stop_gate` is off by default. When on, a final report over `brevity_report_max_chars` gets one `SubagentStop` block decision, feeding the same subagent a request to restate it in the contract shape. It defaults off because that costs a full extra turn — the subagent re-reads its own report and rewrites it — and only pays off where reports are routinely enormous. It is hard-capped at one block per agent (an exclusive-create marker file, the same race-free dedup pattern used for unknown-agent-type tracking), so it can never loop even if the rewritten report is still judged too long.

Drive all of this from `/agent-companion:brevity` (`node scripts/brevity.mjs`) — the skill has the exact commands.

## Standing rules

A rule written into `CLAUDE.md` is read once, at the top of a session, and then competes with everything that follows it — the same adherence problem described above. A standing rule is instead re-injected by a hook exactly when its condition is met, so it arrives at the moment it is relevant instead of hours earlier and forgotten.

A rule is two independent conditions plus a directive:

- **`when`** — a regex tested against the *text* of what is happening: the user's prompt, or a spawn brief. Answers "is this turn about X?"
- **`gate`** — a *session state* check, independent of any text. Answers "is this session in a shape where the rule is worth its tokens?"

The split exists because some rules need to fire on content regardless of history (`copyable-prompt`), and at least one needs to fire on history regardless of content (`delegate-reminder`, below) — a single condition type cannot express both.

Four scopes, each deciding what `when` is tested against and where the directive lands:

| scope | `when` tested against | injected into |
|---|---|---|
| `user-prompt` | the prompt just submitted | the main session, that turn |
| `always` | *(ignored — fires every turn)* | the main session, every turn |
| `session-start` | *(ignored — fires once)* | the main session, at start |
| `spawn` | the brief of an agent being spawned | that subagent's prompt |

A `session-start` rule also reaches a subagent that compacts, because SessionStart fires inside it. A rule with `"audience": "lead"` stays out of that: six of the built-ins carry it (`lead-brevity`, `delegate-first`, `resume-doctrine`, `poll-guard-doctrine`, `pr-wait-hint`, `lead-effort-check`), since a worker cannot spawn, resume, arm a wake or ask the operator. A rule with no `audience` (every rule you add, unless you set it) reaches the lead and workers alike. The scout drift block, the main-CI note and the capacity line are lead-only in the same way.

Nine rules ship built in:

| id | scope | fires |
|---|---|---|
| `copyable-prompt` | `user-prompt` | the user asks for a prompt — puts the whole thing in one fenced block, commentary outside it |
| `lead-brevity` | `session-start` | every session, while brevity resolves on globally |
| `delegate-first` | `session-start` | every session — the orchestrator rules, restated where they are actually read |
| `resume-doctrine` | `session-start` | every session — resume a stopped worker only while its cache is warm; otherwise spawn fresh from a file handoff (enforced by `hooks/resume-guard.mjs`) |
| `delegate-reminder` | `always` | gated — see below |
| `agent-brevity` | `spawn` | disabled by default; reserved so the `spawn` scope shows up in `rules list` |
| `poll-guard-doctrine` | `session-start` | every session — cache-advisor guard (b): "one completion wait, never per-item wakes" (see `hooks/poll-guard.mjs`) |
| `pr-wait-hint` | `session-start` | every session, while `pr_wait` is on — one line pointing at `scripts/pr-wait.mjs` (see "PR and CI wait") |
| `lead-effort-check` | `session-start` | disabled by default. Turn on with `{"id":"lead-effort-check","enabled":true}`. When the session will orchestrate and its effort is below xhigh, asks the operator with the AskUserQuestion options selector ("Raise to xhigh (Recommended)" or "Stay at <current>"), with no spawn or other tool call until answered; "Raise" tells the operator to use the app's effort control and waits (the app refuses a session changing its own effort, so the lead does not set it itself). Unattended sessions (a `scheduledTaskId`, headless, no AskUserQuestion) are never asked: they continue and state the effort once. Never raises to max, never lowers |

### `delegate-reminder` — the direct answer to "my delegation rules stop being followed"

This is the only shipped `always`-scope rule, and it is gated on purpose: its `delegation-drift` gate is satisfied only once `delegation_guard` has actually caught this session running execution-class tool calls on the main thread. Until then it injects nothing — a session that never drifts pays nothing for it. After each firing it is injected once, on the next prompt, and is then silent until the guard fires again.

That behaviour is exactly what a document read once at session start cannot have. A written rule's influence only ever decays as more context piles on top of it; a hook-injected rule can instead be conditional on the session's own behaviour — silent when it is not needed, and reappearing exactly when it has been earned, each time the behaviour it is correcting recurs.

Drive this from `/agent-companion:standing-rules` (`node scripts/rules.mjs`) — the skill has `add`/`test`/`enable`/`disable`.

## Spawning rule (operator-approved 2026-09-23)

Three checks, warn-only (a false block stops legitimate work more than a bad spawn costs) — the same posture as every other guard here:

1. **Every spawn names a definition stating BOTH model and effort** (a ladder `ac-*` def or a project def). A spawn with no model, or a definition with no effort, inherits the lead's model and effort and counts as a violation. The "no effort stated" half already existed; `hooks/spawn-guard.mjs` now also warns on the "no model at all" half — previously silent whenever the brief declared no `WEIGHT:`, since `fit_autofill` (above) only fills a model in off a declared weight. That note covers both halves at once, naming the lead's own model and effort when its transcript shows them. The one opt-in exception to warn-only: `inherit_guard: block` denies the worst shape — model AND effort inherited from a premium-tier lead, with no `WEIGHT:` line and no `TYPE:` the table knows.
2. **Build check before opus/fable-tier work.** If the SESSION's own Claude Code build is below `config/model-tiers.json`'s `aliasResolution.minClaudeCodeVersion`, `hooks/spawn-guard.mjs` warns rather than letting the spawn pin around it. Read from the CALLING session's own transcript (`sessionBuildVersion()` in `hooks/lib/context.mjs`, a bounded tail-read of the `version` field every harness-written record carries) — never from `claude --version` (what the daily scout's `scripts/detect.mjs` check does for the harness-wide signal), because the desktop app bundles its own build separate from the CLI on PATH and a session keeps the build it started with. Falls back to silence, never a guess, when the transcript is unreadable.
3. **Verify the resolved model.** The model a spawn actually ran on (its subagent transcript's own last `type:"assistant"` record) must match what its definition's alias resolves to on that build. This cannot run at spawn time — the spawned agent's transcript does not exist yet — so it runs from the audit instead: `scripts/lib/model-mismatch.mjs` + the `model-resolution-mismatch` check (`node scripts/audit.mjs --only model-resolution-mismatch`). Correlates `spawns.jsonl` telemetry to subagent transcripts by nearest timestamp within a session (no field links the two directly — no agentId is known at spawn time), matched by closest-pair-first rather than per-row-in-order to avoid mismatching near-simultaneous spawns. Bounded to a fixed 48h window regardless of `--days` — an unbounded transcript walk over every project measured over two minutes.

## Lean ladder workers (0.31.0)

Every spawn pays for the tools, listings and instructions its agent definition leaves in. The ten `ac-*` rungs now carry a generated `disallowedTools` line (config `ladderTools`, written by `scripts/routing-table.mjs --sync-agent-descriptions`, checked as `tools-drift` by `--check-agent-descriptions`):

- Everywhere: `Artifact` (an exact tool name, so `ArtifactComments`, `ArtifactData` and `ArtifactCheck` are listed too), the desktop-only servers (`mcp__visualize`, `mcp__terminal`, `mcp__ccd_session`, `mcp__ccd_connectors`, `mcp__ccd_directory`, `mcp__ccd_pr`, `mcp__ccd_sidebar`, `mcp__ccd_view`, `mcp__ccd_window`) and `mcp__mcp-registry`. Chosen from 30 days of measured subagent use per server; a server a rung really uses stays (`mcp__ccd_session_mgmt` is kept on `ac-haiku`).
- The browser servers (`mcp__Claude_Browser`, `mcp__claude-in-chrome`, `mcp__computer-use`) on every rung. UI and browser work has its own ladder-routed path: **`ac-browser`** (sonnet/high) and **`ac-browser-opus`** (opus/medium), `config/model-tiers.json` `ladderVariants`. A variant is not a rung (no number, never an escalation target, never picked by routing), but every guard counts it as a ladder agent. `node scripts/recommend.mjs --type <task-type> --browser` names it; the delegation guard names it; the spawn guard does not swap a general-purpose spawn whose brief names the browser or Artifact for a rung, and notes a ladder spawn that does.
- No account-specific connector ids appear in the list. `disallowedTools` takes whole servers (`mcp__<server>`); the documented glob forms are `mcp__<server>__*` and `mcp__*`, and no `mcp__ccd_*` pattern is relied on.

The same release trims the rung bodies to one sentence and the generated listing descriptions to about 100 to 160 characters, delivers the reporting contract once (spawn guard to SubagentStart handoff: the SubagentStart payload carries no prompt, so the old marker check never matched), names long-detail files `<task>-detail.md` (Claude Code refuses a subagent Write to `report*`, `summary*`, `findings*` and `analysis*` `.md` names), and keeps the lead's SessionStart text out of a compacting subagent. `omitClaudeMd` was evaluated for the rungs and not applied: see `docs/lean-verification/README.txt` for how to verify the tool, deferred-name and instruction-block removal in a fresh session.

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

## Main-branch CI status

`ci_status_signal` (on by default) closes a specific gap: a repo's main
branch can sit red for hours before anyone notices, because the only signal
is a pile of GitHub Actions failure emails nobody reads until there are 60 of
them. This checks `gh`'s own view of each covered repo's default branch and
surfaces a red streak two ways — the daily scout, and a cheap SessionStart
note — never re-running, cancelling, or fixing anything.

**How a repo counts as red:** its default branch's *latest completed* run of
an *active* workflow concluded `failure`, `cancelled`, or `timed_out`. Green,
in progress, or no completed runs at all are all silent. The reported
"red since" timestamp is the oldest run in the current unbroken red streak,
within the last 30 completed runs fetched (a longer streak reports that
oldest-fetched run as a lower bound rather than paginating further — this is
a daily suggestion, not an incident timeline).

**Scope (a deliberate choice between two safer options):** the brief asked
for either "public repos only" or "the current project only" — whichever is
safer — rather than the broader auto-discovery `publication_leak_sweep` does.
This checks the **current project's own repo** (whatever its visibility),
**plus** any repo already confirmed public by `publication_leak_sweep`
(`state/baseline.json`'s `publicationKnownPublicRepos`, populated only when
that separate, off-by-default feature has actually run). No new repo-listing
or discovery `gh` calls are made just for this feature, and no repo of
unknown or private visibility is ever added beyond the current project
itself. A private current-project repo's name is scrubbed out of the signal
text exactly like any other private detail (see `scripts/lib/scrub.mjs`); an
already-known-public repo's name and run URL stay readable.

**Fails silent, on purpose:** `gh` missing, unauthenticated, or erroring
(offline included) — the signal simply does not fire that run. It is never
itself reported as a finding; a human already gets told when `gh` is broken
through other means.

**Rate limiting:** results are cached per repo in `state/baseline.json`'s
`ciStatusCache` for about 10 minutes, so a SessionStart hook firing on every
new session never triggers its own `gh` call — it reads that cache only. The
daily scout (`scripts/detect.mjs`) is what actually refreshes the cache.

**SessionStart note:** `hooks/scout-surface.mjs` reads `ciStatusCache` for
whatever repo the CURRENT session's cwd resolves to (a local, no-network
`git remote get-url origin`) and, when that entry is red, adds one line:
`main CI red since <timestamp>, <workflow> — <url>`. This never blocks on
the network — a cache miss or a repo the cache doesn't cover is silent. It is
independent of `scout_surface`: turning the generic scout-signal listing off
does not suppress this note, and vice versa.

## Memory vault

The corpus at `~/.claude/projects/*/memory/` was never under version control —
a rewritten `MEMORY.md` carries no history, so there is no way to tell what
changed or whether anything was lost. `memory_vault` (off by default — see
[Features](#features)) fixes that with a **mirrored** local git repository,
not a git working tree on the corpus itself: see
[`docs/adr/0001-memory-corpus-backup-vault.md`](../../docs/adr/0001-memory-corpus-backup-vault.md)
for why the live corpus is never a working tree, and what that decision costs.

```bash
node scripts/memory-vault.mjs init            # create the vault (idempotent)
node scripts/memory-vault.mjs sync             # copy + commit what changed
node scripts/memory-vault.mjs sync --json      # same, machine-readable
node scripts/memory-vault.mjs status           # report vault state
```

**Read-only against the corpus, always.** Every read goes through the same
`discoverFiles()` reader the audit and memory-search already use — nothing
here can call a git command, `writeFileSync`, or `unlink` against
`~/.claude/projects/**`. The vault itself lives at
`~/.claude/agent-companion/memory-vault/` (`stateRoot()`, survives an
uninstall same as telemetry — see [State](#state)), mirroring the corpus
under `projects/<project>/memory/**`, so `git log -p` works on a path that
matches the original:

```bash
git -C ~/.claude/agent-companion/memory-vault log -p -- projects/<project>/memory/MEMORY.md
```

**What each `sync` does:**

- Copies every readable file under a project's `memory/` into the vault,
  **excluding** anything that trips the secrets gate below.
- Removes, from the vault, any file no longer present in the live corpus —
  so a deletion is a *recorded* commit, not a silent gap; the last known
  content stays recoverable with `git show <sha>^:<path>`.
- Commits once, with a message stating how many files were added, modified,
  and deleted, and which projects were touched — **only if something
  changed**. A `sync` with nothing new stages and commits nothing.
- Refuses to treat a suspiciously empty enumeration (corpus root briefly
  unreadable) as "everything was deleted" — if the corpus reports zero files
  while the vault already holds tracked content, the sync aborts untouched
  rather than mass-deleting the vault's history.

**Bytes in, the same bytes out.** `init` writes a `.gitattributes` containing
`* -text`, which turns off git's line-ending conversion in both directions.
Without it `core.autocrlf` (true by default on Windows) commits an LF-native
store as LF and *checks it back out as CRLF* — nothing errors, nothing warns,
and the rewrite is only visible at restore time, the one moment the vault is
the last remaining copy. `status` reports `byte-exact`, and the audit's
`memory-vault-drift` check warns if it is ever missing.

A vault created before this existed gets the file added by re-running `init`
— but only when it would change nothing: every tracked file's working-tree
bytes are compared against its committed blob first, and if any differ (the
signature of content that *would* be renormalised) the backfill refuses and
says so rather than rewriting what was backed up. Existing history is never
rewritten either way.

**Secrets gate, on every sync, not a one-off.** Before a file is written into
the vault, its content is checked against a fixed set of credential-shaped
patterns (cloud provider keys, private-key headers, bearer/JWT tokens,
embedded connection-string credentials, generic `secret:`/`token:`/
`password:` assignments). A match excludes that one file from the commit —
reported by file path and pattern label only, never the matched text — and
leaves whatever the vault already had for it untouched.

**Never inside another repository.** The vault must be a git repository of
its own. `init` and `sync` refuse, writing nothing at all (no vault
directory, lock or status file), when the vault location is inside an
existing repository's work tree or `.git`, when its `.git` is a symlink or
junction, when a marker file sits in a repository the plugin did not create,
or when a vault path is longer than 246 characters on Windows. Git for
Windows cannot find a repository past that length, whatever `core.longpaths`
says. Every git call the vault makes also ignores the caller's
repo-locating `GIT_*` variables, inherited `-c` config, and hooks.

The plugin recognises a vault it created by its history: every root commit
is `memory-vault: initialize`. The identity in the vault's config does not
count, so you can change the vault's `user.email`, for example before pushing
it somewhere. The vault stays in use, and `sync` prints a one-line note. A
refusal never tells you to delete a directory that holds commits or files. It
tells you to move the directory aside by renaming it, which keeps everything
in it. It suggests deleting only a directory with an empty `.git` and nothing
else. Sometimes an initialization stops before its first commit, which leaves
the marker and the vault identity but no commits. The next `init` or `sync`
finishes that initialization instead of refusing it. Vault commits are never
signed, whatever your global `commit.gpgsign` says. `status` runs the same
guards as `sync` before it touches the vault's work tree, so it never writes
an index. If a guard fails, it reports the vault as refused and exits 1, and
the audit's `memory-vault-drift` check fails with the same reason.

**Moving the vault.** Set `AGENT_COMPANION_VAULT_DIR` to an absolute path to
move the vault alone. This is the fix when the default location is refused,
for example because `~/.claude` is itself a git repository:

```bash
AGENT_COMPANION_VAULT_DIR=/path/outside/any/repo/memory-vault node scripts/memory-vault.mjs sync
```

**Set it persistently.** The inline form above moves the vault for that one
command. Two other things read the variable from their own environment: the
scheduled calibration scout, which runs `sync` every day (see
[`routines/calibration-scout-daily.md`](routines/calibration-scout-daily.md)),
and the audit's `memory-vault-drift` check. If the variable is not set where
they run, they use the default location. The scout then starts a second vault
there or is refused, and the audit reports on the wrong vault. Set it in one
of these places:

- **Claude Code's `settings.json`** (`~/.claude/settings.json`), in its `env`
  block. This is recommended: every Claude Code session gets it, including
  the scheduled scout's and every command it runs.

  ```json
  {
    "env": {
      "AGENT_COMPANION_VAULT_DIR": "/absolute/path/outside/any/repo/memory-vault"
    }
  }
  ```

- **A user environment variable**, for runs outside Claude Code. On Windows,
  use `setx AGENT_COMPANION_VAULT_DIR "D:\backups\memory-vault"`. It applies
  only to processes started afterwards, so restart Claude Code. On macOS or
  Linux, use an `export` line in your shell profile, which reaches only
  processes started from that shell. A scheduler that starts no login shell
  will not see it, which is why `settings.json` is the recommended place.

To confirm, run `node scripts/memory-vault.mjs status` from the same kind of
session the scout uses. Its first line shows the vault directory it resolved.

The path must also be outside the agent-companion state root. It cannot be
the state root, a directory inside it, or a directory that contains it,
because `sync` keeps its lock and status file there. The one exception is the
default location, `<state root>/memory-vault`.

`AGENT_COMPANION_STATE_DIR` also moves the vault, but it moves **all**
agent-companion state with it: `config/` (brevity toggles, standing rules),
telemetry, and dedup state. Use it only if that is what you want.

**Never a session transcript.** Transcripts live at
`~/.claude/projects/<project>/*.jsonl`, a *sibling* of that project's
`memory/` directory, never inside it — structurally outside every path this
feature reads. `tests/memory-vault.test.mjs` proves it directly: a fixture
`.jsonl` file placed next to a `memory/` directory never appears anywhere in
the vault's working tree or git history after `init` + `sync`.

**Scheduling.** No new scheduler was created. `sync` runs from the existing
daily calibration scout's **local-only** step (see
[Routines](#routines) — the vault needs the real `~/.claude/projects/` tree,
which does not exist in a cloud sandbox) and self-gates on the
`memory_vault` option, exactly like every other opt-in hook here.

**Adding a remote is a separate, manual step** — this feature only ever
creates and commits to a purely local repository:

```bash
git -C ~/.claude/agent-companion/memory-vault remote add origin <url>
git -C ~/.claude/agent-companion/memory-vault push -u origin main
```

## Cache TTL analysis

`node scripts/cache-ttl.mjs` (also `/agent-companion:audit --only cache-ttl`)
answers one question: would setting `subagentPromptCacheTtl` to `"1h"` save
or cost THIS operator money, measured against their own transcripts? Read-only
— it never writes a setting or an agent definition, and never will.

**Why this is not obvious.** Every subagent request writes its prompt cache
with a 5-minute TTL by default. A cache write costs 1.25x the base input
price under a 5m TTL, 2x under a 1h TTL — strictly more per write. But a 1h
TTL keeps the cache warm through gaps a 5m TTL would have let expire, turning
what would have been a fresh (2x-costing) write into a cheap read (a small
fraction of input price). Whether the extra write cost gets paid back depends
entirely on this operator's own gap distribution between subagent requests —
which is exactly what this check measures instead of assumes.

**The three gap bands, and why only one of them matters:**

| Gap between requests | Under either TTL | 1h changes anything? |
|---|---|---|
| under 5 minutes | cache still warm | no — sanity check, not the opportunity |
| 5–60 minutes | 5m cache expired, so today it rewrites | **yes** — this is the band 1h can pay off in |
| over 60 minutes | cold under either TTL | no |

For a request in the 5-60 minute band, `convertedTokens` is how many of its
write tokens would instead have been reads under a 1h TTL:
`clamp(prevPrefix - read, 0, write)`, where `prevPrefix` is the previous
request's `input + write + read` — clamped because the conversion can never
exceed either what the cache actually held or what this request actually
wrote.

**Cost formulas** (`in`/`out` are $/MTok from `config/model-pricing.json`,
`rm` is that model's cache-read multiplier):

```
cost today    = I·in + W·1.25·in + R·rm·in + O·out
cost with 1h  = I·in + (W-conv)·2·in + (R+conv)·rm·in + O·out
break-even    = 0.75 / (2 - rm)         (as a share of write tokens)
```

**What this cannot see — and why the verdict is conservative, not symmetric.**
`subagentPromptCacheTtl` also governs compaction, session-title generation,
and workflow requests, none of which show up as ordinary subagent
transcripts, so none of them are in any total above. Those are almost
entirely ONE-SHOT writes — a compaction summary or a title is generated once
and never read back through the cache — so under a 1h TTL they pay the full
2x write cost with essentially nothing to earn it back. That is a real cost
this analysis cannot measure, and it only ever pushes in one direction: it
makes a 1h TTL look better here than it will actually be. The verdict
thresholds below account for that by being harder to satisfy in the
"set it" direction than in the "don't" direction, rather than a symmetric
±X% band.

**The verdict** picks one of three shapes, using named thresholds (all in
`scripts/lib/cache-ttl.mjs`, `computeVerdict()`):

| Condition | Verdict |
|---|---|
| global delta ≤ `SET_GLOBALLY_DELTA_PCT` (-1.0%) **and** no model tier carrying ≥ `MIN_TIER_SPEND_SHARE_PCT` (5%) of spend has a *positive* delta | set `subagentPromptCacheTtl` to `"1h"` globally |
| global delta ≥ `DONT_SET_DELTA_PCT` (+1.0%) **and** the opus/fable-only policy is also non-negative | don't set it, full stop |
| otherwise — tiers disagree, or the global delta sits inside the ±1% dead zone | don't set it globally; instead list every `agentType × model` row with a delta at or past `-MIN_AGENT_SAVING_PCT` (1.0% — a -0.24% "saving" is noise, not a reason to edit a definition), at least `MIN_REQUESTS_FOR_AGENT_ROW` (500) requests, and a **named, editable** agent definition — excluding harness built-ins (`general-purpose`, `Explore`, `Plan`, ...; reuses `KNOWN_AGENT_TYPES` from `hooks/lib/context.mjs`) and subagents with no sidecar `.meta.json` at all (`(no meta)`), neither of which has any frontmatter to set `experimental: { cacheTtl: "1h" }` on |

A candidate that qualifies for the per-agent list above but whose OWN
definition **already** carries `experimental: { cacheTtl: "1h" }` (read live
via `agentDefinition()`, not a hardcoded name list) is reported separately as
"already on `experimental.cacheTtl: "1h"` (no action needed)" instead of
being re-recommended — otherwise a rung that was already switched would show
up as a fresh suggestion to make the same edit again, forever, as long as its
measured delta stayed negative (`alreadyOneHourFrom()` in `scripts/lib/cache-ttl.mjs`).

**Which ladder rungs use the 1-hour cache today: none.** All ten generic
`ac-*` ladder workers use the default 5-minute subagent cache. Four of them
(`ac-opus-medium`, `ac-opus-high`, `ac-opus-xhigh`, `ac-opus-max`) carried
`experimental: { cacheTtl: "1h" }` from 0.29.17 to 0.29.29 and it was removed
in 0.29.30 (2026-10-03, operator choice). Why: from 2026-10-02T16Z the 1h cache
writes cost 242 plan units, 23% of the total. These workers run continuously
and compact often, so the cache is rewritten long before an hour passes; a 1h
TTL only pays for an agent that sits idle for more than 5 minutes, and every
rewrite costs 1.6x a 5-minute write (2x base input against 1.25x). The
mechanism stays: a rung's optional `cacheTtl` field in
`config/model-tiers.json`'s `ladder` is generated into the file by
`scripts/routing-table.mjs --sync-agent-descriptions`, so a rung can be put
back on 1h with a one-line config edit. See `ladderCacheTtlNote` and
`cacheTtl.ladderWorkersExcludedNote` in that config. The resume doctrine is
unchanged: resume a stopped worker only while its cache is warm (5 minutes),
otherwise spawn a fresh ladder worker from a file handoff
(`hooks/resume-guard.mjs`).

A **compaction** immediately before a request (`isCompactSummary: true` on
the synthetic user record, or its preceding `compact_boundary` system
marker) forces a fresh cache write regardless of TTL — the old cache is
discarded along with the summarised context, not merely expired — so its
`convertedTokens` is pinned to 0 in every band and it is counted separately
in the cause breakdown rather than folded into "unknown".

The break-even line (observed rewrite share vs. the share required, per
tier) is always printed alongside the verdict, regardless of which branch
fired — it's the number that explains the call, not just the conclusion.

**What the report covers:** totals and a band table; the sanity check
(observed `cache_read / (read+write)` per band — near 100% under 5 minutes,
near 0% at 5-60, proving the cliff exists); a breakdown of WHY a 5-60 minute
gap happened (a long tool call the previous turn was waiting on, vs. the lead
resuming a turn that had already ended) plus tool-wait p10/p50/p90; per-model
and per-agentType×model deltas against the model's own break-even; the
main-session 5m/1h write split (confirms the setting cannot touch the main
conversation, and flags it if subagents are already partly writing 1h via an
agent's own `experimental.cacheTtl` frontmatter); a three-way policy
comparison (all-5m / all-1h / 1h only for the opus/fable tier); and a
one-line verdict. Unknown models are excluded from every dollar total and
listed separately — there is no safe number to guess for an unpriced model.

```bash
node scripts/cache-ttl.mjs                  # last 30 days, human report
node scripts/cache-ttl.mjs --days 60 --json  # a different window, machine-readable
```

**Pricing is data, not code** — same rule as `config/model-tiers.json`, and
deliberately a SEPARATE table: `model-tiers.json` classifies generic routing
aliases (haiku/sonnet/opus/fable) for the spawn guards, which is coarser than
pricing needs (opus-5 and opus-5-5 route to the same guard tier but do not
cost the same; fable-5 and fable-5-1 share a sticker price but differ in
cache-read multiplier). Extend `config/model-pricing.json` for a new model's
price; override without a release by writing the same shape to
`~/.claude/agent-companion/state/model-pricing.json` (merged by alias, like
every other override in this plugin).

## Transcript report

`node scripts/transcript-report.mjs` reads the operator's transcripts and
prints what they say about tokens and cache:
- per-model totals with a price-derived cost;
- compaction counts with pre/post token sizes;
- a histogram of the time between consecutive requests, with how many were
  cache hits vs. rewrites and why each rewrite happened (the cache expired
  while idle, the prompt prefix changed, or a compaction). The histogram is
  also split by what connected the two requests (a tool result, a prompt, a
  message from another agent, a harness record) and the cache TTL that
  applied (5m or 1h);
- the gaps where a prompt or a message resumed the conversation after longer
  than the TTL;
- the first-request "spawn baseline" per subagent type;
- context peaks and growth.

It is read-only and local, and `--json` gives the full object.

```bash
node scripts/transcript-report.mjs                 # last 30 days
node scripts/transcript-report.mjs --days 7 --json
node scripts/transcript-report.mjs --workflows     # include workflow agents
node scripts/transcript-report.mjs --max-ms 20000  # time budget; newest files are read first
```

Every transcript reader in this plugin (this report, cache-ttl, transcript
harvest, the telemetry-coverage and model-mismatch checks) goes through one
module, `scripts/lib/transcripts.mjs`. Its header states the dedup rules:
- One API request is written as several lines, so it counts once, with the
  field-wise max of their usage.
- Lines re-logged later in the same file are not new requests.
- A request copied into a resumed or forked transcript counts once across
  files. It belongs to the original transcript and carries the largest usage
  of any copy.

After a compaction, the working context size is the first request's context,
not the summary's `postTokens`.

## Cache advisor: the auto-compact window

`node scripts/cache-advisor.mjs` works out, from your own transcripts, the
auto-compact window that costs least for each model, and the one value that
costs least for your model mix. Claude Code has a single window setting
(`autoCompactWindow`, set with `/autocompact`; the `--autocompact` flag and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` take precedence), from 100K to 1M tokens and
capped at each model's context window. Unset, native-1M models compact at
about 967K and 200K models at about 167K (`config/compaction.json`, which
cites where it came from).

Three things about the setting that change the number you type:

- **A window compacts 33K below its value.** Claude Code compacts at
  min(window, context window) minus min(max output, 20K) minus 13K, so
  `/autocompact 275k` compacts at about 242K. That is also why the 1M default
  is "about 967K". Every window the advisor prints is the value to type, with
  the compaction point beside it.
- **In settings.json it must be an integer** from 100000 to 1000000. Claude
  Code silently drops anything else (the string `"400k"`, or `400`) and the
  default applies. The advisor resolves what is really in effect the way
  Claude Code does (the environment variable, then managed, project and user
  settings; a running session's `--autocompact` flag cannot be seen from
  outside it) and prints a warning for every value Claude Code ignores.
- **`/autocompact <value>` applies at once** in that session and saves the
  number to your user settings; an edit to settings.json is read when a
  session starts.

The trade-off: every request re-reads the whole context from cache, so a
larger window costs more per request, and more again when a resume after the
cache expired rewrites it. A compaction costs the summarising call, a rewrite
of the post-compaction context, and the re-reading the model does afterwards
("rework", measured as extra context growth in the 50 requests after a
compaction). The advisor replays each transcript's real context growth and
real idle expiries under every candidate window and sums the cost. The replay
at the window you actually ran with is checked against what those requests
cost (`fit`, near 1.0), and a closed-form optimum is printed beside it as a
cross-check. `scripts/lib/cache-advisor.mjs` states the whole model.

- Dollar figures are tokens x API list price. On a subscription plan they are
  notional: they rank windows, they are not a bill. The benchmark rows'
  `cost_usd` is Claude Code's own figure from the same list prices, so it is
  used only to check the price table (a warning prints if they disagree by
  more than 2%), never to scale anything. A plan-usage view prices every model's tokens at Sonnet's price vector
  times the dated `planUsageMultipliers` in `config/model-tiers.json` (the
  benchmark's plan-usage method; a tier with no multiplier has no plan figure).
- Real traffic only: benchmark sessions (the harness's `bench-*` and
  `rescore-*` working directories in the OS temp dir) are excluded before
  reading, and the report says how many project directories were left out.
- Rework is measured, and a control at points with no compaction shows it is
  caused by compaction, but it is the least certain input. The whole
  evaluation is repeated with rework set to 0 and printed beside the main
  result, per model and for the mix.
- Not priced: the detail a compaction loses and the time it takes. The advisor
  never recommends a window that would compact more often than once every 10
  turns (`minTurnsPerCompaction`, measured with each model's own requests per
  turn), and it shows the cheapest window without that floor beside it. For
  the one global value the floor applies to the model mix as a whole, and any
  model that would still compact more often than that at the recommended
  value gets its own warning line.
- A model with fewer than 1,000 requests, or fewer than 5 sessions that grew
  past 100K, is reported as insufficient data rather than extrapolated.
- It also prints where each model's cache money goes (reads, 5m and 1h writes,
  and rewrites by cause) and the cold first-request cost of each subagent type,
  median and p90, per day.

It is advice only and never writes a Claude Code setting; apply it with
`/autocompact <value>` yourself. It saves a small summary (numbers and model
ids) in the plugin's state directory so `/ac recommend` can quote the window
for the model it recommends, with the date of the run. It also runs as the
`cache-advisor` audit check, bounded by the `cache_advisor_max_ms` option
(20 s by default, newest files first), which warns when the window in effect
costs more than 5% above the cheapest, or when a value you set is ignored. A
run cut short by the budget says it is partial and which days it covers
completely (reading newest first skews the model mix toward recent work), and
it never replaces a saved full-read summary.

```bash
node scripts/cache-advisor.mjs                  # last 30 days
node scripts/cache-advisor.mjs --days 14 --json
node scripts/cache-advisor.mjs --curve          # every model's full cost curve
node scripts/cache-advisor.mjs --max-ms 20000   # time budget for reading
```

## Main-session compaction floor (opt-in)

Claude Code has one auto-compact window for the main session and every subagent
(`autoCompactWindow` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). A window small enough to keep
long-lived subagents cheap makes the main session compact earlier than it needs to.
This option lets the main session compact later while subagents keep the global
window.

`hooks/compact-floor.mjs` is a plugin **hooks module** (a function hook, named under
`modules` in `hooks/hooks.json` next to the classic hooks). On `session.compact` it
vetoes **automatic** compaction of the **main** session (and its early "precompute" of a
summary) until its context reaches `main_compact_floor_tokens`. Subagents, manual
`/compact` and the plugin trigger go straight to core. It fails open: a bad option value, a missing token count or any
exception means compaction is not vetoed.

| Option | Default | Meaning |
| --- | --- | --- |
| `main_compact_floor_tokens` | `0` (off) | Main-session floor in tokens, `100000` to `1000000`. `0` or unset: the module passes everything through. Outside the range: fails open and logs once. The floor actually enforced is `min(floor, model window - 150000)`: see the trade-off. |

```json
{ "pluginConfigs": { "agent-companion@agent-templates": { "options": { "main_compact_floor_tokens": 367000 } } } }
```

**Trade-off.** Below the floor the main session runs past the global window, so it carries
a larger context (more cached-read tokens per turn) and a later, bigger compaction
instead of several earlier small ones. The floor only matters when it is above the
global window's trigger point; with a floor at or below it nothing is vetoed. The status
line and `/context` still show "until auto-compact" against the **global** window, so
they read as if compaction were imminent while the floor holds it back.

**Wedge guard.** Claude Code blocks the prompt outright ("Prompt is too long") a little
under the model window (about window minus 23K), and a vetoed compaction never lifts that,
so an unguarded floor near the window would leave the session with no automatic way out.
The module therefore enforces `min(floor, model window - 150000)`, reading the window from
the session (`$.session.usage().context.window`): a 1M model with floor `367000` is held to
367K, a floor of `990000` is held to 850K, and on a 200K model (for example a `--model haiku`
run, since plugin options are global) the enforced floor is 50K, which every auto-compaction
already exceeds, so nothing is vetoed. An unknown window passes and logs once. Early
"precompute" is vetoed below the floor too: core would otherwise build a summary at the
early arm point (about 184K on a 250K window), keep it, and apply it at the floor as
summary-of-the-first-184K plus every raw message since, a compaction that frees about half
of what a fresh one would.

**One early compaction can still happen.** Right after `/resume` of a large transcript, or
right after a compaction, the session reports no token count until the next response
arrives, and the module fails open on an unknown count, so a single compaction may fire
below the floor in that window.

**Requirements.** A Claude Code build that loads plugin hooks modules (the engine's
`tengu_plugin_hooks_modules` rollout, on by default in 2.1.286; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0`
turns it off, and so do `--bare`, `disableAllHooks` and `allowManagedHooksOnly` in managed
settings). Elsewhere the option does nothing. The option is read when the plugin loads;
restart the session after changing it.

**Log.** `compact-floor.log` under the plugin's state root (`~/.claude/agent-companion/`, or `AGENT_COMPANION_STATE_DIR`; the plugin data directory is used when the engine exposes it to modules, which 2.1.286 does not), capped at 200 lines: one line at the session's first veto, one line per main-session pass (with the number of vetoes since the last line), one line per fail-open reason. Never one line per vetoed call.

**Turn it off.** Set `main_compact_floor_tokens` to `0` (or remove it) and restart the
session, or disable the plugin.

## Model tiers are data, not code

Which models count as premium, and how they rank against each other, lives in
[`config/model-tiers.json`](config/model-tiers.json) — not in the guards. A tier
table compiled into code goes stale the moment a lineup changes, and it goes
stale **silently**: the guards keep running and simply stop classifying
correctly. This plugin exists partly because a routing table sat wrong for a
whole model generation without anyone noticing.

Override without waiting for a release by writing a file of the same shape to
`~/.claude/agent-companion/state/model-tiers.json` (a legacy copy at
`$CLAUDE_PLUGIN_DATA/model-tiers.json` is still honoured as a fallback, so an
override written before 0.17.0 keeps working). It merges **by alias, then per key within a tier** (one level deep), so
adding one model needs one entry, and flagging a tier retired needs only
`{"tiers":{"haiku":{"retired":true}}}` — not a restatement of the table — a table
you have to retype is a table you will not update:

```json
{ "tiers": { "newtier": { "rank": 2, "premium": false, "match": "newtier" } } }
```

**An unrecognised model is treated as premium and flagged.** Defaulting an
unknown model to cheap would let a newly released top tier bypass the warrant
and the fan-out cap during exactly the window in which nobody has updated the
table yet. So it fails toward the expensive assumption, and the audit tells you
the table needs an entry rather than quietly applying the strict path.

## Routing profile

Your own routing rows, kept apart from the shipped table
(docs/adr/0003-per-user-routing-profiles.md). A row is keyed by task type and
wins over the shipped trial and the grid when a brief declares that `TYPE:`
as-is. The floors still apply after it: critical work stays on opus at xhigh
or above (F1), nothing routes to fable (F2), a reviewer matches its writer
(F3), and a row must name an available tier alias with an effort it takes
(F4). A row that breaks any of these is refused when written and ignored if
the file is edited by hand. The elevated effort floor (F5, high) can be waived
on one row with `--waive-floor elevated`, and only on a row you set yourself;
`why` always prints the waiver. No waiver lets an architecture-class type
(integration, large-refactor, novel-design, critical-change, or a local type
you flag `architectureClass: true`) route to opus/low: `set` refuses that row
and the resolver ignores it if hand-edited (F6).

```bash
node "$AC/scripts/routing-profile.mjs" set integration --model sonnet --effort high --because "sonnet handles my integration work"
node "$AC/scripts/routing-profile.mjs" set code-review --effort xhigh   # a review row sets a minimum effort only
node "$AC/scripts/routing-profile.mjs" why integration                 # the full explain stack (= recommend --explain)
node "$AC/scripts/routing-profile.mjs" show
node "$AC/scripts/routing-profile.mjs" unset integration               # the row is retired, kept in the journal
node "$AC/scripts/routing-profile.mjs" rollback --row integration      # the row's previous value
node "$AC/scripts/routing-profile.mjs" rollback --to 3                 # the whole profile as it stood at revision 3
```

`/ac routing set|unset|show|why|rollback …` is the short form. A `set` row is
`operator-observed`, starts as a `trial`, and gets a review date 90 days out;
nothing expires it.

**Where it lives.** `~/.claude/agent-companion/config/routing-profile.json`,
next to an append-only journal (`routing-profile.journal.jsonl`, one line per
change) from which any revision can be rebuilt. Never in a repository and
never in the plugin directory, so an uninstall keeps it. Every write goes
through one validated writer: locked, written to a temp file and renamed, and
journalled. A profile that fails to parse, fails the schema, or comes from a
newer major format is ignored as a whole; the shipped table routes, and
`state/routing-profile-invalid.json` records the failure for the scout.

The profile can also define **local task types** (`types`, the same preset
shape as the shipped ones). `TYPE:` resolves shipped types first, then local
ones. `routing-table.mjs --profile` shows the table as this machine resolves
it; the default output stays the shipped table, because it is committed as
`docs/ROUTING.md`. For the reasoning behind the table's shape — lowest
sufficient tier, effort as a separate lever, reviewer parity, the consequence
floors, trials vs. profiles, cost basis, and haiku-as-validator — see
[`docs/ROUTING-RATIONALE.md`](docs/ROUTING-RATIONALE.md).

## Self-review (architect-class writers)

An architect-class writer gets its work reviewed by its own reviewer, spawned
from inside the writer, instead of handing an unreviewed diff back to the lead
to review. Which types do this is data: `selfReview` in
[`config/model-tiers.json`](config/model-tiers.json), next to the task types
(today `novel-design` and `critical-change`, narrowed on 2026-10-02 from the
four architect-class types; one fix round; opt-out line `REVIEW: lead`).

**Where the protocol lives.** It is generated from that config into the body
of every ladder rung that is currently the default for a listed type (today
`ac-opus-xhigh`), between `self-review protocol BEGIN/END` markers, by
`scripts/routing-table.mjs --sync-agent-descriptions`. `--check-agent-descriptions`
fails on drift, so when the table moves a type to another rung the block
has to move with it, and a hand edit is caught. A listed type spawned on any
other ladder rung (a routing profile or a local table override can put it
there) gets the same text, sized to that rung, appended to its brief by the
spawn guard. The text tells the writer to:

1. commit, then spawn ONE foreground reviewer on the rung matching its own
   model and effort, with `TYPE: code-review` and `WRITER: <model>/<effort>`;
2. give that reviewer the lead's brief (verbatim or its path), the branch, sha
   and diff range, the adversarial instruction (verdict `PASS` or `FIX`,
   findings ranked blocker/should-fix/nit with file:line and a repro), the
   review file path (the lead's, else `REVIEW-<name>.md` next to the report),
   and a checkout of its own to work in;
3. do one fix round, list the findings it disputes, and never re-review;
4. return the report, the reviewer's verdict line verbatim, the review path,
   the post-fix sha and the disputed findings.

A brief carrying `REVIEW: lead` on a line of its own opts that spawn out: the
lead reviews it as before. A built-in type (its effort is not pinned) or a
project agent (`.claude/agents/`) does not get the text; give a project agent
the same wording by hand if it should self-review.

**What the guard adds.** A review spawned by a subagent with no `WRITER:` line
is sized to the caller (see `fit_guard`); a self-reviewing writer that names a
`WRITER:` below itself gets a note; a critical-change writer's review is
floored by F1. Reviewers never spawn reviewers (`review_recursion_guard`, one
level up). `spawns.jsonl` rows record `tool_use_id`, `parent_agent_id`,
`caller_tool_use_id`, `self_review` (a review by a writer of a listed type),
`review_by_subagent`, `self_review_expected`, `self_review_injected` and
`inferred_writer` ([docs/TELEMETRY.md](docs/TELEMETRY.md)).

**What the guard cannot see.** The writer writes its reviewer's brief and
relays the verdict. A review spawned with no `TYPE:` line, a second review, a
background review, or no review at all pass without a note. The protocol
tells the writer not to do these things; nothing enforces it.

**Where the lead still acts.** The lead lands the work and merges it, settles
the findings the writer disputes, and spot-checks the review. The protocol
moves the first review pass off the lead; it does not move the decision to
ship. What to check:

- the review file exists, and its first line is the verdict the writer
  relayed;
- the reviewer's actual brief is the first user record of its transcript,
  `<session>/subagents/agent-<reviewer id>.jsonl`: it should carry the lead's
  brief and the diff range, with nothing narrowing the review;
- the reviewer's `spawns.jsonl` row has `caller_tool_use_id` equal to the
  writer row's `tool_use_id`, and a `fit` of `fit` against its writer.

## Model benchmark

The routing table's `taskTypes.*.override` entries (routing trials) are
backed by a real, in-plugin model x effort benchmark, not intuition:
`scripts/benchmark.mjs` (plan/budget/order/fairness — `/ac benchmark` or the
`model-benchmark` skill) drives `bench/runner.mjs`'s proven mechanics
(headless `claude -p`, full model ids, effort proven from the transcript,
`claude.exe` never `claude.cmd`, a throwaway sandbox per run, your normal
OAuth session by default — `--isolate-home` opts into a throwaway
HOME/USERPROFILE too, requires `ANTHROPIC_API_KEY`) against a synthetic task
set (easy/hard variants, `bench/tasks/`) plus real-history tasks mined from
this repo's own fix commits. An auth/login failure is classified distinctly
(`status=auth_error`) and aborts the batch immediately rather than being
misread as a 0%-pass run — see docs/BENCHMARK.md "Preconditions".

**Results never live in this repo.** They land under the plugin's data dir
(`benchmarks/<phase>-<date>/` — the same `dataDir()` resolver every other
script here uses), never committed.

**Adding a new real-history task never means committing extracted source.**
`bench/task-packs/` is a FORMAT plus a builder
(`node bench/task-packs/build-pack.mjs`) that extracts a fix commit's parent
state at RUN TIME (`git show <ref>:<path>`, never `git clone`), verifies
fail-at-parent/pass-at-fix before the pack is usable, and stores only a
hand-written symptom-only report, a hidden test, and two base64-encoded git
refs — a plaintext SHA is exactly the shape this repo's own
`scripts/leak-check.mjs` bans.

**Results carry their own uncertainty and provenance.** Summaries report
pass@1 and pass@k with 95% Wilson intervals per cell and task family, and
flag groups too small to separate. Every result row records the CLI version,
the requested and resolved model, the effort, and content hashes of the
task. An **optional rubric judge** grades design quality the hidden test
cannot see. It is a separate score, never merged into pass/fail. It is blind,
votes 3 times and passes on 2 of 3, must be different from and at least as
strong as the model under test, and is refused until it has been
**calibrated** against a task's real fix (must pass) and known-bad variants
(must fail).

**Routing canaries** (`evals/`) check that a live session consults the
routing guidance and lands on the table's answer. They are a small
`claude plugin eval` suite, run on demand and never automatically.

See [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for consolidated lessons
(ceiling effects, statistics, the fairness rule, the rubric judge, the
routing eval suite, known CLI flag gaps) and
[`skills/model-benchmark/SKILL.md`](skills/model-benchmark/SKILL.md) for the
operating procedure.

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

**Enforcement fails open; detection does not.** The main-thread test is
`agent_id` absent (`callerIsSubagent()` in `hooks/lib/context.mjs`, shared by
every lead-only hook): the harness's own hook-input schema says `agent_id` is
present only inside a subagent and absent for the main thread, even in `--agent`
sessions, and tells hooks to use it rather than `agent_type`. The delegation
guard adds one condition (`isMainThread()`): a payload that did not parse, or
carries no `session_id`, is never counted as the main thread. The spawn guard and
the runaway notice test `agent_id` alone (`callerIsSubagent()`), so such a payload
is still the lead to them. An
agent type we do not recognise is never blocked — but it *is* recorded to
`unknown-agent-types.jsonl`, so a new type introduced by a harness update
surfaces in the next calibration run instead of silently changing behaviour.

**Under-enforcement is the safe failure.** A guard that stops matching looks
identical to a guard that was never tripped, so the calibration routine treats a
denial count of **zero** as a signal to run the canary — not as good news.

## Configuration

Toggles are declared as `userConfig` and set per-user without editing plugin
files:

```json
{
  "pluginConfigs": {
    "agent-companion@agent-templates": {
      "options": {
        "delegation_guard": "warn",
        "delegation_guard_scope": "attended",
        "delegation_threshold": 4,
        "premium_max_concurrent": 2,
        "memory_budget_tokens": 3000,
        "brevity": true,
        "brevity_peer": true,
        "brevity_reinforce": true,
        "brevity_telemetry": true,
        "brevity_stop_gate": false,
        "brevity_report_max_chars": 4000,
        "standing_rules": true,
        "standing_rules_max_chars": 3000,
        "review_recursion_guard": true
      }
    }
  }
}
```

Omitting the `options` wrapper fails **silently** — the block is not
recognised, no error is raised, and every option falls back to its default.
`pluginConfigs` is honoured only in **user** or **managed** settings; it has no
effect in project or local scope.

## State

**Durable telemetry and state live OUTSIDE the plugin data directory**, under
`~/.claude/agent-companion/` (override: `AGENT_COMPANION_STATE_DIR`, or
`CLAUDE_CONFIG_DIR`-relative) — survives upgrades AND uninstalls. A plugin
uninstall only ever deletes `${CLAUDE_PLUGIN_DATA}`
(`~/.claude/plugins/data/agent-companion-<marketplace>/`), which is now used
solely for disposable caches. See `docs/TELEMETRY.md` for the full layout,
the legacy-data import, and the schema.

`config/` is the one directory under the state root that is **user-authored** rather than derived: `brevity.json` and `standing-rules.json` hold the operator's own overrides. Unlike `telemetry/` and `state/`, which are safe to delete to reset history, deleting `config/` throws away choices, not just history.

| File | Location | Contents |
|---|---|---|
| `config/brevity.json` | state root | operator's runtime global override and per-agent overrides for the reporting contract |
| `config/standing-rules.json` | state root | operator's rule additions and overrides; built-ins stay in code, so only a diff is written |
| `telemetry/spawns.jsonl` | state root | every `Agent` spawn: model, subagent type, caller/spawn effort (v2) |
| `telemetry/subagent-starts.jsonl` | state root | post-spawn confirmation |
| `telemetry/denials.jsonl` | state root | every guard denial, plus each `delegation_guard: warn` firing (`outcome: "warn"`) |
| `telemetry/unknown-agent-types.jsonl` | state root | agent types not in the known set |
| `telemetry/fixtures.jsonl` | state root | rows from `verify-`/`test-`/`fixture-` sessions, routed here instead of a production stream |
| `telemetry/brevity.jsonl` | state root | one row per `SubagentStart` self-heal and per `SubagentStop`: agent type, report length, whether the contract was on, whether it was gated |
| `state/delegation-streak.json` | state root | per-session main-thread streak counter, firing count (`fired`) and reminders sent (`reminded`; the `delegation-drift` gate is due while `fired > reminded`), plus what the last counted call's env said for `CLAUDE_CODE_SESSION_ATTENDED` (`attended`: `"1"`, `"0"` or `"absent"`, for `attended_env_missing`); read-modify-written under `delegation-streak.json.lock`, which waits at most 1 s and is broken once 3 s old whoever owns it; sessions untouched for 7 days are pruned |
| `state/premium-window.json` | state root | rolling window used to approximate premium concurrency; read-modify-written only under `premium-window.json.lock` (a transient lock both hooks share, via hooks/lib/file-lock.mjs: it names its owner, and is broken only when that process is gone and the lock is over 1 s old) |
| `state/baseline.json` | state root | previous harness version + counters, for daily drift detection; also the publication-leak sweep's per-repo hit fingerprints (keyed HMACs, not guessable hashes), so an accepted finding doesn't re-fire daily, and its repo-visibility cache (only public answers kept, for 24h; not-public and unknown ones are rechecked every run, so a repo made public is swept on the next run) |
| `leak-fingerprint.key` | state root | per-machine random key for those hit fingerprints, created on the first sweep (owner-only permissions) |
| `state/scout-latest.json` | state root | most recent calibration-scout result (overwritten each run) |
| `state/scout-history.jsonl` | state root | append-only: one line per scout run |
| `state/version-notice-state.json` | state root | per-session `loadedAt`, which (plugin, lastUpdated) pairs already got the staleness notice, and — once the global hook is installed — the `loadedVersion` recorded for the self-check handoff; pruned after a week |
| `state/upload-state.json` | state root | opt-in telemetry-upload cursor |
| `state/import-cursors.json` | state root | legacy-import cursors, keyed by source file path |
| `state/migrated.json` | state root | written once, after the first legacy-data import |
| `state/model-tiers.json` | state root | operator override of `config/model-tiers.json` (optional); a legacy copy under the plugin data dir is still honoured as a fallback |
| `state/agent-types/*.seen` | state root | one marker file per seen unknown agent type (race-free dedup) |
| `memory-vault/` | state root, or `AGENT_COMPANION_VAULT_DIR` when set | the vault repo itself — a separate git repository, see [Memory vault](#memory-vault) |
| `state/memory-vault-sync.lock` | state root | held for the duration of one `memory-vault.mjs sync`; stale after 120s and taken over |
| `state/memory-vault-status.json` | state root | fast-read cache of the vault's last sync outcome, plus a record of every sync ATTEMPT — including the ones turned away before doing any work, which is how a sync that silently stopped running becomes reportable (git history is the source of truth for content, not this file) |
| `migration/backup-<stamp>/...` | state root | verbatim backup of each legacy dir's durable files, taken before the first import |
| `refactor-prompt.md` | plugin data dir | generated when an instruction file is over budget or memory is unreachable |
| `memory-index*.json`, `memory-merge-status-*.json` | plugin data dir | disposable, regenerable memory-search caches |
| `transcript-harvest/` | plugin data dir | human-reviewed transcript digests |

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

### Global hook — never itself stale

`version_notice`'s own checker lives inside the plugin, so it is bound to
whatever installed-plugin-cache folder a session loaded at startup, same as
every other hook — a stale session runs a stale checker. Installing the
staleness shim as a **user-level** hook fixes that: it runs from a fixed path
(`~/.claude/hooks/agent-companion-staleness.mjs`) that never needs updating,
and re-resolves the currently installed agent-companion fresh on every
invocation instead of running whatever copy this session happened to load.

```bash
node "$AC/scripts/install-global-hooks.mjs"           # install
node "$AC/scripts/install-global-hooks.mjs" --dry-run  # preview, touches nothing
node "$AC/scripts/install-global-hooks.mjs" --uninstall
```

Idempotent, backs up `settings.json` before writing, and once installed the
plugin-registered hook defers to it instead of duplicating the notice — see
`hooks/self-update.mjs` for the handoff. Optional: `version_notice` already
catches most staleness without it, just one `/reload-plugins` (or restart)
behind.

### Six separate stale-state traps

Updating this plugin touches six independent caches, and skipping any one
leaves you running old code **with no error at all**:

| # | Step | Symptom if skipped |
|---|---|---|
| 1 | `claude plugin marketplace update <marketplace>` | installs re-run the old commit; a fix that is already on `main` appears not to work |
| 2 | `claude plugin update <plugin>@<marketplace>` | cache is current, installed version is not |
| 3 | `/reload-plugins`, or a new session | new version installed, old hooks still bound |
| 4 | check the running session's own age | a session predating the install never had hooks at all |
| 5 | remove and re-add the marketplace on claude.ai | cloud sessions keep loading the previous version's hooks and skills while every local check — `claude plugin list`, the marketplace cache commit, the manifest check — reports the new version |
| 6 | check every copy with `node scripts/version.mjs` (`/ac version`) | the CLI cache is current while the desktop app's own copy (`…/local-agent-mode-sessions/<acct>/<org>/rpm/plugin_<id>/`) is still on an older version: desktop Code-tab sessions keep the old hooks and routing, and `installed_plugins.json` looks fine. Fix: disable, then re-enable, agent-companion in the desktop app's plugin manager (not `claude plugin uninstall`), then idle desktop sessions pick up the current copy on their next turn (a session that is mid-turn, after that turn); confirm with `/ac version`. Afterwards the desktop session runs the CLI cache copy, so a later `claude plugin update` covers it. With no desktop copy, desktop sessions already use the CLI cache |

Three traps within the traps: `claude plugin update` needs the **fully qualified**
`plugin@marketplace` — the bare name fails with a misleading *"Plugin not
found"*. `claude plugin details` reads the **cache**, not the installed copy,
so it will happily describe components that are not actually running. And the
local verification commands above cannot see the claude.ai cache at all —
"verified locally" says nothing about what a cloud session is running. A
version bump alone does not invalidate it either; the marketplace has to be
removed and re-added on the claude.ai side.

Verify what is real rather than what is reported:

```bash
git -C ~/.claude/plugins/marketplaces/<marketplace> log --oneline -1
claude plugin list
```

### Verifying it is actually running

After installing or reloading:

```bash
ls ~/.claude/agent-companion/telemetry/
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
| `routing-table` | `/ac routing` | the current table, rendered from config; `/ac routing set`, `unset`, `show`, `why` and `rollback` manage your routing profile |
| `audit` | `/ac audit --dir <project>` | the composable hygiene audit; `--fix` for the fixable checks |
| `brevity` | `/ac brevity` | is the reporting contract on, for whom, and which layer is winning |
| `standing-rules` | `/ac rules` | which "always do X if Y" rules exist, and whether one would fire on given text |
| `version` | `/ac version` | which agent-companion is running, and whether every installed copy (CLI cache, desktop app copy, marketplace clone) is current |
| `setup` | `/ac setup` | the setup steps on a new machine, both scouts included |
| `calibration-scout` | `/ac scout` | the daily drift scout, run by hand |
| `model-benchmark` | `/ac benchmark` | re-running the model x effort benchmark: plan, budget, order, fairness, reporting |

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

The calibration scout's **local-only** step also drives `memory_vault`'s
`sync` (see [Memory vault](#memory-vault)) — no second scheduler was added
for it; it self-gates on the option and is silent when off or unchanged.

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
