---
id: no-install-through-a-shared-node-modules-link
title: Never install into, or remove a worktree holding, a dependency directory that links to another checkout's install
scope: [universal]
requires: {}
status: active
since: 2026-11-23
provenance: [contrib-2]
corroborated: 1
---
A worktree's `{{DEPS_DIR}}` is sometimes a junction or symlink to the main checkout's install. `npm ci` empties its install directory first, and `git worktree remove` descends the link: either empties the main install and breaks every worktree linked to it. The resulting module-not-found failures look like product bugs.

**How to apply:**
- Never run `npm ci` or `npm install` in a worktree with a linked `{{DEPS_DIR}}`; remove the link first with a non-recursive removal, then install for real.
- Before `git worktree remove`, list the tree's links (`dir /AL /S /B {{TREE}}`), remove each non-recursively; if one will not come off, leave the tree and report.
- A worktree whose lockfile differs needs its own install, or its tests run against the target's dependencies.
- After a suspected wipe, treat earlier passes through the link as unverified.

See [[recursive-delete-follows-a-reparse-point]].
