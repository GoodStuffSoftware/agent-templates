# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

## 0.31.31 — 2026-10-23

- **Token bleed guard, phase 1: step backstop.** Every agent definition (`ac-*` rungs and `ac-browser*`) carries `maxTurns: 150`, the Claude Code turn limit (documented as supported for plugin agents; at the limit the parent gets the partial output back). A live spawn test was not possible here (headless auth expired). The limit also applies to `long-autonomous-run` agents, which can no longer exceed 150 turns per spawn, and ladder agents can no longer reach the 300-turn `runaway_turns` note.
- **Scope rule in briefs.** The spawn guard appends one short clause by `TYPE:` (else `ROLE:`): writers are told to build the smallest change and to report before creating anything the brief does not name; lookup, research, survey, explore and verify briefs are told to create no new files beyond the requested output. Reviews and other types get none (`hooks/lib/scope-rule.mjs`).
- **Self-review question.** Step 1 of the self-review protocol, in the generated block of the rungs that carry it and in the copy the spawn guard appends, now first lists anything built that the brief did not ask for, to remove or flag to the lead.

## 0.31.30 — 2026-10-18

- **Session budget notice (handover-lessons).** The notice no longer recommends a hand-off to a fresh session (measured: no usage saving); it says auto-compaction handles context, lists what cuts spend, and allows a hand-over only for a plugin version change or job end. (Repo) leak-check fails new or changed lessons over 150 words; unchanged long lessons are grandfathered by a digest baseline (`scripts/lesson-baseline.json`).
- **pr-wait on a commit (prwait).** `pr-wait.mjs` also waits on a commit: a sha (or `--sha`), or a branch with no open PR such as main after a direct push, waits for every workflow run of the commit (a branch: its current head), exits 1 if any run fails or is cancelled and 0 only when all succeed; runs that have not registered yet are waited on for up to 90 s (then `NO-RUNS`, exit 0). Telemetry mode `commit`. Hint and usage name the new forms.
- **CI is the test gate (ci-flow).** `agent-companion-tests` runs on ubuntu-latest and windows-latest; the Windows leg also runs `scripts-tests`. The pre-push hook only scans pushed commits for leaks and private names (seconds, no lease). `ci-local.mjs --pre-push-hook --with-suites` or `CI_LOCAL_PRE_PUSH_SUITES=1` brings the local suites back. Release flow: writers run targeted tests; the lander pushes `release/<ver>`, waits for both workflows green on that sha, fast-forwards main to it, installs after green.
  - **Windows 8.3 temp dir.** The dev-root safety check and the repo file listing in `leak-scan-core.mjs` (and the standalone `scripts/leak-check.mjs`) now compare canonical paths; the bench judge CLI caller ignores an asynchronous stdin EPIPE from a child that exits before reading its prompt.
- **Fix (high): the resource-queue wrap no longer changes what a command does (queue-wrap).** A heavy command used to have only its heavy segment wrapped and run in a new child shell, so a shell variable assigned earlier in the same line was empty there: `M=$(git commit-tree ...); git push origin $M:refs/heads/b` became a push of `:refs/heads/b`, which deletes the remote branch (2026-10-18; restored by hand). The gate now wraps the whole line, unchanged, and the queue runs it with `run --shell bash`: bash evaluates the line byte for byte (passed in the environment, so no second quoting layer and no Windows command-line parsing), with assignments, substitutions, here-docs, here-strings, arrays and `$?` as unwrapped. Only a leading `cd <dir> &&` stays outside so the directory change lasts; in rewrite mode a line that changes directory later is denied with the reason instead of rewritten. On Windows the queue uses Git's `usr\bin\bash.exe` (the `bin\bash.exe` launcher reorders PATH) and never a WSL bash; with no bash the command is not run in another shell. A push with `--no-verify` skips the pre-push hook and is no longer queued. New guard: a `git push` that deletes remote refs (empty-source refspec `:ref` / `+:ref`, quoted or not, `--delete`, `-d`, `--prune`, `--mirror`) is denied unless the command carries `# guard-ack: destructive-git`; dry runs pass, and the operator command guard's merged-branch clean-up form is left to that guard when it is installed.

## 0.31.29 — 2026-10-17

