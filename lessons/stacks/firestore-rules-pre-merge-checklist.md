---
id: firestore-rules-pre-merge-checklist
title: Firestore rule changes require an explicit identity-binding and schema-drift review before merge
scope: [stack:firestore]
requires: { stack: firestore }
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Any change to Firestore security rules requires a pre-merge checklist covering: (1) identity binding — every non-admin write rule must bind the write to the authenticated user's uid; (2) schema drift — rule field names must match the actual schema written by the application; (3) admin bypass audit — any admin clause must use the same identity check as the rest of the codebase; (4) backward compat under rollout — if the new rule tightens what was previously accepted, account for old-client writes during the rollout window; (5) rules test coverage — positive and negative cases must exist in the test suite.

**Why:** Firestore rule bugs are completely silent — they don't throw TypeScript errors, don't fail lint, and often don't fail positive-path tests. A missing identity binding allows any authenticated user to vandalise records they don't own. A typo'd field name either makes a rule always pass or always fail. These bugs can exist in production for weeks or months before being discovered. A rule change with passing positive tests and clean lint is still entirely unsafe without this review.

**How to apply:**
- Add this checklist to the reviewer agent's definition and to CLAUDE.md for any project using Firestore.
- Treat any checklist item failure as a blocker — not a nit. Firestore rules are a security boundary.
- Write both a positive test (legitimate write succeeds) and at least one negative test (impersonation, unauthorized field, over-limit write) for every rule you add or change.
- Deploy rules changes separately from app changes and verify the rules are live before deploying the app: `firebase deploy --only firestore:rules`.
- **(4) backward compat, refined)** An ADDITIVE-ONLY rules change — for example, denying writes to a subcollection or field that no shipped client has ever written to — is safe for old clients without a minRequiredVersion bump. The general test to apply at review time: a rules change is only unsafe for old clients when it NARROWS something a live client actually exercises. So enumerate what shipped clients actually write (grep the client codebase for the write calls, don't infer from the rule text), not what the new rule text theoretically covers — a rule can look broad while the population of real writers it affects is empty. See [[a-whole-document-cap-freezes-pre-existing-data]] as the counter-example: there, a seemingly narrow addition (a cap on a field size) froze existing records precisely because clients *were* already writing that field, past the new limit, and the check was evaluated against the whole document rather than the diff.
