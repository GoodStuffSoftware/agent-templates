---
id: a-secret-managers-list-command-can-print-every-value
title: A secret manager's list command can print every value — a briefed filter is not a control
scope: [universal]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
Some secret-manager CLIs return each secret's value in their list output, not only its name and date. Briefing an agent to "run list and filter to names" protects nothing: if the filter breaks, every value lands in the transcript and the model's context. Incident: a verify agent printed a full private key that way minutes after it was generated.

**How to apply:**
- Never brief an agent to run list or get on a secret store, filtered or not.
- For existence and date checks, run a script file that drops the value field inside the process before printing, or use the setup tool's own verify-only mode.
- Prefer commands known to be metadata-only.
- If a value leaks, say so plainly and recommend rotation; that call is the owner's.

Related: [[an-ephemeral-instance-can-print-a-first-run-secret]], [[credentials-never-reach-an-error-path]].
