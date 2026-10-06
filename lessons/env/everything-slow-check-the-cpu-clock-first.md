---
id: everything-slow-check-the-cpu-clock-first
title: When a familiar workload slows by an order of magnitude, read the CPU clock before blaming disk, network, dependencies or neighbours
scope: [env]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A host that installed dependencies in under a minute took 19 minutes, and CI gates went from 9 to 93 minutes. A 4K disk benchmark read 2.4 MB/s (looks like a dying disk); `time` showed huge system-CPU seconds (looks like a CPU-bound workload needing more cores); load average 6 on 4 vCPUs with idle processes (looks like a noisy neighbour). All three were one cause: the CPU was hardware-throttled to roughly 175 MHz against a 1900 MHz base, far below the architectural minimum frequency. Refuted along the way: storage (no page faults, 0% iowait), steal time (0), and oversubscription (user time was about equal to real time, meaning the task held a core and ran slowly; oversubscription shows wall much greater than user).

**Why:** a throttled CPU inflates every measurement that executes instructions, including the tests you would use to rule it out.

**How to apply:**
- **First measurement:** `dd if=/dev/zero of=/dev/null bs=4k count=200000`, which touches no disk, network or memory pressure. Healthy is on the order of 1 GB/s or more; far below that is dispositive. Then compare `/proc/cpuinfo` MHz to `cpufreq/cpuinfo_min_freq`.
- **Second:** re-run an OLD tree that previously ran fast. That separates "the machine" from "the code" in one run and refutes dependency-growth theories.
- **Do not re-run time-boxed gates while the check reads slow;** it burns the timeout again. Treat any throughput figure recorded during the window as suspect.
- **Related hardware tell:** a failure that moves to a different file or error on every run, with clean passes interleaved (lint stack overflows, native access violations), is the machine, not the code. Retry, and verify changed files in isolation.

Related: [[match-instrument-to-failure-class]], [[compare-siblings-outlier-is-the-fault]], [[a-default-timeout-shorter-than-cold-start-manufactures-flakes]].
