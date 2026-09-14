---
id: a-cli-script-without-a-main-guard-runs-on-import
title: A CLI-style script with no main-module guard runs on import — add the guard before the first test imports it
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A script that doubles as a CLI — argument dispatch at the bottom of the file — and has never been imported hides a landmine: the first test that imports it executes that dispatch **inside the test runner, against the developer machine's real state.**

Observed: a test import of a listener script took a real process lock, read a real credential from the user's home directory, and made a real network call to a production host. No damage only because that credential had already been revoked.

**Rule:** before the first test import of any script under {{SCRIPTS_DIR}}, read its tail for an is-main-module guard. If there is none, add the guard — plus a witness test that a bare import runs nothing — **before** writing the import that needs it.

**And inject the environment.** Tests supply the home directory and the network client; never the real machine. A script that reads its own paths and clients from module scope cannot be tested safely no matter where the guard is.

**Generalization:** any file whose top level performs side effects is a file you cannot import to inspect. The guard is what converts a script into a module, and the conversion belongs to whoever first wants it importable.

Related: [[never-test-in-a-live-deployment-tree]], [[neutralize-ambient-env-in-negative-tests]], [[an-ephemeral-instance-can-print-a-first-run-secret]].
