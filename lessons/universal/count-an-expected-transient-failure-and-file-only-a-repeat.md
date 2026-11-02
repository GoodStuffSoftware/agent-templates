---
id: count-an-expected-transient-failure-and-file-only-a-repeat
title: Count an expected transient failure instead of filing it — file only the repeat
scope: [universal]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
A client that files an error report for every failure reopens the same production issue group over expected events: one failed update check, a device that is offline, a lazy chunk that did not load. The fix, used three times in one app, is a named counter for the expected case instead of a filed error.

**How to apply:**
- Count the first network-type failure since the last success; file the second consecutive one (after the retry cooldown, so it was a real retry that also failed) and every later one. A success resets the run.
- Only network-type failures count: a 404 or certificate failure is not transient and files at once.
- Do not count while the app is already reloading, since that failure is the reload's own.
- Keep the counter visible so a rise is still noticed.
