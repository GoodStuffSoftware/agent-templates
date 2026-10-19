---
id: a-cli-sanity-check-must-not-leave-an-interactive-session
title: A "does the agent CLI start" check must not leave an interactive session alive — it looks like a human peer
scope: [agent-process, vendor:anthropic]
requires: { harness: claude-code }
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
A worker proving the agent CLI starts, by launching the bare command in a terminal tab that stays open, leaves an interactive session waiting for input. It lives for days, keeps touching its transcript, and any session list keyed on file modification time counts it as a live human session.

**How to apply:**
- Use the non-interactive form (`claude -p "<prompt>"`), which exits when it answers, or do not run the real CLI at all: test the wrapper, the flag parsing or the config.
- Never start the bare command in a tab that stays open.
- After any such check, list processes and tabs and close what you started.
- Code that lists live sessions judges liveness by the newest timestamped record in the transcript, not by file mtime.

Incident: two such sessions sat idle for days and showed as "live".

Related: [[a-subagent-lock-pid-is-the-lead]], [[never-kill-processes-by-image-name-on-a-shared-machine]].
