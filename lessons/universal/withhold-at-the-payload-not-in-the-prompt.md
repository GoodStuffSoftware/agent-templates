---
id: withhold-at-the-payload-not-in-the-prompt
title: When a model summarizes mixed public and private data, withhold at the PAYLOAD — never redact in the prompt
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
Asked for a public "what I have been working on" digest with private sources redacted, the obvious build feeds every commit subject to the model and instructs it to hide the private names. Demonstrated against real history, that publishes a production incident and its date, a just-closed vulnerability class, an abuse vector, and key-lifecycle details — while hiding only the repository NAME, which is the least sensitive field in the set.

**Invert it.** Public sources contribute full text. Private sources contribute ONLY derived aggregates — a count, a histogram of conventional-commit types. Read the sensitive text to compute the aggregate, then drop it before the model call. **The model cannot leak what it never received**, so a reworded prompt, a model swap, or a hostile commit message cannot widen the hole.

**The tell:** rich prose and leakage are the SAME property. If the output about a withheld source is vivid, check what you fed it.

**Ship a payload-audit hatch with any such boundary.** An environment flag that prints the exact bytes about to be sent and exits is the only check that actually proves the boundary. It is one conditional block, and it is what a reviewer runs after editing the file. Pair it with a fixture flag that substitutes a canned string for the model call, so the output filter can be exercised — including against deliberately leaky prose — without spending a request.

**A rare-token canary is a backstop, not the guarantee.** Flagging output words that occur only in the withheld corpus catches a future edit that starts forwarding the sensitive text. Tune it for near-zero false positives — drop short words, carry a real common-word list, and fail on two distinct hits OR one long jargon token — because a gate that flags ordinary English fires on every legitimate run and gets deleted, leaving nothing ([[a-guard-reused-across-contexts-can-invert]]). Say in the comment that it is a backstop, so nobody mistakes it for the boundary.

**When the change downgrades a credential's promise, rewrite the doc that teaches the setup.** Adding per-day counts here forced a token from metadata-only to contents-read: the promise changed from "the credential cannot read your code" to "the script reads it and does not forward it." Scope the broader credential to the allowlisted resources only, so the allowlist is enforced by the credential rather than by code — and rewrite the setup doc's old instruction instead of leaving it to contradict the running config ([[correct-a-durable-record-explicitly]]).

Related: [[credentials-never-reach-an-error-path]], [[a-silent-guard-needs-a-canary]].
