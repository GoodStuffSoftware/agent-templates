---
id: static-instructions-teach-discovery
title: Static instruction artifacts must teach how to DISCOVER a mutable capability surface, never enumerate its current state
scope: [agent-process]
requires: {}
status: active
since: 2026-07-13
provenance: [contrib-2]
corroborated: 2
---
Any instruction artifact that is frozen at load time — a skill file, an agent brief, a system-prompt attachment, a playbook — must NOT enumerate a capability surface that can change underneath it (the current tool set, endpoint list, agent roster, feature flags). It freezes at invocation; the surface keeps moving; the two silently diverge and the agent then acts with full confidence on a stale snapshot. Instead, such an artifact describes HOW to discover the current state: the list/introspection call to run, the change signal to react to, and the source-of-truth file — never WHAT the state is right now.

This is the counterpart to building live capability propagation. When a system pushes new or changed capabilities into running agents (server-side change notifications, a message-bus broadcast, a re-list on a signal), a static artifact that hard-codes the old capability set defeats the propagation — the agent keeps following the frozen list and never sees the update. A skill is "a way to load the mutable way," not a place to pin the mutable thing.

Exact current values belong in exactly one place: test assertions, where pinning is deliberate and a drift is supposed to fail the build.

**Why:** Static instructions are re-read verbatim every invocation but authored once. The moment they name a specific tool, count, endpoint, or roster, they encode a point-in-time snapshot that rots the first time the surface changes — and unlike a stale test (which goes red) a stale instruction just quietly misleads. Teaching discovery instead of state makes the artifact self-updating: it always resolves to current reality because it defers to a live source rather than carrying a copy.

**How to apply:**
- When an artifact must reference a mutable surface, write discovery, not a listing: "enumerate via `{{LIST_CALL}}`; re-enumerate when `{{CHANGE_SIGNAL}}` fires; the source of truth is `{{CAPABILITY_SOURCE_OF_TRUTH}}`." Never paste the current set or its count.
- Audit existing skills/briefs for frozen enumerations (tool names, "there are N tools", role lists). Rewrite each into a loader of the discovery mechanism.
- Keep pinned exact values only in test assertions, where a mismatch failing CI is the intended behavior.
- Pairs with [[slim-always-loaded-instructions]] (what belongs in always-loaded core vs on-demand) and [[knowledge-routing-ladder]] (where a new rule lands). A discovery instruction is a constant; the discovered set is not.

**A rationale is the load-bearing kind of prose, and the least likely to have been re-checked.** A load-bearing comment asserted that a tool-name prefix was stable "on every machine, forever," and a design decision was built on that claim — while a sibling configuration file in the SAME directory already documented that a differently-declared server arrives under a prefix the matcher does not match. The codebase knew the truth and the rationale did not; nobody had grepped for the counter-example because the comment read as settled background, not as a claim to verify.

**How to apply (continued):**
- When a claim appears as a RATIONALE ("this is safe because X is always true," "the prefix is stable because Y"), grep the repository for its own counter-example before trusting it. A rationale earns less scrutiny than an instruction precisely because it reads as explanation rather than as a directive — which is exactly why it rots first.

Related: [[an-unauthenticated-duplicate-entry-is-not-an-outage]] and [[review-docs-against-the-code-seam]].
