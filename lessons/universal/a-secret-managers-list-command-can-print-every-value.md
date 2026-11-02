---
id: a-secret-managers-list-command-can-print-every-value
title: A list or inspect command can print every secret value — a briefed filter is not a control
scope: [universal]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 2
---
Some CLIs return secret values in their list or inspect output: a secret manager's list, a process manager's list/show/env (each app's full environment, tokens included). "Run it and filter to names" protects nothing: if the filter breaks, every value lands in the transcript. Incidents: a verify agent printed a full private key; a filtered one-liner hit a byte-order mark, failed to parse and echoed its raw input, environment included.

**How to apply:**
- Never brief an agent to run such a command raw, filtered or not.
- Check through a script file that runs the command itself, prints only named fields and, on any error, prints one fixed line, never the input.
- Prefer commands known to be metadata-only.
- If a value leaks, say so plainly and recommend rotation; that call is the owner's.

Related: [[an-ephemeral-instance-can-print-a-first-run-secret]], [[credentials-never-reach-an-error-path]].
