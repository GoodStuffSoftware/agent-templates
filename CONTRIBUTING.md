# CONTRIBUTING — flowing improvements back to the library

This is the **UP-flow** (project → library). When a change you make in a real project improves something **generic**, you bring it back here so every future hydration inherits it. For the DOWN-flow (library → project) see [HYDRATION.md](HYDRATION.md).

---

## When to contribute (the trigger)

This extends the general agent-maintenance habit — *keep your agent defs, rules, and conventions as living documents* — one level up. Normally, when a session reveals a new gotcha, a better process step, or a missing rule, you update the relevant agent def or rules file **in the project**. The contribution trigger fires when that update is **generic**:

> A project change touches an agent def, a `CLAUDE.md` rule, or a convention, **and** the improvement would help other projects — not just this one.

Examples that SHOULD flow back:
- A stall-prevention or write-target rule that turned out to be missing or wrong in the template.
- A better default for an agent's `model`/`effort`, or a clearer routing description.
- A new reusable agent role that a whole class of projects would want.
- A sharper version of a cross-project rule in `anthropic/shared/cross-project-rules.md`.

Examples that should NOT flow back (project-local — they stay in the project):
- Anything naming the project, its domain, its stack, its brand voice, its file paths.
- A one-off convention that only makes sense for this product.
- Content, copy, or design decisions.

---

## The "is this generic?" test

Before contributing, run the change through this test:

1. **Does it name anything project-specific?** A real project name, domain, path, person, product, brand voice, or stack detail? If yes → strip those specifics.
2. **After stripping the specifics, is there still a reusable kernel?**
   - **Yes** → it's generic. Replace the specifics with `{{PLACEHOLDERS}}` (or generic examples like `acme.com`) and contribute it.
   - **No** — the rule *was* the specifics, nothing reusable remains → it's project-local. Keep it in the project; don't contribute.

If you're unsure, lean toward keeping it project-local. A template polluted with a half-generic rule is worse than a project that kept a useful local one.

---

## The scrub checklist

Before opening a contribution, scrub it:

- [ ] **Generalize specifics → placeholders.** Every real value becomes a `{{PLACEHOLDER}}` (and gets an entry in the template's placeholder table if it's new) or a generic example.
- [ ] **Pick the right home** (see next section).
- [ ] **Run the leak guard:** `node scripts/leak-check.mjs` — it must exit 0. It catches any real-world token you missed (project/product names, domains, user home path, handle, name, email, git-SHA-like hex runs), plus **your own machine's real project names and agent-file prefixes, derived at run time** from your dev root and `~/.claude/projects` (never written anywhere), and private absolute paths (`/home/<name>/`, `~/dev/<project>`, …). CI has no dev root, so only a local run catches a derived-name leak. Machine-structure warnings do not fail, but read them. Fix every hit. **This same guard runs in CI on every push and pull request** (see [`.github/workflows/leak-check.yml`](.github/workflows/leak-check.yml)) and fails the check on any hit — running it locally first just saves a round-trip. (One narrow exception: the repo names its owner in `LICENSE` — that's ownership metadata, not a content leak. The exemption in `leak-check.mjs` is both LICENSE-scoped and token-scoped, so the company name stays banned in every other file and all other tokens stay banned even in LICENSE.)
- [ ] **Re-read the diff as a stranger.** Would someone with no knowledge of your project understand and use this? If it only makes sense with your project's context, it's not generic yet.
- [ ] **Know the guard's boundary.** Leak-check scans committable *file contents* only — commit messages and branch names are not scanned. Whether source-project names may appear in commit metadata is maintainer discretion; the no-specifics guarantee and its CI enforcement cover files. And the guard matches known tokens, not meaning: proprietary material (real code, config, product logic) stays out of files entirely — reconstruct generic examples rather than pasting-and-renaming.

**WIP pushes:** a branch named `wip/**` or `backup/**` is excluded from the push trigger on both CI workflows (still fully covered via `pull_request`, and every other branch — including `main` — still runs on every push). Push in-progress or backup work there to avoid emailing the operator on every commit.

---

## Local CI gate (pre-push)

