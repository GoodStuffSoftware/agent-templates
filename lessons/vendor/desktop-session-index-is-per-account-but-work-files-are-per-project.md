---
id: desktop-session-index-is-per-account-but-work-files-are-per-project
title: The Claude desktop session index is partitioned per account, but the work files are keyed by project path — a switch looks like data loss and is not
scope: [vendor:anthropic]
requires: { harness: claude-desktop }
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Desktop-app UI state can be partitioned per signed-in account while the actual work product is partitioned per project path. The two schemes do not match, so an account switch would look like data loss when it is not.

The desktop app keeps its Code-tab session INDEX (sidebar list, titles, archive state) under `%APPDATA%\Claude\claude-code-sessions\{{ACCOUNT_UUID}}\{{ORG_UUID}}\` on Windows, and `local-agent-mode-sessions` is split the same way. Signing into another account makes the app read a different folder, so earlier sessions drop out of the sidebar — but they are not deleted.

The work product is keyed by PROJECT PATH and stays usable whichever account is signed in: transcripts (`~/.claude/projects/<cwd>/*.jsonl`), auto-memory, `CLAUDE.md`, skills, plugins and settings. Account identity lives in `~/.claude.json` (`oauthAccount`), credentials in `~/.claude/.credentials.json`.

**How to apply:**
- **Anything that syncs or backs up Claude state should treat the desktop session index as account-partitioned** (do not expect it to be complete or stable across switches) and **must never copy credential files**.
- **After an account switch, recover "missing" sessions from the transcripts** (CLI resume from inside the project directory) rather than editing the app's session-index store.
- **`claude.ai`-side state** (connectors, cloud sessions, Remote Control, scheduled routines, Artifacts, chat memory) belongs to the signed-in account and does not carry over on a switch at all — genuinely a different account's data, not merely hidden.
- **`CLAUDE_CONFIG_DIR` set per profile** separates ALL local state per profile, splitting history across profiles — a different mechanism from the per-account sidebar partitioning.

**Evidence level:** the per-account folder layout was verified on disk (MEASURED). That the sidebar visibly empties after a switch is inferred from that layout (INFERENCE), not observed with a second account signed in.

Related: [[scope-a-broken-finding-to-the-measured-path]].
