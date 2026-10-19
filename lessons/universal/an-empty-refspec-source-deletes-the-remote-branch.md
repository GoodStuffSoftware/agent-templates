---
id: an-empty-refspec-source-deletes-the-remote-branch
title: An empty refspec source deletes the remote branch — write literal shas, and read the remote back after every push
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
`git push <remote> $SHA:refs/heads/<branch>` with `$SHA` empty becomes `:refs/heads/<branch>`, which DELETES the remote branch. It happened on a shared integration branch when a command-rewriting hook wrapped the line and dropped a variable set earlier in the same command; the branch was gone for minutes, and no history was lost only because other writers were paused.

**How to apply:**
- Use literal shas and paths in refspecs and in any command that may be wrapped, never a variable set earlier on the same line; `${VAR:?}` turns an empty one into an error.
- After every push to a shared branch, `git ls-remote <remote> <branch>` and compare.
- Wrapper authors: run the original command line unchanged, and refuse empty-source refspecs without an explicit destructive-git acknowledgement.

Related: [[guard-hooks-deny-teach-ack]], [[windows-shell-layers-mangle-your-arguments]].
