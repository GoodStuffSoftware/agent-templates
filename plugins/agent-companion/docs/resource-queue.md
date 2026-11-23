# The machine-wide resource queue

This is the one spec of the queue. Everything else (README option rows, CONTRIBUTING.md, code comments, the CHANGELOG) points here.

The queue lets every agent and every project on one machine share its CPU, RAM and a few named single-user resources (an end-to-end rig, an Android emulator, a gradle project directory) without piling up. A heavy command asks for what it needs, waits in a fair queue until all of it is free at once, runs below normal priority, and gives it back when it ends. It never makes a command fail: waits are bounded and a broken ledger runs the command unqueued.

| Piece | Where | Part |
|---|---|---|
| Ledger core, lease protocol, sweeps | `plugins/agent-companion/scripts/ci-budget.mjs` | 1 and 2 |
| Rules and classes, measured defaults | `plugins/agent-companion/config/resource-rules.json`, `scripts/lib/resource-rules.mjs` | 2 |
| CLI (`run`, `reserve`, `status` ...) | `plugins/agent-companion/scripts/resource-queue.mjs` | 3 |
| PreToolUse resource gate | `hooks/lib/resource-gate.mjs`, called from `hooks/bash-tail.mjs` | 4 |
| "Shared resources:" session line | `hooks/lib/resource-line.mjs`, called from `hooks/advisory-b.mjs` | 5 |

Contents: Part 1 is the lease protocol the pre-push gate (`scripts/ci-local.mjs`) was built on, moved here from CONTRIBUTING.md. Part 2 extends it to the whole queue: resources, run leases, admission, rules, clears, reservations, hold and bound leases. Part 3 is the CLI, the stable launcher path and the `status --json` schema. Part 4 is the hook interface and the gate. Part 5 is the session line.

## Part 1: the shared CI budget (lease protocol)

`plugins/agent-companion/scripts/ci-budget.mjs` replaces the one-run mutex with a shared worker budget: several runs may go at once, and the total of test workers across every run on the machine, plus the load from outside our runs that goes beyond the cores the budget leaves free, stays under one budget. A new run starts with fewer workers when the box is busy, or waits in a fair queue; it never fails. `scripts/ci-local.mjs` takes its leases from it (see "Full suites go through the shared budget" in CONTRIBUTING.md). This file is the one spec of the format. The code links here, and another repo can take leases from the same budget by following it.

**Knobs.**

