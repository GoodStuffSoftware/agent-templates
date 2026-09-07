---
id: review-docs-against-the-code-seam
title: Review a doc about code against the code — prose describing a branch is exactly where a wrong branch hides
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 2
---
An adversarial review of a documentation-and-procedure diff — no code changed, but the procedure was one agents would execute verbatim — found its two worst defects not by reading the prose harder, but by spending three minutes grepping the code each sentence described.

- A sentence claimed a free self-probe verifies your own wake path. Reading the dispatcher's classifier proved it false in *both* branches: an agent already holding a wait never fires the trigger, and an agent not holding one fires it at real cost. The step could never verify what it claimed.
- A sentence said "on refusal, re-register and move on." The store's response contract returned `ok: true` with a separate `bound: false` field on exactly that refusal. The prescribed success check would have read a refusal as a success and silently no-opped.

Both sentences read as obviously correct. Neither survived contact with the function it described.

**Why:** a docs-only diff invites a docs-only review, and prose has no type checker. A sentence about a branch is a claim about control flow written in a medium where nothing can contradict it — which makes it the cheapest place for a wrong branch to live and the last place anyone looks. The cost is asymmetric: a wrong sentence in an operational procedure reproduces, verbatim and repeatedly, the exact failure the document exists to prevent.

**How to apply:**
- **For every operational claim in the doc, find the code that implements it.** Grep the function, the classifier, the response builder. "This probe verifies X", "on success the call returns Y", "if it fails, retry" — each is a falsifiable claim with a specific implementation, and checking it is minutes.
- **Check the actual branch ORDER, not just that the branch exists.** Docs paraphrase; paraphrase loses ordering, and ordering is usually where the exception lives.
- **Suspect every `ok: true`-with-a-refusal-field shape.** APIs that report transport success alongside a semantic refusal are reliably paraphrased as plain success, and every consumer written from the paraphrase inherits the bug ([[assert-the-resolved-value-not-the-declaration]]).
- **Read the failure returns, not only the happy path.** A doc that says what happens on success and is silent on failure is describing one of the two branches it needed to describe.
- **Weight the review by who executes the doc.** Reference prose a human skims is low stakes; a procedure an agent runs verbatim is code with worse tooling, and deserves a code review.
**A spec that describes INTENT is not a record of what shipped — and stale intent propagates outward.** A "business model outline — not a feature design" document, written months before the feature and never updated, misled two independent agents on the same day: it named the wrong trial length, the wrong price points, and denied a purchase path that had been live for several releases. The authoritative answers were single constants in the code (`{{TRIAL_CONSTANT}}`, the tier table in the billing composable). The damage did not stop at the doc: its claims had been copied into marketing copy under unresolved `[VERIFY]` markers that nobody ever resolved, and from there into a **public store listing** that overstated the product's feature count and misdescribed what was free.

- **Derive a product fact from the constant, never from a spec.** Where the code holds the number, the doc holds someone's plan for the number.
- **Treat an unresolved `[VERIFY]`/`[TBD]` marker as a defect with a deadline, not as a caveat.** A marker that survives into published copy has failed at the one job it had. Grep for them before any customer-facing text ships.
- Label a document that was never a record — "outline, superseded by the code at `{{PATH}}`" — at the top, in the same pass in which you discover it is wrong. Correcting only the sentence you needed leaves the next reader to rediscover the rest ([[correct-a-durable-record-explicitly]]).
- Related: [[docs-living-or-historical]] (which docs are maintained at all) and [[probe-behaviour-not-version-stamps]] (behaviour outranks any written claim about it).
