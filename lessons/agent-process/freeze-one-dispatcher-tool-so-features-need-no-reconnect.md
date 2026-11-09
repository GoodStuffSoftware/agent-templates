---
id: freeze-one-dispatcher-tool-so-features-need-no-reconnect
title: Give a connector one frozen dispatcher tool so new features need no reconnect
scope: [agent-process, vendor:anthropic]
requires: {}
status: active
since: 2026-11-09
provenance: [contrib-2]
corroborated: 1
---
Some hosts (claude.ai custom connectors, for one) cache a connector's tool list and input schemas at connect time. A new tool or a changed input schema stays invisible until the user refreshes or reconnects it. An agent can't trigger that, and a running session keeps the list it started with. Output-only changes need no refresh.

**Technique:** expose one frozen tool, `{{SERVER}}_run`, with input `{action: string, args?: free-form object}`. Its description never lists actions; it says to call action `help`. Back it with one registry where every existing tool is also an action, sharing its handler and validator. New features are `actionOnly` entries: they appear in `help` and dispatch, never in `tools/list`, so no reconnect is needed.

**Trade-off:** the host no longer sees per-action schemas, so validate inside the dispatcher.

Related: [[tool-listing-is-scope-filtered]].
