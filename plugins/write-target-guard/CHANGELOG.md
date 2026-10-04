# Changelog

All notable changes to the **write-target-guard** plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-03

First release as a plugin. Ported from a machine-local, single-project PreToolUse
hook (originally hard-coded to one repo) and generalised.

### Added

- **Config-driven rules.** The guard reads one JSON file from
  `~/.claude/write-target-guard.config.json`; the plugin ships no project-specific
  paths. Ships `write-target-guard.config.example.json`.
- **Path-alias hardening** so an alternate spelling of a protected path cannot
  dodge the guard:
  - **P1** device/UNC prefixes (`\\?\`, `\\.\`, `\\?\UNC\`, admin-share UNC to
    loopback / hostname / IPv6 loopback). Unresolvable device/volume namespaces
    (`\\?\Volume{GUID}\`, `\\.\GLOBALROOT\`, raw devices) are **denied**, not
    guessed at.
  - **P2** alternate data streams (`::$DATA`, `:$DATA`, `:stream`) and trailing
    dots/spaces, stripped before the path check.
  - **P3** 8.3 short names, junctions, symlinks and `subst`, folded via
    `fs.realpathSync.native` on the deepest existing ancestor with a lexical
    fallback (a realpath failure does **not** fail open).
- **P5** root config files (`package.json`, lockfile, build config, …) count as
  code at a checkout root, including worktree roots when
  `rootCodeFilesAtWorktreeRoots` is set.
- **Self-protection.** A `Write`/`Edit` to the guard's own config or hook file is
  denied unless the content carries `guard-ack: guard-config`.
- **Loud fail-open.** A missing or malformed config fails open but emits a
  top-level `systemMessage` plus a stderr line, in **every** deployment (plugin or
  single-file). The only silent allow is an explicit valid opt-out
  (`"enabled": false` or empty `"repos": []`).
- **UNC targets denied.** Any write whose target is a UNC path that cannot be folded
  to a local drive (`\\server\share\…`, `\\localhost\Users\…`, `\\?\UNC\…`, or a
  realpath onto a share) is denied, code or not. This closes a bypass where a
  loopback or LAN-address spelling of a protected file was allowed. A repo whose
  primary lives on a share or mapped drive gets every write denied.
- **Configured paths are canonicalised** like targets, so an 8.3 or junction spelling
  of `primary` or `worktreeMark` in the config still matches. The test tmpdir is no
  longer pre-resolved, which had masked this on `windows-latest` (8.3 short profile dir).
- **Config shape is validated.** A wrong-typed field or list element is dropped with
  a loud `WARNING` (stderr plus `systemMessage`), the rest stays enforced, and no
  usable repo entry falls to the loud malformed fail-open. A missing primary is kept
  and warned about.
- **Drive-relative and rooted-relative targets denied** (`C:..\src\x.ts`, `\src\x.ts`,
  `/c/…`), as they resolve against the writer's cwd. `\??\` is handled like `\\?\`.
  A segment of only dots/spaces no longer lets a following `..` cancel the wrong
  segment.
- **`MultiEdit` and `NotebookEdit` are guarded** (matcher now
  `^(Write|Edit|MultiEdit|NotebookEdit)$`), and the INACTIVE `systemMessage` and
  stderr line both name all four.
- **Folder rules read only below the checkout root.** `exemptDirs`, `codeDirs` and
  `scriptDir` ignore the folders a checkout sits in: a primary under a `docs` folder
  no longer exempts its code, and one under a `src` folder no longer treats
  `LICENSE` or `.gitignore` as code.
- **Config path pinned to the OS account.** The config is read from
  `os.userInfo().homedir`, so `USERPROFILE`/`HOME` cannot relocate it; a
  `--config <absolute path>` argument in the hook's own registration is the only
  override.
- **Plain relative targets resolve against the hook's cwd**, so a relative
  `src\x.ts` from the primary is denied (the pre-alias hook allowed it).
- **Over-long targets denied, and every path is judged fast.** A target longer than
  the Windows maximum of 32,767 characters is denied. Below it, a long run of dots or
  spaces, or a deep not-yet-created tail, decides in well under a second; before, it
  could outrun the hook's time limit, which lets the write through.
- **Control characters denied.** A target containing NUL or any other character
  below 0x20 is denied as an invalid path; a NUL had let `…\src\x.ts\0.md` pass as
  markdown.
- **`--config` given twice is a broken registration**: loud INACTIVE, like a
  malformed config, instead of the first value winning silently.
- **A planted or oversized `.git` or `HEAD` is denied fast.** The guard reads at most
  4 KB of the `.git` file, `HEAD` and a rebase `head-name`, and parses the `gitdir:`
  line in one pass; a larger file is an unreadable branch, so DENY. Before, a 50 KB
  whitespace run in `.git` took seconds, and a timed-out guard lets the write through.
- **An oversized config is a loud INACTIVE.** A config file over 64 KiB is treated as
  malformed instead of being parsed for longer than the hook's time limit.
- **`--config=<path>` works** like `--config <path>`; the two forms count together, so
  giving both is the "given twice" error.
- **README:** Cutover rewritten (running the plugin and a `settings.json` entry
  together runs the guard twice; the entry to remove is given) and a Known
  limitations section added.
- Windows-only CI workflow (`windows-latest`) and a zero-dependency `node:test`
  suite that self-skips off Windows and on volumes/accounts lacking 8.3 or symlink
  capability.

### Notes

- There is deliberately **no environment-variable override** of the config path or
  of any rule (a bypass vector); that includes `USERPROFILE`/`HOME`.
- A nested repo under `.claude\worktrees\<name>` that is not a real linked worktree
  but names an allowed branch is allowed: the guard is branch-keyed (see Known
  limitations).
- Branch-resolution failure on an auto-worktree falls back to **deny**.
- The hook has no sibling imports, so the single-file-copy deployment behaves
  identically to the plugin deployment.
