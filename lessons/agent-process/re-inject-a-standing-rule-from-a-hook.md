---
id: re-inject-a-standing-rule-from-a-hook
title: A rule in a document is read once; a rule in a hook arrives when it is earned
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
"I have rules all over and they stop being followed" is a structural complaint, not a discipline one. A standing instruction in an always-loaded file is read at position zero and then competes with every token that follows it; by mid-session it has lost. The fix is not a louder rule or a third copy — it is re-injection at the moment the rule is relevant, from a hook that runs every turn. Anything that must hold for a whole session and cannot survive on attention alone belongs in the harness, not in prose.

The incident: a project kept restating the same handful of standing rules across a CLAUDE.md, a skill, and an agent definition, and still watched sessions drift past them once the transcript grew long enough to bury the original text. The rules themselves were fine; the delivery mechanism — read-once, at the top — was not built to survive a long session.

**Why:** a document is loaded once and then sits, unchanged, at the bottom of the context stack while newer tool results and reasoning pile on top of it. A hook, by contrast, runs fresh on every turn and can choose, each time, whether to say anything at all.

**How to apply:**
- **Split a rule's condition in two — TEXT and STATE.** A text condition (a pattern over the prompt, or over a worker's brief) asks "is this turn about X?"; a state condition asks "is this session in a state where the rule is worth its tokens?". Keeping them separate is what makes an always-on rule affordable — the rule that fires on every single turn costs nothing until its state gate is satisfied.
- **Gate the nag on evidence the enforcement layer already collects.** A guard that nudges the main thread after N consecutive execution-class tool calls already knows whether this session has drifted, so have it record a COUNT rather than a flag and let the reminder read it. The result is silent in a well-behaved session and repeats every turn in one that actually misbehaved; a constant reminder is a tax everyone learns to skim, an adaptive one arrives exactly when it has been earned and keeps arriving while the behaviour lasts.
- **A self-healing injection must check whether its own earlier injection landed, not re-run blindly.** Where a pre-spawn hook rewrites a worker's brief and a start-of-worker hook can also inject context, the second should look for its own marker in the prompt the worker ACTUALLY received and stay silent when it is there — that converts a belt-and-braces duplicate into a repair that fires only when the primary path failed. This is doubly true when the feature exists to reduce token cost, since one that pays its own tax twice refutes itself.
- **Ship the probe that proves the feature is LIVE, not merely installed.** A canary that runs the real hook as a child process and asserts the injected marker appears in the rewritten input catches the failure that matters — a feature that is present, configured, and doing nothing. Validate the canary by deliberately neutering the production path and confirming it goes red ([[a-silent-guard-needs-a-canary]]).

Related: [[slim-always-loaded-instructions]], [[knowledge-routing-ladder]], [[adjust-a-shared-accumulator-by-delta]], [[guard-hooks-deny-teach-ack]].
