---
id: migrated-config-carries-source-host-env
title: Config and daemon state copied from another host still describes that host — read identity from the live system
scope: [universal]
requires: {}
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 3
---
A process-manager state dump, a service unit, a scheduler export, an env file — anything copied or migrated from one machine to another — carries the source machine's baked values: hostnames, machine-identifying environment variables, absolute paths, user names. The processes still start, so nothing announces the staleness, and the artifact keeps confidently describing a machine you are not on.

That matters most to whoever reads it next. An agent or operator inspecting the artifact to answer "where am I / what is this box" gets the *previous* box's answer, and then either concludes the environment is misconfigured and "fixes" values that were never wrong, or makes a host-conditional decision on a false premise.

The same staleness has a louder second form: migrated state that names a RUNTIME the new machine does not have. A desktop app restored from backup carried one entry in its persisted session store pointing at a remote-target environment that existed only on the old machine. On every activation of that tab the app "preflighted" the stored target by spawning the runtime's command-line tool; the new machine had only the operating system's installer stub for it, which presents an interactive console — defeating the hidden-window flag the app spawned with. The fix is retiring the stale state entry, not installing a runtime the machine never needed.

**Why:** Migrated state is trusted precisely because it works. It survived the move, the services came up, so it reads as current — but only the parts the runtime actually exercises were validated by that move. Descriptive fields (host name, machine env, recorded paths) are inert: nothing dereferences them, so nothing corrects them, and they persist indefinitely as authoritative-looking evidence about the wrong machine.

**How to apply:**
- Read host identity from the live system, never from a config artifact's baked values. If a decision branches on which machine you are on, resolve that from the OS at the moment you branch.
- **A credential file is identity-bearing: copying it to another name does not re-scope it.** A service-account key carries the identity of the environment that ISSUED it, so placing a copy at the filename a resolver expects for a *different* environment produces an artifact that authenticates as the original — and fails while LOOKING configured. That is the worst version of this failure: file-present reading as credential-works is what let one production environment sit broken for fifteen hours behind an all-green panel. **Derive the filename from the credential's own declared identity, never from where you want it to be used**, and verify by making one authenticated call and confirming which environment answers.
- When migrating daemon or scheduler state between hosts, regenerate it on the target where the tool supports that, rather than copying. Where you must copy, audit every absolute path, hostname, and baked env var in it.
- Annotate the migrated artifact itself with a line saying where it came from and which of its values are known-stale — the next reader is the one who needs it ([[record-intentional-absence]] is the same discipline applied to removals).
- **When an app repeatedly spawns a missing runtime's installer or stub after a migration, suspect migrated per-app state before blaming configuration or the app.** Search the app's data directory (binary-aware, cache directories excluded) for markers of the old machine's runtimes — old hostnames, distribution paths, container or remote-shell target names — and cross-check the hits against the app's own index of stored items. Retire the stale record (archive or quarantine it; do not delete) rather than installing something the new machine never needed.
- **Diagnostic ladder for "what spawned this transient window":** (1) run a watcher that polls the process table for the suspect executable at a few-hundred-millisecond interval and captures its command line plus PARENT AND GRANDPARENT *at first sight* — parents may exit within seconds, so resolve the chain immediately, log as one JSON object per line, and auto-exit shortly after the first capture; (2) string-search the app's binaries and bundles for the spawn call to learn its arguments and gating conditions; (3) binary-aware search of the app's data directories for target markers, cross-referenced against the app's own list API to identify the exact stale record.
- Pairs with [[diagnose-the-right-process]]: confirm the live thing before you diagnose it, whether "the thing" is a process or the host. Config-declared commands are also a guard blind spot after a migration — see [[guard-coverage-enumerate-issuing-surfaces]].