- **Kill guard (W1).** A kill inside `$( )` or backticks in an unquoted heredoc body, a shell fed by `<<<` or an echo/printf pipe (and `pwsh -Command -`), and a here-string or quoted string piped into `iex` / `Invoke-Expression` are now denied; quoted heredocs and text piped into a non-shell stay data.
- **Python-stdin and env guards (W2).** python_stdin_guard: a command substitution inside a piped-into command is fed by that pipe (N1), an inner NUL redirect still overrides it (N2), `time f() {` and `f() ( ... )` define a function judged at its call sites (N5). env_dump_guard: `env -S STRING` (also `-SSTRING`, `-iS`, `--split-string=`) is split into words and the command it names is judged, so `env printenv` / `env -S printenv` deny and `env -S "ls -l"` allows.
- **Reporting contract (W3).** Caps the final worker notice at about 300 tokens (detail goes to the detail file) and bars interim notices for planned background waits.
- **Calibration scout routine (W4).** The local run does the model-lineup diff on every run; cloud-only paths and the cloud-routine pin check are reported as not run locally, never as clean.
- **scout-ack (W5).** `scout-ack add` before any hand-off state exists is refused ("run the scout once first") instead of writing an ack the first scout run would void.
- **Scout detectors (W6).** `routing_trial_review_due` no longer re-raises a shipped trial that a winning profile row has replaced (the profile row's own reviewBy still raises); `routine_model_drift` ignores disabled scheduled tasks (`enabled: false`), cron or one-off.
- **Contribution folding (W7).** Fold gates in CONTRIBUTING.md, new CONTRIBUTIONS_INBOX.md entries and a lesson; leak-check warns on lesson bodies over 150 words.
- **env guard, second pass (fix S).** `env -S STRING` gets the full scan again (nested shells, `eval`, `xargs`, inline programs, quote-aware split), `env` as a prefix before a nested shell is judged, and `xargs` and `awk ENVIRON` programs are judged.
- **Review fixes (fix B).** Stale tests corrected; the worker-wait rules say no interim notice; a quiet local scout run prints nothing; the lesson word cap is 800; a corrupt scout state gets its own `scout-ack` refusal message; the inbox lists newest first.

## 0.31.28 — 2026-10-17

Five parts: the env-dump guard judges inline code, the 10-16 routing verdicts reach the shipped table, the daily scout hands off a delta instead of repeating itself, and three resource-queue probe nits from the 0.31.26 review, and idle and max-hold flag a live holder instead of releasing it.

- **Env-dump guard judges inline code (`env_dump_guard`).** Code inside a quoted program was invisible to the guard; it is now read. Covered: `node -e/-p/--eval`, `bun -e`, `deno eval`, `python -c` (also `-Ic`), a program fed on stdin (own heredoc, `<<<`, an upstream `cat <<E |` or `echo` / `printf` pipe, a PowerShell here-string), `bash`/`sh`/`pwsh` reading a script from stdin and `powershell -EncodedCommand`, through `uv/poetry/pipenv/pdm/hatch/rye run` and `npx/bunx`. The new module `hooks/lib/env-dump-inline.mjs` lexes the JS or Python (strings, comments, template and f-string expressions), follows aliases and copies of `process.env` / `os.environ`, and refuses a dump of the whole object or a secret-named read that reaches stdout or stderr; names-only forms (`Object.keys(process.env)`, `sorted(os.environ)`), counts, presence tests and output sent to a file pass. A program that does not lex is judged on the clear forms only, and a copy with \" and \' unescaped is judged too (PowerShell 5.1 and cmd argument quoting). A string handed to `execSync`, `spawn`, `os.system` or `subprocess` is scanned as a shell command.
  - **Stream fix.** `env 2>/dev/null` and `printenv 2>/dev/null` used to count as redirected and were allowed; redirection words are now dropped before classifying, so both are refused. Stdout and stderr are tracked apart (`2>&1 > file` leaves stderr on the pipe).
  - **`<<<` prints.** `cat|base64|grep|sed|... <<< "$SECRET"` is refused as a print (`grep -q/-c/-l` and a `${NAME:+x}` test excepted; `gh auth login --with-token <<< "$TOKEN"` stays allowed). A PowerShell first word in quotes is a string value, not a command, unless a double-quoted one expands a secret-named `$env:NAME`.
  - **Shared tokenizer (`process-kill-guard.mjs`).** Bash `<<<` is now one operator followed by an ordinary word (the here-string text was taken as a heredoc delimiter), and PowerShell `@'..'@` / `@"..."@` here-strings are one quoted data word, with `$( ... )` subexpressions in the double-quoted form still seen by both guards.
  - **Known false positives.** A names-only projection built from `Object.entries(process.env)` or `os.environ.items()` while a print exists in the same program is refused; the deny text points to the names-only forms.
- **10-16 routing verdicts applied to `config/model-tiers.json`.** `bounded-feature` and `integration` settle on sonnet/high (bounded-feature: n=131 at an effective 3.25 plan units against 6.39 for opus/medium; integration: n=47 at about 2.34 against 2.93, the F5 waiver dropped), and `verify` on sonnet/low (the haiku route was cheaper but failed on quality after a false verify report on 2026-10-09). Settled rows lose their review date; `large-refactor`, `long-autonomous-run` and `subagent-worker` are reviewed again by 2026-10-30. `ac-sonnet-high` now carries the self-review protocol and its description names the types it is the default for; ROUTING.md and the recommend skill follow the table.
  - **Scout detectors.** `session_churn` skips a review spawned by a subagent (the self-review protocol is a design, not churn); `haiku_fit_leak` skips grid rows (a declared weight is not a route the lead left); `project_agent_drift` reports once per repository and appends the count of drifted worktree copies.
- **Scout hand-off.** After each scout run `detect.mjs` computes a zero-token delta against the previous one (new, cleared, changed, repeating) and writes `scout-delta.json` / `scout-delta.md` with a per-signal streak of distinct UTC days (the first run replays `scout-history.jsonl`). An acknowledgement ledger (`scout-acks.json`, CLI `scripts/scout-ack.mjs`: `show | list | add | remove`; a note is required, default expiry 14 days) hides a signal until it changes materially (grows by at least 2 and half the acked count, or under 60% word overlap with every entry the ack saw) or the ack expires. Sessions whose cwd matches `scout_triage_cwds` (path prefixes, comma or semicolon separated; default empty) get a two-line SessionStart summary of the top three unacknowledged signals with days repeating; everything else is unchanged. New options `scout_triage_cwds` and `scout_repeat_days` (default 3); `/ac scout delta` in the calibration-scout skill.
- **Resource-queue probe nits (0.31.26 review).** A reused pid is kept out of the process tree by start-time evidence (a child that started before its parent is a stale ppid; an orphan is adopted only if it started no earlier than its dead parent and no later than the first sample that found it dead; a missing start time keeps today's adoption; Linux now reads start times from `/proc`). Busy-child command lines match the name as a whole token or path part (`javascript` no longer matches `java`, `fix/vitest-flake` no longer matches `vitest`). The exclusive check honours `CI_BUDGET_RESOURCES`: with `app-e2e=2` a holder at the max-hold limit is cleared plainly instead of flagged.
- **Idle and max-hold flag a live holder instead of releasing it.** While a lease holder is alive, neither the idle rule nor max-hold clears it: `status` shows `IDLE?` (quiet longer than `idleMs`) or `OVER TIME` (past its hold limit) and keeps the lease, and the "Shared resources:" session line appends ` IDLE?` / ` OVER` after the holder. Dead holders are still reclaimed by the pid-dead rule. The wrapper writes the sampler evidence (process count, shells, CPU, ports, why) as a JSON second line of the `.act` sidecar, so a flag shows what the probe saw; old readers still read line 1.
- **`ac-sonnet-high` carries the generated self-review block.** The generator writes the protocol block into every rung that is the default route for a `selfReview` type, and the 10-16 verdicts route `bounded-feature` and `integration` to sonnet/high. The spawn guard appends the text only to a rung whose file lacks the block, so there is no second copy.
- **Review fix round.** Four fixes from the pre-release review; the version stays 0.31.28.
  - **Reviewer-rung note.** A rung that already carries the self-review block (such as `ac-sonnet-high`) gets a short note from the spawn guard naming the reviewer rung the routing table sets for its pair (and the critical preset), so the block's older rung text does not win; still no second protocol copy.
  - **Resource queue.** A flagged live holder is released by the sweep after a 4 h ceiling (`live-holder-ceiling` rule; `ceilingMs`, 0 or `enabled:false` turns it off). A stale heartbeat on a verified-live wrapper pid (start time no later than the grant) is flagged `HEARTBEAT STALE` and kept. `IDLE?`, `OVER` and `HB?` all show on the "Shared resources:" line, with the hand-release command. New CLI `resource-queue.mjs release <lease-id>` (a unique 4+ hex prefix works). A reused pid is re-adopted into the process tree by start time.
  - **Scout hand-off.** An ack with a missing or unreadable `expires` counts as expired; a cleared signal drops its acks; no triage line on `compact`; the ledger is written under a file lock and an unreadable one is kept as `scout-acks.json.bad`.
  - **Env-dump guard.** Denied: the PowerShell call operator or a dot-source running an env program (also `$x = & '...'` and `$x = . '...'`), `exec(` and template-literal commands in inline code, a bash-expanded secret `$NAME` in inline code or an unquoted heredoc, and screen targets (`/dev/stdout`, `>(...)`, `CON`, `*>&1`). Inline code over the 50,000-character cap gets the raw-text check for the clear forms instead of being skipped. Allowed: a count of the env object, its keys or entries (`.length`, `len(...)`) and captured python output when nothing prints.

## 0.31.27 — 2026-10-17

Fix: the resource-queue probe split a process command line with the host dirname, which returns "." for a Windows path on Linux, so the Linux CI run of 0.31.26 failed the msys sampleTree test; it now splits with win32 rules on any host (Windows behavior unchanged), with a test that runs the Linux branch by injection.

## 0.31.26 — 2026-10-17

Fix: the resource queue's idle rule released a live push-gate lease (`app-e2e` shown free) while a full E2E ran under it.

- **Root cause.** The activity probe walked Windows parent pids only. When a Git Bash (msys) process forks and the child execs another msys program (a pre-push hook running an npm or npx shim through bash), the exec'd program is a new Windows process whose Windows parent, the forked child, exits at once. Everything under it had a dead Windows parent and fell outside the walk: the probe saw only the wrapper, git and the hook's sh, all quiet, and never recorded activity (the clear's evidence: idle 600371 ms of a 600389 ms hold). Reproduced on Windows with a wrapper -> sh -c -> msys sh script -> node -> busy node tree.
- **Probe.** `sampleTree()` adds msys parent links from Git's `ps -a -l` (one hidden spawn in the wrapper, never on the hook path), adopts the children of any pid seen in the tree before it died, sums CPU per pid against the previous sample (an exited process no longer masks the rest), matches busy children by command line as well as image name, and counts an msys process in the tree as active when the msys list is unreadable (unknown means keep).
- **Max-hold.** A live holder of an exclusive resource is no longer released at its hold limit while it is active or unmeasured: `status` flags it `OVER TIME` (holder field `overTime`) and keeps it. It is cleared only when its probe shows it quiet for `idleMs`. Box-only leases keep the plain clear; dead and stale holders are cleared at once, as before. Clears still never signal a process.
- **Finding ps.exe.** The probe finds Git's `ps.exe` the way the plugin finds Git Bash, not through PATH alone: beside the tree's own sh, then `CLAUDE_CODE_GIT_BASH_PATH`'s install, the standard install dirs, PATH, and last `git --exec-path`. A hook or the push gate can run with a stripped PATH. The real msys process-tree test names every program by absolute path and skips with a stated reason when Git's `ps.exe` cannot be found; it had failed only inside the push gate, which hides every PATH dir holding a `claude` binary (here node's own dir), so its bare `node` never started.
- **Limits.** `e2e`, `e2e-spec`, `push-gate` and the `app-e2e` resource flag over time at 30 minutes (loaded full runs measured 10 to 18 minutes).
- **Status.** CIM process start times are parsed (the PowerShell 5.1 `/Date(ms)/` form).

## 0.31.25 — 2026-10-17

A machine-wide resource queue with a gate that routes heavy commands through it, a "Shared resources:" session line, and three new guards (kill by name, plugin uninstall, environment dump). The one spec of the queue is now `docs/resource-queue.md`.

- **Resource queue.** `scripts/ci-budget.mjs` moved from the repo's `scripts/` to the plugin (`scripts/ci-local.mjs` imports it from there) and now schedules more than test workers: `box` units (CPU) plus named exclusive resources (`app-e2e`, `android-emu`, `gradle-{cwd}` ...), all granted at once in one lease. Admission is per-resource FIFO, box units against the sampled outside load, and RAM: free memory must cover the request after a reserve of `max(2 GB, 12.5%)` of total RAM and the RAM of leases still ramping up. New CLI `scripts/resource-queue.mjs` (`run`, `status`, `sweep`, `install-launcher`, `reserve`, `unreserve`, `hold`, `resume`); `run` keeps the command's exit code and quoting, runs it below normal priority, and `RESOURCE_QUEUE=0` skips the queue. `status --json` is schema version 1. A generated launcher at `~/.claude/agent-companion/bin/resource-queue.mjs` keeps the same path across plugin updates.
- **Rules and clears.** `config/resource-rules.json` ships measured classes (e2e, vitest, lint, emulator, gradle, install ...); a user file under `<claude dir>/agent-companion/config/` overrides it. Rule sweeps clear dead, stale and gone entries and, for run leases, `max-hold` and `idle` (low CPU, no listening socket in the class's ports, no busy child). A clear only releases the claim: it never kills a process, and a cleared process that still runs counts as outside load. Every clear is appended to `clears.jsonl` in the ledger directory.
- **Reservations, hold and bound leases.** `reserve <resource> --for <group> --until <time>` makes other groups step aside for one resource, for at most 4 hours; it ends on expiry, when its owner is gone, or on `unreserve`. `hold` / `resume` pause the caller's own queued entries without losing their place. `run --bind-pid` ties a lease to a daemon's pid. A removed yield-file branch means no file read by the queue can stop all waiters.
- **Reservation idle lapse.** A reservation ends when no job of its group has held or waited for the reserved resource for `reservationIdleLapseMinutes` (`resource-rules.json`, default 20; 0 or null = off), counted from its creation or the last matching activity. Matching activity is a live lease or live queued ticket of the reservation's group that uses the reserved resource (a paused ticket counts as a waiter), or the release of such a lease; it is kept in the ledger sidecar `reservation-<id>.active` (`{lastMatchAt}`). The sweep removes the reservation under the rule `reservation-idle-lapse` and logs it to `clears.jsonl` with evidence `{forGroup, createdAt, expiresAt, endsAt, idleMinutes, lastMatchAt, lapseMinutes}`.
- **Resource gate (`resource_gate`: `deny` default, `rewrite`, `hint`, `off`; `resource_gate_permission_modes`, default `bypassPermissions`).** A PreToolUse step inside `bash-tail.mjs` (no extra hook process) refuses a heavy Bash command, or in `rewrite` wraps it in the queue, and the text gives the exact queued command. Targeted runs, commands already in the queue and `ci-local` are untouched. New `telemetry/resource-gate.jsonl`. `rewrite` is proven in tests; whether Claude Code applies it under `bypassPermissions` is not yet verified live.
- **Session line (`shared_resources_line`, default on).** A `Shared resources:` line of about 300 characters at session start, and before a prompt when it changed, while the queue has something held, queued, reserved or recently cleared. Nothing is added while idle.
- **Kill-by-name guard (`kill_by_name_guard`: `deny` default, `warn`, `off`).** Refuses `taskkill` without `/PID` or with `/IM`, `pkill`, `killall`, `Stop-Process -Name`, name-filtered `wmic`/CIM deletes, and a kill fed by a name lookup; kills by PID pass. Logged as guard `kill-by-name`.
- **Plugin-uninstall guard (no option).** `claude plugin uninstall`, `remove` and `rm` are always denied, because an uninstall deletes the plugin data directory; the text names the safe refresh. Logged as guard `plugin-uninstall`.
- **Env-dump guard (`env_dump_guard`: `deny` default, `warn`, `off`).** Refuses bare `env`, `printenv`, `set`, `export -p`, `Get-ChildItem env:` and similar, and printing a variable whose name has a part TOKEN, KEY, SECRET, PASSWORD, PASSWD, AUTH, CREDENTIAL or COOKIE; names-only and count-only forms pass, and so does a secret piped into a consumer that does not echo it (`echo "$TOKEN" | docker login --password-stdin`). Logged as guard `env-dump`; the `detail` is the kind and the program word only, never the command.
- **Review fixes.** The gate no longer classes `git push` as `push-gate` when the repo's pre-push hook only runs git-lfs or echoes (an unknown, empty or unreadable hook stays heavy). Quotes inside a `"$(cat <<'EOF' ... EOF)"` commit or PR body, and apostrophes plus backticked words in it, are data for the gate and for the kill, uninstall and env-dump guards. The plugin-uninstall guard no longer matches a project's own `cli.js`.
- **Docs.** CONTRIBUTING.md gains one "Install a release" section with install rules R7 to R10 (one user-scope record, no project enabling line, hand-install, fresh session); the Shared CI budget spec moved to `docs/resource-queue.md`.

## 0.31.24 — 2026-10-16

A test fix: the ci-budget suites no longer depend on the host's core count, which turned main CI red on 0.31.23. And the daily checkup measures the share of worker units over the active context ceiling, not only over a fixed 150K.

- **Share over the active ceiling.** 0.31.23 raised the `subagent_ceiling_tokens` default to 175K, but the checkup still measured `shareOver150kPct` against a hard-coded 150K, so a trigger reading it could take "ceiling not biting" from the wrong line. Day records now add `subagent.ceilingTokens`, `unitsOverCeiling` and `shareOverCeilingPct`, measured against the option as the subagent-context hook reads it (default 175000; a value that is not positive measures against 175000). `shareOver150kPct` stays, so the history series keeps comparing. The hourly buckets gain the ceiling-share slot and the ceiling they were counted against; a day whose hours were counted against two ceilings (the option changed) or that holds hours from a state written before 0.31.24 has `null` there, and the register reads it as a gap. New register metric `shareOverCeilingPct` (source `history`, also through the usage-analysis runner, which reads the day's history record), and a usage-analysis default `ctx.overCeilingShare` beside `ctx.over150kShare`. The shipped example register has no trigger on the 150K share, so nothing there moves; a personal register's trigger on `shareOver150kPct` should switch its `metric` to `shareOverCeilingPct`.

- **ci-budget test worlds pin their core count.** The fake worlds in `ci-budget.test.mjs` and `ci-budget-fixes.test.mjs` injected a cpu sampler and turned the load guard off with `reserve: 0, loadPct: Infinity`, but left `cores` to the host. The guard's threshold is then `cores - reserve`, so on the 4-core Linux runner a fake reading of 5 busy cores counted as a loaded machine and grants dropped to one worker; on the 32-core Windows box it did not. Two tests failed on CI only ("external load" and "resize"). The worlds now pass `cores: 64`. `os.loadavg()` is not read anywhere in ci-budget, so the Windows-zero-loadavg difference played no part. No product code changed.
- **Regression test.** `scripts/tests/ci-budget-small-host.test.mjs` re-runs both suites under a preload (`scripts/tests/fixtures/small-linux-host.mjs`) that makes the process look like that runner: 4 cores, a non-zero loadavg, 3 cores busy. Before the fix it fails with the same two tests as CI.

## 0.31.23 — 2026-10-16

A higher context ceiling, a one-wait rule without the hand-back clause that refuses repeat polls, and ci-local that runs at below-normal priority and leaves headroom for hooks.

- **Context ceiling 175K.** `subagent_ceiling_tokens` default 150000 -> 175000 (scope unchanged). A 10-16 simulation over 544 workers put 175K best (-9.6 against -7.8 units/day, 18% fewer handoffs, about 40K headroom before the ~217K subagent compaction). The repeat line stays off; its help text no longer says 175000 restores a second notice.
- **One-wait rule.** The "Cannot wait: STATUS: partial, the lead waits" clause is gone from the `worker-one-wait` spawn rule and from the worker hint; both now point at a `run_in_background` command, `pr-wait.mjs` for PRs and CI, and a background `gh run watch` for a main-branch run. No worker used the clause in 1,109 final messages; a handled partial costs the lead about 0.6-1.0 units.
- **Repeat polls denied (`worker_wait_guard`: `hint`, `deny-repeat` default, `off`; `worker_wait_repeat_window_minutes`, default 15).** A repeat sleep, poll or watch loop by the same worker in the same session within the window of its previous match is refused, naming the sanctioned wait, and logged to `denials.jsonl` (guard `worker-wait`); every match restarts the window; `worker-wait.jsonl` rows gain `action` (hint, deny, silent). `worker_wait_guard: hint` restores the 0.31.22 behaviour. Data: polling loops still cost 9.8 units/day, 47% of hint rows on 10-16 were repeat polls, and 82% of matches follow the worker's previous match within 15 minutes.
- **ci-local below-normal priority.** `lowerOwnPriority()` lowers ci-local's own priority at start (silent on failure); the suites, test processes, their children and the pre-push gate inherit it. Hooks are untouched and keep normal priority; no hook timeout changed.
- **CI budget headroom.** The shared budget keeps a core reserve (`CI_LOCAL_RESERVE`, default max(1, cores/8)) and a load threshold (`CI_LOCAL_LOAD_PCT`, default 90): on a loaded machine a lease gets one worker per lane, and nothing waits or fails. A long pass runs in slices (`CI_LOCAL_SLICE`, default 6 files per worker; 0 = single run) and re-samples the load between slices. The lease protocol and file formats are unchanged; `status` gains the load-guard fields. CONTRIBUTING.md documents the knobs.

## 0.31.22 — 2026-10-16

Hook-process timing telemetry, a lead-effort rule that informs instead of asking, spawn rows that carry the working folder with a project-dir agent lookup, and the scout's naming and finished-task fixes.

- **Hook timing (`hook_timing_telemetry`, default on).** Each hook process appends its CPU and wall time (Node startup included) to `telemetry/hook-timing.jsonl` as it exits (8 MB cap, one rotation). Fixture and canary sessions are not recorded. `node scripts/hook-timing.mjs` reports processes per call by tool, CPU and wall per call (median, p90), per-day totals, parallel vs sequential per event, and an estimate (E) of one process per event.
- **Lead-effort rule informs.** The rule now informs once, in the lead's first report, when the lead runs below xhigh. It no longer asks the operator, waits, or blocks a spawn; other behavior is unchanged.
- **Spawn rows and agent lookup.** `spawns.jsonl` rows gain `cwd`, `project_root` and `project_dir_env`, each as a path key (`path:` and a short hash, never the path, since rows are path-free). Project agents are also looked up under `CLAUDE_PROJECT_DIR/.claude/agents` (after the cwd chain, before the user's folder), fixing unpinned spawns when the lead's cwd had moved out of the project.
- **Scout naming.** `project_agent_drift` names repo roots "repo root N" and worktrees by tree, and lists a root once however its path is spelled.
- **Finished one-off tasks.** `routine_model_drift` skips disabled one-time tasks whose fire time has passed, so the routine-effort-pins/t-model-drift flag no longer fires for them.
- **Pricing check.** The Sonnet 5.5 cache-read price was verified at $0.10/MTok against the pricing page; the table was already correct, no change.

## 0.31.21 — 2026-10-15

The usage summary names info-severity regressions, the scheduled analysis waits on a held lock, and the python-stdin guard covers wrapped forms and logs each deny.

- **Info-severity regressions.** The usage summary counted only alert-severity scenarios at status regression, and nearly all shipped scenarios are info, so it read "regressions: none" while info scenarios had regressed. Info-severity regressions are now counted and named (`summary.infoRegressionIds`): "none at alert severity; N info-severity (not paged): ids". Alert paging (`regressionIds`, the scout `usage_regression` signal) is unchanged.
- **Scheduled run waits on the lock.** `usage-analysis.mjs --scheduled` waits (bounded, 100 s, polling every second; `--lock-wait-seconds`, `--lock-poll-ms`) for a held lock, then runs and records itself. Still held after the wait: exit 3 with `lockTimeout`, and the scout routine re-runs once. A hand-typed run is unchanged (skip, exit 0); a stale lock is removed with no wait.
- **Repo-root names.** `plugin_project_copy` names repo-root records "repo root" (numbered "repo root N" when several) instead of the project name, which the scout scrubbed to `<name>`. Worktrees keep their tree name.
- **python_stdin_guard coverage.** The guard now judges python-reads-stdin inside for/while/until bodies, shell function bodies (at their call sites), behind `timeout N` and `env -u VAR`, and inside quoted `"$(...)"` substitutions, exactly as the plain call. Each deny is logged to `denials.jsonl` (guard `python-stdin`; outcome `warn` in warn mode). The judging pass has a 3M-step budget; running out fails open (allow).

## 0.31.20 — 2026-10-14

Hotfix: CI on Linux was red since 0.31.18; no behavior change.

- **Fixture username check.** The usage-scenarios test refused its own source when it contained the OS account name anywhere. On a GitHub-hosted runner that account is `runner`, a word the file uses in prose ("through the runner"), so the check failed there and passed on Windows. A hosted CI or container account (`runner`, `root` and a few others) is now checked only as a path segment, as `scripts/leak-check.mjs` treats a generic handle; any other account name is still refused anywhere in the file, now case-insensitively.

## 0.31.19 — 2026-10-14

Hotfix: the daily usage analysis computed no day on an upgraded install.

- **Usage facts backfill.** A checkup state written before the fact sink existed (every install upgraded from 0.31.17 or earlier) started its facts at the next whole day, so `usage-analysis.mjs --scheduled` found no facts day and printed `computed: []` for up to two days. The scan now rebuilds the facts once, as the design's first-install backfill: each transcript is re-read from its start up to the scan's own cursor, for the closed days in the last 8 (never before the scan began), into a fresh accumulator; the scan then goes on from the cursor, so nothing is counted twice and the facts equal a full scan. A state 0.31.18 already upgraded is rebuilt the same way (its partial spawn records are replaced). Runs once per state; a fresh install is unchanged. A day with a spawn still open stays deferred until it closes or 48 h pass, as before.
- **Scout step timeout.** The scout gives its `usage-analysis.mjs --scheduled` call a 10-minute timeout, since the one-time rebuild can take a few minutes.

## 0.31.18 — 2026-10-13

The daily usage analysis (facts, config, comparison library, runner, scenarios, skill and docs, scout signals, register scenario trigger), a shared machine-wide CI worker budget, one install per machine at user scope, and a `python_stdin_guard`; plus the review fixes for each of those.

- **Usage metric registry.** One registry of usage metrics; the decision register's metric catalog is now a projection of it.
- **Usage facts.** The checkup scan feeds a fact sink and writes per-day facts files; facts carry spawn records (request categories, context buckets, startup cost, compactions, extra turns, STATUS word, simple runs, re-spawn key). A spawn open across the day boundary lands on its start day, with `usage-facts/open.json` as the carry-over mirror; a spawn with a visible completion closes at once, idle and 48 h stay as the fallback.
- **Usage config.** Layered usage-analysis config (shipped, user, `project:<label>/`) with a loader, validation and `usage-config.mjs` check, explain and list.
- **Settings journal.** A SessionStart journal of configured model and effort, feeding `setting:` window events.
- **Comparison library.** Cohort filter, tree and session exclusions, prior-day, trailing-7, same-weekday-4 and window comparisons, event resolution for rollout, decision, release, cli, tag, config and setting, point, Wilson and seeded-bootstrap thresholds, groupBy; a `level` kind compares a day's figure against a fixed zero. Pure, UTC day arithmetic, gaps never zeros.
- **Daily usage analysis runner.** `scripts/usage-analysis.mjs` scans, then computes every settled checkup day not yet computed into `state/usage-analysis/<day>.json`, a dated report `reports/usage/usage-<day>.md`, a 3-line `state/usage-analysis-latest.json` and a status file. Results are idempotent (inputsDigest; a config or facts change gives revision+1 with its reason); a day with open spawns or partial data is deferred, never zero-filled; `--scheduled` never waits and defaults to `--max-seconds 120` and `--max-days 14`; `--dry-run` writes nothing; with `usage_analysis` off a scheduled run prints one line and exits 0. It shares the checkup lock and writes only below the state root. No model call.
- **Checkup pipeline and summary.** The background checkup runs scan, usage analysis, status, then the register, in one lock. SessionStart shows the 3-line usage summary once and again only when the set of regressions changes; unattended sessions (`CLAUDE_CODE_SESSION_ATTENDED=0`, a routine folder, a scheduledTaskId) never see it and no longer mark the daily checkup line as shown, and the same guard covers the release and register lines. Rung labels are `model/effort` (`sonnet/high`) everywhere, with `sonnet-high` accepted as an alias in cohort config. New option `usage_analysis` (default true).
- **Scenarios.** Day, week, plan-meter, lead, exclusion, worker, routing, review, context, Haiku, routine and plugin metrics with shipped scenarios and stat adapters for the remaining register metrics; spawn telemetry and scheduled-run records are read for them; `usage-acceptance-xhigh.mjs` runs the xhigh-window acceptance.
- **Scout reads the analysis.** New signals `usage_regression`, `usage_analysis_stale`, `usage_analysis_config_invalid` and `routine_model_drift` (each fires once per change; a quiet day emits nothing). The scout moves to 04:10 local and runs `usage-analysis.mjs --scheduled` first; its plugin update step runs only when the new option `scout_plugin_update` (default true) is not false. Declares `usage_analysis_report_dir`. The routine pins `model: sonnet`.
- **Register scenario trigger.** Decision register `scenario` trigger kind, `{"kind":"scenario","scenario":"<id>","comparison":"trailing-7","on":"regression","minDays":2}`, reads the runner's result files and recomputes nothing. Ids and comparisons are validated against the usage-analysis config (loaded lazily, so the register does not load usage config at import); a missing, deferred or unusable result day is a gap, never a fire. The `usage_regression` signal route keeps working.
- **Usage skill and docs.** `usage-analysis` skill, `/ac usage` forwarder row, `docs/USAGE-ANALYSIS.md` (analyze a day, explain a result, add a user or `project:<label>/` scenario; zero tokens), `usage-analysis.mjs init --from-register` (writes only when the file is absent, otherwise prints a diff; proposes only rollout rows that exist), and a test that every routine carries a `model:` line.
- **Usage review fixes.** Project scenarios are always scoped to their own project; `environment.day.boundaryUtcHour` other than 8 is refused (facts days are cut at 08:00Z, 04:00 EDT or 03:00 EST from 2026-11-01); the settings journal records configured model and effort, bounds cwd and serializes simultaneous writers under a lock; only a real launch ack keeps a spawn open; a continued worker re-opens its spawn; scenario metrics and params are validated against the registry in `usage-config` and the register. A session-scoped exclusion keeps the session's worker records; the summary says "n/a (0 scenarios evaluated, N gaps)" instead of "regressions: none" when nothing was evaluated; a scenario without a metric adapter is a gap every day; unobservable exclusions are named; a settled day with zero sessions is a real 0 for sum metrics. No stale alarm on the first morning after install; signal text keeps rung labels and command hints; scenarios read spawn type and real struggle rows; routine drift and missed runs alert on every day through `level`; `week.pace` is a gap early in the plan week; the usage config and facts lines are allowlisted in the route-readers scan.
- **Shared CI budget.** `scripts/ci-local.mjs` (and so the pre-push hook) takes its test workers from a machine-wide budget (`scripts/ci-budget.mjs`, default half the logical cores, `CI_LOCAL_BUDGET`) instead of the one-run `ci-lock` mutex, which is removed: several runs may go at once, a busy box means fewer workers or a fair wait, never a failure, and `--test-concurrency` is the grant. Git- and sh-heavy test files run in a pass of their own under a capped heavy lane (`CI_LOCAL_HEAVY_MAX`, `CI_LOCAL_HEAVY_COST`); a run of only single scripts takes a 1-unit express lease; a worktree still on the old lock counts as one full run; dead or hung holders are reclaimed by heartbeat; a released lease cannot be revived. No wait is unbounded (heavy pass 10 min, full-run queue `CI_LOCAL_QUEUE_MAX_WAIT_MS` 30 min, express 5 min; each then goes on with one worker and one line); a ledger or cpu-sampler error runs unmanaged with one line; `node scripts/ci-budget.mjs status` shows who holds the budget. The lease protocol is specified in CONTRIBUTING.md.
- **One install per machine.** agent-companion runs from the user-scope record. `scripts/version.mjs` judges only that record; each project- or local-scope record is reported as "should not exist (user scope only)" (never STALE) with its project path, the settings file whose `enabledPlugins` line recreates it and the fix; with no user record it says to install at user scope first. Scout `plugin_version_behind` and `plugin_copy_stale` read the user record only; new `plugin_project_copy` signal lists every project or local record; the scout's install and update commands pass `--scope user` and warn instead of touching project records. Setup, the version skill, README, CONTRIBUTING and the hook recovery text install and update at user scope.
- **Python stdin guard.** New option `python_stdin_guard` (deny (default), warn, off): on Windows, a Bash or PowerShell command that starts Python reading its program from a NUL stdin (`python3 -`, a bare `python3`, an empty heredoc) is denied, since it spins a REPL that outlives the tool timeout; `-c`, `-m`, a script file, a non-empty heredoc or a pipe pass, and `# guard-ack: python-stdin` acknowledges. Follows `(python3 -)` and `{ python3 -; }` groups. Poll-guard warn mode keeps the worker one-wait advisory.
- **Rung normalizer.** `normalizeRung` lives in the dependency-free `usage/rung.mjs`, so the register's metric path never loads usage config; the runner now passes the metric registry to `loadConfig`.

## 0.31.17 — 2026-10-13

Review nits from 0.31.16, a stricter decision-register check, a mistyped-floor report, a fix for "Other live sessions", a ledger that sees stopped workers, and hygiene fixes; plus the reviewer tier floor, the routine model-drift signal, haiku-fit measurement and signal, the routine pin rule (new option, new deny), the `research` route, the granularity batch (finer task types, ceiling handoff nudge, one-wait rule, bash exit telemetry, post-PASS defect signal) and the new `type_line_required` option.

- **Register checks.** `decision-register --check` now rejects control characters (U+0000-U+001F, U+007F) in trigger `pattern` and `flags`, naming the decision, trigger and code point; state writes keep triggers and baselines a concurrent writer added. `routing-profile.mjs set` refusing a model row with no effort is now covered by a test.
- **Tier floor typo.** A mistyped `tiers.<alias>.minEffort` (not one of the tier's efforts) still fails open, but is now reported by the scout as `tier_min_effort_invalid` and by `routing-table.mjs --check-agent-descriptions`; the haiku effortsNote now says the grid enforces medium; the override example in the retirement comment no longer uses haiku.
- **Review nits from 0.31.16.** The legacy `claude-haiku-4-5` pin no longer draws the rule-1 "set effort" note (reference models are checked before the alias), `scout_suppress: decision_review_due` now also stops the date-trigger scan, one unbounded regex group removed from the pinned-model scan, stale haiku comments and a dead doc pointer fixed, tests tightened.
- **Hygiene.** Advisory claim files older than 14 days are pruned; `struggle-patterns.json` entries with nested quantifiers are skipped (ReDoS guard); the "state keeps no prompt text" test now stores real sentences; the README states `known_peers` / `related_repos` must be JSON strings, the 256 KB catch-up tail limit, and a neutral tier-override example.
- **Local CI lock.** `scripts/ci-local.mjs` (and so the pre-push hook) now takes a machine-wide lock before its first suite, so only one full run goes at a time across all worktrees (waiters print the holder and poll every 5 s; dead or 45-minute-old locks are taken over; `CI_LOCAL_MAX_PARALLEL`, `CI_LOCAL_LOCK=0`); the timing margins in the `pr-wait`, `git-brief` and `read-dedupe` tests are widened so they hold under load.
- **Live sessions.** "Other live sessions" now requires the newest timestamped record (not just the file mtime) to be within 2 h, so idle transcripts touched by the desktop app or orphaned CLIs are no longer listed; age and order use the record time. Tests added for subagent tick silence and subagent transcripts in the catch-up scan.
- **Worker ledger.** A worker stopped with TaskStop now gets a stop row (new PostToolUse `^TaskStop$` hook); a start with no stop counts as running only while its subagent transcript was written in the last 15 min (6 h age cap when no transcript is found), which ends zombies from crashes, resumes and operator-rejected prompts; state pruning also runs on stop and session start (hourly); the overdue-worker telemetry read is 256 KB and skipped with no running worker; repeated SendMessage to a known or already-warned peer no longer rescans the transcript. A worker blocked more than 15 min on one tool call is hidden from the overdue notice until it writes again.
- **Reviewer floor.** Reviewer parity now honors a tier's `minEffort`: a `haiku/low` writer gets a `haiku/medium` reviewer (raise only; `--explain` shows the `haiku-min-effort` floor); docs/ROUTING.md notes it.
- **Routine model drift.** Scout signal `routine_model_drift` compares the last 48 h of desktop scheduled-run records with each task's `model:` line and its folder effort pin, and lists tasks with no `model:` line (the app then starts them on the composer's last-selected model); setup now adds a `model: opus` frontmatter step to the scout task; the routine-placement note shows the model a folder effort pin is keyed to and whether the task has a `model:` line.
- **Haiku fit.** Review verdict rows now record `reviewed_model`/`reviewed_effort` (the WRITER line) and `reviewer_model`/`reviewer_effort`, so reviewer FIX rate by writer model is measurable; new scout signal `haiku_fit_leak` counts spawns routed to a haiku rung in the last 7 days that ran on another model, with the top agent types.
- **Routine pin rule** ("all routines are evaluated and pinned"): a `RemoteTrigger` create/update whose `job_config` has no `ccr.session_context.model` is denied (full ids get a non-blocking alias note); the routine placement note now states the model pin and whether the cwd effort pin applies; a PostToolUse check names the SKILL.md path when a new local task has no `model:` line. Option `routine_pin_rule` (default on).
- **`research` route.** `TYPE: research` moves from haiku/medium (it was an alias of explore, so on the Haiku trial row) to its own task type on sonnet/medium; explore excludes multi-hop research; spawn-guard adds a non-blocking note when a Haiku-routed spawn asks for another model (a trial leak, reported by `haiku_fit_leak`), silent with a `REASON:` or `WARRANT:` line, never a deny.
- **Context-ceiling handoff nudge.** A subagent on sonnet/high or above (and every opus rung) is told ONCE, at `subagent_ceiling_tokens` (default 150000), to write a handoff file and return `STATUS: partial`, so the lead can start a fresh worker on the same rung; haiku, sonnet/low and sonnet/medium are never nudged. A second nudge only when `subagent_ceiling_repeat_tokens` is set (default 0, off).
- **Worker one-wait rule.** New `worker-one-wait` spawn rule (one line in every spawn brief) and a one-time hint from `hooks/poll-guard.mjs` when a subagent runs a sleep, poll or watch loop in Bash or PowerShell, with a `worker-wait.jsonl` row per match; option `worker_wait_advisory` (default on). Advisory only.
- **Finer task types.** `lookup`, `survey` and `bounded-feature-small` are real task types with their own routes; the `lookup` alias is removed, `explore` stays. `docs/ROUTING.md`, the recommend skill and two agent descriptions regenerated.
- **Worker status in the ledger.** A worker ledger stop row now records the worker's final `STATUS:` word (done, blocked, partial).
- **Bash exit telemetry.** New `bash-exit.jsonl` (PostToolUse and PostToolUseFailure on `^Bash$`): exit code, failed flag and a hash of the normalised command, never the command text, so repeated failures of the same gate can be counted. Record only; option `bash_exit_telemetry` (default on).
- **Post-PASS defect signal.** When a FIX or BLOCK verdict lands on a branch that earlier drew a PASS, one row goes to `review-outcomes.jsonl` (`post_pass_defect: true`, at most one per PASS); the decision register folds it into the PASS reviewer's spawn row at read time. An upper bound, not a verdict-quality judgement.
- **Type line required** (new option `type_line_required`: deny (default), warn, off). A ladder-rung spawn (`ac-*`, not the browser variants) with no `TYPE:`, `WEIGHT:` or `KIND:` line is denied (`deny`) or, with `warn`, allowed with a note folded into the role nudge; a weighted `WARRANT:` stands in, `CONSEQUENCE:` alone does not. A worker spawning a worker gets an extra sentence. README row, TELEMETRY guard name and recommend skill updated.
- **Ledger liveness fixes.** `TaskStop` by worker name (not only by id) now writes the stop row; a subagent blocked inside one long tool call stays counted as running for up to 90 min of an open call (the 15-min idle bound applies otherwise); liveness is judged from the last record time, not the file mtime.
- **Routine placement fixes.** The post-create check takes the task id from the result when the input also has a `taskId`; a top-level `effortLevel` pin in the folder settings is now reported consistently in the placement note.
- **Spawn-guard and struggle nits.** An empty `REASON:` line no longer silences the Haiku-leak note; the struggle-pattern ReDoS guard also skips one more nested-quantifier shape.
- **Reviewer floor on legacy ids.** The tier `minEffort` floor is skipped for reference models that take no effort (`claude-haiku-4-5`), so a legacy-pin writer no longer gets a `medium` reviewer.
- **Review fixes (docs and signals).** `routine_model_drift` ignores runs that predate the pin and handles `best` / `opusplan` and frontmatter forms; README alias count and `overdue_worker_warning` row, TELEMETRY table pipes, scout dispatch rows for the new signals, the routing-doc per-tier example and the model-tiers `updated` date corrected; `docs/ROUTING.md` and the recommend skill regenerated.
- **Granularity fixes (verdict and status).** The post-PASS defect branch key now follows the branch under review (the `BRANCH:` line, the token after "review", or the range head), ignoring file paths and base branches; STATUS template echoes no longer parse as a status; `TYPE: operate` workers get a `worker-one-wait-operate` variant that waits in one foreground `pr-wait` call instead of handing the wait to the lead.
- **Granularity fixes (bash telemetry and poll guard).** `bash-exit.jsonl` records `run_in_background` calls as background (exit null, `background: true`) instead of a finished exit 0, and the hook also accepts the PowerShell tool name; the worker one-wait detector reads sleep units (`2m`, `1h`), scans `bash -c` / `sh -c` / `-Command` / `ssh` quoted bodies, ignores `while read` batch loops with no sleep or status polling, and ignores heredoc bodies.
- **Takes effect** in a new session.

## 0.31.16 — 2026-10-12

Sonnet 5.5 and Haiku 5.5 in the tier data, alias-only routines, a drift signal for pinned model ids, routing review dates, and `date` and `signal` triggers for the decision register. Labels: M measured, E estimated.

- **Tier data.** `sonnet` resolves to Sonnet 5.5; `haiku` is Haiku 5.5 (takes effort, default medium, 1M context, no retirement before 2027-10-07). The Haiku 4.5 retirement state and every warning that pushed users off haiku are gone. The haiku rows, the ladder rung, the explore and verify trials and `ac-haiku` name medium effort (an empty effort floors to low, which Anthropic advises against for agent work, E). A haiku spawn with no effort in its definition now inherits the lead's effort with the "no effort stated" note, and its spawn telemetry reads `inherited` (was `none`).
- **Prices and windows.** Sonnet 5.5 cache read is $0.10 per MTok (was $0.20, M); Haiku 5.5 is priced ($0.10 in, $0.50 out, read $0.01; the step above 100K prompt tokens is not modelled); both are 1M windows with compaction at 967K. Plan units are unchanged: the plan baseline stays on the Sonnet 5 price vector (M, `models-5-5-data` test).
- **Aliases.** The setup skill, the calibration-scout skill and the daily routine name models by alias (`sonnet`, `opus`, `haiku`), not ids.
- **Pinned-model signal** (new option `pinned_model_check`, default on). The scout reports a full model id pinned where the alias would do, or one the tier data marks superseded, in the tier data, scheduled tasks, settings and agent definitions (user and known projects); dispatch `manual-check`, once per distinct pin. The daily routine also lists cloud routines through RemoteTrigger when it has it, and says so when it skips. New signal `model_tier_data_changed` when a tier's model id moves. Reverse: set `pinned_model_check` false, or list `pinned_model_id` / `model_tier_data_changed` in `scout_suppress`.
- **Routing review dates.** `/ac routing set` takes `--review-by YYYY-MM-DD` (trial review date; default stays 90 days; a past, unparseable or valueless date is refused and nothing is written) and `--settled` (a decided choice: state adopted, no review date; not with `--review-by`). The scout's `routing_trial_review_due` now also covers your own trial rows whose `reviewBy` has passed, and ignores settled and retired rows. Off-switch: do not pass the flags (the default 90 days is unchanged); `scout_suppress` drops the signal.
- **Decision register.** Two new trigger kinds. `signal` (`signalKinds`, optional `pattern`/`flags`) listens to the scout's own signals, so a model release between two CLI versions still reaches the decision. `date` (`{ "kind": "date", "due": "YYYY-MM-DD" }`) flags once when that UTC day begins, in the daily checkup and the scout, and not after the decision leaves `active`; `--check` rejects a missing or impossible `due`. A passed review date ranks after changelog and signal flags, before unexercised. Reverse: set `decision_register` false (stops both scans), or remove the triggers from the register.
- **Haiku effort floor.** New tier field `minEffort` (haiku: `medium`) in `config/model-tiers.json`: the plain grid never resolves a tier below it, applied after the kind delta. `--weight 1|2 --kind mechanical` now gives `haiku/medium` (was `haiku/low`, M); the two grid rows for weights 1 and 2 in `docs/ROUTING.md` and the "grid would otherwise resolve to" text on the explore, verify, mechanical-edit and subagent-worker trials change with it, and no other cell moves (differential test, 252 cases over the route matrix, M). Explicit trial and profile rows name their own effort and are not clamped. Reverse: delete `minEffort` from the haiku tier (state-dir override `{"tiers":{"haiku":{"minEffort":null}}}` also works).
- **Tests.** New: `models-5-5-data`, `pinned-model`, `detect-pinned-model`, `decision-register-signal`, `routing-profile-review-by`, `decision-register-date`, `decision-register-date-and-signal` (a register with both kinds passes `--check` and evaluates both). About 20 existing test files were restaged because haiku now takes an effort (retirement shapes are staged through an override or in memory); version test bumped.
- **Takes effect** in a new session. On a machine with a state override `model-tiers.json` that sets `tiers.haiku.retired`, remove that key or haiku keeps falling back to sonnet.

## 0.31.15 — 2026-10-12

Session catch-up, five advisory hooks, a struggle detector and shorter standing-rule texts. Each hook is advisory, fails open, starts no child process and has its own off-switch. Labels: M measured, E estimated.

- **Catch-up note** (new option `catchup_note`, default on). Rules, memory and operator directives added after a session started now reach it, resumed sessions included. A SessionStart snapshot (`state/session-delta/`, hashes only) and a UserPromptSubmit diff add one note of at most 2,000 characters, once per item: new session-start standing rules, new MEMORY.md index lines (project and user), new CLAUDE.md lines, and "always/never/from now on" sentences the operator typed in other sessions in the last 24 hours (prompts the harness marks as human-typed only (`origin.kind: human`; compaction summaries, sidechains and origin-less turns are skipped), labelled with the project, quoted as data and framed as advisory context; a message from another session, `<cross-session-message>` or `<teammate-message>`, is never read as a directive, in any transcript). A session with no snapshot uses its first transcript time as t0, and a standing rule counts as new only if its raw file entry has an `added` timestamp later than that (read from the file, because `compileRule` drops unknown keys); `scripts/rules.mjs add` now stamps `added`. The directive scan reads the last 256 KB of the 40 newest transcripts touched in the last 24 hours and, on a rescan (at most once a minute), transcripts unchanged since the last scan. Zero tokens until something changes. Reverse: set `catchup_note` false.
- **Publish check** (new option `publish_check`, default on). A PreToolUse note on `Artifact` (main thread; once per artifact id per 30 minutes) and on `AskUserQuestion` when the question asks for approval or sign-off on UI work (once per session): capture a narrow-width screenshot, try each input once, attach the screenshot or dev URL to a sign-off. Never blocks; no telemetry. Reverse: set `publish_check` false.
- **windowsHide check** (new option `window_check`, default on). A PreToolUse note on `Write` and `Edit` of `.js`, `.mjs`, `.cjs` and `.ts` files when the new text adds a `child_process` `spawn`, `exec`, `execFile` or `fork` call (or sync form) with no `windowsHide` in that call. Skips calls whose options are a variable or spread. Once per file per session; also in subagents. Never blocks. Reverse: set `window_check` false.
- **Chip check** (new option `chip_check`, default on). A PreToolUse note on the desktop `spawn_task` tool, main thread only, once per session: a lead that holds the context and is free should do the follow-up itself. Never blocks. Reverse: set `chip_check` false.
- **Live sessions, peer-message warning, overdue worker notice** (new options `live_sessions`, `related_repos`, `peer_message_warning`, `known_peers`, `overdue_worker_warning`, `overdue_worker_minutes`; new hook `hooks/advisory-b.mjs`, ledger `state/worker-ledger/`, 7-day prune). Three notes for a lead, none blocks: other live sessions in this repo and related repos at start and when the set changes; a warning when SendMessage targets another session while the lead's own subagents run (no note for a reply to a session that already sent this one a message (`cross-session-message`, `agent-message` or `teammate-message`), or for a name in `known_peers`, a JSON array; the note reads "Fine if it is meant for a peer or coordinator; to reach a worker, use its name"); and a notice once per background worker that has run past 22 minutes. The overdue check runs on a PostToolUse entry with no matcher. Reverse: set the options false (`overdue_worker_minutes` 0 turns the overdue notice off).
- **Struggle detector** (new option `struggle_detector`, default on). A UserPromptSubmit hook scores each operator prompt for corrections and repeats; when 2 of the last 6 prompts score 2 or more it tells the operator (below xhigh: raising effort to xhigh may help; at xhigh or unknown: a missing fact or rule, or a fresh session) and gives the lead one line. A message from another session is not an operator prompt: it is neither scored nor counted. Stored sentence stems are hashed; the log row goes through the shared writer (new `docs/TELEMETRY.md` section). Cooldown 6 prompts, at most 2 per session, zero tokens otherwise; stores scores and sentence stems only, never prompt text (`state/struggle/`, `telemetry/struggle.jsonl`). Extra patterns in `config/struggle-patterns.json` (example `config/struggle-patterns.example.json`). Reverse: set `struggle_detector` false.
- **Shorter standing-rule texts.** The built-in `lead-brevity`, `delegate-first`, `resume-doctrine`, `pr-wait-hint` and `lead-effort-check` texts are shorter with every instruction kept (`lead-effort-check` is one template, 1,108 to 957 characters, M); `resume-doctrine` now ends "continuing re-reads all context each call". The dropped-rules line names the dropped rules: `- (N more rule(s) dropped: over the <cap>-char limit: id1, id2, ...)`. The 3,000-character cap is unchanged. No option; reverse by reverting the commit.
- **Tests.** New: `session-delta` (16, including two rules.mjs add integration cases and the cross-session case), `advisory-a` (12), `advisory-b` (14), `struggle-detector` (30), `cross-session` (3); `rules-roundtrip`, `standing-rules`, `lead-effort-check`, `lead-effort-live`, `rollout-schedule` updated; version test bumped.
- **Takes effect** in a new session.

## 0.31.14 — 2026-10-12

Standing-rules writes keep fields the CLI does not own, background reviewer verdicts, and two review nits. Labels: M measured, E estimated.

- **Standing-rules CLI edits the file in place.** `scripts/rules.mjs` add, enable, disable and remove now read the file as authored and change only the named entry (new `editRulesFile`, `setRuleEnabled`, `appendUserRule`, `removeRuleEntry` in `hooks/lib/rules.mjs`); top-level keys and every other field of every entry (`activeFrom`, `after.then`, a top-level `then`, unknown keys) pass through, and the write is atomic. Before, the CLI rebuilt the file from compiled rules: on the operator's real file it dropped the `activeFrom` and top-level `then` of the `lead-effort-check` override and rewrote every entry (M, 0.31.13 CLI on a copy), and in the new round-trip test it lost a top-level key and an unknown entry key (M; the test fails on 0.31.13 source). Behaviour change: an existing file that is not valid JSON with a top-level `rules` array (or a bare array; a BOM-prefixed file is refused because the reader ignores it) now makes the write fail with an error that says so and names the file, instead of being replaced; an empty file counts as no rules and a write starts it afresh. A bare array is converted to `{version, rules}` on its first write. `add` also refuses an id the file already holds as a malformed entry. An entry written by `add` carries id, enabled, scope, when, then, gate, note and no `builtin`. `writeRules` is unchanged and no longer used by the CLI.
- **Background reviewer verdicts.** The review-verdict hook now also runs on SubagentStop (`hooks.json`, `--event stop`). At launch (PostToolUse) a background reviewer's agent id is remembered in `state/review-agents/<agent_id>.json` (7-day prune on write); at stop the verdict is read from `last_assistant_message`, falling back to the last assistant text in the agent transcript (512 KB tail), and appended to `review-verdicts.jsonl` with two new fields, `source` (`post-tool-use` or `subagent-stop`) and `agent_id` (docs/TELEMETRY.md). One row per spawn: both paths check for an existing row first; a stop with no mapping is ignored, a stop with no verdict leaves the mapping for a later stop. `spawn_telemetry` off skips both paths. Limits: reviewers launched before this version is installed are not recovered, and the SubagentStop path is unproven until the first real background review (no live payload with a reviewer message was captured; E).
- **Register reads verdicts once.** `readSpawnRows(file, {foldVerdicts})`: the denials read passes false, so `review-verdicts.jsonl` is parsed once per register evaluation (a test counts 1 read; M).
- **README.** `project_pins` row: a project's `.claude/agents` folder is repository content. The review-verdicts row describes the background path.
- **Tests.** New: `rules-roundtrip` (5), `review-verdict-background` (13), a read-once case in `decision-register`; version test bumped.
- **Takes effect** in a new session (the SubagentStop registration is read at session start). Reverse: revert the commit; no option.

## 0.31.13 — 2026-10-10

Task type aliases and a TYPE nudge, scout copy staleness, project pins, a live lead-effort check, lead-effort metrics for the decision register, reviewer-verdict telemetry and a scheduled-task placement note. Labels: M measured, E estimated.

- **Task type aliases and `type_line_nudge`** (new option `type_line_nudge`, default on). `taskTypeAliases` in `config/model-tiers.json` maps ten other spellings to a task type: `research`, `analysis`, `lookup` -> `explore`; `bugfix` -> `debug-root-cause`; `bounded-fix`, `bounded` -> `bounded-feature`; `mechanical`, `one-line`, `docs` -> `mechanical-edit`; `review` -> `code-review`. An alias only respells a type and takes that type's route; a shipped or local type of the same name wins, an alias to an unknown type is ignored, and a user override replaces the key whole. `recommend.mjs --type` and the spawn guard's `TYPE:` line both resolve them. A `TYPE:` that is neither a type nor an alias gets one non-blocking line naming the valid types. Telemetry: `declared_type` now holds the raw value as written and the new `declared_type_resolved` the canonical type (null when equal). Also in this part: `detect.mjs` no longer writes to stderr outside a repo, the routine's STEP 0 looks in the marketplace copy first, the routine's signal table has rows for the 11 kinds it lacked, and the open 0.31.12 review nits (eight register fixtures renamed; fetched changelog text carries no control characters or backticks into the surfaced line, and the README says to treat it as untrusted text; register writes survive a Windows reader holding the file).
- **Scout copy selection and `scout_copy_stale`.** The daily scout routine now picks the marketplace copy of the plugin before a checkout. A new advisory signal, `scout_copy_stale`, says the scout that RAN is older than the marketplace's copy, so the checks added since did not run. Directional (a checkout ahead of the marketplace stays silent), local only.
- **Project pins** (new option `project_pins`, default on). A project agent or user agent whose definition sets its own model and/or effort is the operator's tier choice: the spawn guard no longer denies, nags or rewrites such a spawn over task weight (no best-fit deny, no over/under/parity notes, no `WARRANT:` requirement, no autofill or rung swap). Role rules still apply, a pinned writer with no self-review protocol in its file gets it appended, and a `model` parameter that replaces the pinned model gets one non-blocking note. The premium cap is unchanged. The spawn audit counts pinned rows apart. Telemetry: `project_pinned`, `pin_scope`, `pin_fields`, `pin_model_overridden`; `self_review_injected` also covers a pinned writer. 47 fixed cases compared before and after: with the option off no decision, rewrite or telemetry differs (M).
- **Lead-effort live check** (new options `lead_effort_live_check`, default on, and `lead_effort_rollout_id`, default empty). The built-in `lead-effort-check` wording is now rollout-aware: xhigh until the rollout id named by `lead_effort_rollout_id` is reached in `rollout.json`, high from it; empty option means no switch and the target stays xhigh as before. At or above the target the lead says nothing and asks nothing; the text never raises to max and never suggests lowering. It also says get_session can show the effort the session STARTED with, so an operator's "already raised" is enough to continue. While the rule is enabled, the first Agent spawn of a main session compares the LIVE effort from the hook payload with the target: below, one non-blocking note to the lead; above, one informational message to the operator; equal, nothing; once per session, never a deny or rewrite. Telemetry: `lead_effort_live`, `lead_effort_target`. 96 combinations of caller, effort, time and payload compared with 0.31.12: 0 allow, deny or rewrite differences (M).
- **Leads-at-high register metrics.** Five decision-register metrics: `leadRebriefsPer100Spawns`, `reviewFixShareByLeadEffort`, `leadRoutingDeniesPer100Spawns`, `leadUnderProvisionedShare` (each with `params.levels`) and `mainUnitsPerLeadSpawn` (history only; the history keeps no effort per session). A metric trigger's optional `baseline.levels` names the efforts counted in the pre window. Five generic example triggers added to `config/decision-register.example.json`.
- **Review-verdict telemetry.** A new PostToolUse hook on `Agent` (`hooks/review-verdict.mjs`) records the `VERDICT:` line of a reviewer's result to `telemetry/review-verdicts.jsonl` (docs/TELEMETRY.md); the register reader folds each row into the matching spawn row as `review_verdict`. Limit: verdicts are captured for FOREGROUND reviewers only, because a background spawn's PostToolUse carries the launch acknowledgement, not the result. `reviewFixShareByLeadEffort` stays silent until verdicts accumulate. Local only: state sync does not upload the file.
- **Routine placement note** (new option `routine_placement_note`, default on). A PreToolUse note on the desktop scheduled-task create tool, and on the update tool when it sets a `prompt`: the folder's effort pin, the effort a new task starts at, and the placement rule (`/ac recommend` for parent and worker, create from the folder pinned to the parent's level). Optional folder map `config/routine-pins.json` (example `config/routine-pins.example.json`). Never blocks; writes no telemetry.
- **Tests.** New files: `task-type-aliases`, `detect-scout-copy-stale`, `detect-no-stderr-outside-repo`, `decision-register-nits`, `spawn-guard-project-pins`, `lead-effort-live`, `decision-register-lead-metrics`, `review-verdict`, `routine-placement`; changed: `lead-effort-check` (length cap raised for the added clause).
- **Takes effect** in a new session. Reverse: set the new options false (`type_line_nudge`, `project_pins`, `lead_effort_live_check`, `routine_placement_note`) or leave `lead_effort_rollout_id` empty; revert the commit to remove the code.

## 0.31.12 — 2026-10-10

The decision register, a tighter release-watch filter, the critical-change reviewer text, and a usage-lockout marker on the checkup line. Labels: M measured, E estimated.

- **Decision register** (new option `decision_register`, default on; README "Decision register"). A file you write, `config/decision-register.json` under the agent-companion state root, holds standing decisions, the premises each rests on (labelled M or E) and triggers that say "look at this decision again". Three trigger kinds: `changelog` (a regex tested against EVERY item of each release newer than `sinceVersion`, on the existing daily fetch, so no extra network; a hit flags at once), `metric` (a daily-checkup metric past a threshold for `minDays` consecutive qualifying days, with staged-change baselines frozen at a scheduled switch), and `exercise` (a scheduled change that was never exercised, or exercised wrongly, read from `spawns.jsonl`). Eight catalog metrics: `unitsPerSpawn`, `mainUnitsPerDay`, `shareOver150kPct`, `compactionsPer100Spawns`, `ceilingNudgesPerDay`, `leadEffortShare`, `reviewsPerWriter`, `haikuSpawns`. Zero model calls. New: `scripts/lib/decision-register.mjs`, `scripts/decision-register.mjs` (`--check`, `--evaluate [--now ISO] [--changelog <file>]`, `--detail`, `--path`), `config/decision-register.example.json`. No register, no work.
  - **Wiring.** `scripts/daily-checkup.mjs` calls `runRegister` after `runCheckup`, inside its lock. `runReleaseWatch` takes an optional `onParsed`, called once with the full parsed changelog on a parsed fetch and on the local-cache fallback, never on a network failure with nothing to parse; the scout passes it to the register's changelog scan. The scout adds `decision_register_invalid` and `decision_review_due` signals.
  - **SessionStart.** A new piece 5 in `hooks/scout-surface.mjs`: ONE line per flag, once, at the next main-session start, severity order wrong, metric, changelog, unexercised; at most 300 characters with the details path last. A changelog flag quotes the clause around the match, not the item's first characters. A flag older than 72 hours is not shown, a subagent session gets nothing, `decision_register` false or `decision_review_due` in `scout_suppress` silences it, and the flag is marked shown last. The full text is in `state/decision-register-details.md`.
  - **State.** `state/decision-register-state.json` (streaks, frozen baselines, hits, flags, a seen-set so one episode flags once). Fail open throughout: a corrupt state, history or spawns row is skipped. The checkup, the scout and the SessionStart hook share the file without a lock, so each write re-reads the file and keeps what another writer added meanwhile (flags, hits, seen and surfaced keys).
- **release-watch topics tightened.** The old list matched on bare `agents`, `plugins`, `hooks`, `cache`, `desktop` and `Monitor`, which caught the `claude agents` view, plugin folder caches and chart labels. The new `TOPICS` are narrow patterns for subagents, hooks, cache, compaction, effort, models, transcripts, SendMessage, worktree, workflow and plugins; `desktop` and `Monitor` are dropped, `models` and `transcripts` added, and a `MODS_NOISE` test stops an item about the mods runtime or plugin UI matching on the word hook, plugin or agent alone. Over the last 12 releases (2.1.285 to 2.1.296, 1,010 items, one ranged fetch of the live changelog head on 2026-10-10): items matched 330 to 134 (M), the worst single release 55 to 21 (M). Of the 134, 120 were also matched before and 14 are new (model and transcript items); 2 of the 14 are noise (E).
- **Critical-change reviewer text.** The self-review text appended to a sonnet writer's brief now names the rung the recommender gives for a critical review. (A) A brief with no `CONSEQUENCE:` line takes `critical` when its `TYPE:` is a critical task type, for this text only. (B) `reviewerRungFor` returns any rung the recommender names, including another model (a critical review of a sonnet writer is `ac-opus-xhigh`). (C) The pointer then reads `--writer <pair> --consequence critical`. Only the appended text changes: 25 combinations of rung and brief gave identical spawn-guard exit status, decision, reason, rewrite and context before and after (M); the generated `agents/*.md` blocks are unchanged.
- **Usage-lockout marker on the checkup line.** The daily checkup counts the synthetic "hit your ... limit" messages once each per day into `limit: { hits, firstAt }` on the day record. The checkup line says `usage limit hit that day (first at <time>)`, and the register treats such a day as a gap for the per-day totals. Stored history records are not rewritten; the field is additive (docs/TELEMETRY.md).
- **Tests.** New `tests/decision-register.test.mjs` (schema, changelog, metrics, seen-set, baselines, exercise, detail file, fail open, privacy, CLI) and `tests/decision-register-integration.test.mjs` (the hook process, the integration with the checkup and release-watch). Changed: `release-watch`, `reviewer-effort-floor`, `daily-checkup`, plugin option and version tests.
- **Takes effect** in a new session. Reverse: set `decision_register` false, or delete the register file (nothing runs without it); revert the commit to remove the code.

## 0.31.11 — 2026-10-10

Lean listings for ladder workers: no skill listing at worker start, shorter agent descriptions. Operator approved removing skill listings and unused tool names from WORKERS only; the main session keeps everything. Evidence: the 10-02 week measured the harness listings injected at worker start and after each compaction at skill listing 4.16%, deferred-tool names 2.92%, agent listing 1.49% of the weekly limit, most of it in subagents (`tasks/usage-why-2026-10-06/hook-messages-detail.md`; this change's measurements in `ac-worker-lean-listings-detail.md`).

- **`Skill` denied on every ladder rung** (config `ladderTools.keepOn.Skill`, generated into each `disallowedTools` line; `tools-drift` checks it). A deny drops the tool's schema and the skill listing. The browser variants `ac-browser` and `ac-browser-opus` keep it: the browser skills are read before the first browser step. 33 of 1,359 ladder runs in 14 days called a skill; 15 of them `team-orchestration`, from the global rule that says to load it before spawning, which a self-reviewing writer follows to spawn its reviewer.
- **Five unused built-in tools dropped everywhere:** `ListSkills`, `SearchSkills` (no use without Skill), `ListPlugins`, `SearchPlugins`, `SuggestPluginInstall` (plugin discovery ran in 2 of 1,359 ladder runs; `SearchPlugins` carries a loaded schema in every worker). The browser variants drop them too.
- **Spawn guard knows a skill is gone.** A brief that says "invoke/load <name> skill" or names the Skill tool is no longer rewritten from general-purpose to a rung (`briefNeedsDroppedTools(...).skill`), and a ladder spawn whose brief asks for one gets a one-line note to name the `SKILL.md` path instead.
- **Non-skill paths.** The self-review block (generated into the three opus rungs, appended to a brief for the others) now says "you have no Skill tool: this text is the whole spawn recipe, so do not look for the team-orchestration skill". The spawn guard's messages that a worker can read named `node scripts/recommend.mjs` relative to the plugin (it does not resolve from a project directory) and "the setup skill"; they now carry the absolute path of `recommend.mjs` and of `skills/setup/SKILL.md`. Lead side (outside the repo): `references/briefing.md` of the team-orchestration skill says a brief that needs a skill names that skill's `SKILL.md` path for the worker to Read.
- **Descriptions about a third shorter** (1,766 to 1,216 bytes across the twelve `agents/ac-*.md`, 31%). A rung that is no task type's base default now carries only `Rung N/10: <role>.`; one that is says `Base default for: <types>; profile may differ.`; the haiku notice keeps `RETIRING (no sooner than <date>)` and `Falls back to <rung>.`; a browser variant ends `Not a rung; browser tools.` Roles shortened in `config/model-tiers.json`. The rung number, the role and the base-default types, which the recommender and the leads route by, are kept.
- **No other tool family dropped; the gap is reported, not worked around.** Over the last 14 days ladder workers called these MCP families: the browser servers, `ccd_session`, `ccd_session_mgmt`, `terminal`, `mcp-registry` (already denied since 0.31.0), `scheduled-tasks`, the agent-bus server, the cloudflare docs and api servers, and two connectors that Claude Code names by a per-account id (a second route to the agent-bus server, and a file-storage connector). Every family with a stable name that a worker used is kept. The families nobody used (about 49 tool names: a docs connector 8, a calendar connector 9, a mail connector 30, a second visualize server 2) are named by a per-account id too, and a shipped file cannot carry an id; an allowlist (`tools:`) would drop the two used id-named connectors with them. So nothing more is dropped from a shipped file. Dropping those 49 names needs a user-level layer the plugin does not have (the frontmatter is static plugin text); `leak-check` stays clean and `lean-listings.test.mjs` pins that no shipped file carries a UUID.
- **Tests.** New `tests/lean-listings.test.mjs`: every rung denies Skill, the browser variants keep it, keepOn names exactly the browser variants, no UUID in any shipped file or tools line, descriptions total at most 1,250 bytes with rung number and role kept, the self-review sentence, and no bare relative recommender path in the spawn guard. `agent-description-drift` and `gate-messages` tests updated for the shorter descriptions.
- **Reverse:** revert the commit and run `node scripts/routing-table.mjs --sync-agent-descriptions` in a clean state (`AGENT_COMPANION_STATE_DIR` set to an empty directory: a machine's own `model-tiers.json` override, such as `tiers.haiku.retired`, otherwise leaks into the generated descriptions).
- **Takes effect** in a new session: Claude Code loads agent definitions at session start.

## 0.31.10 — 2026-10-10

- **`reviewerEffortFloor`** (`config/model-tiers.json`, empty as shipped; read from the per-user `model-tiers.json`): `{"sonnet": {"effort": "xhigh"}}`. The mirror of `reviewerEffortCap`: a NON-critical review on that model runs at LEAST at that effort even when its writer ran lower (a floor only raises). Same optional `activeFrom` and `exceptWriterTypes`; applied after the cap; a critical review is still sized by F1. Operator decision 2026-10-09 (5a): sonnet code reviews stay at xhigh, which the 2026-10-10 move of bounded-feature writers to sonnet/medium would otherwise have dropped to medium, because a reviewer follows its writer's effort. With the floor, `recommend.mjs --type code-review --writer sonnet/<any effort>` names `agent-companion:ac-sonnet-xhigh`. Nothing changes at install (the key is empty).
- **The reviewer rung in the appended protocol agrees.** The self-review text the spawn guard appends to a writer's brief (a ladder rung that does not carry the block, which is every sonnet rung) now names the rung the recommender gives for a review of that pair, when it is on the same model with another effort (`reviewerRungFor` in `hooks/lib/self-review.mjs`); the `WRITER:` line stays the writer's own pair. A critical change, another model or an unrouted pair keeps the writer's own rung, as before. A writer whose effort is not stated (`WRITER: sonnet`) counts as below the floor, so its review is floored too. The rung text generated into `agents/ac-*.md` is unchanged (it never reads a machine's config or the date).
- **Messages.** The guard's parity note names a cap or floor that moved the reviewer's effort ("floor F3: effort medium -> xhigh (reviewerEffortFloor: a sonnet review runs at least at xhigh, an exception to effort parity)"); `recommend.mjs` says "above" or "below" the writer's effort and which setting did it.
- **Tests.** New `tests/reviewer-effort-floor.test.mjs`: shipped empty, every sonnet writer effort, opus untouched, critical and elevated, floor with the opus cap before and after the cap date, `activeFrom`/`exceptWriterTypes`/unusable shapes, the recommender CLI, `reviewerRungFor`, and the appended text through the spawn guard.
- Reverse: remove `reviewerEffortFloor` from the user `model-tiers.json`; revert the commit to remove the support.

## 0.31.8 — 2026-10-10

- **`rules test` judges a scheduled rule by its state now.** It listed a rule written as `enabled:false` + `activeFrom` + `after:{enabled:true}` as "disabled" even after its date, while `rules list` and the hooks (which inject it) were right. It now uses the same effective state; pinned by `rollout-schedule-edges.test.mjs`.

## 0.31.9 — 2026-10-10

Scout: a zero-token daily checkup of plan usage, in place of the week-long trial evaluations. **No routing, effort, model, guard or review-protocol change; no subagent-start token added (subagents get nothing).** The operator dropped the week-long trials: staged changes now switch on one per day at 08:00Z (`rollout.json`) and stay on, so each morning needs a cheap read of what the day cost and which change had just switched on. Cheap was the rule: no model call, no network, no window.

- **The checkup** (`scripts/daily-checkup.mjs`, `scripts/lib/daily-checkup.mjs`; option `daily_checkup`, default on). Once per closed day (08:00Z to 08:00Z, named by its start date) it appends one JSON line to `state/daily-checkup-history.jsonl`: percent of the weekly limit for the day (main and subagent units), the week so far and the pace at reset, spawns by `TYPE:` line, `ROLE:` line and rung with units per spawn, subagent compactions per 100 spawns, the share of subagent units above 150K context, context-ceiling nudges (`telemetry/context-ceiling.jsonl`, a missing log is 0), and which `rollout.json` changes were active and which switched on that day (a missing file records none). Fields: `docs/TELEMETRY.md`.
- **Plan units.** The usage study's model (`week1009-scan`): every request at the Sonnet price vector times the model's plan weight, reusing `pricing.mjs` (`planPriceSpecFor`, Opus 1.5 from `planUsageMultipliers`) and the transcript reader (`discoverTranscripts`, `usageOf`, `contextTokensOf`, `isCompactBoundary`); Haiku 0.5 and Fable 5 are the study's constants, an unplaced model counts as Opus. Options `weekly_limit_units` (default 2677, so 1% = 26.8) and `daily_pace_target_pct` (default 14). Weeks reset Friday 16:00Z. Checked against the study's own scan on the live corpus: the same totals to the second decimal (main 30.54, subagent 161.31 units for 2026-10-09T16:00Z to 2026-10-10T04:08Z).
- **Background and incremental.** The scout (step 1f of `scripts/detect.mjs`) and the main-session SessionStart hook both call `launchCheckup()`: a detached child with `windowsHide: true`, stdio ignored, started only when the latest closed day has no finished run (one attempt per 3 hours, one run at a time), so SessionStart never waits and no window opens. `state/daily-checkup.json` keeps a byte offset per transcript; a run reads only whole lines after it. The first run looks back at most 8 days. A request is counted once however many lines or forked copies carry it (`state/daily-checkup-seen.bin`); a file written in the last 2 minutes holds its still-streaming last request for the next run. A damaged state file means a first run, a damaged seen file means a possible double count, never a throw.
- **One SessionStart line.** `hooks/scout-surface.mjs`: for a MAIN session, once per day, ONE line with the latest day's share of the weekly limit against the target, the week so far with the pace at reset, any change switched on that day, and the history path. Subagents, a missing or damaged history and a line more than 3 days old are silent.
- **Tests.** New `tests/daily-checkup.test.mjs` (28 tests): unit maths, the 08:00Z day and Friday 16:00Z week boundaries, the options, the incremental cursor (only the appended bytes are read, no line twice, a half-written last line waits), the 8-day look-back, once-per-request counting, the hold-back, spawn classes, compactions and the 150K share, rollout tagging (absent, corrupt, BOM, zoneless), the nudge count, missing or corrupt input, the detached launch (arguments, throttle, option and environment off), and the SessionStart line (once per day, subagent silence, corrupt history). `tests/isolate.mjs` forbids the launch for every other test.
- Reverse: set `daily_checkup` to false; revert the commit to remove it. The history and state files are safe to delete.

## 0.31.7 — 2026-10-10

Scheduled config (`activeFrom`), the machinery behind four operator-adopted routing changes that switch on one per day, plus three noisy `PreToolUse:Agent` messages removed. **Nothing changes at install: every new key is empty or unset as shipped. The shipped behaviour changes are message text and one inert wording change in the self-review block (below).**

- **`activeFrom` / `after`.** A routing-profile row, a standing rule, or a `reviewerEffortCap` entry may carry `activeFrom`: a UTC timestamp (`Z`, an offset, or no zone, read as UTC) or a change id looked up in `<stateRoot>/rollout.json` (`{"<change-id>": "<ISO UTC>"}`, one shared schedule, the same file and the same reading as the context-ceiling hook). Nothing flips it; the clock is read each time the config is read (`rolloutActive()` in `hooks/lib/context.mjs`, cached by mtime; `AGENT_COMPANION_FAKE_NOW` moves it). Unresolvable (id not named, file missing or unreadable, not a date, an impossible date like 2026-02-31) means NOT yet active, so a typo leaves today's behaviour; a rule whose `activeFrom` is present but unusable (a number, `""`) is held off. With `after`, the config is the current behaviour until the moment and the overlay is laid over it after (rules: `enabled`, `then`, `when`, `gate`; profile rows: any row field, but an overlay that would make the row unusable is not applied and the stored row stays); without `after` a rule is off, and a profile row absent, until the moment. **Write a scheduled change as current behaviour plus `after`** (a new rule as `enabled: false` with `after: {enabled: true}`): a copy of the plugin that predates this release ignores both keys and, with the no-`after` form, would switch on at once; an older `rules` CLI also drops both keys when it rewrites the file. `rules list` shows each rule's state right now.
- **`reviewerEffortCap`** (`config/model-tiers.json`, empty as shipped; read from the per-user `model-tiers.json`): `{"opus": {"effort": "high", "activeFrom": "<id>", "exceptWriterTypes": ["novel-design", "critical-change"]}}`. An exception to "a reviewer's effort may exceed its writer's, never drop": a NON-critical review on that model runs at most at that effort. Critical reviews keep the F1 floor, a cap never raises a lower writer's effort or goes below an elevated change's effort floor, and named writer types keep full parity **where the writer's TYPE is known** (a subagent writer's own review, or `--writer-type`); a LEAD-spawned review of a critical-change writer carries no type, so declare `CONSEQUENCE: critical` there. The cap sizes what the guard and the recommender call the right reviewer; it does not by itself change the reviewer a self-reviewing writer spawns (the rung text spawns its own rung), so the spend moves only once a standing rule tells the writer which rung to spawn. Wired through `resolveRoute`/`parityFloors` (new `writerType`), the spawn guard (passes the caller's declared TYPE), `recommend.mjs`/`evaluate.mjs` (`--writer-type`; the non-parity recommendation shows the capped reviewer).
- **Self-review step 4** now allows ONE exception to "never re-review": a standing rule appended to the brief that asks for a narrow re-check of blocking findings (one fresh, capped re-check of those blockers only). With no such rule the protocol is unchanged (the new sentence is inert). The three `ac-opus-*` rung bodies and every appended protocol carry the new wording.
- **Three messages gone, no decision changed.** (1) The lead-facing "agent-companion (self-review): ... does not carry the protocol in its definition, so it was appended to the brief" note; the append itself is unchanged. (2) An empty "PreToolUse:Agent says:": `allowWith` now trims its text and prints nothing when it has no message, no `updatedInput` and no `additionalContext`. (3) The "this spawn names X AND passes isolation ... ordinary subagent" notice, which is wrong on desktop; `gate2_fired` stays in the spawn row (option `isolation_demotion_notice` is now telemetry only).
- **Tests.** `rollout-schedule-edges.test.mjs` (unusable `activeFrom`, the new-rule form, a row without `after`, an overlay that would break the row, the elevated floor, the fake clock, and that the ceiling hook and the config agree on every `rollout.json` shape), `rollout-schedule.test.mjs` (helpers, profile overlay, cap before/after/critical/excepted/medium writer, rules before/after and round trip, SessionStart hook before/after, recommender), `spawn-quiet-messages.test.mjs` (silent spawn, no isolation notice, no self-review note and the append kept, a block-mode deny unchanged); `spawn-shape-gates` gate2 and `self-review` tests updated.
- Reverse: revert the commit; delete the `activeFrom`/`after` keys from the user config (older code ignores them anyway).

## 0.31.6 — 2026-10-10

Subagent context ceiling: at 150K tokens of context a subagent is nudged to write a checkpoint file and return. Operator approved ("adopt now", 2026-10-10); evidence `tasks/usage-why-2026-10-06/ceiling-detail.md` (C = 150K the best ceiling found; modelled saving about 4.2% of the weekly limit at the 10-02 volume, range 1.2-7.1%, the sign depending on what compaction costs). **Rollout-gated: shipped and installed, but it does nothing until 2026-10-14T08:00Z** (`rollout.json`, change id `context-ceiling`).

- **The nudge.** `hooks/subagent-context.mjs` (PreToolUse, inside the subagent) reuses the context reading it already makes (the tail of the subagent's own transcript, no second read). First time the context is at or past `subagent_ceiling_tokens` (default 150000): one `additionalContext` nudge to stop new work, write a checkpoint file (goal, done, remaining steps, key paths, open findings) and return with the path and a proposed split of the rest. Again once, and only once, if it keeps growing past `subagent_ceiling_repeat_tokens` (175000). First seen past 175K: one nudge. Main sessions are untouched (no `agent_id`). Never blocks, denies or rewrites a call; a missing or corrupt transcript is silent. New `hooks/lib/context-ceiling.mjs`.
- **Backstop kept.** The at-compaction wrap-up and the `subagent_context_notice_tokens` size notice are unchanged; if both apply, the two texts go out in one message.
- **Gate.** `<state root>/rollout.json` is `{change-id: activeFrom UTC}`; the nudge is off until `context-ceiling` has passed. A missing file, missing id or unparseable timestamp is off. `AGENT_COMPANION_FAKE_NOW` moves the clock for tests. The quiet period burns no once-claim. A UTF-8 BOM in the file (PowerShell 5.1 writes one) is stripped, and a timestamp with no zone designator is read as UTC. A compaction with no request after it yet is not read as a big context.
- **Log.** `telemetry/context-ceiling.jsonl`: UTC time, agent type, `agent_id`, context tokens, tier (`docs/TELEMETRY.md`), for the scout's daily count. Scout files untouched.
- **Options.** `subagent_ceiling_tokens` (0 = off), `subagent_ceiling_repeat_tokens`.
- **Lead side (outside the repo).** team-orchestration `references/harness-and-spawning.md`: on a checkpoint return, continue with a FRESH worker that reads the checkpoint file; never resume the old one.
- **Tests.** New `tests/context-ceiling.test.mjs`: below 150K, the crossing, no repeat to 175K, second nudge past 175K, first seen late, main session, missing/corrupt transcript, never a deny, gate closed/open and its failure shapes, options, combination with the existing notice.
- Reverse: set `subagent_ceiling_tokens` to 0, or remove `context-ceiling` from `rollout.json`; revert the commit to remove it.

## 0.31.5 — 2026-10-09

Scout: Claude Code release watch, and a list of scout signals to suppress. **No routing, effort, model, guard or review-protocol change; no subagent-start token added (subagents get nothing new).** Source: a machine ran 13 releases behind (2.1.283 against 2.1.296) with nobody seeing the new features (Agent `effort` per spawn, a subagent `autoCompactWindow`, resume-cache fixes), because the scout only compared the installed version with its previous run; and `model_benchmark_suggested` repeated 163 times on a machine where the operator rule is no benchmark runs.

- **Release watch** (`scripts/lib/release-watch.mjs`, step 1e of `scripts/detect.mjs`; option `release_watch`, default on). One ranged GET of the head of the public changelog, at most once per 24 hours (success or failure; `state/release-watch.json`), a 3 s budget, no child process (so no console window), silent and non-fatal when offline; the changelog Claude Code caches (`<config dir>/cache/changelog.md`) backs up a failed fetch. For releases newer than the installed version it keeps the items matching agents/subagents, hooks, cache, compaction, effort, SendMessage, worktree, workflow, Monitor, desktop or plugins in `state/cli-release-details.md`, and raises `cli_release_available` with the unseen-release and item counts.
- **One SessionStart line.** `hooks/scout-surface.mjs` adds a line for the MAIN session only (versions, matching item count, details path) when an unseen newer release exists, then marks those releases seen, so each release is surfaced once. Subagents get nothing. The generic scout block no longer lists `cli_release_available` (the line is its home).
- **`scout_suppress`** (comma-separated kinds) and **`scout_suppress_reason`** (free text). A suppressed kind is dropped where the scout makes a signal, so it is neither emitted nor counted; the SessionStart block also filters it from an older `scout-latest.json`. Same option layering as every other option (environment, `settings.local.json`, `settings.json`). `release_watch` false, or `cli_release_available` suppressed, means no request.
- **Tests.** New `tests/release-watch.test.mjs` (26 tests): topic extraction, the 24 h throttle, offline / HTTP error / timeout (also through the scout path) / oversized body / a 200 that is not a changelog, the local-cache fallback (which only ever adds releases), the details file, the seen-set across two releases (and a seen-mark made during the request), main vs subagent surfacing, a caught-up machine, suppression by environment and by `settings.json`. `tests/isolate.mjs` forbids the request for every other test.
- Reverse: set `release_watch` to false; revert the commit to remove it.

## 0.31.4 — 2026-10-09

Cache-TTL check output only: every delta now says which way it points, and the "already writing 1h" line says what the report cannot tell. **Audit output only: no routing, effort, model, guard, cost-model or threshold change, so the 0.31.2 test week is the same era.** Source: the 2026-10-09 cache-ttl run, whose verdict read `don't set subagentPromptCacheTtl globally (delta -0.85%)` while 1h was the cheaper policy.

- **No sign was inverted.** `deltaPct` is `(cost with 1h - cost today) / cost today`, negative when 1h is cheaper, and every branch of `computeVerdict` and `rungVerdict` already applied it that way. The defect was presentation: a bare `-0.85%` beside "don't set" read as "costs more", when the decision was "don't" because -0.85% sits inside the existing -1% bar for a global change. The threshold (`SET_GLOBALLY_DELTA_PCT` -1, `DONT_SET_DELTA_PCT` +1) and the cost model are unchanged.
- **One delta format.** New `fmtDelta()` in `scripts/lib/cache-ttl.mjs` prints `-0.85% (saves with 1h)`, `+1.93% (COSTS more with 1h)`, or `0.00% (no change)`. It is used by the global verdict, the per-model, per-agent, break-even, policy and per-rung lines of `cache-ttl.mjs`, and the `audit.mjs --only cache-ttl` totals line.
- **The verdict says why.** The "don't set globally" line now states the reason in the same words: `1h is cheaper overall, but by less than the 1.00% needed for a global change`, `1h is not cheaper overall`, `1h is cheaper overall, but <tier> (>=5% of spend) costs more with 1h`, or `1h costs more overall; only the opus/fable-only policy saves (...)`.
- **"Already writing 1h".** The transcripts show 1h writes in the window, not whether a setting still in effect produces them. The line (`cache-ttl.mjs` and the audit finding) now says it cannot tell past writes from a current setting and points at settings and agent definitions. No new detection.
- **Tests.** `tests/cache-ttl.test.mjs`: `fmtDelta`; the global verdict with 1h cheaper and 1h dearer inside the bar, clearly cheaper, clearly dearer, and vetoed by a big tier; a per-tier line from the CLI with a tier where 1h is cheaper and one where it is dearer; the already-writing note.
- Reverse: revert the commit.

## 0.31.3 — 2026-10-09

`ROLE:` brief line: spawns are tagged with the role of their main deliverable so the usage study's per-role figures are exact. **Tagging only: no routing, effort, model, review-protocol or guard-decision change, so the test week that started with 0.31.2 (2026-10-09 16:00Z) is the same era for the day-3 and day-6 measurement runs.** Operator approved ("adopt now", 2026-10-09). Source: step 2 of the usage study (`step2-roles-detail.md`, section 8): the role classifier reaches only about 78% on held-out spawns, so role shares are not decision-grade; a stated role is exact.

- **The line.** `ROLE: <reviewer|fixer|lander|writer|docs|lookup|operate|other>`, next to `TYPE:`, naming what the spawn's main deliverable is. `ROLE` joins the directive labels in `hooks/lib/brief-directives.mjs` (same rules as the others: first line-anchored occurrence wins; fenced, quoted, indented and commented lines never declare). `BRIEF_ROLES` is exported there. `ROLE-OF:` is a different, unread line.
- **Spawn guard.** Records the first valid `ROLE:` value as `declared_role` in the spawn telemetry row (null when missing or not one of the eight words; `docs/TELEMETRY.md`). When it is missing or invalid the guard adds one short line of context to the spawn (`additionalContext`, headed "Not blocking"). It never denies, rewrites or reroutes on the role, and no other note, decision or `updatedInput` changes. New option `role_line_nudge` (default `true`) silences the nudge; the role is still recorded.
- **Reviewers carry it.** The self-review protocol (`hooks/lib/self-review.mjs`, generated into `ac-opus-medium`, `ac-opus-high` and `ac-opus-xhigh`, and appended by the guard to every other rung) now has the writer open its reviewer's brief with three lines: `TYPE: code-review`, `WRITER: <pair>`, `ROLE: reviewer`. The recommend skill's reviewer example shows it too.
- **Recommender.** `scripts/recommend.mjs` prints a `brief lines:` line (`TYPE: x + ROLE: y`) and `role` in `--json`: `reviewer` for `code-review`, `lookup` for `explore` and `verify`, `operate` for `operate`, `writer` for the rest. A suggestion; the spawner changes it for a fix, a landing or docs.
- **Doctrine (outside the repo).** team-orchestration core section 6 and `references/briefing.md` gain the line in the brief checklist and the reviewer brief.
- **Tests.** New `tests/role-line.test.mjs` (parsing, recorded role, nudge present/absent, invalid value, option off, deny paths unchanged, reviewer lines in the protocol and the three rung bodies, recommend roles).
- Reverse: set `role_line_nudge` to `false` for silence; revert the commit to remove the label, the protocol line and the recommender line.

## 0.31.2 — 2026-10-06

Lean worker shape: every writer type self-reviews and lands its own work. Source: DECISIONS.md "lean worker shape; main session stays unblocked" (operator, 2026-10-06).

- **Self-review for every writer type.** `selfReview.types` in `config/model-tiers.json` was `novel-design` and `critical-change`; it is now `bounded-feature`, `integration`, `debug-root-cause`, `large-refactor`, `novel-design`, `critical-change` and `long-autonomous-run`. Every change gets one separate reviewer at the writer's tier, spawned by the writer, with one fix round. `mechanical-edit` and `subagent-worker` stay out on purpose: they are the edit workers a writer spawns for a 15+ call job, and the parent writer's one review covers them (listing them would give a change two reviews). Read-only types and parity types stay out. `REVIEW: lead` remains the only opt-out.
- **The writer lands.** The generated protocol (`hooks/lib/self-review.mjs`) gained a step: after the fix round the writer merges and verifies the deploy where the repo deploys on merge, keeps every release gate the repo requires (user sign-off, production deploy approvals, its CLAUDE.md), stops before the merge while a blocker is disputed or left unfixed (the lead settles it first), pushes its branch and says so when neither the brief nor the repo says how to land, and returns the merge sha. The "otherwise skip" clause now reads "read-only work, or the lead opted out and reviews it". The lead settles disputed findings and spot-checks the review file. The protocol block is now generated into `ac-opus-medium` and `ac-opus-high` as well as `ac-opus-xhigh` (the default rungs for the newly listed types); any other rung gets it appended to the brief by the spawn guard, as before.
- **Guards.** `review_recursion_guard` is unchanged in behaviour (a reviewer still cannot spawn a reviewer; a writer's review of its own work is allowed). Its description now says so explicitly and its deny text drops the "re-tasked as a fixer" example. `selfReviewSpawn` follows the new list with no code change. The delegation guard is unchanged.
- **Recommender and docs.** `recommend.mjs` says the writer lands its own work. `ROUTING.md` (generated), `ROUTING-RATIONALE.md`, `README.md` and the recommend skill describe the new shape; the `mechanical-edit` and `subagent-worker` task summaries say to spawn them only for a mechanical job of about 15+ calls or parallel work.
- **Tests.** `tests/self-review.test.mjs` updated for the new list and rung set, plus new cases: a `bounded-feature` writer's review is classified `self_review`, a reviewer is still denied, `mechanical-edit` is not self-reviewing.
- Reverse: empty `selfReview.types` (or restore the two-type list) and run `node scripts/routing-table.mjs --sync-agent-descriptions`.

## 0.31.1 — 2026-10-06

Resume doctrine refined with a measurement, a teammates watch, and stale cost facts corrected. A first version of this release made reuse the default; the same-day measurement refuted it and it was reverted before release.

- Standing rule `resume-doctrine` (id kept): was "resume only while a worker's cache is warm; after its TTL, spawn fresh from a file handoff". Now: continue a worker only while its cache is warm (under 5 minutes) and the follow-on is short (about 10 calls or fewer); otherwise spawn fresh with a short handoff, because continuing re-reads all context each call. Measured since 2026-09-01: a continued worker costs 0.11 (warm) to 0.16 (cold over 1 h) plan units per call against 0.06-0.07 for a fresh follow-on; a cold resume's first call costs about 8x a fresh spawn's; re-discovery is only 1-4% of a follow-on's cost; continuing every follow-on of the week would have cost 6.8% (warm) to 12.6% (cold) of the weekly limit more; only warm follow-ons of about 10 calls or fewer win.
- Resume guard (`hooks/resume-guard.mjs`) unchanged: it still warns on a resume past the cache window and still reads `resume_guard` and `resume_guard_min_tokens` (default 50000).
- Teammates watch (calibration scout). New `scripts/lib/teammates-watch.mjs`, section 1d of `scripts/detect.mjs` and `scripts/teammates-probe.mjs`. When the installed Claude Code version changes the scout suggests the probe once (`teammates_probe_suggested`); it raises `teammates_available` when a team config created after the change lists a teammate besides the lead, watching 21 days. The binary's team strings (TeamCreate, TeamDelete, teammate_spawned, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) are recorded as a change hint only, because they are present in 2.1.286 while teammates do not work. Recorded in its docs: teammates were not in use in the whole-week weeks (August to early September), TeamCreate ran only 2026-05-13 to 2026-06-20, and team-era workers cost 0.110 plan units per call against 0.056 now.
- Stale cost facts corrected: the session budget's weekly allowance is 2,677 plan units (1% = 26.8), not 1,900 (every percentage it quoted was about 41% high). Opus 5.5's plan weight is about 1.5x per token and about 1.9x Sonnet per call at equal context; "came close to Sonnet" and "may be introductory" are removed. Fable's plan weight is marked unverified (the data fits about 3x, not 5x).

## 0.31.0 — 2026-10-06

Lean subagents: the ten `ac-*` ladder workers carry less on every spawn, the reporting contract is delivered once, and the lead's session-start text stays out of a compacting subagent. Source: the 2026-10-06 context-baseline report, section 4. 0.31.0 also ships the opt-in `main_compact_floor_tokens` option (PR 12, merged separately before this release).

### Ladder workers

- **Tools dropped per server (S1/S2).** Each rung gets a generated `disallowedTools` line (config `ladderTools`): `Artifact` (with `ArtifactComments`, `ArtifactData` and `ArtifactCheck`, since the entry is an exact tool name), the desktop-only servers (visualize, terminal, ccd_session, ccd_connectors, ccd_directory, ccd_pr, ccd_sidebar, ccd_view, ccd_window) and mcp-registry everywhere; the browser servers (Claude_Browser, claude-in-chrome, computer-use) on every rung; ccd_session_mgmt except on `ac-haiku`. No account-specific ids. Chosen from 30 days of per-server, per-rung usage over 1,175 ladder runs (Claude_Browser 39 runs, claude-in-chrome 4, computer-use 0, ccd_session 17, ccd_session_mgmt 9, Artifact 7, terminal 1, visualize 0, mcp-registry 1); scheduled-tasks, the agent-bus and cloudflare servers stay because they are used. `--sync-agent-descriptions` writes the line and `--check-agent-descriptions` reports drift as `tools-drift`. Whether the harness also drops a dropped server's deferred names and instruction block is checked in a fresh session with `docs/lean-verification/`.
- **Browser and UI work keeps a routed path.** Two ladder variants beside the ladder, not in it: `ac-browser` (sonnet/high) and `ac-browser-opus` (opus/medium), config `ladderVariants`. Not rungs (no number, never an escalation target, never picked by routing), but every guard counts them as ladder agents (delegation guard, spawn guard, inherit guard, ladder-check, install-ladder-agents). `recommend.mjs --browser` names the variant; the delegation guard's hint names it; the spawn guard no longer swaps a general-purpose spawn whose brief names the browser or Artifact for a rung, and notes a ladder spawn that does. Browser detection covers the three browser servers by name (Claude_Browser, claude-in-chrome, computer-use), "Chrome extension", "check the UI in the browser"-style phrases and screenshots of localhost, but not a bare "browser" or "browse the code".
- **Smaller definitions (S5).** Rung bodies go from about 880 to about 165 characters (ac-haiku 2,840 to 242, ac-opus-xhigh keeps its self-review block); generated listing descriptions go from 2,759 to 1,473 characters in total (about 100 to 160 each); ladder roles are shortened.

### Hooks

- **Reporting contract delivered once (S5).** The SubagentStart payload carries no prompt, so the hook's marker check never matched and it re-added the contract whenever the spawn guard already had (about 71% of spawns). The spawn guard now records the append (one small file per spawn under `state/contract-pending/`, per session, 3-minute expiry, no lock so the guard still loads no lock helper) and SubagentStart consumes one record per start; a repeat start for the same agent id is skipped; a start with no record still self-heals. A record carries the agent type the spawn starts as (and its pre-rewrite type), so only a start of that type consumes it (a workflow-subagent start never eats an `ac-*` record); no record is written when `brevity_reinforce` is off, expired records are pruned on write as well as on consume, and `brevity-started/<agent_id>` markers older than 24 hours are pruned on each start.
- **Long detail files (Claude Code 2.1.286).** The harness refuses a subagent Write to a `report*`, `summary*`, `findings*` or `analysis*` `.md` basename. The contract now says: long detail goes to `<task>-detail.md` (or `.json`/`.csv`) with its path in the final message. A test pins that the example name cannot match the refusal pattern.
- **No lead text in a compacting subagent (S4b).** memory-budget, self-update, ladder-check and git-brief session-start skip a SessionStart that carries an agent id (462 fires in 280 subagent transcripts, mean 5,138 characters, measured). ladder-check also stops recording the subagent's compaction as a process load.
- **Shorter session-start text.** The opt-in lead-effort-check rule 1,155 to 893 characters; the scout line names each signal kind once with a count; the listing descriptions of the seven skills with no use in 30 days (setup, standing-rules, model-benchmark, audit, brevity, calibration-scout, routing-table) go from 266-381 to 114-157 characters, triggers kept.
- **Audit.** The memory-index check follows `index_*.md` files linked from MEMORY.md one level, so a memory directory with a sub-index no longer reports its sub-indexed files as unreachable; `--fix` does not re-link them.

### Not done

- `omitClaudeMd` on the rungs, and the worker-rules paragraph that goes with it. The key works for plugin agents, but a per-project check found rules in six of the operator's projects (a data-boundary rule, secret and port rules, shell and version-bump rules, brand-voice pointers) that no guard enforces and a worker would lose; the saving (about 4-5K tokens of cached context per spawn) does not pay for that. Recorded in the operator's decision log with the reverse path.

## 0.30.2 — 2026-10-06

Test isolation, round two. The suite no longer reads the operator's real home from a child process, and a violation now fails the file that caused it.

- Test fix. The 0.29.25 isolation covered what the plugin resolves through its home override. It left `os.homedir()` and git's `~` pointing at the operator's real home, so any child a test spawned could still read it. Every test process now points `HOME`, `USERPROFILE` and `GIT_CONFIG_GLOBAL` at an empty sandbox directory, and every node child and grandchild arms the same real-`~/.claude` tripwire through a `NODE_OPTIONS` preload (`tests/child-guard.mjs`). A fail-open child that swallows the throw is still recorded.
- A violation now exits the offending test file non-zero. It used to be reported by a root hook that node:test attributed to `tests/isolate.mjs`, so ci-local's isolated re-run passed and the run counted as flaky (non-blocking outside `--ci-parity`). The file itself now fails, and so does its re-run.
- `runHook` and `runScript` run from the sandbox instead of the checkout. From the checkout, a hook walking up for `.claude/settings*.json` read the operator's `~/.claude/settings.json` (eight bash-tail tests depended on it), and `detect.mjs` read the operator's real dev folder.
- Sandbox temp dirs carry the owner pid (`ac-suite-<pid>-*`, `ac-test-<pid>-*`), and a startup sweep removes the ones a killed run left behind: only when the pid is dead, or by age for the old pid-less names. A live run's directory is never touched.
- Fix (`scripts/detect.mjs`, `scripts/lib/publication-sweep.mjs`). The operator's OS handle used for scrubbing now comes from `homeRoot()`, the plugin's home resolver, instead of `os.homedir()`. With a redirected home the handle was the generic word "home". Behaviour is unchanged when the home is not redirected.

## 0.30.1 — 2026-10-06

A test fix for Linux CI, and a fix for a fetch that could leave git running on a loaded machine.

- Test fix. Since 0.30.0 the git-brief fetch-timeout test (`tests/git-brief.test.mjs`) failed on every Linux CI run, even though the process-tree kill worked. The cause was the test's hang server, which never read its sockets. On Linux, SIGKILL closes the connection with a FIN. Node reports end of stream on an undrained socket only after the buffered request has been read, so the socket never closed. On Windows, `taskkill /F` resets the connection, which closes the socket either way. The server now drains its sockets. The assertion is unchanged: a surviving git-remote-http still leaves its socket open and fails the test. The fixed sleep is now a bounded wait for the close events, and a failure lists each socket's events.
- Fetch fix (`scripts/git-brief.mjs`). git-brief's fetch runs under a small runner that kills git's whole process tree at the cap. A backstop kills the runner itself 2 s after the cap. On a loaded machine the runner can take longer than that just to start, so the backstop fired first and left git and git-remote-http running, holding the connection open. This is what failed the fetch-timeout test intermittently on Windows under full-suite load. The runner now prints git's pid, and when the backstop fires the caller kills git's tree itself (`taskkill /T /F` on Windows, the process group elsewhere). git is now started detached on Windows as well as elsewhere. Otherwise killing the runner also killed git and its first child, through node's kill-on-close job, while git-remote-http survived without a parent, out of reach of `taskkill /T`. Detached adds no visible window: git now runs with no console at all, where before it had a hidden one. On Windows the orphan kill first checks that the pid still belongs to a git process, since the pid may have been reused by then, and it runs in a detached helper so it does not hold the hook past its 5 s timeout. A new test forces the backstop path and asserts that no connection survives.
- Behaviour change on Windows: if the hook process itself is killed from outside (for example by the hook timeout), git and git-remote-http now survive it, as they already did on Linux. A stalled transfer still ends by itself through git's low-speed abort (`GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME`, set unless the operator sets them).

## 0.30.0 — 2026-10-04

Token-saving trial: four changes shipped together, each with its own on/off toggle and telemetry stream, so the trial can be switched off per feature and measured per feature (injected-text numbers below).

Trial: each feature has its own toggle and its own telemetry stream. It is measured over the first full week against the 2026-09-27..2026-10-04 baseline, net of retries and re-checks (a saving that forces a redo does not count).

### Trimmed injected text

Trimmed the text the plugin adds to every session. Keeps every rule; shortens rationale (the small requirements and reasons that did go are listed under "Known limits"). Source: `plugin-overhead-2026-10-04.md` (usage postmortem), trims 1 to 4.

- Scout surface (SessionStart): the main session gets a pointer line (signal count, kinds, path to `scout-latest.json`, "mention only if asked") instead of the full signal list; subagents get nothing (the hook already skipped them: `sessionIsSubagent`). The CI-red line is unchanged.
- Standing rules: subagents get none (every built-in session-start rule is `audience: lead`; no rule that governs a worker's own tool use exists to keep). Main session wording tightened, every rule kept: the delegate-first rationale clause "omitted inherits this tier" is dropped (the instruction to set the model explicitly stays); other rules lose filler words only.
- Reporting contract (SubagentStart/spawn brief): tightened, every rule kept (STATUS line, blockers uncompressed, outcome shape, omit list, long output to a file, peer messages one screen); some rationale and emphasis shortened (see "Known limits").
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
- New option `pr_wait` (default on; `CLAUDE_PLUGIN_OPTION_PR_WAIT=0` turns it off) and standing rule `pr-wait-hint`: one session-start line naming the script (reworded after review, see "Review fixes"). Off hides only that line; the script still runs.
- Telemetry stream `telemetry/pr-wait.jsonl`, one row per run: mode, polls, duration, outcome, exit code (`docs/TELEMETRY.md`).
- Tests: `tests/pr-wait.test.mjs` (gh stubbed, including a previous-commit-green PR and a run list holding only the commit before the push), plus the rule-count updates in `tests/standing-rules.test.mjs`.
### Injected text with all four changes

Same method as the trim table (static run of every SessionStart and SubagentStart hook, clean config dir, 3-signal scout; chars of `additionalContext`). Main = scout pointer + standing rules + git brief; the machine-specific capacity line (about 120) is left out. Subagent = what SubagentStart injects (reporting contract + git brief); standing rules and scout add nothing for a worker. `read_dedupe` injects nothing at start (it only denies a repeat Read), so its row never moves.

| Toggles | Main session start | Subagent start |
|---|---|---|
| all on | 1,396 | 796 |
| `git_brief` off | 1,073 | 473 |
| `pr_wait` off | 1,194 | 796 |
| `read_dedupe` off | 1,396 | 796 |
| all three off (the trimmed baseline) | 871 | 473 |

So the three trial features add 525 characters to a main session start (git brief 323, pr-wait hint 202) and 323 to a subagent start (git brief); each is gone with its own switch. Both depend on the plugin's install path, which these lines print: measured with a typical cache path (`C:/Users/<name>/.claude/plugins/cache/agent-companion/agent-companion/<version>`, 75 characters). The pr-wait hint grew from 136 to 202 after review because it now carries the real script path and `run_in_background`. Before review the table read 1,354 / 820 (git brief 347, hint 136), measured under a longer path for the brief.

### Review fixes (2026-10-04)

An independent review of the four changes returned SHIP-WITH-FIXES (2 high, 4 medium, 11 low). Each finding was reproduced before it was fixed.

- **`landed` answered from a stale fetch (high).** `git-brief.mjs landed` honoured the 5-minute fetch stamp, so a branch merged in that window read as NOT on main. `landed` now always fetches (`--no-fetch` for local refs only); the 5-minute window applies to the injected start line only. A NOT that rests on a failed fetch or no remote carries a note (`fetch failed; origin/main may be stale`, `local origin/main only`). An unknown or deleted ref prints `UNKNOWN (no such ref X)` instead of a NOT, and so does a git timeout.
- **A timed-out fetch left `git-remote-http` running (high).** The old synchronous kill ended `git` but not its transport child, which kept the connection open (indefinitely on Windows). Fetches now run under a runner that kills the whole process tree on timeout (`taskkill /T /F` on Windows, a process-group kill elsewhere), with `GIT_HTTP_LOW_SPEED_LIMIT`/`TIME` as a second cut, and one run has an overall deadline (fetch cap plus local cap, `AC_GIT_BRIEF_DEADLINE_MS`). Tested: no orphan survives a hung fetch.
- **pr-wait answered PASS too early (medium).** CI registers checks one after another, so a first poll could see one finished green check and nothing pending. PASS now needs the same check set (head commit, names, verdicts) on two polls at least `PR_WAIT_SETTLE_MS` (default 20 s) apart; a new or changed check restarts the clock; a failure still returns at once. The final line carries the bound head commit (`@sha7`), and `NO-CHECKS` now says "no CI observed (exit 0 = nothing failed)". "not a git repository" is a permanent error (exit 3 at once, not after about 15 s of retries).
- **The pr-wait hint (medium).** It named release tools a plain repository does not have and gave no path. It now carries the script's real absolute path and says to launch it with `run_in_background` (a foreground call dies at two minutes).
- **read-dedupe compared only mtime and size (medium).** A same-size edit with the mtime put back (some tools, and `touch -r`) was missed and a stale read denied. The stat tuple now includes ctime, which a user-space call cannot put back.
- **read-dedupe state contended across agents (medium).** One state file and lock per session made parallel agents queue and fail open on a busy lock. State is now one file per (session, agent), so agents never contend, a held lock on one agent does not touch another, and a lock that cannot be taken writes a `lock-timeout` row instead of vanishing. A whole-session compaction removes every agent's file.
- **Telemetry for all three streams (`docs/TELEMETRY.md`).** read-dedupe: `allow` rows with `allow_reason` (the denominator of the denial rate), `lock-timeout` rows, `hook_event`, `agent_type`, `tool_use_id`, `est_chars`, `deny_chars`, `age_ms`, `deny_at` (joins a `retry-ran` to its denial), `read_index`, `lock_wait_ms`, `duration_ms`, `transcript_bytes`. git-brief: `outcome`, `fetch_outcome`, `fetch_age_ms`, per-step `steps_ms`, `start_ms`; for `landed`, `answer`, `target_hash`, `stamp_age_ms`, `rechecked_after_NOT`. pr-wait: a `start` row (a killed run now leaves one), `event`, `cycles`, `settle_waits`, `head_sha`, `target_hash`, `repo_hash`, `error_class`; `polls` counts gh calls (a PR poll is three).
- **Docs.** `standing_rules: false` also removes the pr-wait hint, because the hint is a built-in standing rule (the toggle note says so). The "keeps every requirement" claim for the trims is reworded to "keeps every rule; shortens rationale".

### Known limits

Found by the review and accepted for the trial; none changes a verdict.

- **Parallel starts can fetch together.** The git-brief fetch stamp is written without a lock, so subagents starting in the same instant may each fetch (once per burst rather than once per 5 minutes). Each fetch is capped at 1.5 s; not fixed.
- **The pr-wait hint is longer than 150 characters.** The earlier 150-character cap cannot hold once the line carries a real absolute path. The wording, path excluded, is at most 125 characters (tested); the whole line is that plus the path length (about 200 under a typical install).
- **A check that registers late is still missed.** The pr-wait settle rule needs the same check set on two polls at least 20 s apart; a check that first appears more than 20 s after the others can still be missed by a PASS.
- **A timed-out fetch costs about 2.1 s on Windows, not 1.5 s.** The 1.5 s cap is when the fetch is killed; reaping its process tree adds about 0.6 s.
- **`NO-CHECKS` still exits 0.** A repository whose CI is slow to start or path-filtered reads as exit 0 after the 90 s grace. The line now says no CI was observed; a distinct exit code was not added, because callers key on 0 today.
- **ctime also moves on attribute changes.** A `chmod`, a rename-over or a hard-link change on an unchanged file forgets the read record, so one repeat read is allowed. The cost is a missed denial, never a wrong one.
- **The scout block lost its per-signal detail.** The session-start scout block is a pointer (count, kinds, path to `scout-latest.json`); the per-signal detail, the dispatch hint (`-> plugin-update`) and the `audit.mjs --only harness-drift,guard-canary` pointer are one file read away, not in context. Intentional (token saving); the lead is expected to read the file when a signal matters.
- **Small requirements and reasons the trims dropped** (rules unchanged, emphasis lost): "never the body inline" became "file path plus summary"; "the one thing you need in order to proceed" became "what you need"; "no recap of context they already have" (peer messages) became "a decision or fact, one screen max"; the rationale "an omitted model inherits this session's tier" is gone (the instruction to set the model stays); "instead of resuming it with SendMessage" is gone from the resume rule; "harness-tracked" is gone from the one-completion-wait rule; and a few skill descriptions lost secondary trigger wording (`recommend`, `calibration-scout`, `evaluate`, `memory-search`, `setup`; every quoted trigger phrase survives). If the trial shows spawns without a model, or per-item polling, rising, restore the inherit-tier rationale first.

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
