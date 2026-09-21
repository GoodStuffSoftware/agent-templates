---
id: a-whole-document-cap-freezes-pre-existing-data
title: A size cap evaluated against the whole post-write document freezes every record that predates it
scope: [universal, stack:firestore]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A security rule capped a map field at fifteen keys, evaluated against the WHOLE resulting document rather than against the diff between old and new. Any document already over the cap at the time the rule shipped had every subsequent write refused — including writes that never touched the capped field — and the state could never self-heal, because the one write that would shrink the field back under the cap is itself rejected by the same rule.

The incident: the cap shipped with no migration for existing over-limit data, and stayed invisible for roughly seven weeks. The reason it hid that long is structural, not incidental — the rule engine reports a generic permission-denied with no field named, which reads identically to an unrelated transient failure, a stale auth token, or a flaky connection. Nobody could distinguish "this document is permanently stuck" from "this request happened to fail" from the error alone.

**Why:** a validation predicate written against the post-write resource is a statement about the whole record, while the author writing it is thinking only about the field they just added. Every pre-existing record that already violates the new predicate becomes permanently read-only the moment the rule deploys — not just for writes to that field, but for every write to that document, because most rule engines validate the resource as a unit.

**How to apply:**
- Before introducing any cap or newly-required shape, count the existing population that already violates it. If that count is non-zero, you need a migration before the rule ships, or the field must be excluded from validation until the backfill completes.
- Prefer a predicate over the DIFF ("this write does not increase the field beyond the cap") over one over the final state ("the field is at most the cap") — a diff-based predicate always permits a shrinking write, so a record over the limit can still self-correct.
- When a generic permission error shows up in aggregate error data, bucket it by DOCUMENT before dismissing it as transient noise — a small number of documents erroring on every single write, forever, is a different shape than random failures spread across the population, and averaging hides it ([[read-which-error-fired-before-theorising]]).
- Treat any rule change that narrows what's accepted as requiring the same existing-population check as a schema migration would — the rule engine doesn't distinguish "new" data shape requirements from schema changes, but your rollout process has to.

Related: [[firestore-rules-pre-merge-checklist]], [[a-maintenance-write-fires-the-same-triggers]], [[calibrate-a-bound-against-the-real-distribution]].
