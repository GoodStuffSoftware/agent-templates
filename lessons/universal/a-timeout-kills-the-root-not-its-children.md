---
id: a-timeout-kills-the-root-not-its-children
title: A test timeout kills only the root process — its survivors hold the fixture and the cleanup error replaces the real failure
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A test ran a real hook under a synchronous spawn with a timeout. On a loaded box the run overran, the runtime killed only the shell at the root, and everything after misreported the cause: the hook's surviving children kept the fixture directory as their working directory, so the `finally`-block delete threw EPERM and REPLACED the real failure, while the empty trace read as a behaviour regression.

**How to apply:**
- Run the child asynchronously with a deadline timer that kills the WHOLE TREE (`taskkill /T /F` on Windows, a process group on POSIX) while the root is still alive; a synchronous spawn cannot, because the root is already dead when it returns.
- Fail loudly: `timed out after {{N}} ms in test {{NAME}}` with stdout and stderr tails, and check `res.error` and the signal explicitly.
- Make fixture cleanup retry EPERM/EBUSY and warn instead of throwing.
- Write the root pid to a file, so an outer backstop can reap the tree if the runner itself is killed. Size that backstop's slack for the runner's own boot under starvation (45 s was too short, 90 s held).
- Derive the framework's per-test timeout from the hang-guard budget so the two cannot drift apart, and test the harness: a deadline reports `timedOut` and a grandchild dies.

Related: [[load-sensitive-tests-bound-the-mechanism-not-the-process]], [[never-kill-processes-by-image-name-on-a-shared-machine]].
