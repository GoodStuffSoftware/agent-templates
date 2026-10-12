---
id: a-bare-bash-resolves-to-the-wsl-launcher
title: On Windows a bare bash resolves to the WSL launcher whenever Git's dirs are not ahead of System32 — and npm shims start with env bash
scope: [env:windows]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
`#!/usr/bin/env bash` is the shebang of npm's extension-less `npx`/`npm` shims. If a hook runs with Git's `/usr/bin` missing from PATH, or behind `C:\Windows\System32`, `env` finds System32's `bash.exe` and a git hook silently starts WSL (or, with no WSL, opens a console reporting it is not installed). Observed cause: a harness shell snapshot saved PATH in Windows form, and a few snapshots lost `/usr/bin`; git's `mingw64/bin/git.exe` does not re-prepend it for hooks. The WindowsApps alias directory holds a second WSL `bash.exe`.

**How to apply:**
- Any PATH workaround must PREPEND Git's dirs, ahead of System32 and the WindowsApps alias dir. Leave a PATH that needs no repair byte-identical.
- Source one guard script at the top of every hook, before any npm/npx call; make it fail loudly unless bash resolves to `/usr/bin/bash` or `/bin/bash`, and test it.
- Fix the machine too: a PATH-guard file loaded through the harness's env-file setting plus a pinned Git Bash path, so agent shells never lose the order.
- Do not assume a ban on a shell also covers hook definitions ([[guard-coverage-enumerate-issuing-surfaces]]).

Related: [[bash-tool-routes-to-wsl]].
