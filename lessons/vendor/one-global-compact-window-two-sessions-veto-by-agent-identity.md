---
id: one-global-compact-window-two-sessions-veto-by-agent-identity
title: One global auto-compact window serves the main session and every subagent — veto the main session's early compaction from a plugin hook keyed on agent identity
scope: [vendor:anthropic]
requires: { harness: claude-code }
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A window small enough to keep long-lived subagents cheap makes the main session compact far earlier than it needs to; a window large enough for the main session lets subagents grow past the point where their cache cost pays. A plugin hooks module (a function hook named under `modules` in `hooks/hooks.json`, beside classic command hooks) can answer `{ skip: reason }` on `session.compact` when the trigger is `auto`, there is no `agentId` (main session) and context tokens are below a floor, and call `next(e)` otherwise.

**Gotchas measured on a 2.1.28x build:**
- The skip reason must START with "Compaction blocked by PreCompact hook", or the "skipped" toast is not suppressed.
- Context tokens from the session-usage call describe the MAIN session even inside a subagent's compaction, so gate subagents on `e.agentId`, never on that number; it also lags one turn.
- `$.clock.now()` is a Promise (an un-awaited call fails silently); `$.fs` has no append, so cap a read-modify-write log. A helper that receives `$` must be a top-level function declaration or `claude plugin validate` refuses it.
- The veto repeats every turn below the floor: log once at the first veto, never per call.
- Status line and `/context` still show "until auto-compact" against the global window.
- Modules are gated by a rollout flag and by `--bare`, `disableAllHooks`, `allowManagedHooksOnly`: fail open.
