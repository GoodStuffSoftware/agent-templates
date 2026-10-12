---
id: classify-by-the-import-graph-and-fail-closed-on-unknown-shapes
title: A path-based "ops only, skip the heavy gate" classifier must follow the import graph, diff without rename detection, and fail closed on shapes it cannot read
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A pre-push classifier maps changed files to the tests they affect: docs and tooling skip the end-to-end suite, everything else runs it. Four fail-open gaps, found in one hook:
- `scripts/` was treated as ops, but the build config and the E2E global setup IMPORT files from it. "Directory means ops" is false for those.
- A rename from an app path into an ops path showed only the new path, hiding the deleted app file.
- A rebased branch diffed against the OLD upstream, re-judging commits already gated.
- The allowlist in the hook and the classifier in the script were two definitions that drifted.

**How to apply:**
- Keep an explicit list of build-imported files that always classify as run-everything, and add a DRIFT test that re-derives it from the real import graph.
- Diff with `--no-renames` so both sides of a rename appear.
- Where a script key is reached by the test run (the dev-server command, its pre/post hooks, chained runs), read it from the test config; if the config is not one narrow shape you can parse (spreads, multiple arguments, later mutation, unexpanded globs or variables), return "unknown" and classify as run-everything.
- Add a sync test so the hook's allowlist and the classifier cannot say different things.
- For a behaviour-neutral change that is mis-classified, add a targeted SKIP rule in the same branch (it applies to its own push) instead of bypassing the hook.

Related: [[a-gate-that-exists-vs-a-gate-that-covers]], [[exempt-the-generated-field-not-the-file]].
