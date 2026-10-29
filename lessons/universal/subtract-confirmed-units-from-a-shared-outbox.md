---
id: subtract-confirmed-units-from-a-shared-outbox
title: A flush owns only what the server confirmed — subtract confirmed units from the live outbox, never overwrite it with a snapshot
scope: [universal]
requires: {}
status: active
since: 2026-10-26
provenance: [contrib-2]
corroborated: 1
---
A flush that reads its outbox once, awaits the network, then writes a snapshot-derived queue back wipes whatever was enqueued meanwhile. And one write the server will never accept, in an all-or-nothing batch, holds every record behind it, including the error report that would name it.

**How to apply:**
- Remove an entry only after the server confirms it AND it still equals what was sent. Unequal, or a failed comparison, means keep and re-send (idempotent), never drop.
- Change the live queue by synchronous read-modify-write; one flush at a time per process.
- On a non-retryable batch failure, split in halves until rejected units stand alone; ack the rest, quarantine and report the rejected. A transient failure stops the flush, dropping nothing.
- Send error reports from a leg no poison can block.

**Incident:** records stayed stuck behind one rejected write until this invariant was written down.
