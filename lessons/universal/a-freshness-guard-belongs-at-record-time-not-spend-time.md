---
id: a-freshness-guard-belongs-at-record-time-not-spend-time
title: A freshness guard belongs where the pass is RECORDED, not where it is spent — and strictness should be asymmetric by cost
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 2
---
When an expensive check writes "this passed" into a cache, and a cheaper gate later spends that cache entry to skip re-running the check, the freshness invariant ("what was tested equals what ships") can only be enforced at the moment the entry is WRITTEN. Checking it again at spend time is a delayed, lossy proxy — the artifact that ships is an immutable commit, and local working-tree state at spend time says nothing about what the tree looked like when the expensive check actually ran.

The incident: an expensive test suite recorded a content-hash pass into a cache; a pre-push hook spent cache entries to skip re-running the suite. To protect the freshness invariant, the hook gated the fast (cache-hit) path on a clean working tree at PUSH time. That guard was in the wrong place in both directions: a tree that was dirty during the actual test run but clean by push time let a misattributed pass through unchecked — the actual hole — while a tree that was clean during the run but dirty by push time burned a full suite re-run for nothing, the visible complaint that got it noticed. Meanwhile the write site, where the invariant is actually decidable, had no check at all.

**Why:** it is tempting to put a freshness check wherever the fast path lives, because that is where skipping the suite happens and where the risk feels concentrated. But the property being protected — "the suite ran against exactly this content" — is only true or false at the moment the suite runs. A check placed anywhere else is measuring a proxy that can drift in either direction between the two moments.

**How to apply:**
- Put the freshness assertion at the WRITE site: before recording a pass, confirm the tree the check just ran against is exactly the tree the resulting artifact will ship (no uncommitted changes to tracked content). A record made against a locally-patched tree should never bank a pass at all.
- Make the spend-time check, if you keep one, cheap and narrow — or drop it once the record-time check is solid, since a spend-time freshness check is inherently checking a state that has already moved on.
- **Strictness should be asymmetric by the COST of a false positive at each site**, not uniform. A false positive at record time costs one unbanked pass (re-earned next run, cheap); a false positive at spend time costs a full re-run (expensive). Be strict where a false positive is cheap, permissive where it is expensive — the reverse of what feels intuitively "safer."
- Scope a record-time freshness check to TRACKED, modified content specifically. A persistent untracked file that will never ship should not block banking a pass forever, and untracked content realistically cannot turn a failing tree green the way a locally modified tracked file can.
- Couple the two check sites explicitly (comments, tests) when you rely on the record-time check to justify a loose or absent spend-time one — removing the spend-time guard is only sound while the record-time one still exists.
- Related: [[gate-the-write-not-the-aftermath]] (the same "assert before, not after" principle, applied to a single pipeline rather than to a record/spend pair) and [[a-checkout-is-not-the-running-system]] (a working copy describes what could ship, never what shipped).

**The record-time guard itself has three holes.** (a) Re-deriving the sha, tree or branch at write time instead of pinning them at run start: a commit taken mid-run banks the pass for a sha no completed run tested, and the same re-derivation hits any machine-global ledger that escapes the worktree. (b) Sampling dirt only at run START: on a run of 12 to 25 minutes, an edit to a tracked file mid-run is served by hot reload, the suite goes green, and the green banks for the unedited commit. (c) A mid-run COMMIT leaves the tree clean again, so a dirt comparison sees nothing.

- Pin sha, tree and branch together BEFORE the run and pass the pinned values to the writer; never re-derive at write time.
- Sample the tracked working tree at start AND end, refuse if content differs (naming the paths), and capture the head sha in each sample so a start/end mismatch refuses. Keep the start sample: sampling only at the end refuses on artifacts the run itself created.
- Refresh the index's cached stat data before the dirt probe so a stale cache cannot fake a change.
- See [[every-branch-of-a-gate-decision-refuses-unless-it-positively-banks]] for the decision function itself.
