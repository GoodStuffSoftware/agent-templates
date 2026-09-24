# ADR 0001 — a versioned local backup for the Claude Code memory corpus

**Status:** Accepted
**Date:** 2026-09-20
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

> This is the first ADR in this repository, so it also sets the convention:
> one file per decision under `docs/adr/`, numbered sequentially, never
> renumbered or deleted — a superseded decision gets a new ADR that says so,
> the way `docs/memory-layer-evaluation.md` §4.5 already does in prose for
> the finding this ADR turns into a shipped feature.

## Context

Claude Code's native Auto Memory feature keeps per-project facts at
`~/.claude/projects/<encoded-cwd>/memory/`: an index (`MEMORY.md`) plus one
`.md` file per fact, each with YAML frontmatter (`name`, `description`,
`metadata.type`). Measured on the operator's machine 2026-09-20: 18 project
directories, 13 with a non-empty store, 473 memory files total, largest
244 files. `docs/memory-layer-evaluation.md` §4.5 already established the gap
this ADR closes:

> "A copy is not a history. Last-write-wins replication restores *a* state;
> it cannot tell you what a memory said before someone rewrote it... The
> incumbent's headline strength — 'git-friendly' — is unrealised."

That finding is now a fact on the ground, not a hypothetical: earlier the
same day, a project's `MEMORY.md` was rewritten with no way to tell what
changed or whether anything was lost. `git log -p MEMORY.md` would have
answered it in one command, if the file had ever been in a repository.

A separate, pre-existing mechanism (a `session-sync` plugin, not part of this
repository) already replicates the whole `~/.claude` tree — including the
memory directories — to cloud storage via rclone. That plugin solves
*transport and durability* (bytes exist somewhere else) but not *history*
(what did this file say last Tuesday, and did the rewrite lose anything). The
two problems have a ~5,500x size difference between them (§4.5: ~1.5 MB of
memory vs. ~8 GB dominated by session transcripts) and should not be solved
by the same mechanism. This ADR is scoped to history for the memory corpus
only; it does not replace, wrap, or depend on `session-sync`.

### Requirements this decision must satisfy (operator-stated, non-negotiable)

1. The live corpus is never written to, moved, renamed, or deleted by this
   feature. Read-only, always.
2. If the plugin is uninstalled tomorrow, native memory keeps working
   unchanged, and any backup already taken stays readable with plain `git` —
   no proprietary format, no database, no required tooling.
