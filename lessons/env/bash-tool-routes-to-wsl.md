---
id: bash-tool-routes-to-wsl
title: The Bash tool is whatever shell the harness spawns — Git Bash when Claude Code runs natively on Windows, WSL only when the harness itself runs inside WSL
scope: [env:windows, vendor:anthropic]
requires: { harness: claude-code, os: windows }
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
The Bash tool is not bound to one shell on Windows — it is whatever shell the harness process itself spawns. When the harness runs INSIDE WSL, Bash routes to WSL (`/usr/bin/bash`), and a call on a machine where WSL is not already running wakes the WSL VM, which then competes with native processes for CPU and RAM. When the harness is installed NATIVELY on Windows, Bash is Git for Windows' MSYS2 bash — it never touches WSL. An earlier version of this lesson generalized the first case into a universal claim about "the Bash tool on Windows"; that was a fact about one machine's harness placement, not about the tool.

**Why:** Case 1 (harness inside WSL) — a Bash tool call that booted WSL during a CPU-intensive operation (test suite, Android build, gradle compile) caused a confirmed multi-hour test-starvation incident on a real project. The contention was not obvious — the WSL VM and the native processes share CPU fairly, but a test runner that expects to use N cores only got N/2. The failure looked like a slow machine, not a WSL conflict. Bash there also mangled native Windows paths (stripped backslashes from `C:\Users\...`), so commands targeting native paths failed outright.

Case 2 (harness native on Windows, measured 2026-09 after a machine migration) — the Bash tool is Git Bash, not WSL. Measured on that box: Git Bash ran routine git/grep/file glue calls roughly 2.5x faster than the equivalent PowerShell 5.1 invocation, at roughly 1/8 the resident memory, and the WSL VM never woke for any Bash call across the measurement window. Carrying case 1's rule ("avoid Bash on Windows") forward onto this box would have thrown away the faster, cheaper path for no reason — the two cases need opposite guidance.

**How to apply:**
- Before writing any rule about "the Bash tool on Windows," prove which shell the tool actually spawns on this machine — `uname -s` from inside a Bash call, the spawned executable's path, and its parent process. Don't inherit a rule written for a different box.
- Re-measure after any machine migration or harness reinstall — the harness's own placement (native vs. inside WSL) is what decides this, and that placement can change silently.
- For file operations (read, search, find, edit), prefer the dedicated tools over shell commands regardless of which shell is behind Bash.
- If the harness runs inside WSL and a command genuinely requires bash syntax, use the Bash tool only after confirming WSL is already running and the operation is not CPU-contention-sensitive.
- PowerShell 5.1 gotchas: no `&&` operator (use `;` + `if ($?)`), default encoding is UTF-16 LE (pass `-Encoding utf8`), use `Get-CimInstance` not `Get-WmiObject` for fresh process data.
