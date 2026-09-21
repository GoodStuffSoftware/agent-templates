---
id: a-copy-only-sync-resurrects-what-you-deleted
title: A local quarantine does not hold while a copy-only sync still has the file remotely
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Moving a bad file out of a live, synced store does not remove it — it only removes your local copy. If the sync tool pushes with a copy operation that never deletes on the remote, the remote copy survives your quarantine and comes back on the next pull.

The incident: a stale application-state file was moved out of the live store specifically to stop a side effect it was triggering. Weeks later it was back, carrying its ORIGINAL modification time — not a freshly rewritten one — because the roaming sync tool in the pipeline pushes with a copy-only operation that never deletes on the remote side. A later pull mirrored the remote copy straight back into the local store, undoing the quarantine with no local action at all.

**Why:** "copy-only" sync tools are chosen specifically because they are safe against accidental remote deletion — but that same property means a LOCAL deletion is invisible to them: from the tool's point of view, nothing changed on the remote, so nothing needs re-syncing. The tell that you're looking at a resurrection rather than a fresh write is the modification time: a file whose mtime predates your quarantine action did not come back from something writing it anew, it came back from a mirror faithfully restoring what was already there.

**How to apply:**
- Fix it on BOTH sides: either move the remote copy to a quarantine location too, or produce a genuinely newer local version (for example, by writing the state through the application itself) so a newest-wins sync policy overwrites the stale remote copy instead of being overwritten by it.
- Verify that any exclude/ignore setting for the sync tool is actually being CONSUMED — one investigated instance had an exclude rule declared in configuration that the tool never read, which quietly defeated the intended protection.
- Record the quarantine somewhere the next session will look before moving on — an unrecorded deliberate removal reads to the next person as an accident to be fixed ([[record-intentional-absence]]).
- Before concluding the file "came back different" or "came back the same," normalize your comparison (line endings, whitespace) so you're comparing content, not artifacts of the diff tool — [[normalize-before-declaring-difference]] — and remember that opening the file to inspect it can itself count as a write in some sync-aware editors ([[a-read-that-opens-an-edit-is-a-write]]).
