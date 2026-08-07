---
id: agent-filesystem-overlay-hides-failed-installs
title: Never run an installer for the user — a sandboxed agent's package writes can land in an overlay the user's shell cannot see
scope: [agent-process]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
When an agent's shell tool runs inside a filesystem overlay, a package install performed by the agent can succeed *for the agent* and never reach the real disk. The installer prints "added {{N}} packages"; afterwards a path test, a which-style lookup, a file glob, and even RUNNING the binary all succeed from inside the agent session — while the user's own shell reports "not recognized" or a module-not-found error, because nothing was written where they can see it.

Two hard findings from the same day: the failure is completely invisible from the agent's side, so it is naturally misdiagnosed as a search-path problem and costs several turns of shims and absolute paths; and disabling the sandbox did NOT fix it. On the same machine, with every environment fingerprint identical to the user's shell, the installed command existed for the agent and not for the user. Editor-style file writes DID persist; shell package installs did not.

**Why:** Every existence check available to the agent reads through the same overlay that absorbed the write, so the agent's evidence is perfectly self-consistent and perfectly wrong. This is the [[verify-at-destination-prove-the-target]] failure in its purest form — the check is honest and aimed at a target that is not the one that matters.

**How to apply:**
- **Do not run installers for the user. Give them the command to run.** A complete copy-paste block, starting with the directory change, is the deliverable.
- **An agent-side reinstall can DESTROY a working user install**: the installer removes the real package first, then writes the replacement into the overlay. If the user's binary worked and then stopped, suspect your own concurrent install before anything else.
- Never run an installer while the user is actively using that binary.
- Do not accept agent-side existence checks as proof the tool exists FOR THE USER — path tests, command lookups, globs and executing the binary all read the overlay. Ask the user to run the verification.
- Tell-tale to recognize instantly: works for you, "not recognized" for them → overlay, not search path. Stop shimming.
- Read-only analysis can stay sandboxed; this concerns writes that must persist outside the session.
