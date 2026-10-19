---
id: a-stopped-task-handle-may-leave-its-process-running
title: Stopping a background task handle may leave its script running — and a replace-style edit does not reach a running instance
scope: [agent-process, vendor:anthropic]
requires: { harness: claude-code }
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
The harness's stop action on a backgrounded shell script can report success while the script's shell process keeps running. A replace-style edit (`sed -i` writes a new file) does not reach an instance already running; it keeps executing its old text, whereas a truncating rewrite may. Incident: stale lock-waiter loops, one started before a yield step was added with an in-place edit, took a shared lock ahead of the queue it was meant to yield to.

**How to apply:**
- After stopping a background script, check the process list filtered on its command line; if alive, stop that PID and its tree, your own PIDs only, never by image name.
- When a lock or queue protocol changes, sweep and restart every running waiter. Editing the file is not deploying it.
- Prefer one supervised entry point to hand-rolled waiters.

Related: [[never-kill-processes-by-image-name-on-a-shared-machine]], [[a-timeout-kills-the-root-not-its-children]], [[background-agents-die-with-their-host]].