| Variable | Default | Meaning |
|---|---|---|
| `CI_LOCAL_BUDGET` | `max(2, floor(cores * 0.5))` (16 on 32 logical cores) | total units |
| `CI_LOCAL_HEAVY_COST` | `3` (clamped to the budget) | units one heavy worker costs |
| `CI_LOCAL_HEAVY_MAX` | `2` | heavy workers machine-wide |
| `CI_LOCAL_EXPRESS` | `2` | extra units a targeted run may use past the budget |
| `CI_LOCAL_MAX_PARALLEL` | unlimited | caps concurrent *full* runs only (the budget governs otherwise; before 0.31.18 it was the old lock's slot count, default 1) |
| `CI_LOCAL_LOCK=0` | off | bypass: a no-op lease, no files written |
| `CI_LOCAL_BUDGET_POLL_MS` / `CI_LOCAL_BUDGET_STALE_MS` | `1500` / `90000` | queue poll interval, heartbeat stale age |
| `CI_BUDGET_DIR` | see below | ledger directory |
| `CI_LOCAL_HEAVY_MAX_WAIT_MS` | `600000` (10 min) | longest a heavy pass waits for a slot before it runs with one heavy worker |
| `CI_LOCAL_QUEUE_MAX_WAIT_MS` | `1800000` (30 min) | longest a full run waits in the queue; then it starts with 1 worker, over budget, and logs one line |
| `CI_LOCAL_EXPRESS_MAX_WAIT_MS` | `300000` (5 min) | longest a targeted run waits at the express headroom; then it starts over budget and logs one line |
| `CI_LOCAL_RESERVE` | `max(1, round(cores / 8))` (4 on 32 logical cores; `0` = none; at most `cores - 1`) | cores kept idle for interactive work and hooks; see "Headroom for hooks" |
| `CI_LOCAL_LOAD_PCT` | `90` (1 to 100) | busy share of the cores above which the machine counts as loaded |
| `CI_LOCAL_SLICE` | `6` (`0` = off) | test files per granted worker in one slice of a long ci-local pass; each slice re-samples the load (ci-local only; not part of the lease protocol) |
| `CI_BUDGET_REPO` | basename of the git top-level directory above the worktree (walk up for `.git`, no process spawned), else the worktree basename | `repo` label written into leases |

**Ledger directory.** Machine-wide and named after no repo: `CI_BUDGET_DIR` if set, else `<claude home>/agent-companion/ci-budget` on Windows (outside AppData on purpose: the MSIX-packaged desktop app and unpackaged daemons see different `%LOCALAPPDATA%` folders; the older `%LOCALAPPDATA%\ci-budget` and the package private copies are still counted, read-only, while older versions run), else `$XDG_RUNTIME_DIR/ci-budget` (fallback `os.tmpdir()/ci-budget`).

**Files** (ids are 12 hex chars):

- `lease-<id>.json`: one per holder, `{ id, pid, startedAt, heartbeatAt, repo, worktree, kind, units, heavy, heavyCost, label }`. A holder's `hbStale` is `{heartbeatAgeMs, staleMs}` or null, `ceilingMs` the live-holder ceiling (null when off) and `releaseCommand` the command that releases it by hand (flagged holders only). Times are epoch ms. `kind` is `full` or `targeted`. `repo` is a label, `worktree` a path, both for display only.
- `lease-<id>.hb`: a heartbeat sidecar holding one epoch-ms number.
- `ticket-<id>.json`: one per queued full run, `{ id, pid, createdAt, heartbeatAt, repo, worktree, kind: "full", desired }`.
- `admit.lock`: a short mutex, `{ pid, at, token }`, held only while a process reads the ledger and writes a lease.

**Units.** A lease holds `units` plain workers and `heavy` heavy workers (test files that spawn many git or shell processes, so spawn cost, not CPU, is what limits them). It is charged `units + heavy * heavyCost`. `held` is the sum of live charges. A lease never holds fewer than one worker, except while a heavy pass waits: a waiter holds nothing, so that several waiters on a small budget cannot starve each other (each keeping one unit would leave the others too little room for a heavy worker, and none would ever be granted).

**Atomic rules.** Create a file with an exclusive open (`wx`). Update by writing a temp file in the same directory and renaming it over the target (retry a few times on `EPERM`/`EBUSY`, which Windows raises while a reader has the target open). Only the owner updates its lease or ticket. A lease is created and resized while holding `admit.lock`; the heartbeat put-back below is the one exception. The `.hb` sidecar is the one file rewritten in place (a single number; a reader ignores a torn read). Remove a stale file by renaming it aside first, so that of several reclaimers only one wins. `admit.lock` is created with `wx`, removed after use, and broken when its pid is dead or it is over 10 s old.

**Stale rules.** A lease or ticket is stale when its pid is not alive, or its heartbeat is older than 90 s. The heartbeat is the newest of `heartbeatAt`, the sidecar value, and the start time. Whoever notices removes it. A reclaiming read also deletes crash debris, `*.tmp-*` and `*.stale-*` files over about 10 minutes old. There is no age cap on the heartbeat rule: a heartbeat is the proof of life, and it also covers Windows pid reuse. A lease whose heartbeat went stale but whose wrapper pid is verified live (it started no later than the grant plus 5 s, so it is not a reused pid) is flagged `HEARTBEAT STALE` and kept, up to the 4 h live-holder ceiling below; a pid that cannot be verified is released as before. The owner refreshes it every 20 s from a worker thread, not a main-thread timer, because ci-local blocks its main thread in `spawnSync` for minutes. A long suspend (a laptop sleep) can make a live lease look stale before its next tick. The heartbeat thread then puts the lease back from the record the main thread last sent it, on its next tick (within 20 s) and without taking `admit.lock`, so a few units can briefly be over-admitted. A reader normalizes a lease it does not fully understand (a missing `kind` counts as `full`, a bad `heavyCost` as the local default) instead of failing.

**Admission, full run.** The run writes a ticket, then loops: drop stale entries; only the head ticket, ordered by `(createdAt, pid)`, may be admitted. The head samples outside load, takes `admit.lock`, re-reads the ledger and computes `free = budget - held - counted` (`counted` is the part of the outside load that the budget's headroom does not already cover; see "Outside load"). It admits only if `free >= 1` and fewer than `CI_LOCAL_MAX_PARALLEL` full leases are live: `grant = min(desired, free)` plain units, ticket removed, lease created. A head that finds no live lease may always start with one unit, so outside load alone never starves it. Once the head is admitted the next ticket is evaluated against what is left. The wait is bounded: after `CI_LOCAL_QUEUE_MAX_WAIT_MS` (default 30 minutes), head or not, the run drops its ticket, takes a 1-unit lease whatever `free` is (so a hung but alive holder cannot stall it forever) and prints one line saying it ran over budget after the wait. A waiter polls the directory every 1.5 s with fs calls only (the head also reads `os.cpus()` for the outside-load sample) and prints one `waiting` line at the start and one every 60 s.

**Outside load.** Two `os.cpus()` reads about 300 ms apart give `busy = sum over cores of (1 - idleDelta / totalDelta)` cores. `external = max(0, round(busy - held))`: the busy cores our held units do not explain. The sampler is injectable, nothing is spawned. **Only the outside load beyond the machine's headroom is charged:** `counted = max(0, external - max(0, cores - budget))`. The budget is a share of the cores (default half), and the `cores - budget` cores outside it are already left to outside work (a desktop's other programs, Defender, hooks), so charging all of `external` again counted that work twice: on 2026-11-13 a 32-core desktop (budget 16) never admitted a 12-slot job behind a 1-slot holder, because outside load sat at 9 to 17 cores, and every job queued behind it waited the 30-minute bound. A budget at or above the core count (a small host, or `CI_LOCAL_BUDGET` set high) has no headroom, so all of `external` counts there, and `counted` is never negative; admission never goes past `budget - held`. Every admission path uses it: full runs, resizes, and `box:N` requests below. `status` still shows the raw `external` estimate.

**Admission, targeted run (express).** A single-file run takes a 1-unit `targeted` lease with no ticket, at once, while `held + 1 <= budget + CI_LOCAL_EXPRESS`; past that it polls without queueing. It never waits behind a full suite. Its wait is bounded too: after `CI_LOCAL_EXPRESS_MAX_WAIT_MS` (default 5 minutes) it takes its 1-unit lease anyway, over budget, and prints one line saying so.

**Headroom for hooks.** Hooks and interactive work share this machine with the test runs, so the budget keeps room for them. The machine is *loaded* when `busy > min(cores - CI_LOCAL_RESERVE, cores * CI_LOCAL_LOAD_PCT / 100)`, where `busy` is the same sampled busy-core count as above, our own workers included: fewer than `CI_LOCAL_RESERVE` cores idle, or over `CI_LOCAL_LOAD_PCT` percent busy. Admission slows while it is loaded. A full run is admitted with one worker whatever `desired` and `free` say. A resize grants at most one worker per lane (plain, heavy) and cuts a lease that is larger to one worker. Nothing waits and nothing fails: the one-worker floor of the rules above still holds, and a later request admits more once the load is down. The load is sampled again on every grow, and on `lease.resize(spec, { resample: true })` even when the lease asks for no more than it holds. ci-local uses that between slices of a long pass: its regular files run in slices of `CI_LOCAL_SLICE` files per worker (default 6) and each slice asks for its workers again, so a long pass follows the load instead of holding the grant it won at admission. A slice that was cut to one worker is short, so the next look comes soon. A targeted run is one worker already and is not slowed. With `CI_LOCAL_RESERVE=0 CI_LOCAL_LOAD_PCT=100` the guard never trips. A lease written by another repo needs no change for any of this: the file formats and the rules above are unchanged, and the guard is applied by whoever admits.

**Priority.** A test run should yield the cpu to hooks. `scripts/ci-local.mjs` calls `lowerOwnPriority()` (from `ci-budget.mjs`) first thing in its entry point, which runs `os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)` inside a `try`/`catch` that logs nothing, and skips a process that is already nicer. Children inherit the class on Windows (checked through `sh`) and the nice value elsewhere, so the suites, the per-file test processes and their git and shell children all run below normal; the pre-push gate runs through the same entry point. Hooks are a separate path and keep normal priority. Another repo that takes leases should do the same in the script that starts its tests.

**Heavy lane.** `lease.resize({ units, heavy })` changes a lease between phases. A shrink applies at once. A grow goes through admission against `free` (outside load beyond the headroom counted; see "Headroom for hooks" for a loaded machine), and each heavy worker also needs `heavyMax - heavyHeld >= 1` and `free >= heavyCost`. A run alone on the box (nothing else held) always gets one heavy worker whatever the outside load, as a full run always gets one unit. Without `{ wait: true }` it takes what it can get; with it, it polls until every requested lane has a worker, holding nothing meanwhile, and after `CI_LOCAL_HEAVY_MAX_WAIT_MS` it takes one heavy worker regardless of `free` and the cap and logs one line.

**Fail open.** Any ledger error (a directory that exists but is read-only, `EPERM`, `EACCES`, a disk error) or a throwing cpu sampler makes the run go on without the budget: `acquire` returns a no-op lease, a failure during `resize` turns the lease into one, and either way one line says so. The budget never crashes ci-local or blocks a push.

**Known limits (accepted).** A stale `admit.lock` can be broken twice by two simultaneous contenders, so two runs may be inside the admission section for a few ms and over-admit a few units once; it takes a crash inside that ms-wide section plus two contenders. The `.hb` sidecar is rewritten in place, so a reader can see it empty (about one read in a million); the reader then falls back to the lease's own `heartbeatAt`, and the heartbeat thread puts a falsely reclaimed lease back on its next tick.

**Lifecycle.** The module releases its leases on process `exit`, `SIGINT` and `SIGTERM` (the signal handler exits 130 or 143 itself when nothing else listens). A killed process is reclaimed by the stale rules. Release wins over the heartbeat: `release()` first tells the heartbeat thread to stop, through a shared flag, and waits out a tick that is already under way (a few ms), and only then removes the lease files, so a released lease is never put back.

**Old lock holders.** While worktrees on 0.31.17 or earlier still take the pre-budget mutex, a reader counts each live holder of its slot files (`slot-<n>.lock` under `os.tmpdir()/agent-templates-ci-local`, or `$CI_LOCAL_LOCK_DIR`; pid alive and under 45 minutes old) as one full run at the default concurrency, `min(8, max(1, floor(cores / 2)))` units. It only reads that directory.

**Status.** `node plugins/agent-companion/scripts/ci-budget.mjs status [--json] [--no-sample]` prints budget, held, free, the outside-load estimate, the load guard (reserve, threshold, loaded now or not), each lease (kind, repo, worktree, pid, workers, heavy, age, heartbeat age) of every repo, and the queue. It reads only and removes nothing.

## Part 2: the queue (resources, admission, rules, clears)

Part 1 describes the budget and the lease files. The queue adds named resources, RAM, run leases and a rule engine on the same ledger directory and the same atomic-file rules. Every field below is additive: a reader that does not know it ignores it, and a lease or ticket written without it reads as before.

### Resources

- **`box`** is the CI budget of Part 1 (`CI_LOCAL_BUDGET`, default `max(2, floor(cores / 2))`), counted in units. It is sized from the machine and never set in the rules file.
- **Named resources** are exclusive by default: capacity 1. A name is letters, digits, `.`, `_`, `-`. The capacity comes from `CI_BUDGET_RESOURCES=a=2,b=1`, else `resources.<name>.capacity` in the rules file, else 1. The shipped file names `app-e2e` (capacity 1, an end-to-end rig that boots emulators and browsers), and classes name `android-emu`, `gradle-{cwd}` (one per project directory: `{cwd}` becomes an 8-hex hash of the working directory) and `fs-emu-ports`.
- **A request** is a set of `box:N` units, zero or more named resources (`name` or `name:N`) and an optional RAM figure. It is granted all at once or not at all.

### Run leases and tickets

A command run through the queue (`resource-queue.mjs run`, Part 3) is a lease of `kind` `run`. Its extra fields on `lease-<id>.json`: `project`, `session`, `resources` (`{name: n}`), `ramMb`, `limits` (`{maxHoldMs, idleMs, minHoldMs}`), `monitored`, and, when asked, `group`, and for a bound lease `boundPid` and `wrapperPid`. A queued run is a `ticket-<id>.json` with `kind: "run"`, `boxUnits`, `resources`, `ramMb`, `label`, `project`, `session`, and optionally `group`.

Sidecars next to a lease or ticket:

- `lease-<id>.act`: line 1 `"sampledAt activeAt"`; line 2 (optional) the last sample's replay record, one small JSON object: `n` (samples so far), `size` (tree size), `shells` (msys shells in the tree), `links` (msys links read; `null` = unreadable), `cpuMs` and `dtMs` (summed cpu delta over the interval; `null` on the first sample), `pct`, `kids` (busy-child matches), `ports` (listening ports in the class bands; `null` = not read because an earlier test already said active), `why` (the test that said active, else `null`). Written by the wrapper while it measures the process tree; the idle rule reads it. A reader that knows only line 1 still works.
- `lease-<id>.live`: `{pid, startedAt, verifiedAt}`, the verified-live record for a stale-heartbeat lease (see `heartbeat-stale`). Written by a sweep, read by `status`, removed with the lease.
- `lease-<id>.cleared`: a tombstone. A lease the rules cleared stays cleared: the wrapper's heartbeat does not put it back.
- `ticket-<id>.paused`: `{by, at, until}`, a hold (see "Reservations, hold and bound leases").

`project` is the working directory's project label; a linked git worktree is named for its main checkout. `session` is `CLAUDE_CODE_SESSION_ID`.

### Admission

A request is admitted when every part of it fits at once:

1. **FIFO, per resource, with bounded backfill (0.31.62).** A later box-only ticket may go first when, after its grant, `budget - held - request` still covers the box (and RAM) need of every ticket it passes; it never passes a ticket on a shared named lane, and a head passed over 6 times blocks it again.
1. **FIFO, per resource.** Tickets are ordered by `(createdAt, pid)`. A ticket waits behind an earlier ticket only when they share a resource: a later ticket that wants only `app-e2e` is not blocked by an earlier one that wants only `box`. Only box-using tickets order against each other for the box. A ticket that is held or passed over (below) blocks nobody.
2. **Units and CPU.** For `box:N`: `N <= budget - held - counted`, where `counted` is the part of the sampled outside load of Part 1 (busy cores our held units do not explain) that exceeds `cores - budget`. A blocked request says why: `box:12 wanted, 11 available of 16 (1 held, outside load ~20 cores; 4 count against the budget after 16 cores of headroom)`. A request that finds nothing else held always progresses. The headroom rules of Part 1 ("Headroom for hooks") apply unchanged.
3. **Named resources.** Each requested name has `held + N <= capacity`.
4. **RAM.** A request that states RAM (`--ram` or its class's `ramMb`) needs `free RAM - reserve - committed >= request`, where `reserve = max(ram.reserveMinMb 2048, ram.reserveFraction 0.125 * total RAM)` (the **floor is `max(2 GB, 12.5%)`**: 8 GB on a 64 GB machine, 2 GB up to 16 GB; a number in `ram.reserveMb` overrides it) and `committed` is the RAM of leases younger than `ram.rampMs` (default 60 s): granted but not yet at their peak. The check is skipped while nothing else is held.
5. **No reservation against it.** See "Reservations, hold and bound leases".

The grant is atomic: the admitter takes `admit.lock`, re-reads the ledger, and writes one lease holding every resource. The wait is bounded like a full run's (`CI_LOCAL_QUEUE_MAX_WAIT_MS`, 30 minutes, or `--max-wait` seconds): after it the run takes its lease over budget and prints one line saying so. Time spent held or passed over for a reservation does not count. A waiter prints a `waiting` line saying what blocks it (`blockedBy`) at the start and every 60 s. A ledger error runs the command without the queue (fail open).

### The rules file

Shipped defaults: `plugins/agent-companion/config/resource-rules.json`. The user's file is `<claude dir>/agent-companion/config/resource-rules.json`; `AC_RESOURCE_RULES` points at a different file. Merge: objects merge key by key, `rules` and `classes` merge by `id`, other arrays replace. A value of `null` or `0` turns a limit off.

| Key | Meaning |
|---|---|
| `ram` | `reserveMb` (null = auto), `reserveMinMb` 2048, `reserveFraction` 0.125, `rampMs` 60000 |
| `resources.<name>` | `capacity`, and the limits `maxHoldMs`, `minHoldMs`, `idleMs` for leases that hold it |
| `classes[]` | A named kind of heavy command: `id`, `box` units, `resources`, `ramMb`, `maxHoldMs`, `ports` (listening-socket bands that count as activity), `busyChildren` (process names that count as activity), `notes`. `run --class <id>` fills the request from it. The shipped classes are `e2e`, `e2e-spec`, `push-gate`, `vitest-full`, `vitest-dir`, `lint`, `emulator`, `gradle`, `fs-emulator`, `install`, `node-test-full`, `build` and `test-suite`. Figures marked M in the file are measured, E are conservative estimates |
| `rules[]` | The clear rules below. `enabled` and the numbers can be overridden by `id` |
| `legacyLocks[]` | Held-lock directories of older tooling that the admitter reads (never writes) and waits for. Empty by default. There is no yield file: no file read by the queue can stop every waiter |
| `strays[]` | Processes that should not run while nothing holds their resource, for `status --strays` |

### Clear rules

A rule clears a lease or ticket, which means it **releases the claim**. It never signals, kills or stops a process; a cleared holder that is still running keeps running and its CPU counts as outside load. The sweep runs on every join, every poll, on `status` and on `sweep`.

| Rule | Applies to | Clears when |
|---|---|---|
| `pid-dead` | leases, tickets | the holder's or requester's pid is not alive (a pid-bound lease: the bound pid) |
| `heartbeat-stale` | leases, tickets | no heartbeat for `CI_LOCAL_BUDGET_STALE_MS` (90 s). A bound lease has no heartbeat rule. **Exception:** a lease whose wrapper pid is verified live (see "Stale rules"; the check reads the process table at most once a minute per pid, only in a sweep, and is cached in `lease-<id>.live`, which `status` reads without spawning anything) is flagged `HEARTBEAT STALE` (holder field `hbStale`: `heartbeatAgeMs`, `staleMs`) and kept up to the `live-holder-ceiling`; a pid with an unknown or later start time is released as before |
| `requester-gone` | tickets | the queued requester's pid is not alive (the clears log names this rule for tickets) |
| `max-hold` | run leases | older than the limit: its class's `maxHoldMs`, else the smallest `maxHoldMs` of the resources it holds. **A live holder is not released by this rule, only kept up to the `live-holder-ceiling` (4 h):** if its wrapper pid (or bound pid) is alive, whatever it holds (a named resource of capacity 1, or box units only) and whatever its probe says, the lease is kept and `status` flags it `OVER TIME` (holder field `overTime`: `heldMs`, `maxHoldMs`, `activity` `active`, `idle` or `unknown`; with a probe record also `sampleAgeMs` and `sample`). It goes when it exits or dies (`pid-dead`), or at the ceiling. Dead and stale holders go at once under `pid-dead` and `heartbeat-stale` |
| `idle` | run leases with an `.act` sidecar | **A live holder is not released by this rule, only kept up to the `live-holder-ceiling` (4 h):** when the test below says idle but the holder's wrapper pid (or bound pid) is alive, the lease is kept and `status` flags it `IDLE?` (holder field `idleFlag`: `idleMs`, `idleLimitMs`, `sampleAgeMs`, `sample`, the last probe record above: tree size, cpu delta, ports, busy-child matches, sample count). The sampler can misread a live tree (a push gate was cleared this way while its tests and end-to-end run were working); a pid that is still running is the stronger evidence. The lease ends when the holder exits or dies (`pid-dead`), or at the ceiling. The test: at least `minHoldMs` old and, for `idleMs`, the process tree used under `minCpuPct` (5) of one core, held no listening socket in the class's port bands and had no busy child. A busy child is a process whose image name is a `busyChildren` name (or that name + `w`: `java`, `javaw`), or whose command line holds the name as a whole token: it starts at the line start, whitespace, a quote, a path separator, `= : ; , @ (` or a hyphen (`ms-playwright`), and ends at the line end, whitespace, a quote, a path separator, `= : ; , )`, a file extension (`java.exe`, `vitest.mjs`, `vitest.config.ts`) or `-core` (`playwright-core`). So `java` does not match `javascript`, and `vitest` does not match a branch name such as `fix/vitest-flake` on a push command line. The tree is the Windows parent walk plus Git Bash (msys) links read from Git's `ps -a -l` (Git's `ps.exe` is found beside the tree's sh, then through `CLAUDE_CODE_GIT_BASH_PATH`, the standard install dirs, PATH and `git --exec-path`, so a stripped PATH cannot hide it), plus the children of any pid seen in the tree earlier (adopted only when their start time fits: no earlier than the dead pid's own start, else the root's, and no later than the first sample that found it dead; a start time missing on either side adopts, as before): an msys fork + exec of an msys program (a hook running an npm or npx shim) leaves the exec'd program with a dead Windows parent. A process that started before its own parent, by the start times the probe reads (Windows `CreationDate`, Linux `/proc` starttime, 2 s of slack), carries a stale parent pid left by a reused pid and is not in the tree; with no start time on either side the link stands. An msys process in the tree while that list is unreadable counts as active (unknown means keep). CPU is summed per pid against the previous sample. A lease nobody measures is never idle-flagged. A bound lease has no sidecar, so it is exempt |
| `live-holder-ceiling` | run leases | a live holder that `max-hold`, `idle` or a stale heartbeat flagged has held its lease longer than `ceilingMs` in the rule entry of `resource-rules.json` (default 14400000, 4 h, counted from the grant). The sweep then releases the lease, prints one loud line (`RELEASED the lease of LIVE pid ...`; the process is not touched and may still run) and logs the clear under rule `live-holder-ceiling`, evidence `heldMs`, `ceilingMs`, `flaggedBy` (`max-hold`, `idle` or `heartbeat-stale`) and the flagging rule's own evidence. Turn it off with `ceilingMs` null or 0, or `enabled: false`: a flagged live holder is then kept until it exits |
| `manual` | leases | `resource-queue.mjs release <lease-id>` (see the CLI): clears one lease on request, with a tombstone like any clear; evidence `by: manual` |
| `reservation-expired`, `reservation-owner-gone`, `reservation-invalid`, `unreserved` | reservations | see "Reservations, hold and bound leases" |
| `reservation-idle-lapse` | reservations | see "Reservations, hold and bound leases" |

The shipped rule defaults: `max-hold` and `idle` enabled (both flag a live holder; the `live-holder-ceiling`, 4 h, releases a flagged one; a dead one goes under `pid-dead`); `idle` with `sampleMs` 30000 and `minCpuPct` 5; `app-e2e` with `maxHoldMs` 1800000, `minHoldMs` 600000 and `idleMs` 300000; the `e2e`, `e2e-spec` and `push-gate` classes flag over time at 1800000 (loaded full runs were measured at 10 to 18 minutes).

### The clears log

Every clear is appended once (only by the process that actually removed the entry; one that lost the cleanup race writes no row) to `clears.jsonl` in the ledger directory, one JSON object per line, rotated to `clears.jsonl.1` over 512 KB. Fields: `at` (epoch ms), `rule`, `type` (`lease`, `ticket` or `reservation`), `id`, `pid`, `label`, `project`, `repo`, `worktree`, `session`, `resources` (`{name: units}`; `{<resource>: 0}` for a reservation) and `evidence` (what the rule saw: ages, cpu share, ports, the limit). Rules that clear a dead holder record the pid; a `live-holder-ceiling` clear and a `manual` clear are logged like any other; a flag (`IDLE?`, `OVER TIME`, `HEARTBEAT STALE`) is not a clear and is not logged: it lives in `status` while the lease runs, with the same evidence plus the last probe record (`sample`: tree size, cpu delta, ports, busy-child matches, sample count) and its age (`sampleAgeMs`). `status` shows the newest as `recentClears`, and the session line shows one that is under 15 minutes old.

### The grants log

Every grant appends one JSON line to `grants.jsonl` in the ledger directory (rotated to `grants.jsonl.1` over 512 KB, like `clears.jsonl`); a write failure never blocks a grant. It answers whether RAM, the box or a named lane is the real limit. Fields: `ts` (epoch ms), `id` (lease id), `kind` (`run`, `full`, `targeted`), `label`, `project`, `requested` (`{box, <lane>: units}`), `ramMb`, `waitedMs`, `waitedBy` (`{resource: ms}`: each poll interval is split over the resources blocking the request at its start; `box`, `ram`, a lane name, `hold`, or a reserved resource), `limiting` (every resource that blocked it at any point), `backfilled` (it went ahead of a blocked head, see Admission), `overCapacity` (granted by the bounded wait over budget, with `overCap`: the lanes it went over, e.g. `["pool 2+1/2"]`), and `held` (`{box, ramMb}` held by other leases just before this grant). Grants of ci-local's own queue (`full`, `targeted`) are box waits: `waitedBy` is `{box: waitedMs}` when they waited.

`resource-queue.mjs grants [--hours N] [--json]` (default 24 h; reads both log files, read only) prints the grant count, how many waited, median (mean of the middle two for an even count) and p90 (nearest rank) wait, backfilled and over-capacity counts, and for each limiting resource its wait time, its share of all attributed wait time and how many grants it limited. `--json` gives `{ok, dir, hours, count, waited, medianWaitMs, p90WaitMs, maxWaitMs, totalWaitMs, backfilled, overCapacity, limiting: [{resource, waitMs, share, grants}]}`.

**Split self-check.** When live leases sit in another ledger (the old `%LOCALAPPDATA%\ci-budget` or an MSIX private copy, counted read-only, see Part 1), `status` prints one line `WARNING: split ledger: N live lease(s) in another ledger (<dir>: <n>; ...)` and `--json` carries `foreign: {count, dirs}`. No line when there are none.

### Reservations, hold and bound leases

#### Reservations: step aside for a named group

A reservation lets one party tell the queue "this resource goes to group G first, until time T". It always names who it is for, always ends, and only ever affects waiters outside that group, for that one resource.

```
reserve <resource> --for <group> --until <time> [--reason <text>]
unreserve <resource> [--for <group>]
run ... --group <name> ...
```

- `<resource>` is `box` or a named resource. `<group>` is a name (letters, digits, `.`, `_`, `-`). A request joins a group with `run --group <name>`; the group is recorded on its ticket and lease. Requests without `--group` belong to no group and never match a reservation.
- `--until` is required: a duration (`90s`, `30m`, `2h`, `1h30m`), a local `HH:MM` (the next one), an ISO time, or epoch milliseconds. The end is capped at 4 hours after creation; a longer ask is clamped and the command says so. A past time is refused.
- File: `reservation-<id>.json` in the ledger directory, `{id, resource, forGroup, owner:{pid, session}, createdAt, expiresAt, reason}`, written with write-temp-then-rename. `owner.pid` is `--owner-pid` or `CLAUDE_PID` (0 if unknown: then only the clock applies); `owner.session` is `CLAUDE_CODE_SESSION_ID`. Reserving the same resource for the same group again replaces the earlier reservation; different groups may each hold a reservation on one resource.
- Effect on admission. While a reservation on resource R is active, a waiter whose group is not among R's reserved groups is passed over for R: it cannot be admitted, it keeps its queue position, and its wait line says why and until when. Waiters whose group matches are admitted first, in their own FIFO order, as R is free. R free and nobody from the group queued does not release the reservation: the group may be between two jobs. Requests that do not use R are not affected at all.
- A queued ticket that is passed over (reservation or hold) does not block the tickets behind it on any resource, so a reservation on one resource never delays work on another.
- Time spent passed over (or held) does not count toward the bounded queue wait.
- A reservation ends when: the effective end `min(expiresAt, createdAt + 4 h)` has passed; `owner.pid` is set and not alive; the file is invalid (no resource, no group, no creation time, no expiry); anyone runs `unreserve`; or the idle lapse below. The sweep removes it and appends a record to `clears.jsonl` (`type: "reservation"`, `rule` one of `reservation-expired`, `reservation-owner-gone`, `reservation-invalid`, `unreserved`, `reservation-idle-lapse`, `evidence` with `forGroup`, `createdAt`, `expiresAt`, `endsAt` and, for `unreserved`, `by`).
- After a reservation ends the original queue order applies again: nobody lost a place.
- No global block. No file, flag or command stops every waiter: a reservation is per resource and per group, ends within 4 hours, ends when its owner is gone, and any waiter's operator can lift it with `unreserve`.

**Idle lapse (use it or lose it).** A reservation also ends when no job of its group has held or waited for the reserved resource for `reservationIdleLapseMinutes` (`resource-rules.json`, default 20; `0` or null turns the lapse off). The idle time is counted from the reservation's creation or from the last matching activity, whichever is later. Matching activity is a live lease or live queued ticket whose group equals the reservation's group and which uses the reserved resource (a paused ticket counts as a waiter), or the release of such a lease. The last matching activity is stored in the ledger in `reservation-<id>.active` (`{lastMatchAt}`, epoch ms), so it survives the wrapper exiting; the sweep also removes orphan `.active` files. The sweep removes a lapsed reservation and appends to `clears.jsonl` a record with `rule: "reservation-idle-lapse"`, `type: "reservation"` and evidence `{forGroup, createdAt, expiresAt, endsAt, idleMinutes, lastMatchAt, lapseMinutes}`; it shows in recent clears like the other reservation rules. The 4 h cap, expiry, owner-gone and `unreserve` are unchanged. The lapse is evaluated in sweeps (every join, poll and `sweep`), so a reservation on a ledger nobody touches is removed at the next sweep.

#### Hold: pause my own queued entries

```
hold [--until <time>]
resume
```

`hold` pauses every queued entry whose recorded session equals the caller's `CLAUDE_CODE_SESSION_ID`; with no session id it refuses (exit 2) rather than guess. `resume` undoes it. A paused entry keeps its place and is passed over when its turn comes; entries behind it are not blocked by it, and nobody else's entries change. A hold lasts until `resume`, the `--until` time, or 4 hours at most, then lapses by itself. State is the sidecar `ticket-<id>.paused`, not a ticket field (the waiting process rewrites its own ticket and would undo it). Running leases are never paused.

#### Pid-bound leases (daemons)

```
run --resource <name>[:N] [--class <id>] [--shell bash] --bind-pid <pid> [-- <cmd...>]
```

For a daemon the wrapper does not outlive (an Android emulator holding `android-emu:1` for up to 60 minutes). The request queues like any other; when granted, the lease gets `pid` = `boundPid` = the bound pid and `wrapperPid` = the wrapper's pid. The wrapper writes no heartbeat and does not release at exit. With a command, the command runs and its exit does not release the lease; without one, the wrapper prints the lease id and exits 0. The lease is stale exactly when `boundPid` is not alive (rule `pid-dead`); `max-hold` flags it over time (an exclusive resource is not taken from a live bound pid that is unmeasured before the 4 h ceiling); the lease, never the process, is cleared when the pid is gone. If the bound pid is not running at the grant, the lease is the wrapper's, an ordinary one, and a line says so (with no command nothing stays held and the exit code is 1). A reused pid keeps a bound lease alive; `status` shows it OVER TIME past `max-hold`, and the ceiling releases it 4 h after the grant like any other live holder.

#### Compatibility

All fields above are additive. A reader ignores unknown fields and treats a missing `reservations` array in a status object as empty. `schemaVersion` of the status stays 1.

### Live capacity and charge-follows-measure

Option `live_capacity` (default `on`; `off`, `false`, `0`, `no`, or `CLAUDE_PLUGIN_OPTION_LIVE_CAPACITY`; each process reads it at start). Off restores the older behaviour: every holder costs its declared units.

**Charge.** Declared is `units + heavy * heavyCost`. A run lease the wrapper tracks (not a bound daemon, not a ci-local lease) with a fresh `lease-<id>.use` sidecar (age under 150 s) and at least 3 valid samples (about 80 s) is charged `clamp(ceil(max(last 4 cpu samples)), 1, declared)`: it rises at the first busy sample and falls only after 4 quiet samples (about 100 s). Never above declared, never below 1. Anything else (no measure, stale measure, still warming, bound daemon, ci-local) is charged declared.

**Expected use of a new job** comes from `usage.jsonl`: key `cls|repo|label` (digits and long ids in the label folded to `#`), falling back to `cls|repo`; the nearest-rank 90th percentile over the newest 20 rows, needing at least 3 rows. No history: declared.

**Admission** of a box request: (1) the budget test against `min(budget, physical cores) - held (charged) - counted external`, using the expected charge when history exists; (2) a free-CPU test: the expected cores must fit in `cores - reserve - busy - promised`, where `promised` is what leases still warming are expected to use (skipped when the box is empty); (3) a hard cap: charged units plus the request never exceed the physical core count; (4) RAM uses the expected peak when history exists. FIFO, backfill, exclusive lanes, tombstones and the over-capacity grant after the bounded wait are unchanged.

**Status.** Holder rows gain `declared`, `charged`, `measured` (`{cpu, ramMb, n, ageMs, warm, fresh}` or null) and `expected`; text form `declared 8 / charged 1 / measured 0.1 cpu 310 MB`; the machine block gains `liveCapacity`; every waiter shows a `why:` line. All keys are additive (schema version unchanged).

**Files (ledger dir).** `usage.jsonl`: one row per released tracked lease with at least 3 valid samples (`key, key2, cls, repo, label, project, declared, durMs, ts, cpuP90, cpuMax, ramMaxMb, n`); delete rows to reset a poisoned history. `lease-<id>.use`: written by the wrapper tick (`{v, at, n, win, cpu, ramMb, ramPeakMb}`); a missing or torn file reads as no measure. The lease record gains `ukey, key2, cls, expCpu, expRamMb`, a ticket `expCpu, expRamMb`.

**Limits.** A fork-per-file runner between ticks is not seen, so measured cpu can understate (the max over 4 samples, the p90 over runs and the free-CPU test, which reads the machine's real busy cores, bound this). A stale `.use` (150 s) reverts the lease to declared. An idle holder that bursts can oversubscribe for at most one tick (25 s), bounded by the physical-cores cap.

### Stuck holders

A run lease with no progress (CPU time, I/O counters, new or ended processes, idle-probe activity) for 15 minutes while held past its expected hold (the lease limit, else 30 minutes) is STUCK. Both numbers are the `stuck` rule in `config/resource-rules.json` (`quietMs`, `defaultHoldMs`).

Option `stuck_holder_policy`: `flag` (default) keeps the lease; `release` lets the sweep free it, logged once, without stopping the process. A release is sticky: the `.cleared` tombstone stops the heartbeat from reviving it, and the wrapper logs that it "was released ... keeps running without it". Any other value counts as `flag`. Progress sampling rides the reap tick, so it needs `reap_policy` not `off`.

Status: holder rows gain `progress` and `stuck`; text `STUCK (no progress Nm on cpu, io: held Nm > expected Nm; policy flag: kept)` replaces OVER TIME / IDLE?, and the session line shows ` STUCK <age>`. Signals: Windows I/O is read, write and other transfer bytes; Linux reads `/proc/<pid>/io`; macOS has no I/O counter, so cpu, spawn and probe only. Sidecar: `lease-<id>.prog`.

### Reaping a lease's children

The wrapper of a `run` lease records its process tree (pid + creation time) in `lease-<id>.tree` (a timer, first tick at about 3 s, then every 25 s; one process snapshot per tick, about 1.2 s on Windows, always outside the ledger lock). Bound leases, non-run leases and ci-local record nothing; a class can opt out with `reapTree: false`.

**When it stops processes:** at release (`why: release`: the recorded tree plus live descendants of the wrapper); in the sweep (`sweep`, `status`, a heartbeat sweep that reclaimed a dead lease) for trees whose lease is gone and whose wrapper is no longer running (`why: sweep`); and in each tick's orphan pass (`why: orphan`). A lease hand-released with `release <id>` while its wrapper runs is not an orphan. Hooks never snapshot.

**How:** one pid at a time, children first. Windows `taskkill /F /PID <pid>` (never `/T`); POSIX SIGTERM, re-check pid + creation time, then SIGKILL. A reused pid is skipped.

**Never stopped, whatever the policy:** claude, Stream Deck, this process and its ancestors, pids 4 and below, the wrapper itself, anything matched by `reap_never`, and everything under a protected process.

**Options.** `reap_policy`: `on` (default), `dry-run` (the plan goes to `reaps.jsonl` as `mode: would-kill`, once per tree, nothing stopped), `off` (nothing snapshotted, recorded or stopped); an unknown value counts as `dry-run`. `reap_never`: comma-separated, case-insensitive substring of name, executable or command line, or `/regex/flags`.

**`reap --dry-run [--json]`** is read-only: one snapshot, and for every recorded tree whose lease is gone and wrapper not running it prints each process that would be stopped (pid, image, memory, lease id, why) and each spared one with its reason. Without `--dry-run` it is a usage error pointing to `sweep`.

**`reaps.jsonl`** (ledger dir, rotates at 512 KB): one row per process `{ts, mode: 'kill'|'would-kill', why, lease, pid, image, creationTime, parentPid, memMb, how: 'recorded'|'descendant', ok}`. The wrapper prints one stderr line when it stops something.

## Part 3: the CLI, the launcher and the status schema

### CLI

```
node <plugin>/scripts/resource-queue.mjs run --resource box:N [--resource name[:N]] [--class <id>] [--ram 4G]
     [--label <text>] [--max-wait <s>] [--group <name>] [--bind-pid <pid>] -- <cmd...>
node <plugin>/scripts/resource-queue.mjs reserve <resource> --for <group> --until <time> [--reason <text>] [--owner-pid <pid>]
node <plugin>/scripts/resource-queue.mjs unreserve <resource> [--for <group>]
node <plugin>/scripts/resource-queue.mjs hold [--until <time>]
node <plugin>/scripts/resource-queue.mjs resume
node <plugin>/scripts/resource-queue.mjs status [--json] [--resource <name>] [--sample] [--strays]
node <plugin>/scripts/resource-queue.mjs grants [--hours N] [--json]
node <plugin>/scripts/resource-queue.mjs sweep
node <plugin>/scripts/resource-queue.mjs reap --dry-run [--json]
node <plugin>/scripts/resource-queue.mjs release <lease-id>
node <plugin>/scripts/resource-queue.mjs install-launcher
```

- `run` queues, takes every resource in one lease, runs the command below normal priority with `windowsHide`, keeps the lease alive, and releases it when the command ends or on a signal. Its exit code is the command's: a signal is `128 + n`, a program that is not found is 127. `--class` fills in units, resources and RAM from the rules; explicit `--resource` and `--ram` flags win.
- **How the command runs.** Several arguments after `--` are the exact argv, run with no shell and with quoting kept. One argument holding shell syntax is run through Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`) or `sh`. A lone argument that is an existing file is a program (so `C:\Program Files\nodejs\node.exe` is not mangled by a shell). Windows `.cmd` and `.bat` files run through `cmd.exe`.
- **Re-entry.** The child's environment carries `AC_RESOURCE_LEASE=<id>`. A nested `run` subtracts what that live lease already holds, and the gate does not wrap a command that carries it.
- **Opt-out.** `RESOURCE_QUEUE=0` or `CI_LOCAL_LOCK=0` runs the command directly, no files written.
- `status` reads the ledger (reading sweeps, as in Part 1, so a dead entry is cleared and logged rather than shown). `sweep` runs the clear rules on demand. `--sample` adds a CPU sample of the outside load (the text form takes one by itself whenever the queue is not empty, to say why the head is blocked; `--json` never does unless asked); `--strays` lists processes matching the `strays` rules while their resource is unheld.
- `release <lease-id>` releases one lease by hand, for a hung live holder the ceiling has not reached yet. The id is the 12 hex characters `status` shows, or a unique prefix of 4 or more. It writes the tombstone, removes the lease files and logs the clear as rule `manual` (evidence `by: manual`); the process is not touched. Exit 2 for a bad, ambiguous or unknown id. The stable launcher takes the same command: `node ~/.claude/agent-companion/bin/resource-queue.mjs release <lease-id>`. `status` prints the exact command (`releaseCommand`) beside a flagged holder.
- Exit 2 for a usage error (a missing `--for` or `--until`, `hold` with no session id).

`node plugins/agent-companion/scripts/ci-budget.mjs status` remains for the Part 1 view; the `ci-local` pre-push gate imports `acquire` from the same module and is unchanged.

### The stable launcher path

A plugin update moves the versioned plugin path, so anything that must name the CLI (a deny message, a brief, a wrapper in a project's scripts) uses a generated launcher at a path that does not change:

```
<claude dir>/agent-companion/bin/resource-queue.mjs     (normally ~/.claude/agent-companion/bin/resource-queue.mjs)
```

It picks the newest `plugins/cache/*/agent-companion/<version>` copy (falling back to the marketplace clone) and calls its CLI. If no plugin copy is found, `run` still runs the command, unqueued. `install-launcher` writes it and is idempotent; SessionStart installs it (the session line hook calls `installLauncher()`, even when the line option is off). Before the first SessionStart the gate's text names the plugin's own versioned path instead.

### `status --json` schema (version 1)

```
{ schema: "resource-queue-status", schemaVersion: 1, ok, generatedAt, dir,
  machine: { cores, totalRamMb, freeRamMb, ramReserveMb, busyCores, externalCores, loaded },
  resources: [ { name, capacity, held, free,
      holders: [ { id, kind, pid, alive, label, project, repo, worktree, session, units, ramMb,
                   startedAt, heartbeatAt, ageMs, heartbeatAgeMs, lastActivityAt, idleMs, stale,
                   group, bound, boundPid, overTime, idleFlag, hbStale, ceilingMs, releaseCommand } ] } ],
  queue: [ { position, id, kind, pid, alive, label, project, repo, worktree, session, wants, ramMb,
             createdAt, heartbeatAt, waitedMs, blockedBy, blockedReason, group, paused, pausedBy, pausedUntil, passedOver } ],
  reservations: [ { id, resource, forGroup, owner: { pid, session }, ownerAlive,
                    createdAt, expiresAt, remainingMs, reason } ],
  recentClears: [ { at, rule, type, id, pid, label, project, repo, worktree, session, resources, evidence } ],
  legacyLocks, strays,
  foreign: { count, dirs: [ { dir, count } ] } }
```

Times are epoch ms. `expiresAt` in `reservations` is the effective end, after the 4 hour cap. `blockedBy` lists resource names (and `hold`); `blockedReason` is the text of why (slots wanted vs available, held, outside load), `''` when nothing blocks; the box reason needs `--sample` (without a sample the box check is skipped and a job held only by outside load shows no reason). The text form prints it as a `why:` line under the head of the queue. Status does not sample the CPU unless asked and never throws. The key sets are pinned in `tests/resource-queue-status.test.mjs`. A reader ignores unknown keys and treats a missing `reservations` as empty.

## Part 4: the hook interface and the gate

### Hook interface

Hooks do not spawn the CLI to look: they import `scripts/ci-budget.mjs` and call `resourceStatus(opts)` in-process (the same object as `status --json`, no sampling, fail soft), and `scripts/resource-queue.mjs` for `installLauncher()` and `launcherPath()`. Measured by hand: the first import costs about 11 ms, the first `resourceStatus()` about 3 ms, a repeat under 1 ms. A hook must not take `admit.lock` or wait. Since 0.31.62 a status call does sweep the ledger (expired, dead-pid and over-ceiling entries are dropped, no process-table call), so a lease no waiter ever noticed is cleared; pass `sweep: false` to read only.

### The resource gate (PreToolUse, Bash)

A heavy command started bare overloads the machine and, because the hooks share its CPU, makes the guards fail open. The gate refuses or rewrites such a command so that it runs through the queue. It is `hooks/lib/resource-gate.mjs` (a pure classifier plus `gateDecision` and `rewriteCommand`), run as step 1 of `hooks/bash-tail.mjs`, which is the one hook that rewrites Bash input; the output-tail step then wraps the gate's result. No extra hook process is added.

**What counts as heavy.** The classifier matches whole-suite and whole-project work, using the measured classes: end-to-end runs, a full or directory-wide vitest, `node --test` over a directory, a push gate with heavy checks, lint and typecheck of a project, an Android emulator, gradle, and `npm ci`. Each match names a class from the rules file. It does not touch: a targeted run (one test file, a single-file eslint), a command already wrapped in the queue, agent-templates `ci-local` (which holds its own lease), quoted or echoed text, or anything when `RESOURCE_QUEUE=0` or `AC_RESOURCE_LEASE` is in the environment. `bash -c` strings, wrappers, heredocs and groups are followed or wrapped whole. Known limits: bare `vitest` counts as a full run; a positional filter without a slash counts as targeted; `npm run check` counts as lint.

**Tools and classes (0.31.62).** The gate covers the Bash and PowerShell tools (`hooks.json` matcher `^(Bash|PowerShell)$`). Besides the classes above it has `build` (box 6: xcodebuild, cargo build/check/clippy, dotnet build/publish, msbuild, go build, mvn/mvnw/mvnd, docker build/buildx/compose build|up, vite/quasar/nuxt/next/webpack build, `npm run build`) and `test-suite` (box 8: cargo test, dotnet test, go test, pytest, jest, npm e2e or test-suite scripts). A user override file merges by class id and can change a class's box share or patterns.

**PowerShell.** Forms such as `.\gradlew.bat build`, `& .\gradlew.bat build` and `cd app; .\gradlew.bat build` are recognised; the queued command uses `resource-queue.mjs run --shell powershell`. Opt a command out with `$env:RESOURCE_QUEUE = 0; <command>` (Bash: `RESOURCE_QUEUE=0 <command>`). In `rewrite` mode a PowerShell command is denied by default, with the queued command in the reason, because the hooks docs do not state that the PowerShell tool honours `updatedInput`; set `resource_gate_powershell_rewrite` to `true` once a live check shows a rewritten command runs. Deny, hint and off are unaffected.

**Banned commands.** Refused in every mode and not opt-out-able (`RESOURCE_QUEUE=0` is ignored): empty infinite loops (`while(1){}`, `for(;;){}`), which pin a core and have starved the box (use a real workload through the queue), and `taskkill /IM <name>`, which kills every process of that name including other agents' (kill by PID, or limit CPU with ProcessorAffinity on the one process). The deny text names the alternative.

**Modes** (option `resource_gate`):

| Mode | Effect |
|---|---|
| `deny` (default) | The call is refused. The text prints the exact wrapped command (`node <launcher> run --class <id> --label <id> -- '<command>'`) on its own line. |
| `rewrite` | The whole command line is replaced by that wrapped command: `node <launcher> run --class <id> --label <id> --shell bash -- '<line>'`, which runs the line byte for byte in bash (`eval` of the line, passed in the environment), so assignments, functions and options set earlier in the line stay in scope. What the child bash does not have: functions, aliases and shell options the Bash tool loads from its session snapshot, and the outer shell's `$`. Only a leading `cd <dir>` (or `cd -- <dir>`) joined by `&&`, `;` or a newline stays outside, so the directory change lasts past the call. That leading cd may be followed by one parenthesised group, `cd <dir> && ( npm ci; npm run lint )`, possibly with more steps joined by `&&`, `;`, `|` or a newline after it: the group is wrapped whole, from the directory the hoisted cd set, so cwd and exit status are the same. Still denied: a second cd or pushd anywhere in the wrapped part (inside the group too), a nested or second group, a brace group, a heredoc, a `||` or background `&` after the group, and any cd the gate cannot read (`cd -P x`, `cd a b`, `cd $DIR`). A line that changes directory later is denied instead of rewritten. Never one segment alone: a segment moved into a child shell loses the shell variables set before it (2026-10-18, an empty `$M` turned a push refspec into a remote delete). Applies only in the permission modes of `resource_gate_permission_modes` (default `bypassPermissions`; `any` lifts the limit) and only when no deny or ask rule from settings could match the original or the wrapped command; otherwise it denies, with the same command in its text. One `updatedInput` carries the whole input, so `timeout`, `run_in_background` and `description` survive. |
| `hint` | Runs unchanged; adds a one-line suggestion. |
| `off` | Nothing happens. |

**Worktree command clause.** Claude Code itself refuses some commands from a worktree-isolated agent as too complex to verify (`cd <dir> && ... <<EOF` compounds, `git -C` aimed outside its own tree), which is not this gate. The spawn guard appends one short `[agent-companion: worktree]` clause (about 250 characters, `WORKTREE_SENTENCES` in `hooks/lib/writer-brief.mjs`) to every spawn with `isolation: "worktree"`: do not cd into the worktree, `git -C` only on your own tree, write files with Write and not heredocs, run a heavy command as one plain command so this gate can wrap it. No clause without isolation, none when the brief already carries it.

**Cloud sessions.** When `CLAUDE_CODE_REMOTE` is `true` (Claude Code sets it in a cloud session) the gate does nothing in any mode: a cloud session is one disposable sandbox with no shared machine to protect, and a command rewritten into the queue wrapper looks suspicious to the cloud's own classifier (measured 2026-10-29: the wrapped `npm ci` was denied there and the routine failed). The "Shared resources:" line, the launcher install at session start, the capacity line and the keep-warm notes are skipped there too. Only `CLAUDE_CODE_REMOTE` counts (`isCloudSession` in `hooks/lib/context.mjs`); local behavior is unchanged.

**Not yet verified live:** whether Claude Code applies `updatedInput` with no `permissionDecision` under `bypassPermissions`. The composition is proven in tests, including one real bash run through the real queue (exit code 7 passed through, ledger empty afterwards). Keep `deny` as the default until a fresh-session check confirms `rewrite`.

**Telemetry.** `telemetry/resource-gate.jsonl`: one row per `denied`, `hinted` or `rewritten` decision (`event`), with `mode`, `classes`, `command_chars` and, for a rewrite, `run_in_background`; never the command text.

## Part 5: the "Shared resources:" session line

At SessionStart, and before a prompt when it changed, `hooks/advisory-b.mjs` adds one line to the context, next to the other-live-sessions line, from `resourceStatus()`. It appears only when something is held, queued, reserved, or was cleared in the last 15 minutes; an idle queue adds nothing on its own (from 2 active leads the line appears with the lead count, see below). It is cut at 300 characters. Option `shared_resources_line` (default true).

Shape: each resource with units out of capacity and its holders (label or session, `@project`, age, `DEAD` or `STALE`, then `IDLE?`, `OVER` and `HB?` for a live holder flagged by the idle rule, the max-hold rule or a stale heartbeat; a holder past both limits shows `IDLE? OVER`), then the queue in order (up to four, `blockedBy` named), then up to two reservations (`<resource> for <group>`, time left), then the newest clear under 15 minutes old. When a live holder is flagged, the line ends with `release a flagged one by hand: node ~/.claude/agent-companion/bin/resource-queue.mjs release <id>.` for the first one (the rest of the line is clipped to keep the 300 characters):

```
Shared resources: box 3/8: full-suite@agent-templ~ 0s; app-e2e 1/1: e2e-run@app 0s; queue: 1) e2e-next@app 0s for app-e2e; reserved: app-e2e for release-train 2h left.
```

(The sample is a real render from a test ledger with three leases and tickets and one reservation.) A holder is spelled out the first time it appears; later resources name it by label only. The prompt-time line is re-added only when the holders, the queue, the reservations or the recent clears change, not as ages tick. Turning the line off does not stop SessionStart installing the launcher.

**Lead count (0.31.32).** The line also says how many orchestration sessions ("leads") are active on this machine: a lead is a session with a helper spawn in the last hour, read from the plugin's per-session worker ledger (`state/worker-ledger/<session>.jsonl`, one stat per file, a tail read only of files touched in the last hour). From two leads the line carries `leads active (helper spawn in the last hour): N` (it appears even with an idle queue); above 4 it adds `More than 4 leads active: each extra lead adds cold re-reads of its whole conversation.` The warning and the release hint are reserved before the body is clipped to 300 characters. The prompt-time signature holds the count only as a level (under 2, 2 to 4, over 4), so a change of count inside a level adds nothing.
