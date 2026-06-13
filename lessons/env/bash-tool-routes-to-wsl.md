---
id: bash-tool-routes-to-wsl
title: On Windows, the Bash tool routes to WSL — use the PowerShell tool for native Windows operations
scope: [env:windows, vendor:anthropic]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
In the agent on Windows, the Bash tool routes to WSL (`/usr/bin/bash`), not to a native Windows shell. Any Bash tool call on a machine where WSL is not already running will wake the WSL VM — which competes with native processes (dev servers, build tools, test runners) for CPU and RAM. Use the PowerShell tool for all shell operations on Windows, or use the dedicated file tools (read, edit, create, grep, glob) which accept Windows paths directly.

**Why:** A Bash tool call that boots WSL during a CPU-intensive operation (test suite, Android build, gradle compile) caused a confirmed multi-hour test-starvation incident on a real project. The contention is not obvious — the WSL VM and the native processes share CPU fairly, but a test runner that expects to use N cores now only gets N/2. The failure looks like a slow machine, not like a WSL conflict. The Bash tool also mangles Windows paths (it strips backslashes from `C:\Users\...`), so commands targeting native paths fail outright.

**How to apply:**
- On Windows projects, add to every agent's rules: "Use the PowerShell tool, not the Bash tool."
- For file operations (read, search, find, edit), prefer the dedicated tools over shell commands regardless of which shell.
- If a command genuinely requires bash syntax (a shell one-liner using POSIX tools), use the Bash tool only after confirming WSL is already running and the operation is not CPU-contention-sensitive.
- PowerShell 5.1 gotchas: no `&&` operator (use `;` + `if ($?)`), default encoding is UTF-16 LE (pass `-Encoding utf8`), use `Get-CimInstance` not `Get-WmiObject` for fresh process data.
