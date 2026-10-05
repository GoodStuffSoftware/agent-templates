---
id: desktop-worktree-pin-is-a-separate-guard-from-hooks
title: A desktop app's worktree pin is a separate guard from hooks — give same-repo parallel writers their own isolated worktree
scope: [vendor:anthropic]
requires: { harness: claude-desktop }
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Parallel writer subagents spawned from a lead session were refused when they tried to Write/Edit in a pre-created, deliberately named sibling worktree of the same repo ("belongs to a different worktree"). The refusal was reported as `permission-rule` even though every PreToolUse hook had already returned allow, so it looked like a hook deny and was debugged as one.

**The pin.** The desktop app pins a session to its own auto-worktree, and every non-isolated subagent inherits that pin. Write/Edit into any OTHER worktree of the SAME repo is refused, surfacing as `permission-rule` after hooks have already allowed it. Check the guard before suspecting a hook. A worktree in a DIFFERENT repo is unaffected.

**Fix.** Give same-repo parallel writers `isolation: "worktree"`, and have each worker run `git switch -c <type>/<scope> origin/{{BASE_BRANCH}}` as its first step, so it works on its own branch inside the worktree it was handed. A pre-created named sibling worktree in the same repo cannot be written by a non-isolated worker however it was set up.

**Anti-pattern: a fallback in the brief for a refused write.** "If Write/Edit is refused, edit through Bash/node" turns a correct refusal into a complete bypass of the guard. A refusal means the write target is wrong. The brief should say: stop and report to `{{LEAD_SESSION}}`, do not route around it.

**Related hook lesson.** A write-target guard that classifies `.claude/worktrees/*` by PATH alone denies deliberately named worktrees. Key on the worktree's actual branch instead:
- read `<root>/.git` to find the gitdir, then read its HEAD, spawning no git process;
- allow named work-branch prefixes (`feat/`, `fix/`, `docs/`, `chore/`);
- deny `claude/*`, detached HEAD, and anything unreadable (fail closed);
- normalise `..` segments BEFORE any prefix check, or a traversal out of an allowed worktree borrows that worktree's allowance.

Related: [[cowork-auto-worktree-detection]], [[a-worktree-isolated-writer-can-remove-a-peers-worktree]], [[write-target-in-initial-brief]].
