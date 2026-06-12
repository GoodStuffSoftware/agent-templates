---
id: windows-home-config-glob
title: On Windows, the agent tool's Glob may not traverse the user-profile config dir
scope: [env:windows, vendor:anthropic]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
On Windows, the agent tool's Glob can return "no files" for the user-profile config directory even though the files plainly exist there. Glob silently under-reports instead of erroring, so it looks like the directory is empty when it isn't.

**Why:** The discrepancy makes you conclude a config file is missing and act on that false negative — re-creating a file that already exists, or skipping a step that should have run. The failure is silent: no error, just an empty result.

**How to apply:**
- When you need to enumerate files under the user-profile config dir on Windows, use an absolute-path read of the known file, or list the directory via the native shell — don't trust a Glob "no files" there.
- Treat a Glob empty-result in that location as "unknown," not "confirmed empty," and verify with a direct read or shell listing before acting.
