---
id: reload-connector-tools-by-toggling
title: A running session keeps a connector's old tool list - toggle the connector off and on, do not ask for a refresh
scope: [agent-process, vendor:anthropic]
requires: {}
status: active
since: 2026-11-23
provenance: [contrib-2]
corroborated: 1
---
When a remote connector's server gains tools in a deploy, sessions already open keep the list they loaded. A refresh in the connector settings did not change it, and the session's reconnect tool refuses a connector that reports "connected". Servers that declare `listChanged: false` cannot push the change.

**How to apply:**
- First confirm the server's own `tools/list` shows the new count.
- Do not ask the operator to refresh or reconnect, and do not start a new session.
- Switch the connector off for this session and end the turn; then switch it on and end the turn. The new tools appear after about 15 seconds.
- The off switch can also become the default for new sessions until switched back on, so keep the gap to one turn.

Prevention instead of cure: [[freeze-one-dispatcher-tool-so-features-need-no-reconnect]].
