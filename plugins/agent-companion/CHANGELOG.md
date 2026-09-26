# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

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
