---
id: guard-coverage-enumerate-issuing-surfaces
title: A tool-call guard polices the agent's own calls, not commands declared in configuration — enumerate every surface that can issue the banned call
scope: [agent-process]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
A pre-tool-use guard intercepts calls the AGENT makes. It does not police commands declared inside configuration — hook definitions, status-line commands, editor tasks, scheduler entries — because those are executed by the harness, not requested through the guarded tool. So a rule can be correctly written, correctly enforced, and still violated dozens of times a day through a surface the guard never sees.

The incident: a box had a hard deny on a particular shell for the agent's own tool calls, added after that shell's runtime starved the machine. The ban held. Meanwhile four separate configuration files invoked the same shell by bare name — a global status-line command firing on EVERY session start, a permission-request hook, and two project hooks on high-frequency tool events. On a machine where that shell's binary existed but its directory was not on the search path, while a same-named system stub WAS, every one of those resolved to the stub, which opened a console window to report the runtime was missing. The ban was in place; the problem recurred anyway, on a surface outside the guard's reach.

**Why:** A guard's coverage surface is narrower than the rule it enforces, and the gap is invisible from inside the guard — it logs only what it sees, so its logs look clean. The gap widens after a machine migration, because configuration written for an environment where the interpreter existed keeps invoking it by bare name in an environment where the same name resolves to something else entirely.

**How to apply:**
- When banning a tool, shell, or command class on a machine, audit BOTH surfaces: the tool-call guard AND every configuration file that can declare a command — global settings, per-project settings, per-workspace settings, status lines, scheduler and process-manager entries.
- **Pin the absolute interpreter path in every config-declared command**, or port the script to an interpreter the environment definitely resolves correctly. A bare interpreter name is resolved by the search path at execution time, by whatever binary happens to win — a decision made on a different machine than the one you wrote it on.
- Sweep for ORPHANED scripts left behind by a migration. Files referenced by nothing are inert, but they carry the same assumption and reintroduce it the moment something rewires them.
- A hidden-window flag on the spawn does not save you: an interactive installer stub can defeat it and present a console anyway.
- Related: [[guard-hooks-deny-teach-ack]] (how to build the guard) and [[migrated-config-carries-source-host-env]] (why the config still describes the old machine).
