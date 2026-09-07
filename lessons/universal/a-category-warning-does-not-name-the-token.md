---
id: a-category-warning-does-not-name-the-token
title: A validator that reports a CATEGORY has not named the token — bisect it, and confirm on a reload
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
Platform validators frequently report a **rule class** rather than the offending input: "must not use keywords that indicate price or promotion", "contains restricted terminology", "does not meet these guidelines". The obvious candidate is rarely the only one, and removing it alone leaves the warning standing — at which point people conclude the warning is stuck, or a bug, and ship around it.

The incident: a store listing's short description tripped a price/promotion rule. Removing the word "free" did **not** clear it. It cleared only once a second phrase — the product's actual differentiator, a "no advertising" claim — was also removed. Two independent tokens, one warning, no indication in the message that either was involved. And the trap is structural: the phrase that disqualifies you is exactly the phrase your positioning is built on. The fix is placement, not silence — the claim moves to the fields the rule does not cover (the long description, captions, creative), and the constrained field gets a neutral rewrite.

**Why:** validators report the rule they matched because the rule is what they know; mapping it back to a span of input is extra work the vendor did not do. So the diagnosis is yours, it is a bisection, and it terminates only when the warning actually clears.

**How to apply:**
- **Bisect.** Remove one candidate at a time and re-check. Do not stop at the first plausible one; a rule can match several tokens and reports the same message for all of them.
- **Confirm by a full reload, not by inline validation.** Client-side validation often lags the server's verdict, so a warning that disappears as you type — or fails to — is not evidence either way.
- Learn what the flag actually **costs** before reacting. Here it removed eligibility for the platform's own merchandising surfaces while leaving listing, search and installability untouched — worth knowing precisely, because it decides whether you rewrite or accept.
- When an **adjacent** warning may be static boilerplate rather than a live flag on your input, mark it **UNVERIFIED** and name the thirty-second test that would settle it. Do not act on an unverified flag, and do not let it quietly become received wisdom ([[absence-observed-is-not-absence-explained]]).
- Related: [[read-which-error-fired-before-theorising]] — mine the message you were handed before generating theories, and accept that this class of message simply does not carry the answer.
