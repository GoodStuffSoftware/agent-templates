---
id: lockstep-failure-means-shared-singleton
title: When every parallel instance fails identically, suspect a shared singleton — not exhaustion
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
Read the **distribution** of a multi-instance failure before reading any resource gauge. The two candidate causes have different signatures:

| Observation | Signature of |
|---|---|
| `{{SOME}}/{{N}}` failed, order-dependent, varies between runs | a resource ceiling — memory, handles, file descriptors, quota |
| `{{N}}/{{N}}` failed, identically, at the same point | a contended singleton — a lock file, a registry/locator keyed by a shared id, a fixed port, a lease |

Resource ceilings are probabilistic: some workers get the resource and proceed, others do not. A singleton takes down every participant the same way.

The incident: a parallel test harness booted N sandbox instances; all N failed to become ready. It was diagnosed as a memory ceiling, because the host genuinely was low on free RAM. It was not. The instances all share one lock/registry file keyed by a common project identifier, and a previously killed run had left that file pointing at a dead process — so every new instance died on it. The low free RAM was a coincidence that made the wrong theory look corroborated. The tool had even printed a message naming the real cause ("it seems you are running multiple instances…"), which was quoted verbatim in the failure report and read past.

**Why:** A gauge that independently looks bad is not confirmation — it is a coincidence competing for your attention, and it is most seductive when it is genuinely true. The failing tool's own message outranks an environmental reading, because the tool knows why it refused and the gauge only knows what it measured.

**How to apply:**
- Count the failures before theorising. `{{N}}/{{N}}` is a lock signature; anything short of it is a ceiling signature.
- Read what the failing tool actually printed, and grep for the branch that emits it, before trusting any environmental number — see [[read-which-error-fired-before-theorising]].
- **A run killed mid-startup cannot run its own exit cleanup**, so it strands exactly these singletons. After any killed run, clear the stranded artifact before retrying — and only after confirming no live process still holds it.
- The inverse reading is [[compare-siblings-outlier-is-the-fault]]: when one of N misbehaves, the outlier names the fault; when all of N do, the thing they share does.
- If a resource ceiling really is in play, budget against **available** capacity rather than total — see [[budget-fan-out-against-host-memory]]. But establish that it is in play first.
