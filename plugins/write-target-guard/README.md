# Write-Target Guard

A Claude Code **PreToolUse** hook on `Write`, `Edit`, `MultiEdit` and `NotebookEdit` that keeps *code* writes
out of protected git checkouts:

- a repo's **primary / deploy worktree** (where merges land, but code work should
  not happen), and
- its **unnamed auto-worktrees** — a `claude/*` branch sitting under
  `.claude/worktrees/*` that never reaches staging.

Code belongs in a deliberately-named sibling worktree (`feat/…`, `fix/…`, …). The
guard denies a code write to a protected checkout and tells you where it *should*
go. In the primary, docs, `.claude/` config and markdown are exempt (in a `claude/*`
auto-worktree the branch rule runs first, so the exemptions do not apply there), and
a conscious override is available per write (see [Acknowledgements](#acknowledgements)).

The rules are **not** baked into the plugin. They come from a per-machine config
file that lives in your home directory, outside any repo, so this public plugin
ships no project-specific paths. See [Configuration](#configuration).

> **Platform:** Windows. The path rules are `path.win32` (drive letters, UNC and
> device prefixes, 8.3 short names, junctions). The guard is a no-op cost on other
> platforms only in the sense that its fixtures and tests are Windows-shaped; do
> not rely on it off Windows.

---

## Install

This plugin is distributed through the `agent-templates` marketplace. Once the
marketplace is added, enable `write-target-guard` from the plugin manager, then
create the config file (next section). **A missing config does not silently
disable the guard — it warns loudly on every `Write`/`Edit` (see
[Fail-open, loudly](#fail-open-loudly)).**

The hook registers itself via the plugin's `hooks/hooks.json`, which runs:

```
node ${CLAUDE_PLUGIN_ROOT}/hooks/write-target-guard.mjs
```

with the matcher `^(Write|Edit|MultiEdit|NotebookEdit)$`. A `NotebookEdit` is judged by
its `notebook_path` and a `MultiEdit` by its `file_path`; an acknowledgement token may
sit in any edit's `new_string` (`MultiEdit`) or in `new_source` (`NotebookEdit`).

The hook is also usable as a **single copied file** (register
`node <path>\write-target-guard.mjs` directly in `settings.json`). It has **no
sibling imports** — only `node:fs`, `node:path`, `node:os` — precisely so the
copied-file deployment behaves identically to the plugin deployment. See
[Cutover](#cutover-plugin--single-file) if you are moving from one to the other.

---

## Configuration

The guard reads one JSON file, at a **fixed** path in your home directory:

```
<home>\.claude\write-target-guard.config.json
```

(`os.userInfo().homedir\.claude\write-target-guard.config.json` — on Windows,
`C:\Users\<you>\.claude\write-target-guard.config.json`.) The home directory is
the OS account's, **not** `USERPROFILE`/`HOME`: `os.homedir()` honours those, so an
environment variable could point the guard at a disabled config.

There is **deliberately no environment-variable override** of the config path or
of any rule. An env-var or in-repo override would be a bypass vector: a repo you
are editing could point the guard away from itself. The one override is a
`--config <absolute path>` (or `--config=<absolute path>`) argument in the hook's
**own registration** (`hooks.json` / `settings.json`, which already decides whether
the hook runs); the test suite uses it. A `--config` given more than once (in either
form), with no value or with a relative path is treated like a malformed config
(loud, fails open); the first value never wins silently. So is a config file larger
than 64 KiB.

Copy [`write-target-guard.config.example.json`](./write-target-guard.config.example.json)
to that path and edit it for your machine. Schema:

| Field | Meaning |
|---|---|
| `version` | Config schema version (currently `1`). |
| `enabled` | `false` disables the guard **silently** (a valid opt-out). Omit or `true` to enforce. |
| `repos[]` | One entry per protected repo. An empty array is also a silent opt-out. |
| `repos[].primary` | The primary checkout root. A **trailing backslash** excludes sibling dirs (`…\my-project\` does not match `…\my-project-feat\`). |
| `repos[].worktreeMark` | The sub-path marking auto-worktrees (default `.claude\worktrees\`). |
| `repos[].allowedBranchPrefixes` | Branch prefixes that make an auto-worktree writable (default `feat fix docs chore refactor perf test build ci style revert wip`). |
| `repos[].codeDirs` | Directory names that make a file *code* (e.g. `src`, `e2e`, `functions`), matched below the checkout root only. |
| `repos[].scriptDir` / `scriptExts` | A script directory, and the extensions that count as code anywhere inside it (below the checkout root). |
| `repos[].rootCodeFiles` | Files that count as code when they sit **at a checkout root** (e.g. `package.json`, a lockfile, build config). |
| `repos[].rootCodeFilesAtWorktreeRoots` | When `true`, `rootCodeFiles` also count at a worktree root (editing a worktree's build config is code work). |
| `repos[].exemptDirs` / `exemptExts` | Directories (`.claude`, `docs`, `.husky`) and extensions (`md`) exempt **in the primary**, at any depth below its root (a primary that itself sits under a folder named `docs` is not exempted). In a `claude/*` auto-worktree the branch rule runs first and they do not apply. |
| `repos[].coworkAck` / `primaryAck` | The `guard-ack:` tokens that override the auto-worktree and primary denials. |
| `repos[].hints` | `primaryLabel`, `siblingSlug`, `worktreeAddExample` — strings quoted back in the denial message to tell you where to go. |

Paths are compared case-insensitively with backslash separators.

### Trust anchor

This config file **is the trust anchor**: it defines what the guard protects. The
guard therefore **denies a `Write`/`Edit` to the config file itself** (the
`--config` file when one is given, and its own hook file) unless the content carries `guard-ack: guard-config`. Keep the file
in your home `.claude` directory; never commit a machine's real config to a repo.

---

## What counts as a code write

Within a configured repo's tree, a path is *code* if any of the following holds.
Directory names are read only **below the checkout root** (for an auto-worktree,
from the worktree's own name down), never from the folders the checkout sits in:

- a directory component is in `codeDirs`;
- it is anywhere under `scriptDir` with an extension in `scriptExts`;
- it is a `rootCodeFiles` name directly at the primary root (or, with
  `rootCodeFilesAtWorktreeRoots`, directly at a worktree root). **(P5)**

A code write is then judged by *where* it lands:

- **Primary root** → deny (unless `exemptDirs`/`exemptExts`, or
  `guard-ack: <primaryAck>`).
- **Auto-worktree** under `worktreeMark` → judged by the worktree's **current
  branch**, read from `.git` with no git process spawned: a named allowed-prefix
  branch is allowed; `claude/*`, other non-matching names, `main`/`master`/
  `staging`, `backup/*`, a detached HEAD, a name containing `..`, and an
  unreadable, garbled or oversized `.git`, `HEAD` or rebase `head-name` (over
  4 KB) are denied (unless `guard-ack: <coworkAck>`).
  **Branch-resolution failure falls back to DENY, never allow.**

Non-code writes, and writes outside every configured repo, are allowed.

### Path-alias hardening (2026-10-03)

Before any path check, the target `file_path` is **canonicalised** so an alternate
spelling cannot dodge the guard:

- **P1 — device / UNC prefixes.** `\\?\C:\…` and `\\.\C:\…` are stripped to
  `C:\…`; `\\?\UNC\server\share` and `\\.\UNC\…` reduce to `\\server\share`;
  the NT-namespace spelling `\??\` is handled the same way; admin-share UNC onto a
  loopback or this host (`\\localhost\C$`, `\\127.0.0.1\C$`,
  `\\[::1]\C$`, `\\<hostname>\C$`) maps back to the drive letter.
  Forms that **cannot** be resolved to a drive-letter or UNC path —
  `\\?\Volume{GUID}\`, `\\.\GLOBALROOT\…`, raw devices (`PhysicalDrive0`,
  `HarddiskVolume…`) — are **DENIED, not guessed at**. This is a deliberate
  fail-*closed* for exotic forms that never appear in a normal `Write`/`Edit` and
  exist here only as a bypass vector. It is **not** the outer fail-open.
- **P2 — ADS and trailing dot/space.** A trailing NTFS stream
  (`…\App.vue::$DATA`, `:$DATA`, `:stream`) on the final component is dropped, and
  trailing dots/spaces are stripped per segment (Windows opens `App.vue. ` and
  `src ` as `App.vue` / `src`). A segment made only of dots and/or spaces (`. .`,
  `.. `) is skipped like `.`/`..` rather than trimmed to empty, so a following `..`
  cannot cancel the wrong segment.
- **P3 — 8.3 / junctions / symlinks / subst.** After lexical normalisation the
  **deepest existing ancestor** is resolved with `fs.realpathSync.native` (which
  folds an 8.3 short name such as `MYPROJ~1` to its long name and resolves
  junctions and symlinks), then the not-yet-created tail is re-appended. A
  realpath **failure is not an unexpected error**: it falls back to the lexical
  path. It does not fail open.

The same pipeline runs on the **configured paths**: each repo's `primary` and its
worktree prefix (`primary` + `worktreeMark`). An 8.3 or junction spelling in the
config therefore matches the long, resolved target, just as an aliased target
matches a long-name config.

These shapes cannot be judged, so they are **denied for every write**, code or not:

- **Over-long or invalid targets.** A target longer than 32,767 characters (the
  Windows path maximum) or containing a control character (NUL, or any other
  character below 0x20) names no real file. Both are refused before any other
  work, so the guard never spends its time limit on them.
- **Drive-relative and rooted-relative targets.** `C:..\src\x.ts`, `C:src\x.ts`,
  `\Users\...` and `/c/...` resolve against the *writer's* current directory, which
  the guard cannot know. The message says to use a fully qualified path. Plain
  relative paths (`src\x.ts`) resolve against the hook process's working
  directory. That is a change: the pre-alias hook never matched a relative path,
  so a relative `src\x.ts` with the hook's cwd at the primary now **denies**
  where it used to allow.
- **Unresolvable UNC.** A target that is a UNC path P1 cannot fold to a local drive
  (`\\fileserver\share\…`, `\\localhost\Users\…`), or that realpaths to one (a
  mapped network drive, a symlink to a share). The message says to use the local
  drive path. See [Known limitations](#known-limitations).

---

## Fail-open, loudly

If the config is **missing** or **malformed**, the guard **fails open** — `Write`
and `Edit` proceed — but **loudly, in every deployment**. On the non-blocking
exit-0 result it emits a top-level `systemMessage` (the channel Claude Code shows
to the user; plain stdout/stderr reach only the debug log) plus a stderr line:

- **Missing config:** *"write-target-guard is INSTALLED but INACTIVE: no config
  file at `<path>`. Write, Edit, MultiEdit and NotebookEdit are UNGUARDED. Create that file … or
  remove/disable the plugin …"*
- **Malformed config:** *"write-target-guard is INACTIVE: config at `<path>` is
  malformed (`<reason>`). Write, Edit, MultiEdit and NotebookEdit are UNGUARDED until it is fixed."*

A **partly** malformed config is salvaged, loudly, never silently. Each invalid
piece is dropped with one `WARNING` naming the field, on stderr and in the
`systemMessage`, on every call. That covers a wrong-typed list element
(`"codeDirs": ["src", 1]`), a wrong-typed field (`"worktreeMark": 5`), a primary
that is not an absolute path string (`"primary": 42`) and a repo entry that is not
an object (`"repos": [null, …]`). Everything still valid stays enforced. Only when
**no usable repo entry** remains does the guard take the malformed fail-open
above. A configured `primary` that **does not exist** on this machine is kept,
still guarded as written, and warned about the same way.

There is deliberately **no plugin-mode exemption**. Once this machine runs the
guard as a plugin, `CLAUDE_PLUGIN_ROOT` is set, and a *deleted* config is exactly
the case that must stay loud there — a removed config is the one off-switch we
refuse to make silent.

The **only** path to a *silent* allow is an **explicit opt-out inside a valid
config**: top-level `"enabled": false`, or an empty `"repos": []`. Everything else
(a real config with repos) enforces.

### Why fail open, not closed?

This hook runs on **every `Write`/`Edit` on the machine**. Failing *closed* on a
missing or corrupt config would turn one bad file into a total write outage —
including the inability to write the config needed to repair it. Fail-open matches
the guard's existing outer error handling (an unexpected exception also allows),
and the per-call `systemMessage` keeps the degraded state visible on every call in
every deployment, so the trade-off is "unguarded but noisy", never "silently
off". Rejected alternatives: fail-closed (bricks writes); an env-var or sentinel
off-switch (a bypass vector); and a *silent* fail-open, including a plugin-mode
silence (invisible after cutover).

### A gap we name honestly

This is a `Write|Edit|MultiEdit|NotebookEdit` hook. It **cannot** stop a Bash `rm` of the config file (a
different tool surface). That gap is covered by (a) the loud warning above — the
very next `Write`/`Edit` announces the config is gone — and (b) an out-of-band,
versioned backup of `~/.claude` kept off-machine. Do not treat the guard as
tamper-proof storage for its own config.

### A latency note

`realpathSync.native` walks each existing ancestor. A UNC target is denied before
that walk, but a **mapped drive whose share is unreachable** still walks over the
network; a dead UNC host was measured at ~2.7s — within the hook's 15s timeout, a
latency cost, not a correctness one.
Normal local paths resolve in well under a millisecond. The walk is bounded: a
deep not-yet-created tail (up to 16k segments at the 32,767-character maximum) is
searched in a few dozen probes rather than one per segment. A chain that fails at
every depth for a reason other than "not found" (a junction loop), whatever the
error code, stops walking after 64 probes; a gallop and a binary search then find
the deepest ancestor above it that does resolve, so an alias above the loop (an 8.3
name, a junction or `subst` drive into the checkout) still folds. Only when nothing
resolves is the bare lexical path used. The worst cases measured about 0.1–0.7s per
call.

---

## Cutover (plugin ⇄ single file)

Do **not** run both. If `~/.claude/settings.json` still registers the copied hook
while the plugin is enabled, the guard runs **twice** on every write (two processes,
duplicated denials, and every config warning printed twice). Remove the
`settings.json` entry in the same step that enables the plugin.

The entry to remove is the one hook object that runs the copied file, from the
`hooks` array of the `PreToolUse` group whose matcher is `Write|Edit`. Leave any
sibling hooks in that group alone, and drop the whole group only if this was its
only hook:

```json
{
  "type": "command",
  "command": "node",
  "args": ["C:\\Users\\<you>\\.claude\\hooks\\write-target-guard.mjs"],
  "timeout": 15,
  "statusMessage": "Checking write target (worktree discipline)"
}
```

The legacy matcher is `Write|Edit`, so a `settings.json` registration never sees
`MultiEdit` or `NotebookEdit`. If you keep the single-file deployment instead of
cutting over, widen that matcher to `Write|Edit|MultiEdit|NotebookEdit`; the
plugin's `hooks.json` already covers all four.

To move the registration:

1. Create `~/.claude/write-target-guard.config.json` (copy the example).
2. Add the marketplace, enable the plugin, **and remove the `settings.json` entry
   above in the same step**.
3. Restart or reload so the hook registration is re-read.
4. Confirm a trivial code write into a protected checkout is denied exactly once.

---

## Known limitations

- A primary on a network share or a mapped drive gets **every** write denied,
  because every UNC target is denied; work from a local clone.
- WSL (`\\wsl$`, `\\wsl.localhost`) and `\\tsclient` writes are denied, because
  WSL's `/mnt/c` aliases C: and the guard cannot fold them to a local drive path.
- A **disconnected** mapped drive is not caught (realpath fails and the lexical
  drive path is used), though a write to it cannot succeed anyway.
- Writes through **hard links** are not detected; a hard link to a protected file
  looks like an ordinary path elsewhere.
- An **alternate data stream on a directory** is judged as the directory's path:
  `<primary>\src:stream` is allowed (P2 drops the stream). The data lands as a
  stream on the `src` directory object itself, not as a file inside `src`.
- `/c/…` and `/mnt/c/…` targets are denied as rooted-relative, not mapped to C:.
- The config is an off-switch: a missing or malformed config is loud and fails
  open, while `"enabled": false` or no repos is silent by design.
- The guard is **branch-keyed**: a nested repo under `.claude\worktrees\<name>`
  that is not a real linked worktree, but whose `.git` names an allowed branch
  (`feat/…`), is allowed like a real worktree.

---

## Tests

`plugins/write-target-guard/tests/write-target-guard.test.mjs` — zero-dependency
`node:test`, run via `node scripts/ci-local.mjs --suite write-target-guard-tests`
or directly with `node --test`. The suite builds throwaway git repos under a fresh
`mkdtemp` dir, so it never touches anything outside the checkout, and it
self-skips (with a message) off Windows. Machine-dependent cases (an 8.3 short
name, a directory symlink) self-skip only when the volume or the account lacks the
capability. CI runs it on `windows-latest`
(`.github/workflows/write-target-guard-tests.yml`).
