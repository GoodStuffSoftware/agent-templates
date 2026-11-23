---
id: recursive-delete-follows-a-reparse-point
title: A recursive delete through a POSIX-emulation shell can descend INTO a Windows junction and empty its target
scope: [env:windows]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 2
---
Windows junctions and directory symlinks are reparse points. A POSIX-emulation shell can treat one as an ordinary directory, so a recursive force-delete descends into it and empties the TARGET, which lives somewhere else. Incident: a dependency directory (`{{DEPS_DIR}}`) was a junction to a shared cache; a "clean the workspace" delete emptied the cache and every other consumer broke later.

**Why:** The delete succeeds and nothing in the output hints at the blast radius.

**How to apply:**
- Remove reparse points non-recursively FIRST (the link itself), confirm it is gone, then recurse.
- Before a recursive delete in a workspace you did not create, look for `<JUNCTION>` / `<SYMLINKD>` entries.
- Prefer the native shell's recursive remove for Windows paths ([[bash-tool-routes-to-wsl]] is the neighbouring hazard).
- In automation, assert a configured path is a real directory first.
- Second shape: removing a worktree whose dependency directory is a link ([[no-install-through-a-shared-node-modules-link]]).
