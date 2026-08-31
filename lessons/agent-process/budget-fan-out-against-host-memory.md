---
id: budget-fan-out-against-host-memory
title: Budget agent fan-out width against the host's memory, not just against the task — the damage surfaces as "flaky tests" somewhere else
scope: [agent-process]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 2
---
Each concurrent agent is a full OS process with its own footprint (a few hundred MB is typical). Deciding how wide to fan out is therefore a resource decision as much as a parallelism one, and on a constrained host the two answers differ sharply.

What makes this hard to catch is that the damage does NOT land in the agent layer. It lands wherever the machine is asked for something it no longer has:

- tests that spawn real subprocesses or shell out
- anything reading a file another process is still writing
- operations with a fixed time budget
- external process/system queries

These fail NONDETERMINISTICALLY, which reads as "flaky test." So the investigation starts at the test, and the test is fine.

The incident: an orchestrator fanned out a large number of parallel agents on a memory-constrained laptop. Later, an unrelated task's pre-push gate failed three times. The first two failures were one spec hitting a hardcoded timeout; the third was two *different* specs failing in two *different* modes — one reading an empty log file a piped child process should have written to, the other reporting that 2 of 5 external-process queries had genuinely errored rather than run slow. Three diagnostic rounds went into the tests and into hunting orphaned processes from a previously documented leak. Only then did anyone measure the machine: under half a gigabyte free, with the agent fleet itself the single largest consumer.

**Why:** the session that widened the fan-out is usually the one debugging the symptom, and it has no view of its own footprint. Contention is also not confined to one repo — a concurrent test run from a *different* project on the same box produces an identical signature, so "no orphans found" does not mean "not contention."

**How to apply:**
- **Diagnostic order.** When a subprocess-spawning or I/O-timing test fails nondeterministically, measure free memory BEFORE reading the test. If free memory is low, stop investigating the test — free resources and retry.
- **The distinguishing tell.** A *timeout* is consistent with a merely fragile budget. An *error return* from an operation that normally succeeds — a query that fails outright, a file that is empty rather than late — means the resource was absent, not slow. Two different failure modes across two unrelated specs in one run is a host signal, not a test signal.
- **Green in isolation, red in the suite = contention.** Run the single failing file alone before reading its diff at all.
- Treat "several unrelated things got flaky at once" as evidence about the machine before it is evidence about the code.
- Before a wide fan-out, check free memory; on a constrained host prefer sequential batches over maximum concurrency. The ceiling is the host's, not the task's.
- **Size from AVAILABLE capacity, not installed capacity.** A planner that divides total RAM by a per-worker estimate produces a constant — it cannot see the other fleet, the other project's suite, or the browser. The same formula against *free* memory produces a number that moves with the machine, which is the whole point. This holds for any automated width decision: worker counts, batch sizes, connection pools.
- When every member of a fan-out fails identically rather than some of them, stop blaming capacity — that distribution is a shared-singleton signature ([[lockstep-failure-means-shared-singleton]]).
- The durable fix is on the test side too: a hardcoded millisecond budget that only passes on an idle box is a latent failure, not a measurement — see [[measure-gates-under-normal-load]].
