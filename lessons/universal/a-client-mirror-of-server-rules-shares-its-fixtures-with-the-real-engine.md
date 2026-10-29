---
id: a-client-mirror-of-server-rules-shares-its-fixtures-with-the-real-engine
title: A client-side mirror of server validation rules drifts unless one fixture table runs against both the mirror and the real engine
scope: [universal]
requires: {}
status: active
since: 2026-10-26
provenance: [contrib-2]
corroborated: 1
---
A client pre-check that predicts what the server will refuse (to skip a doomed network call and name the reason) silently drifts when either side changes.

**How to apply:**
- Keep ONE fixture table: input, expected accept or refuse, rule id.
- Two tests read it: a unit test runs the mirror per row; an emulator test runs the same rows against the real rules engine. Every rule id needs a refuse row, every target an accept row.
- Mirror only stateless rules. State-dependent ones (existing document, monotonic fields, post-write size) stay with the server's own refusal path.
- A fixture-only change must still trigger the emulator test.
- The mirror is never stricter than the server; an unpredicted refusal is reported as drift.
- Hold a locally refused record with its reason; never drop it.

Related: [[firestore-rules-pre-merge-checklist]], [[subtract-confirmed-units-from-a-shared-outbox]].
