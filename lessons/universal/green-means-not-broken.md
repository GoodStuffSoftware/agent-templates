---
id: green-means-not-broken
title: A passing gate means not-broken, not right — the failure space has three members
scope: [universal]
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Automated checks partition outcomes into pass and fail, but outcomes have at least three members: **correct**, **broken**, and **wrong-but-well-formed**. Gates are built to catch *broken*, because broken is mechanically detectable. Wrong-but-well-formed is indistinguishable from correct to every check you own — so the greener your pipeline, the more confidently it passes exactly the defects that matter.

Two shapes, both observed in practice:

- **A guard blocks step 1; step 2 runs anyway and reports its own success.** A pre-commit hook rejected a commit; the following push ran, created the branch at the unchanged revision, and printed the normal new-branch success plus a link. Every surface said shipped; the payload was empty. Same shape: a failed build followed by a deploy of the previous artifact. The success message describes step 2 honestly — it says nothing about your work.
- **Two valid orderings, one of them meaningless.** Two branches appended to the same concatenation chain. The naive keep-both-hunks resolution was a syntax error, caught loudly by every gate. The *reversed but syntactically valid* resolution compiled, passed the unit suite, passed lint, passed the pre-push gate, and left a sentence beginning "…also do X" with no antecedent, in text an end user copy-pastes. The gates rejected the broken resolution and approved the wrong one.

**Why:** Mechanical detectability is the selection criterion for what a gate checks, and it is uncorrelated with what matters. Ordering is semantics; gates check syntax. Step 2's exit status is about step 2. A pipeline's greenness therefore measures the absence of the cheap failures and is silent on the expensive ones.

**How to apply:**
- After any operation with a guard in front of it, verify the OUTCOME — the revision moved, the content is present at the destination — rather than the exit status of the last command ([[verify-at-destination-prove-the-target]]).
- When resolving a conflict in prose, instructions, configuration, or anything a human reads, RENDER the result and read it. Syntax checks confirm it parses, not that it means anything.
- Anchor merge instructions on the TEXT, never on authorship: "keep mine first" inverts depending on who is speaking; "the block ending {{X}} comes before the line beginning {{Y}}" cannot.
- Anything whose second element says "also", "then", or "in addition" carries a dependency no automated check can see. Read those by hand.
- Sibling of [[match-instrument-to-failure-class]]: that lesson covers a class no gate observes; this one covers a class every gate observes and approves.