3. Session transcripts (`~/.claude/projects/<project>/*.jsonl`, sitting
   *beside* each project's `memory/` directory, not inside it) are never
   captured, under any design. This is provable, not just claimed.
4. Deleting a memory file must be recoverable from history — record
   deletions, not just additions.
5. Concurrent native writes during a sync must not corrupt anything or
   produce a half-committed state. The corpus is written by other live
   sessions while this feature runs; it must tolerate that, not lock against
   it.
6. Ships as a plugin feature (default OFF for the public plugin — see
   "Why default-off" below), not a one-off script.

## Decision

**Build a mirrored vault: a separate local git repository that copies memory
files in and commits, and never touches the live corpus's own directory.**
Concretely: `~/.claude/agent-companion/memory-vault/`, a plain git repo
mirroring `~/.claude/projects/<project>/memory/**` under
`memory-vault/projects/<project>/memory/**`, populated and committed by
`plugins/agent-companion/scripts/memory-vault.mjs sync`.

This is "Option B" below. The one sentence that decided it: **the operator's
own objections to Option A — `git clean -fdx` deleting the ignored transcript
files, `git reset --hard` rewriting live files out from under a running
session — are not edge cases to guard against, they are exactly what git is
*for*, and no amount of `.gitignore` or documentation stops a future
`git`-literate session (human or agent) from running an ordinary, otherwise
harmless git command against a working tree that happens to be the operator's
live memory.**

## Alternatives considered

### Option A — the live corpus IS the git working tree

Run `git init` at `~/.claude/projects/`, with a whitelist `.gitignore`
(`*\n!*/memory/\n!*/memory/**`) so only `*/memory/**` is ever tracked;
everything else (session transcripts, in particular) is untracked and
ignored. `git add -A && git commit` runs directly against the live files. No
copies, no drift, `git log -p` works on the real file at its real path.

**Why it loses.** Every git command in this repository would now run against
the operator's live, concurrently-written memory:

- `git clean -fdx` (a command whose entire job is "delete everything not
  tracked") would delete the *untracked* session transcripts — 96.7% of the
  tree's bytes, per §4.5's measurement — the single most catastrophic outcome
  named in the brief, and the ordinary, textbook use of that flag.
- `git checkout -- .` or `git reset --hard` would silently rewrite memory
  files out from under a session that has them open or is mid-write,
  requirement 5's exact failure mode, and requirement 1's exact violation —
  this is no longer read-only, it is `git`-mediated read-write.
- It puts a `.git` directory inside the operator's live memory tree by
  construction. That is itself a structural change the operator asked this
  feature not to make ("we should not... modify it in any way that will make
  it break without our plugin"): every future tool that walks
  `~/.claude/projects/**` now has to know to skip `.git`, and a `.git`
  sitting inside a tree that other software already walks recursively
  (`discoverFiles()` in this very plugin does exactly that) is a new failure
  surface, not a neutral addition.
- The whitelist `.gitignore` is a single text file. One wrong line — a typo,
  a merge, a future edit — silently widens what the *next* `git add -A`
  captures, and the failure is invisible until someone runs `git log` and
  finds transcript content in history. Requirement 3 asked for this to be
  *proven*, and a design whose safety rests entirely on one `.gitignore` file
  never being wrong is not provable, only auditable after the fact.

None of this requires operator error inside *this* feature's own code — it
only requires someone, someday, running an ordinary git command against
`~/.claude/projects/` for an unrelated reason (a `git status` habit, a future
tool that also wants version control there, an agent cleaning up "untracked
cruft"). The blast radius of that mistake is the operator's entire live
memory and, for `clean -fdx`, every uncommitted session transcript on the
machine. A design where the failure mode is "someone ran `git` normally"
fails the read-only requirement in expectation, not just in the worst case.

### Option A2 — detached `--git-dir`, corpus stays the work-tree

A variant of A: keep `.git` *outside* the corpus
(`~/.claude/agent-companion/memory-vault.git`, `--work-tree=~/.claude/projects`),
avoiding the "a `.git` folder appears inside the live tree" objection while
still committing the real files directly (no copy, no drift).

**Why it loses.** This removes one objection to A and keeps the rest: `git
clean -fdx --git-dir=... --work-tree=~/.claude/projects` still deletes every
untracked file under the work-tree, including transcripts; `git reset --hard`
still rewrites live files under a running session. It also adds a new sharp
edge — the two flags must be supplied correctly on *every* invocation, by
hand or by any future tooling, or an operator's bare `git status` run from
inside `~/.claude/projects` (a directory they will absolutely `cd` into
someday) silently pierces into a git context they did not intend to enter,
via whatever ambient `GIT_DIR`/discovery state is active. It is A's risk
surface with an extra way to invoke it by accident.

### Option C — real-time capture via filesystem watcher

Watch `~/.claude/projects/*/memory/**` for changes (`fs.watch` / a polling
loop) and commit into the vault on every detected write, instead of on a
schedule.

**Why it loses.** It trades a bounded, predictable daily batch for an
unbounded stream of tiny commits racing the very writer it is watching. A
native memory write is not guaranteed atomic from a watcher's perspective —
catching a file mid-rewrite is a real risk with much higher likelihood than
under the periodic-pull model this ADR adopts, because periodic pull reads
each file *once* per cycle and tolerates a bad read by skipping it until the
next cycle (cheap and self-healing), while a watcher fires *per event* and
either reads immediately (higher torn-read odds, no debounce window) or has
to invent a debounce/coalescing layer (state, timers, a new class of bug) to
avoid it. It also needs a long-lived background process — "detached daemon
either outlives its session or dies with it," the exact tradeoff this
plugin's own `README.md` telemetry section already rejected for a
different feature, for the same reason. A scheduled `sync` piggybacked on
infrastructure that already runs daily needs none of this.

### Option B — mirrored vault (chosen)

Copy memory files into a dedicated repository elsewhere; the corpus is never
a git working tree and is never written to. Read-only against the source,
by construction — the only filesystem calls this feature ever makes against
`~/.claude/projects/**` are `readdirSync`/`statSync`/`readFileSync`
(reused directly from the plugin's existing, already-audited
`hooks/lib/memory-index.mjs discoverFiles()`, not reimplemented). There is no
code path in this feature that can call `writeFileSync`, `rename`, `unlink`,
or any git command against that tree, because the vault's git repository
does not live there and no git command in this feature is ever invoked with
`--work-tree` or `-C` pointed at it.

**Cost, stated plainly (this is what B pays for the safety above):**

- It is a copy. Between two `sync` runs it can drift from the live corpus —
  a change made and then reverted inside one interval leaves no trace.
  Accepted: the corpus is small (~1.5 MB measured in §4.5) and the sync
  cadence (daily, piggybacked on the existing calibration scout — see
  "Scheduling" below) is frequent relative to how often any one memory file
  actually changes.
- History granularity is the sync cadence, not the write. A file rewritten
  three times between two syncs is captured as one commit, not three. This
  is the same shape as any periodic backup and is explicitly acceptable per
  the brief's own framing ("across the sync cadence" is the class of
  granularity asked for, not per-write).
- Disk cost: one additional copy of the corpus (~1.5 MB today, growing with
  the corpus, plus git's own history overhead — small at this scale per
  §4.7's "not a real vector database... an exhaustive scan is milliseconds"
  reasoning, which applies here too: hundreds of small text files is well
  inside git's comfortable range).

Both costs are the deliberate trade against Option A's failure mode, which
has no bound: the read-only requirement is non-negotiable per the brief,
and every option that operates directly on the live tree defeats it under
an ordinary git command, not just a bug in this feature's own code.

## Consequences

- **Uninstall safety (requirement 2):** the vault lives under
  `~/.claude/agent-companion/` (`stateRoot()`), the plugin's existing durable
  state root — already proven to survive an uninstall by
  `tests/survives-uninstall.test.mjs`, because a plugin uninstall only ever
  deletes `~/.claude/plugins/data/<plugin>-<marketplace>/`. No new root was
  invented; the vault reuses the one root this plugin already keeps outside
  the uninstall path. If the plugin is removed, the vault directory and its
  git history sit there untouched, readable with plain `git log` /
  `git show`, forever — nothing in it depends on the plugin being installed.
  `AGENT_COMPANION_VAULT_DIR` (an absolute path) moves the vault alone, for
  when the default location sits inside a git repository and is refused.
  `AGENT_COMPANION_STATE_DIR` would move it too, but it moves all of the
  plugin's state with it, including user-authored `config/`.
- **Transcripts (requirement 3):** proven, not just designed-around.
  `hooks/lib/memory-index.mjs discoverFiles()` walks `<root>/<project>/memory/`
  specifically — transcripts live at `<root>/<project>/*.jsonl`, a sibling of
  `memory/`, never inside it, so they are structurally outside every path
  this feature ever reads. `tests/memory-vault.test.mjs` seeds a fixture
  corpus with a `.jsonl` file next to a `memory/` directory and asserts, after
  `init` + `sync`, that no file anywhere under the vault's working tree or
  git history contains `.jsonl` content or the literal transcript marker text
  — a test that fails if this invariant is ever accidentally widened (e.g. by
  someone later changing the walk to `<project>/**` instead of
  `<project>/memory/**`).
- **Deletions recorded (requirement 4):** `sync` computes the live file set
  from `discoverFiles()` and removes, from the vault's working tree, any
  previously-mirrored file no longer present in that set, before
  `git add -A`. Because the deletion is committed (not just the file
  silently vanishing from the next copy), `git log --follow -- <path>` and
  `git show <sha>^:<path>` recover the last known content after a deletion.
  Tested directly.
- **Concurrency (requirement 5):** every corpus read is wrapped and tolerant
  — a file that fails to read (ENOENT because it was deleted between listing
  and reading, EBUSY/EPERM on Windows because another process has it open)
  is skipped for *this* sync only, leaving the vault's existing copy
  untouched; it is picked up on the next cycle once the write settles. This
  is the same "self-heals next cycle" posture `hooks/lib/state-sync.mjs`
  already uses for its own sync problem. Nothing in this feature ever opens
  a corpus file for writing, and no lock is taken against the corpus — only
  against this feature's own concurrent invocations (a `wx`-created
  `state/memory-vault-sync.lock`, stale after 120s, mirroring the existing
  `state/sync.lock` convention in `hooks/lib/state-sync.mjs` /
  `docs/TELEMETRY.md`). **A hard safety guard also protects the vault itself:**
  if `discoverFiles()` returns zero files while the vault already holds
  tracked content, `sync` refuses to proceed — a suspicious empty
  enumeration (root unreadable, transient failure) must never be interpreted
  as "everything was deleted." This is exactly the failure a naive
  copy-and-diff sync would have, and it is covered by a dedicated test.
- **Half-committed state:** a `sync` either produces exactly one git commit
  containing every successfully-read change, or (on any failure before the
  commit, or when nothing changed) no commit at all — `git commit` is atomic
  by construction, so there is no git-level notion of "half committed."
  A second `sync` with no source changes stages nothing and commits nothing
  (`git diff --cached --quiet` gates the commit) — verified in the real run
  below.
- **Secrets (new gate, not in the original ask but required before anything
  is committed):** every file read during `sync` is scanned against a fixed
  set of credential-shaped patterns (cloud provider keys, private-key
  headers, bearer/JWT tokens, embedded connection-string credentials, generic
  `secret:`/`token:`/`password:` assignments) before it is written into the
  vault. A match excludes that one file from the commit (report only: file
  path + which pattern label, never the matched value) and leaves the
  vault's prior copy of it untouched. This runs on every `sync`, not as a
  one-off — it is the standing gate the brief asked for. Dry-run against the
  real corpus (471 files, read-only, no vault touched) flagged 2 files, both
  `private-key-block` — see the report for the file list.
- **Not built:** a remote. The vault is created and committed to purely
  locally; adding `git remote add origin <url>` is the operator's own next
  step (exact command in the report), deliberately not automated here — the
  brief reserves that decision, and this repo's own push target is `origin`
  of `agent-templates` only, never a second remote chosen on the operator's
  behalf.
- **Not built:** reconciliation/merge of the `archive/` duplicate files
  already known to exist in one project's store (27 files that are copies,
  not moves — see the brief). The vault mirrors what is there, duplicates
  included, exactly as the brief instructed ("back up what is there; do not
  try to fix it").

## Why default-OFF

`memory_vault` ships OFF in `plugin.json`'s `userConfig`, matching the
precedent `docs/memory-layer-evaluation.md` set for `memory_search` /
`memory_brief` for the identical reason: `agent-companion` is a *publicly
distributed* plugin, and turning this on writes a second, permanent, git-
versioned copy of someone's personal memory corpus to disk. That is a bigger
default-behavior change than a read-only ranking index (which is itself
already default-off), so it inherits the same default and the same
justification. Unlike `memory-doctor.mjs` and `memory-search.mjs` — which do
not check a master on/off option in their CLI path at all — `sync()` checks
`opt('memory_vault', false)` as the first line of the function, so a hand run
with the option off (by name, by hand, or by the scheduled routine) is a
no-op: nothing is copied and nothing is committed. Set the option, or its
`CLAUDE_PLUGIN_OPTION_MEMORY_VAULT` environment variable, to actually sync.

## Scheduling — reusing the existing cadence instead of inventing a second one

The plugin already has exactly one autonomous, unattended, daily execution
path: the calibration scout (`plugins/agent-companion/routines/
calibration-scout-daily.md`), scheduled outside this repository (a desktop
scheduled task plus a claude.ai cloud routine), where "editing this file is
the whole release" per its own header. A new step was added to that routine's
**local-only** section (the vault needs the real
`~/.claude/projects/` tree, which — per `memory_search_repo`'s own
documented constraint — does not exist in a cloud sandbox) that runs
`node "$AC/scripts/memory-vault.mjs" sync` unconditionally; the script itself
is what checks the `memory_vault` option and no-ops when it is off. This
mirrors how every other opt-in hook in this plugin self-gates
(`scout-surface.mjs`: `if (!opt('scout_surface', true)) passthrough();`)
rather than pushing the on/off decision into the caller. No second scheduler,
cron entry, or daemon was created.

## What would have to be true for this to be wrong

- If the operator's memory corpus grows by orders of magnitude (thousands of
  files, tens of MB), the copy-and-diff `sync` cost could become
  noticeable — still almost certainly sub-second at git's scale, but worth
  re-measuring rather than assuming.
- If `session-sync` (the existing rclone-based replication plugin) is ever
  extended to run `git log`-style history *itself*, this feature would become
  redundant with it rather than complementary — worth checking before adding
  a second vault-like mechanism anywhere else in this operator's tooling.
- If the operator wants sub-daily granularity (e.g. "what did this say an
  hour ago"), Option B's cadence-bound history stops being sufficient and
  Option C's real-time capture — rejected here on complexity and torn-read
  risk — would need to be revisited with a debounce layer designed in from
  the start, not bolted on.
