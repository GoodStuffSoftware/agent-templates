---
id: prove-the-runtime-not-the-error-text
title: Prove the runtime, not the error text — and stamp every environment-dependent rule with where it was measured
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A project banned its agents' shell tool for four months on the strength of one "verification": a native-shell cmdlet typed into that tool failed with `line 1: {{CMDLET}}: command not found`, which was read as proof the tool ran inside a virtualized Linux environment. That output is **identical** under a host-native POSIX compatibility layer, which mounts its shell at the same path. The ban had been true on an earlier machine, where the agent harness itself ran inside the virtual environment; after a hardware migration the tool was native and nobody re-tested.

Measured cost on the new machine: the mandated shell was roughly 2.5x slower per glue call, used about 8x the memory, and errored on roughly one tool call in twelve — with a guard hook hard-denying the faster tool.

**The kernel: a negative result proves the absence of the thing you looked for, never the identity of what you looked in.** Two different runtimes can emit byte-identical error text.

**How to apply:**
- Before a rule says "tool {{TOOL}} runs in {{RUNTIME_A}}", prove it with evidence that DISTINGUISHES A from B: the platform identifier reported from inside the shell, the process's parent chain as the host OS sees it, or the executable path the host actually spawned. "Command not found" and "no such file" distinguish nothing.
- **Stamp every environment-dependent rule with where and when it was measured** ("measured {{DATE}} on {{MACHINE}}"). After a machine migration, harness upgrade, or OS reinstall, the stamp is stale and the rule is a hypothesis again.
- A one-line probe at session start is cheaper than four months of the wrong tool — and far cheaper than a guard hook enforcing a premise nobody has re-checked.
- When you retire such a rule, say in the durable record what the old premise claimed and why it no longer holds ([[correct-a-durable-record-explicitly]]) — otherwise the next session reconstructs the ban from the guard that is still standing.

Related: [[bash-tool-routes-to-wsl]] (the concrete instance of this pair of runtimes), [[migrated-config-carries-source-host-env]], [[probe-behaviour-not-version-stamps]].
