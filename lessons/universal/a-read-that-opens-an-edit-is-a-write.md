---
id: a-read-that-opens-an-edit-is-a-write
title: A read that opens a server-side edit session is a write — quiesce your monitors during a mutation window
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
Some third-party APIs have no plain read. To inspect the current state of a resource you must **open an edit**, list from it, and delete it — and any other client's edit on the same resource can invalidate an edit already in flight. Under that model a dashboard refresh, a status poller or a "what is live?" tool is not an observer. It is a concurrent mutator, and it can kill a deploy.

The incident: a store upload built its artifact fine, then failed with `Invalid request - This Edit has been deleted.` The target track was untouched, and a plain retry ninety seconds later succeeded end to end. The only other activity in the window was an orchestrator's deployment-matrix refresh, which re-reads that same track through `edits.insert → tracks.list → edits.delete` on every **forced** refresh — and two forced refreshes were issued during the upload. Every long-idle client had closed its edit in a `finally`; the collision came from the tool nobody counted as a writer.

**Why:** the mental model of "reads are safe to run any time" is imported from every ordinary API and is wrong for edit/transaction-scoped ones. The tool's own name reinforces the error — a status or state tool sounds read-only — and the failure surfaces on the *mutating* side, so the innocent-looking poller is never suspected.

**How to apply:**
- Read the API's model before classifying a tool as read-only. If inspecting requires opening a session, transaction, draft or edit, that tool **mutates** and belongs under the same concurrency rules as a deploy.
- While a mutation is running — locally or on a remote orchestrator — do not call the forced-refresh, validate or dry-run tools that touch the same resource. A tool that reports only your own **run status** is genuinely safe; one that reaches the third party is not.
- Never run two mutating workers against the same external resource at once. Sequence them, and say so in the runbook.
- On an "edit has been deleted"-class error: verify the target is unchanged, **retry once**, and only investigate if it recurs with no concurrent client. Treating a benign collision as a defect costs more than the retry.
- Related: [[lockstep-failure-means-shared-singleton]] and [[one-canonical-deployer]].
