---
id: migrated-config-carries-source-host-env
title: Config and daemon state copied from another host still describes that host — read identity from the live system
scope: [universal]
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 1
---
A process-manager state dump, a service unit, a scheduler export, an env file — anything copied or migrated from one machine to another — carries the source machine's baked values: hostnames, machine-identifying environment variables, absolute paths, user names. The processes still start, so nothing announces the staleness, and the artifact keeps confidently describing a machine you are not on.

That matters most to whoever reads it next. An agent or operator inspecting the artifact to answer "where am I / what is this box" gets the *previous* box's answer, and then either concludes the environment is misconfigured and "fixes" values that were never wrong, or makes a host-conditional decision on a false premise.

**Why:** Migrated state is trusted precisely because it works. It survived the move, the services came up, so it reads as current — but only the parts the runtime actually exercises were validated by that move. Descriptive fields (host name, machine env, recorded paths) are inert: nothing dereferences them, so nothing corrects them, and they persist indefinitely as authoritative-looking evidence about the wrong machine.

**How to apply:**
- Read host identity from the live system, never from a config artifact's baked values. If a decision branches on which machine you are on, resolve that from the OS at the moment you branch.
- When migrating daemon or scheduler state between hosts, regenerate it on the target where the tool supports that, rather than copying. Where you must copy, audit every absolute path, hostname, and baked env var in it.
- Annotate the migrated artifact itself with a line saying where it came from and which of its values are known-stale — the next reader is the one who needs it ([[record-intentional-absence]] is the same discipline applied to removals).
- Pairs with [[diagnose-the-right-process]]: confirm the live thing before you diagnose it, whether "the thing" is a process or the host.
