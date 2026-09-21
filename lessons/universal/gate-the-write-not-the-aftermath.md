---
id: gate-the-write-not-the-aftermath
title: A check that runs after the thing it gates is decoration — assert before the write, and verify the call ORDER before the deploy
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 2
---
When a script resolves a known-shape conflict automatically — a keep-both union of a changelog's unreleased section, a merged config, a regenerated manifest — every safety check must run on the **resolved text in memory** and **gate** both the write and the commit. A check placed after the write cannot prevent anything; at best it reports on damage already done.

The incident: a placement check threw a false positive *after* the file had already been written. The shell's error handling did not stop the branch the check lived in, so the merge was added, committed and pushed anyway. The union happened to be correct. The process was not — and the same script would have committed a wrong resolution just as cheerfully.

**Why:** an auto-resolver is written happy-path-first, and the assertions get appended at the end where the resolved file is easy to read from disk. That ordering feels natural and is exactly backwards. Compounding it, a failed assertion inside a conditional branch does not always abort the script the way the author assumes — so the "gate" is not even a gate for the caller.

**How to apply:**
- **Build → assert → write → add → commit**, in that order, with **no auto-commit path reachable past a failed assertion**. If the assertion cannot be expressed against the in-memory text, the resolution is not automatable yet.
- Assert three things about a merge resolution: no conflict markers survive; **every** line that came from a conflict region lands inside the intended section; and everything **outside** that section is byte-identical to the base revision.
- **Never prove placement by grepping the whole file for the new content's keywords.** Frozen history contains every word you will pick, so the grep passes for a resolution that put the text in entirely the wrong place. Assert the untouched region is identical to `{{BASE_REF}}` instead — that is a statement nothing else can satisfy accidentally.
- Verify your error handling actually aborts from wherever the check sits (inside a conditional, inside a function, inside a subshell). Test it by forcing the assertion to fail once and confirming nothing was committed ([[assert-the-guard-saw-something]]).
- Related: [[union-merge-eats-shared-closer]] and [[green-means-not-broken]] — a syntactically valid resolution in the wrong order passes every gate you own.

**The same gap shows up one altitude higher, between pipeline steps rather than inside one script.** A release verification tool gained a new channel, marked required, meant to refuse a production promotion outright when it failed. It refused nothing: the deploy script invoked verification AFTER the deploy step had already run, so a verification failure produced a distinct "deployed but unverified" exit code instead of blocking anything. The channel existed, was marked required, and its own code comment claimed it blocked the promotion — only actually executing the real command chain, rather than reading the diff, proved otherwise.

**How to apply (continued):**
- Make "does this actually block?" a reviewer's headline question for any new gate added to an existing pipeline, and answer it by reading the invocation chain end to end and then RUNNING it — never by reading the diff that introduces the check in isolation.
- Wherever a check is added to an existing pipeline, require the reviewer to state, explicitly, the call order they verified (what runs before the check, what runs after, and what happens on each outcome) — a described intent to block is not evidence of an enforced order.
- Related: [[an-open-ticket-is-not-clearance]] (a different way a gate can look satisfied while nothing was actually cleared) and [[a-guard-that-reads-ambient-state-is-not-reading-the-target]] (a gate that runs at the right time but checks the wrong thing).
