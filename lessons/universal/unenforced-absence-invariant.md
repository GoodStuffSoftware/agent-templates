---
id: unenforced-absence-invariant
title: A comment saying "safe because X is never used" is an unenforced invariant — treat it as a tripwire, not a reassurance
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Somewhere in most codebases is a comment shaped like: "this copies everything verbatim, which is fine — nothing sensitive is stored here today." Or "no-op: we never populate that field." Or "unreachable: that mode is disabled."

Each states a fact about the whole system, records it in ONE local file, and then relies on it forever with nothing enforcing it. It is an invariant with no guard.

The danger is not that it goes stale. Plenty of comments go stale harmlessly. It is that this kind goes stale NON-LOCALLY and INVISIBLY:

- The change that falsifies it happens in a different file, by someone with no reason to read this one. No diff ever shows the assertion flipping.
- The comment then argues AGAINST the inspection that would catch it. Someone who arrives suspicious reads a confident sentence and moves on. A silent hazard is bad; a hazard with a reassuring sign on it is worse.

The incident: a cross-environment data-migration function copied a user's auth claims verbatim between environments, under a comment saying in substance "defensive no-op — no such claims are used today." Accurate when written. A later change introduced a privilege-bearing claim, converting the no-op into a privilege-escalation path: an administrator in a low-trust environment could grant the claim to a fresh account there, migrate that account to production, and arrive with production administrator rights. The migration code had six documented containment controls; every one governed WHICH environment could be written to, and none inspected WHAT was being written. The feature author never opened that file — nothing in their diff pointed at it.

**How to apply:**
1. **When you introduce X, grep for prose that assumes X's absence.** Not just callers, not just types — comments. Search the words, not the symbols: "never", "no-op", "not used", "always empty", "cannot happen". The code that breaks may compile perfectly and contain no reference to your change at all.
2. **When you WRITE such a comment, make it enforceable or make it a denial.** Prefer an allowlist over a denylist so the next addition is safe by default; prefer a test that asserts the invariant over a sentence that asserts it. If you truly cannot enforce it, write it as a WARNING about what would break ("if a privileged field is ever added here, this becomes an escalation path") rather than as an all-clear — the same knowledge, aimed so it alerts the future reader instead of dismissing them.
3. **For reviewers: when a change introduces a new KIND of thing, the blast radius is not the diff.** Ask what else in the system handles that kind generically — copiers, serialisers, exporters, sync jobs, backup and migration paths. Generic machinery is exactly what treats a new privileged thing as just another value.

**Why:** a containment control that constrains the *destination* is not a control on the *payload*. Both are needed, and the payload side is the one that is usually only a sentence.

Related: [[safeguard-the-operation-not-the-entry-point]] (where a check belongs), [[externally-asserted-fields-are-not-self-reportable]] (why claims are the dangerous payload), [[record-intentional-absence]].
