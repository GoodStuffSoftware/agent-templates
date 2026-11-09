---
id: key-a-loop-breaker-on-the-build-not-the-version
title: Key a reload-loop guard on the build identity, not the version string, and give it a TTL
scope: [universal]
requires: {}
status: active
since: 2026-11-09
provenance: [contrib-2]
corroborated: 1
---
A client that reloads itself to pick up an update arms a guard first, so a bad reload can't loop. If the guard records only the version that armed it, a redeploy of the same version (a different build) leaves it armed for the tab's life and every later update falls back to the manual path.

**How to apply:**
- Record build identity: version plus the content hash of the entry script.
- On boot, clear the guard when a different build is running; keep it when the same build boots again (that is the loop case).
- Add a TTL backstop for a guard no reload ever consumed.
- Fail toward self-healing: an empty stamp counts as live, a future stamp (clock moved back) as expired. Neither can loop, because a reload re-arms with the current time.

Related: [[a-probe-that-proves-accept-does-not-prove-persist]], [[latch-once-only-guards-after-success]].
