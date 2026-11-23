---
id: pin-spawned-test-credentials-away
title: A unit test that spawns a repo script must hand the child no credentials, no home directory and an empty cwd
scope: [universal]
requires: {}
status: active
since: 2026-11-23
provenance: [contrib-2]
corroborated: 1
---
A CLI-entry test spawned a data-writing script with the parent's environment. The script defaulted to a gitignored key beside itself; in the main checkout that was a live staging key, so the test ran the real job. Worktrees and CI lacked the key and passed. Tell-tale: fails only in the main checkout.

**How to apply:**
- Route every test spawn through ONE helper: empty temp cwd; scrub credential-shaped variables (cloud credential paths, emulator hosts, production gates, TOKEN/SECRET/PASSWORD/API_KEY names, `GIT_*`, SSH agent socket); point HOME and CLI config dirs at empty temp dirs; hide console windows.
- Pass guaranteed-missing key paths via the script's own flags; prove it with dummy keys at every default path.
- Script side: a writing command requires an explicit project flag, checked against the key's project id before the SDK loads, plus a production confirm variable.
