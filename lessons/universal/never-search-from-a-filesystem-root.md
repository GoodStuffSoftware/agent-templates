---
id: never-search-from-a-filesystem-root
title: Refuse recursive searches from a filesystem or drive root - an orphaned one runs for hours and starves the box
scope: [universal]
requires: {}
status: active
since: 2026-11-23
provenance: [contrib-2]
corroborated: 1
---
An agent that runs `find / -name x` to locate a file can lose its parent: the call times out, the shell dies, and the search keeps a full core busy for hours (three orphans in one day). A scheduler that counts that load as external CPU then holds a large queued job, and under strict FIFO everything behind it.

**How to apply:**
- Add a rule or pre-tool-call guard refusing recursive searches or listings rooted at `/`, a drive root or the home directory; point to the file-search tools or a scoped path.
- If a scheduler admits work by free CPU, show the external-load block in its status so a stall explains itself.
- A force-kill may report success while the process lingers briefly; re-check.
