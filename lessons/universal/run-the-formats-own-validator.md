---
id: run-the-formats-own-validator
title: Copying a working example is not validation — a working example only proves ITS OWN feature subset
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1]
corroborated: 1
---
Authoring a schema-bound artifact — a manifest, a config, a workflow file, a package descriptor — by copying the shape of a known-good one from the same ecosystem is a reasonable way to *start*. It is not a way to *check*.

The incident: a published extension manifest was rejected at install time as invalid. It had been modelled on a working, installed extension. But the reference did not use the one optional section the new manifest needed, so the field that was wrong had nothing in the reference to be compared against — the error was structurally invisible. The toolchain had shipped a `validate` subcommand the whole time. Running it took one second and named the exact field and the exact reason.

**Why:** A working example is evidence about the features it exercises and about nothing else. Copying one hands you a plausible artifact with zero coverage of anything the example did not use — and those are precisely the parts you are least able to inspect, because there is no line to compare against. Plausibility is the failure mode, not a defence against it: the artifact looks right, which is why nobody validates it.

**How to apply:**
- Before shipping any schema-bound artifact, look for the format's own first-party `validate` / `lint` / `check` command and run it. The cost is seconds; the failure it prevents lands on users, not on you.
- Treat *"I based it on a working example"* as an unverified claim, not as verification. Say which of the two you did.
- Wire the validator into the project's CI or audit step so the check cannot regress into "we ran it once".
- If no validator exists, the substitute is not a second example — it is the published schema, read against your artifact field by field, with the optional sections your example omitted marked as unchecked.
- Same root shape as [[grep-the-shipped-artifact-not-the-docs]] and [[probe-behaviour-not-version-stamps]]: trusting a plausible secondary source while an authoritative one sits locally, one command away.
