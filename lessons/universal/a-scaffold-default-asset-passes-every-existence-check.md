---
id: a-scaffold-default-asset-passes-every-existence-check
title: A scaffold's default asset passes every existence check — verify provenance, and never allowlist a new default
scope: [universal]
requires: {}
status: active
since: 2026-10-26
provenance: [contrib-2]
corroborated: 1
---
A store build shipped the scaffolding tool's placeholder app icon, with default splash images beside it. No pipeline step produced the icon, and every check asked only whether a file existed, which the scaffold guarantees. The submitter and the review gates passed it; the owner noticed the store page.

**How to apply:**
- For each user-visible asset (icon, splash, name, screenshots) name the step that PRODUCES it from one master source.
- Add a guard that fails if an output is missing or byte-identical to a known framework default (keep the defaults' hashes).
- Run it where the artifact is built and where it is pushed, so no path skips it.
- An allowlisted default carries a date and a tracked follow-up; a new default is never allowlisted.
- After submitting, read the asset back from the store's API.

Related: [[a-green-deploy-is-not-a-live-feature]], [[verify-at-destination-prove-the-target]].