Overnight, more than 60 red CI runs once emailed the operator for causes that were each invisible locally until CI ran: a shallow-clone checkout that couldn't see a commit a task-pack fixture pins, a runner with no `claude` CLI, and a sha-like token in a test comment. `scripts/ci-local.mjs` and a repo-tracked pre-push hook exist so those show up **before** a push, not in a failure email after.

**One-line setup**, once per checkout:

```
node scripts/setup-hooks.mjs
```

This points git at the repo-tracked `.githooks/` directory (`core.hooksPath`) instead of the untracked, per-clone `.git/hooks/`. In a **worktree** checkout, that setting lives in the config every worktree of the repo shares — running the plain command above turns the hook on everywhere, which is usually what you want for your own clone, but is *not* what you want if you're one of several worktrees on a shared machine and only want the hook active in one of them. For that, pass `--worktree` (`node scripts/setup-hooks.mjs --worktree`), which scopes it to the current worktree only via `git config --worktree` — but only once `git config extensions.worktreeConfig true` has already been set (itself a shared-config change, so the script asks you to opt into that explicitly rather than doing it for you).

**The gate tests the tree you are pushing.** From a linked worktree, the hook runs that worktree's own `scripts/ci-local.mjs` and suites, found with `git rev-parse --show-toplevel` from where git starts the hook, never from where the hook file lives. That matters when `core.hooksPath` is an absolute path into another checkout, such as the main one: the hook file that runs is then that checkout's copy. The hook still gates the pushed tree, and it blocks the push if that tree has no `scripts/ci-local.mjs`. `ci-local.mjs --pre-push-hook` also blocks a run whose own location is not the tree being pushed, and it prints one line naming the tree and what is tested there (normal refs run that tree's suites; `main` and `release/**` test the pushed sha in a temp clone; `wip/**` and `backup/**` are scan-only). If you push with an explicit `--work-tree` (`git --git-dir=… --work-tree=<wt> push`) from another checkout, the hook gates `<wt>`, the tree you named. An exported `GIT_WORK_TREE` is treated the same way, since git exports that variable for `--work-tree`; when it names a different tree than the directory you pushed from, ci-local prints a one-line `WARNING` naming both trees and saying the gate is testing the `GIT_WORK_TREE` tree, so unset a stale one. An absolute `core.hooksPath` still runs the *hook file* from the checkout it names, so keep that checkout's `.githooks/pre-push` current, or use the relative `.githooks` that `node scripts/setup-hooks.mjs` sets, which makes each worktree run its own copy.

Two ways a push can run no gate, or a different one, than you expect:
- **A branch with no hook.** With the relative `core.hooksPath=.githooks`, git looks for `.githooks/pre-push` in the tree being pushed. A branch that does not have that file (one cut before the hook existed, say) is pushed with no gate at all and exit 0. CI is still the backstop: it runs the suites on every pushed branch except `wip/**` and `backup/**`, and on every PR.
- **A per-worktree absolute path.** A worktree whose own `config.worktree` sets an absolute `core.hooksPath` overrides the shared relative value, and runs whichever checkout's hook that path names. Check where the value in force comes from with `git config --show-origin --show-scope core.hooksPath` (a `worktree` scope with an absolute path is the case to fix).

**What the hook runs:** `.githooks/pre-push` reads the refs you're pushing and forwards them to `node scripts/ci-local.mjs --pre-push-hook`, which:
- **scans every commit being pushed, on every ref — `wip/**` and `backup/**` included — and every pushed branch and tag name** (`scripts/push-scan.mjs`). A ref name that hits blocks the push and is printed with the match replaced by `[redacted]`. A commit that the remote you are pushing to already has is public already and is skipped. That means the remote tips git reports for the refs being pushed, plus that remote's own remote-tracking refs (`refs/remotes/<remote>/*`) that it still advertises, checked with one `git ls-remote` of the push URL per push. Another remote's refs, a ref made by hand and a stale tracking ref (a branch deleted or rewritten upstream) do not count, so their commits are scanned; `git fetch --prune` refreshes stale tracking refs. If `git ls-remote` fails, only the tips git reports count, and a warning says so. The first push to a remote you have never fetched from scans all the history it would publish. For each other commit, the scan checks the lines that are new relative to every parent (so merging `main` or renaming a file does not re-scan public content, while a name added in a merge's own resolution is still caught), the message, and every path it introduces. They go through leak-check's own checks and through your local private-names denylist, `~/.claude/agent-companion/config/private-names.txt` (or `$AGENT_COMPANION_STATE_DIR/config/private-names.txt`). Content is read straight from git's objects, so files git treats as binary, files marked `-diff` in `.gitattributes`, and files with NUL bytes are scanned too, including as UTF-16. Text that is not valid UTF-8 is also matched as latin1. Text is also matched with JSON/JS escapes (`\n`, `\t`, `\r`, `\uXXXX` and the like) and URL percent-encoding (`%2F` and the like) decoded, so a name right after `\n` in a JSONL transcript or after `%2F` in a URL is caught. Replace refs (`git replace`) and grafts are ignored, so the scan reads exactly the objects the push sends. A compressed file (a zip such as `.docx`, gzip, bzip2, xz, zstd, 7z, a PNG with compressed text, a PDF with filtered streams) is scanned only as raw bytes. You get a warning naming it as "compressed content not scanned", and the push goes on. A file over 16 MiB (`PUSH_SCAN_MAX_FILE_BYTES` changes the cap) is not scanned. You get a warning naming it as "not scanned (size)", and the push goes on. Its path is still checked. A hit blocks the push and prints only the commit SHA, where the hit is (`file:line`, "commit message:N" or "path …"), and which check fired. It never prints the matched text. In a printed path each match is replaced by `[redacted]` and control characters are escaped. A path that cannot be cleaned that way is printed as `[redacted path]`. Denylist format: UTF-8, one entry per line (lines end at LF, CRLF, CR, U+2028 or U+2029), `#` comments allowed. A plain entry matches case-insensitively at word boundaries. A boundary is anything that is not a letter or digit, a lower-to-upper case change, the end of an acronym, or a letter/digit change. So `ann` matches `Ann's`, `ann_id`, `getAnnName` and `ann2`, but not `annotation` or `joann`. An entry starting `re:` is a case-insensitive regex. If the file is missing, the hook prints a one-line warning and carries on. If it exists but cannot be used, the push is blocked and the problem is named, but never the file's contents. That covers a file that cannot be read (a directory, a permission error), one saved as UTF-16 or as invalid UTF-8, an `re:` entry that is invalid or matches empty text, and an entry that holds a control character such as a TAB. Author and committer names and emails are not scanned. A SHA in a commit message is allowed when it names a commit in this repository, as `git revert` messages do;
- **skips the suites** for `wip/**` and `backup/**` branches (same exclusion as the CI workflows above);
- runs the full local suite (`scripts-tests`, `leak-check`, `agent-companion-tests`) for any other branch;
- runs it in **`--ci-parity`** mode — a fresh shallow clone of the commit you're pushing, in a temp dir outside the repo, with `claude` hidden from `PATH` and the checkout depth read from the actual workflow file — when the destination is `main` or `release/**`, since those are the branches a red run is most expensive on;
- **blocks the push** on any failure, printing which suite(s) failed.

Run the same checks by hand at any time with `node scripts/ci-local.mjs` (fast, in place) or `node scripts/ci-local.mjs --ci-parity` (slower, exact CI reproduction) — this is also what CI itself calls, so there is only one implementation of "the suite" to keep green, not two that can drift apart. To scan commits without pushing, run `node scripts/push-scan.mjs origin/main..HEAD`.

**Perf checks are not in the gate.** A wall-clock budget can't be asserted reliably under the suite's parallel load, so agent-companion's timing checks are skipped unless `AGENT_COMPANION_PERF=1` is set, and show up as `skipped` in a normal run. Run them on demand, one file at a time, on a quiet machine: `AGENT_COMPANION_PERF=1 node --test plugins/agent-companion/tests/routing-profile-timing.test.mjs`. The behaviour those checks depend on stays in the gate and is asserted without a clock.

**How test results are reported.** Each test suite's summary line gives node's own counts as `pass N · fail N · todo N · skipped N`. A `todo` test is held work. It never counts as a failure and is never listed under "failing tests". Instead it is listed in its own "todo tests (not failures)" block. When a test file fails, ci-local re-runs that file once on its own:
- If it fails again, the suite is **FAIL**.
- If it passes, the suite is **FLAKY** and the file is named as "flaky on isolated re-run", with a loud `!!!` notice. FLAKY does not block a plain run or a push of an ordinary branch. Under `--ci-parity`, and so for pushes to `main` and `release/**`, it counts as a failure.

**Full suites go through the shared budget.** ci-local takes a lease from a machine-wide worker budget (`scripts/ci-budget.mjs`, files in a repo-neutral ledger directory outside any worktree; protocol in [Shared CI budget](#shared-ci-budget-lease-protocol) below) just before its first suite, so the pre-push hooks of many worktrees share the machine instead of piling up (on 2026-10-13, 11 to 23 concurrent runs pegged the CPU and made timing tests flake). The total of test workers across every run, plus load from outside our runs, stays under one budget (default half the logical cores, `CI_LOCAL_BUDGET`). A run asks for the concurrency below, gets what is free (at least one worker) and passes it to node as `--test-concurrency`; on a busy box it starts with fewer workers or waits in a fair queue, and it never fails. It resizes the lease between phases and releases it on exit, on error and on Ctrl-C or SIGTERM; a killed run is reclaimed at once (its pid is gone); the 90 s figure is for a run whose pid still exists but whose heartbeat went silent. `node scripts/ci-budget.mjs status` shows who holds the budget (add `--json` for scripts, `--no-sample` to skip the 300 ms CPU sample): the budget, what is held and free, outside load, every lease (kind, repo, worktree, pid, workers, age, heartbeat) and the queue. `CI_LOCAL_LOCK=0` skips the budget for one run. The push scan runs before the lease, so scan-only refs never wait.

**Heavy lane.** Test files whose tests spawn git or sh dozens of times are limited by process-spawn cost, not CPU. They are named in one list, `HEAVY_TEST_FILES` in `scripts/ci-local.mjs` (`memory-vault*`, `git-brief*`, `ci-local-parity`, `push-scan`, `publication-sweep`, `pre-push-hook-tree`; a file with 15 or more git or sh spawn and exec call sites, helper calls included, belongs on it). Each suite runs them in a second pass of its own under heavy leases: at most `CI_LOCAL_HEAVY_MAX` (default 2) heavy workers machine-wide, each charged `CI_LOCAL_HEAVY_COST` (default 3) units. The pass waits for a slot, holding nothing while it waits, and after `CI_LOCAL_HEAVY_MAX_WAIT_MS` (default 10 minutes) it runs with one heavy worker anyway and prints one line saying so, so a hook never hangs on a hung holder. A run of only single scripts (`--suite leak-check`) takes a 1-unit `targeted` express lease that never queues; ci-local has no per-file mode.

**Moving from the old lock.** Before 0.31.18 ci-local took a one-run mutex, `scripts/ci-lock.mjs` (removed). A worktree that has not been rebased yet still takes it and never asks the budget, so a new run counts each live holder of that mutex as one full run at the default concurrency (half the cores, at most 8) until it ends. `node scripts/ci-budget.mjs status` lists them. Rebase onto a branch with the budget to stop using it.

**Test concurrency.** ci-local runs at most N test files at once. By default N is half the machine's available CPUs, clamped to 1–8, because node's own default (every core but one) overloads a many-core machine enough to make timing-sensitive tests fail. Set `CI_LOCAL_TEST_CONCURRENCY=<n>` to override it.

**Per-test timeout.** Every `node --test` run ci-local starts, including the isolated re-run, carries `--test-timeout=120000` (two minutes per test). A test that runs longer fails by name with `test timed out after 120000ms`, and its file then goes through the same re-run as any other failure. Before this, the run had no bound, and one pre-push hook sat for about 19 minutes on a file whose tests had all finished. Set `CI_LOCAL_TEST_TIMEOUT_MS=<ms>` to override it. It takes plain decimal digits and refuses `0`, so the bound can't be switched off; a value it refuses prints a warning and the default applies. The slowest test in the agent-companion suite takes about 21 s, so a test that needs more than the default is a test to look at. node applies the timeout to a `describe` block as a whole, and neither suite has one today.

The same runs also pass `--test-force-exit`, which ends the run once every test has finished. node's timeout only bounds a test that is still running. A file whose tests all pass but which leaves a `setInterval`, a listening server or a child process holding the process open would otherwise never exit and the runner would wait on it indefinitely. A test that leaks a handle like that still passes. Close the handle all the same.

**Never use `--no-verify`.** It skips the hook entirely, including the pushed-commit scan, and that scan runs on `wip/**` and `backup/**` pushes too. This repository is public, so a `wip/**` push publishes its commits just as any other push does.

**Post-push:** after any push to a CI-visible branch (i.e. not `wip/**`/`backup/**`), watch the run rather than walking away from it:

```
gh run watch <run-id> --exit-status
```

Treat red as a failed step, not noise — read the log, fix it, and push a fix commit. Never push again to a branch CI is currently red on without first fixing what made it red. If CI is red and you didn't expect that, check **main's own latest run first** — if main is already red, fix the baseline before spending time blaming your diff for it.

See **[Release gate](#release-gate)** below: cutting a versioned release is gated on CI the same way, cross-referenced here rather than restated.

### Shared CI budget (lease protocol)

`scripts/ci-budget.mjs` replaces the one-run mutex with a shared worker budget: several runs may go at once, and the total of test workers across every run on the machine, plus load from outside our runs, stays under one budget. A new run starts with fewer workers when the box is busy, or waits in a fair queue; it never fails. `scripts/ci-local.mjs` takes its leases from it (see "Full suites go through the shared budget" above). This section is the one spec of the format. The code links here, and another repo can take leases from the same budget by following it.

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
| `CI_BUDGET_REPO` | basename of the git top-level directory above the worktree (walk up for `.git`, no process spawned), else the worktree basename | `repo` label written into leases |

**Ledger directory.** Machine-wide and named after no repo: `CI_BUDGET_DIR` if set, else `%LOCALAPPDATA%\ci-budget` on Windows (fallback `os.tmpdir()/ci-budget`), else `$XDG_RUNTIME_DIR/ci-budget` (fallback `os.tmpdir()/ci-budget`).

**Files** (ids are 12 hex chars):

- `lease-<id>.json`: one per holder, `{ id, pid, startedAt, heartbeatAt, repo, worktree, kind, units, heavy, heavyCost, label }`. Times are epoch ms. `kind` is `full` or `targeted`. `repo` is a label, `worktree` a path, both for display only.
- `lease-<id>.hb`: a heartbeat sidecar holding one epoch-ms number.
- `ticket-<id>.json`: one per queued full run, `{ id, pid, createdAt, heartbeatAt, repo, worktree, kind: "full", desired }`.
- `admit.lock`: a short mutex, `{ pid, at, token }`, held only while a process reads the ledger and writes a lease.

**Units.** A lease holds `units` plain workers and `heavy` heavy workers (test files that spawn many git or shell processes, so spawn cost, not CPU, is what limits them). It is charged `units + heavy * heavyCost`. `held` is the sum of live charges. A lease never holds fewer than one worker, except while a heavy pass waits: a waiter holds nothing, so that several waiters on a small budget cannot starve each other (each keeping one unit would leave the others too little room for a heavy worker, and none would ever be granted).

**Atomic rules.** Create a file with an exclusive open (`wx`). Update by writing a temp file in the same directory and renaming it over the target (retry a few times on `EPERM`/`EBUSY`, which Windows raises while a reader has the target open). Only the owner updates its lease or ticket. A lease is created and resized while holding `admit.lock`; the heartbeat put-back below is the one exception. The `.hb` sidecar is the one file rewritten in place (a single number; a reader ignores a torn read). Remove a stale file by renaming it aside first, so that of several reclaimers only one wins. `admit.lock` is created with `wx`, removed after use, and broken when its pid is dead or it is over 10 s old.

**Stale rules.** A lease or ticket is stale when its pid is not alive, or its heartbeat is older than 90 s. The heartbeat is the newest of `heartbeatAt`, the sidecar value, and the start time. Whoever notices removes it. A reclaiming read also deletes crash debris, `*.tmp-*` and `*.stale-*` files over about 10 minutes old. There is no age cap: a heartbeat is the proof of life, and it also covers Windows pid reuse. The owner refreshes it every 20 s from a worker thread, not a main-thread timer, because ci-local blocks its main thread in `spawnSync` for minutes. A long suspend (a laptop sleep) can make a live lease look stale before its next tick. The heartbeat thread then puts the lease back from the record the main thread last sent it, on its next tick (within 20 s) and without taking `admit.lock`, so a few units can briefly be over-admitted. A reader normalizes a lease it does not fully understand (a missing `kind` counts as `full`, a bad `heavyCost` as the local default) instead of failing.

**Admission, full run.** The run writes a ticket, then loops: drop stale entries; only the head ticket, ordered by `(createdAt, pid)`, may be admitted. The head samples outside load, takes `admit.lock`, re-reads the ledger and computes `free = budget - held - external`. It admits only if `free >= 1` and fewer than `CI_LOCAL_MAX_PARALLEL` full leases are live: `grant = min(desired, free)` plain units, ticket removed, lease created. A head that finds no live lease may always start with one unit, so outside load alone never starves it. Once the head is admitted the next ticket is evaluated against what is left. The wait is bounded: after `CI_LOCAL_QUEUE_MAX_WAIT_MS` (default 30 minutes), head or not, the run drops its ticket, takes a 1-unit lease whatever `free` is (so a hung but alive holder cannot stall it forever) and prints one line saying it ran over budget after the wait. A waiter polls the directory every 1.5 s with fs calls only (the head also reads `os.cpus()` for the outside-load sample) and prints one `waiting` line at the start and one every 60 s.

**Outside load.** Two `os.cpus()` reads about 300 ms apart give `busy = sum over cores of (1 - idleDelta / totalDelta)` cores. `external = max(0, round(busy - held))`: the busy cores our held units do not explain. The sampler is injectable, nothing is spawned.

**Admission, targeted run (express).** A single-file run takes a 1-unit `targeted` lease with no ticket, at once, while `held + 1 <= budget + CI_LOCAL_EXPRESS`; past that it polls without queueing. It never waits behind a full suite. Its wait is bounded too: after `CI_LOCAL_EXPRESS_MAX_WAIT_MS` (default 5 minutes) it takes its 1-unit lease anyway, over budget, and prints one line saying so.

**Heavy lane.** `lease.resize({ units, heavy })` changes a lease between phases. A shrink applies at once. A grow goes through admission against `free` (outside load counted), and each heavy worker also needs `heavyMax - heavyHeld >= 1` and `free >= heavyCost`. A run alone on the box (nothing else held) always gets one heavy worker whatever the outside load, as a full run always gets one unit. Without `{ wait: true }` it takes what it can get; with it, it polls until every requested lane has a worker, holding nothing meanwhile, and after `CI_LOCAL_HEAVY_MAX_WAIT_MS` it takes one heavy worker regardless of `free` and the cap and logs one line.

**Fail open.** Any ledger error (a directory that exists but is read-only, `EPERM`, `EACCES`, a disk error) or a throwing cpu sampler makes the run go on without the budget: `acquire` returns a no-op lease, a failure during `resize` turns the lease into one, and either way one line says so. The budget never crashes ci-local or blocks a push.

**Known limits (accepted).** A stale `admit.lock` can be broken twice by two simultaneous contenders, so two runs may be inside the admission section for a few ms and over-admit a few units once; it takes a crash inside that ms-wide section plus two contenders. The `.hb` sidecar is rewritten in place, so a reader can see it empty (about one read in a million); the reader then falls back to the lease's own `heartbeatAt`, and the heartbeat thread puts a falsely reclaimed lease back on its next tick.

**Lifecycle.** The module releases its leases on process `exit`, `SIGINT` and `SIGTERM` (the signal handler exits 130 or 143 itself when nothing else listens). A killed process is reclaimed by the stale rules. Release wins over the heartbeat: `release()` first tells the heartbeat thread to stop, through a shared flag, and waits out a tick that is already under way (a few ms), and only then removes the lease files, so a released lease is never put back.

**Old lock holders.** While worktrees on 0.31.17 or earlier still take the pre-budget mutex, a reader counts each live holder of its slot files (`slot-<n>.lock` under `os.tmpdir()/agent-templates-ci-local`, or `$CI_LOCAL_LOCK_DIR`; pid alive and under 45 minutes old) as one full run at the default concurrency, `min(8, max(1, floor(cores / 2)))` units. It only reads that directory.

**Status.** `node scripts/ci-budget.mjs status [--json] [--no-sample]` prints budget, held, free, the outside-load estimate, each lease (kind, repo, worktree, pid, workers, heavy, age, heartbeat age) of every repo, and the queue. It reads only and removes nothing.

---

## Where it goes

The library has **two layers** (see [ARCHITECTURE.md](ARCHITECTURE.md)): *templates* (scaffolding, in vendor folders) and *lessons* (knowledge, in `lessons/`). Which layer your contribution belongs to determines where it lands.

### Scaffolding (templates)

| What you're contributing | Where it lands |
|--------------------------|----------------|
| A fix/improvement to a specific agent role | that role's def, e.g. `anthropic/basic-site/agents/<role>.md` |
| A new agent role for a class of projects | a new def in the appropriate template's `agents/` |
| A change to the project-CLAUDE skeleton | `anthropic/<template>/CLAUDE.md.template` |
| A whole new template (new project archetype) | a new `<vendor>/<template>/` folder |
| A whole new vendor (different AI coding tool) | a new top-level `<vendor>/` folder + its README |

### Knowledge (lessons)

A **rule, gotcha, or hard-won lesson** is not scaffolding — it lands in `lessons/` as a tagged lesson file, **not** pasted into an agent def or a shared rules doc. To place it, classify it onto the axes (see [ARCHITECTURE.md](ARCHITECTURE.md) §2–3) and let the **first** scope tag pick the directory (cosmetic — routing is by tags):

| First scope tag | Directory |
|-----------------|-----------|
| `universal` | `lessons/universal/` |
| `agent-process` | `lessons/agent-process/` |
| `vendor:*` | `lessons/vendor/` (AI-tool-specific mechanics) |
| `stack:*` | `lessons/stacks/` |
| `env:*` | `lessons/env/` |
| `archetype:*` | `lessons/archetype/` (created when the first one is written) |

Remember the tag semantics: **AND across axes, OR within an axis** (`[stack:nuxt, env:windows]` = Windows-Nuxt only; `[stack:nuxt, stack:vite]` = either). Use `vendor:<id>` for AI-tool mechanics. A lesson's `id` is its forever identity — never reuse one.

If a change is generic but only relevant to one vendor's agent model, tag it `vendor:<id>`. Vendor-neutral scaffolding still goes in that vendor's folder for now (a top-level shared location is a future refactor); vendor-neutral *knowledge* is just a lesson with no `vendor:` tag.

---

## Contribution path

**In practice, this library lands changes by direct commit to `main`** — no feature branch, no PR. Every fold to date has worked this way: a maintainer (human or agent) drains `CONTRIBUTIONS_INBOX.md`, applies the scrubbed entries to their proper home, and commits straight to `main`. That doesn't relax the gate — the `leak-check` CI workflow triggers on `push` as well as `pull_request` (see [`.github/workflows/leak-check.yml`](.github/workflows/leak-check.yml)), so a bad commit to `main` still gets caught. Run `node scripts/leak-check.mjs` locally first to catch it before CI does.

1. **Standard — the inbox.** Append a dated entry to **[CONTRIBUTIONS_INBOX.md](CONTRIBUTIONS_INBOX.md)** describing the scrubbed change, newest entry at the top. This is how contributions accumulate between folds, including from agents or sandboxes that shouldn't or can't commit library changes directly. A maintainer periodically drains the inbox — applies each entry to its proper home (a template file or a `lessons/` file), flips `Applied?` to `yes`, and removes it — landing the fold as a direct commit to `main`.

2. **Also fine — commit straight to `main`.** If you already have write access and the change is scrubbed and ready, there's no need to stage it through the inbox first. Small, well-scoped commits with conventional messages, same as any other change here — this is exactly what every fold commit has done.

3. **If a PR workflow is ever wired up**, the same rules apply: the PR description states what triggered the change, why it's generic (the "is this generic?" result), and which file it lands in, and `leak-check` CI gates the merge. Nothing here requires PRs — treat this as available, not preferred.

Either way: the change isn't "done" until it's scrubbed (leak-check green, locally and in CI) and lands in its proper home (a template file or a `lessons/` lesson), not just the inbox.

---

## Release gate

The same principle governs cutting a versioned release (e.g. the `agent-companion` plugin): landing is gated on CI, not on local runs alone or the [pre-push gate](#local-ci-gate-pre-push) alone. GitHub CI must be green on the release branch before landing, and on main after the push; watch with `gh run watch <id> --exit-status`. Red CI is a failed release step.

**After landing (the agent-companion plugin): check every installed copy.** Landing on `main` does not update any installed copy. Run `claude plugin marketplace update agent-templates`, then `claude plugin update agent-companion@agent-templates --scope user`, then check all the copies with the plugin's own script:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion | head -1)"   # the clone `marketplace update` just refreshed
node "$AC/scripts/version.mjs" --remote     # or /ac version; add --json for a record
```

It lists THIS copy, the CLI cache entry (version, `gitCommitSha`, `lastUpdated` from `installed_plugins.json`), every desktop-app copy (`…/local-agent-mode-sessions/<acct>/<org>/rpm/plugin_<id>/`), the marketplace clone, and, with `--remote`, origin/main, and ends with a verdict line (`all copies current`, or `STALE: <copy> is <ver>, latest is <ver>` with the sessions affected and the fix).

- The release has **landed for CLI sessions** when the CLI cache copy shows the new version and the new `gitCommitSha`. That is the release's definition of done.
- **Record the desktop copy's state separately** in the release note. The desktop app may keep its own copy, which Desktop Code-tab sessions run; `claude plugin update` does not touch it, so it can trail the CLI copy. When it has none, `version.mjs` says so and desktop sessions load the CLI cache copy. A desktop copy that is still behind is reported, never papered over; the daily scout raises `plugin_copy_stale` for it after 6 hours. Fix, verified 2026-10-02: disable, then re-enable, agent-companion in the desktop app's plugin manager (not `claude plugin uninstall`, which wipes the plugin options), then idle desktop sessions pick up the current copy on their next turn (a session that is mid-turn, after that turn); confirm with `/ac version`. Afterwards desktop sessions run the CLI cache copy, so a later `claude plugin update` covers them.
- A behaviour change that must reach desktop sessions at once cannot wait for that sync: put it in the operator routing profile, which every copy reads.

---

## Provenance anonymization

Lessons carry a `provenance: [contrib-1, contrib-2, …]` field — **anonymized contributor ids only**. The library must **never** record who a contributor really is.

**Why:** the leak-check guard bans real names, handles, and emails (it would fail CI on any of them), and there's no reason to publish contributor identities in a vendor-/project-neutral library anyway. So the public record uses opaque ids; the real id↔person mapping lives **only** with the maintainer.

**How:**
- In any lesson you draft, set `provenance` to anonymized ids (`contrib-1`, `contrib-2`, …). Reuse an existing id for the same source across lessons.
- The real mapping goes in `PROVENANCE.local.md` at the repo root — which is **git-ignored and never committed** (see `.gitignore`). Only the maintainer holds it.
- `corroborated` counts *independent sources* observing a lesson; raise it (don't duplicate the lesson) when a second source confirms it.

---

## Harvesting

Most contribution is manual: you notice a generic improvement and follow the steps above. **Harvesting** automates the *detection* and *first-draft* of that flow across a whole project's history, using the [`lessons-harvester`](anthropic/lessons-harvester.md) agent (a Claude Code agent def, `model: sonnet`, `effort: high`).

Its job, in short (full process in the agent def):
1. **Diff** a source project's agent defs + `CLAUDE.md` (+ `CLAUDE.local.md`) since the last harvest baseline (the project's `.template.lock` `libraryCommit`, or a recorded harvest date).
2. **Run the "is this generic?" test** on each changed rule, then **classify** it onto the axes (minding AND/OR semantics).
3. **Dedup** against `lessons/INDEX.md` *by meaning* — propose raising `corroborated` or a supersession instead of a duplicate.
4. **Scrub** specifics → placeholders/generic examples (leak-check will enforce on commit).
5. **Propose, never auto-commit** — drafts go to a PR or `CONTRIBUTIONS_INBOX.md`; a human gates placement + scrub before anything lands in `lessons/`.
6. **Drift check** — compare the maintainer's private global rules kernel (for Claude Code, `~/.claude/CLAUDE.md`) against `lessons/universal/` + `lessons/agent-process/` and report divergence, so the private kernel and its public mirror don't drift silently.

The routing rules the harvester applies are the axes/tags in [ARCHITECTURE.md](ARCHITECTURE.md); the gate is always a human.
