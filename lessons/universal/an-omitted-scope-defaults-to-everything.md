---
id: an-omitted-scope-defaults-to-everything
title: An omitted permission scope is an affirmative grant of everything — read back what the create call actually made
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A scheduled cloud agent was created through an API with no connector list specified. It came back with EVERY connector on the account attached — mail, file storage, calendar, an internal operations bus — and its tool allowlist did not remove them. An agent meant only to write prose from a file had mail access.

**Why:** the dangerous direction of a default is rarely documented. An optional field reads as "leave it out if you don't need it," but for a provisioning call the safe-sounding omission commonly resolves to maximum privilege, not minimum, because the platform has to pick some behavior for the unset case and "attach nothing" would break the common case of "just give me my usual setup." Omission is a decision the platform makes for you, not an absence of one.

**How to apply:**
- After any create call that provisions an identity, a runner, or an integration, READ THE CREATED OBJECT BACK and assert the scope you intended — explicitly clearing or enumerating attachments rather than relying on omission.
- Treat "the field was optional" as a reason to set it, not a reason to skip it.
- Check inherited environment separately from attached integrations — a runner that inherits an environment's variables can hold credentials the task never needed, even when its integration list is correctly scoped.
- When the platform's default cannot be narrowed at create time, narrow it immediately after with a follow-up call, and verify that follow-up took effect the same way — by reading the object back again, not by trusting the response of the narrowing call.

Related: [[an-omitted-worker-tier-inherits-the-leads]] (the same shape in the cost domain: an omission is an affirmative decision, and the default is the expensive one), [[assert-the-resolved-value-not-the-declaration]], [[a-pushed-workflow-can-read-repo-secrets]], [[persist-the-secret-before-the-artifact]].
