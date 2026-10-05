---
id: tests-must-not-write-machine-global-or-live-process-state
title: Tests must not read or write machine-global caches or live-process files — isolate them to a per-run temp and prove it with a sentinel
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Two tests, found independently, reached outside their fixtures. One spawned the real hook against a throwaway fixture without overriding the path of a machine-global cache, so it read (and in another test WROTE, via an inherit hit) a file shared by every worktree's real pushes: hundreds of entries with other sessions writing within the last hour. The other imported a script whose top level starts a watcher; every suite run created a log, wrote its own pid into the live watcher's pidfile and unlinked it on exit, clobbering a genuine running process.

**How to apply:**
- **Grep the test tree for every module that reaches a path outside the repo** (one level up, home, shared temp names) and point it at a per-run temp via the module's own override; confirm no production change was needed.
- **Import-time side effects need a partial filesystem mock** for exactly those paths, delegating the rest.
- **Verify with a planted sentinel:** hash and mtime unchanged after the run, and break the mock's path matcher to show the sentinel DOES get clobbered, which proves the test would notice.
- **Report honestly if the symptom you expected to remove never reproduced;** the isolation gap can still be worth closing on its own.

Related: [[never-test-in-a-live-deployment-tree]], [[an-inherited-env-var-beats-the-child-cwd]], [[neutralize-ambient-env-in-negative-tests]].
