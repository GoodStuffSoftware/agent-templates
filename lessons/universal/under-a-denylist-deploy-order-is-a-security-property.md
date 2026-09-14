---
id: under-a-denylist-deploy-order-is-a-security-property
title: Under a denylist, deploy order is a security property — and a correct instruction with a false reason is worse than none
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
A spec's deploy note said a new server-trusted field was "admin-only either way, so there is no client-facing window", and justified its rules-before-code ordering as mere tidiness. It was false. The policy had no key **allowlist** — only a **denylist** of fields the record's owner may not write — so any field not named in that list was fully client-writable. The policy deploy was the only thing making the field admin-only. Shipping the writing code first would have opened a live self-grant window on a paid entitlement, repeatable from throwaway accounts until the cap drained. A reviewer proved it by deleting the field from the denylist and watching every deny assertion flip to "expected this request to fail, but it succeeded."

**The rule:** when an authorization policy protects fields by naming what callers may NOT write rather than what they MAY write, every field not yet named is writable by default. A "server-only" field is server-only only from the moment its policy entry is **deployed** — not from the moment it is committed. So **deploy the policy before the code that writes the field.** Reversing it opens a window in which clients can forge the field themselves, and the window is invisible in code review, because the repository shows policy and code landing together.

**Check for this whenever adding a field to {{POLICY_FILE}}:** does the rule enumerate permitted keys, or merely forbidden ones? Confirm by DELETING your field from the denylist and re-running the negative tests — if they still pass, they were never testing your field ([[assert-the-guard-saw-something]]).

**Two traps observed alongside it:**
- **A parity test between a constant and the policy FILE proves nothing about the DEPLOYED policy.** Those are different artifacts, and the gap between them is exactly the deploy-ordering window. If you need the guarantee, assert against the live policy ([[a-checkout-is-not-the-running-system]]).
- **Create and update paths can carry different preconditions.** A field may be adequately guarded on update yet plantable on create, where fewer clauses apply — often by a brand-new account, the cheapest attacker to be.
- **Rules-first stops future writes; it does not remove an already-planted value.** A value planted before the policy landed becomes load-bearing the moment the reading code deploys. Audit for existing occurrences read-only before the code deploy, with a baseline field proving your query shape can detect a present field at all.

**The second, sharper kernel: a correct instruction paired with a false justification is more dangerous than no instruction**, because the justification is what a future engineer reasons from when deciding whether the instruction still applies. When you correct an ordering instruction, correct its REASON too, and say plainly what the old reason claimed and why it was wrong ([[correct-a-durable-record-explicitly]]) — otherwise the discredited rationale gets reconstructed from memory and the safeguard is dropped as pointless.

Related: [[gate-the-write-not-the-aftermath]], [[externally-asserted-fields-are-not-self-reportable]], [[ship-the-safe-handle-first]].
