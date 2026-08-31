---
id: recursive-delete-follows-a-reparse-point
title: A recursive delete through a POSIX-emulation shell can descend INTO a Windows junction and empty its target
scope: [env:windows]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
Windows directory junctions and directory symlinks are reparse points. Native Windows tooling generally treats them as links and removes the link. A POSIX-emulation shell on Windows can treat one as an ordinary directory instead — so a recursive force-delete descends into it and deletes the contents of the TARGET, which usually lives somewhere else entirely and is not the thing you were cleaning.

The common shape: a dependency directory (`{{DEPS_DIR}}`) is a junction pointing at a shared cache or a sibling checkout to save disk. A routine "clean the workspace" recursive delete then empties the shared cache, and every other consumer of that cache breaks with an unrelated-looking error some time later.

**Why:** The link is invisible in an ordinary listing, and the delete succeeds — the blast radius is entirely outside the directory you named, so nothing in the command's output hints at what happened. Deletes are also the one operation where "follow the link" is never what anybody wanted, which is exactly why the difference goes untested.

**How to apply:**
- **Dissolve reparse points non-recursively FIRST**, then delete the directory. Remove the link itself (a non-recursive directory removal, or the platform's link-removal verb), confirm it is gone, and only then recurse.
- Detect them before deleting anything recursive in a workspace you did not create: list the directory with the attribute that reveals reparse points and check for `<JUNCTION>` / `<SYMLINKD>` entries.
- Prefer the native shell's recursive remove for Windows paths — it removes the link rather than its target — over the emulation shell's, whose semantics depend on how the layer was compiled ([[bash-tool-routes-to-wsl]] is the neighbouring hazard: which shell you actually got is not always the one you asked for).
- In automation, never recursive-delete a path supplied by configuration without asserting it is a real directory on the expected volume.
