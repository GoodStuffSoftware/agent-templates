---
id: a-maintenance-write-fires-the-same-triggers
title: A maintenance write fires the same triggers a user action does — close the granting switch before you migrate
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
A backfill stamped one new field onto a set of user records. Those writes fired the ordinary on-write trigger, which granted two promotional entitlements and **sent two thank-you emails to real addresses**. A later attempt to revert the backfill fired it again and sent two more. Nothing in the migration mentioned promotions; the trigger did not care.

**The kernel: a datastore trigger sees a write, not an intention.** Backfills, migrations, repairs, and reverts are indistinguishable from user activity at the trigger boundary — including triggers with outward-facing side effects that cannot be undone.

**The corollary that catches people twice:** *undoing* the grant is also a write. Deleting the marker field re-fires the same trigger and re-grants, under the currently deployed code. There is no read-only way out once the switch is open.

**How to apply:**
- **Before any bulk write to a collection, enumerate its triggers** and ask what each one does on an unconditional write — not what it does on the path you are thinking about.
- **Close the granting switch first** (a flag the trigger checks, at the data layer), run the write, verify the counters and the send log are unchanged, then reopen. Prove the closure with a canary write, not by reading the code.
- **In environments where nothing should ever be granted, close it permanently** rather than per-migration.
- **Prefer a backfill that does not need to touch the triggering collection at all** — a sibling document, or deriving at read time ([[derive-at-read-time-over-storing]]).
- **Treat outward-facing side effects as the blocking concern.** A double-granted entitlement is recoverable; an email to a real external person is not ([[gate-the-write-not-the-aftermath]]).

Related: [[a-read-that-opens-an-edit-is-a-write]], [[trigger-follow-up-work-off-durable-state]], [[bulk-edit-success-log-is-not-evidence]].
