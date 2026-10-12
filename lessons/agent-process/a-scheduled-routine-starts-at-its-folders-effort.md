---
id: a-scheduled-routine-starts-at-its-folders-effort
title: A scheduled routine starts at the effort of the folder it was created in — pin effort per folder and rate a dispatch-only parent as light
scope: [agent-process, vendor:anthropic]
requires: { harness: claude-code }
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
Scheduled runs started at the user-level default effort, so a routine that only spawned one worker and relayed its result ran as expensively as the heaviest routine. The scheduler tools take no folder, model or effort argument, and editing the scheduler's task store while its app runs is overwritten from memory.

**How to apply:**
- A routine inherits the settings of the folder it was created from. A folder carrying `{{FOLDER}}/.claude/settings.local.json` with `{"modelSettings":{"{{MODEL_ID}}":{"effortLevel":"{{LEVEL}}"}}}` sets its start effort.
- Keep one pinned folder per level; create the task from a session opened in the folder with the level the routine needs.
- Rate the parent and its worker separately: a parent that only dispatches one worker and relays the result is light work and runs low. Name the worker's tier in the prompt.
- Optional: a non-blocking pre-tool hook on the scheduler's create/update tools can print an advisory (current folder, its pin, the start effort). Fail open and make it switchable.

Related: [[an-orchestration-leads-effort-is-part-of-its-sizing]], [[an-omitted-worker-tier-inherits-the-leads]].
