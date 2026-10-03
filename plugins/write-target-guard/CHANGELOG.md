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
- Windows-only CI workflow (`windows-latest`) and a zero-dependency `node:test`
  suite that self-skips off Windows and on volumes/accounts lacking 8.3 or symlink
  capability.

### Notes

- There is deliberately **no environment-variable override** of the config path or
  of any rule (a bypass vector).
- Branch-resolution failure on an auto-worktree falls back to **deny**.
- The hook has no sibling imports, so the single-file-copy deployment behaves
  identically to the plugin deployment.
