---
id: assert-the-resolved-value-not-the-declaration
title: Assert the value the system resolves, not the one you declared — precedence rules, unread flags, and unforwarded arguments live in the gap
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 4
---
A declaration in a config file is an input to a resolution, not the outcome of one. Tests and reviews that read the declaration confirm the input and say nothing about what the system will actually use. Two failures with the same shape, from one week:

**Precedence silently overrode a correct declaration.** A build variant declared the signing identity it should ship with, and that declaration was correct. But in this build system a *build-type* config outranks a *flavour* one, and the toolchain auto-creates a build type signed with a machine-local developer key. The variant that actually shipped kept taking the machine key. Every test passed throughout — they pinned the DECLARATION and the bug was in the RESOLUTION. The config file even stated the precedence rule, in a comment reasoning about a sibling variant that never ships.

**A flag nobody read made a decision that never happened.** A verification channel was "demoted" by setting `required: false` on it. Nothing in the codebase reads `required` — the verdict model computes *verified* from the absence of failures, deliberately, so that a flag cannot wave a real failure through. The demote therefore never took effect, and the channel went on hard-failing every release verified on a host lacking one optional tool, about a path nobody had published to in two months.

**A third party never forwarded the field, and three tests asserted the field.** A security control was implemented as "set `{{CLIENT_LIB}}.someField = {{USER_ID}}`, then call `order()`". Two unit tests and one end-to-end test asserted the field had been set; all three passed. Reading the shipped library's source showed the order path forwards only its ARGUMENT (`order(additionalData || {})`) and never consults that field. The value never reached the provider, the provider echoed nothing back, and the server-side check — written to tolerate an absent value, because absence is legitimate — passed for every transaction. **The tests were more generous than the library.** Worse than a no-op: with the binding inert, an attacker racing the genuine buyer wins the claim, and the buyer is rejected by the other defence.

**Why:** All three are the same gap. Someone set or declared a value, reasoned about the intended effect, and never observed the resolved one. Reviewing the diff cannot close it: the diff is correct in every case. Only the resolved value — the key the artifact was actually signed with, the field the verdict function actually reads, the argument the dependency was actually called with — carries the answer, and it lives one layer below the file being edited. Asserting the value you SET tests your own assignment statement, which cannot fail.

**How to apply:**
- Assert on the RESOLVED artifact or the RESOLVED value: inspect the produced artifact's signature/identity, print the value the consuming function reads, dump the merged effective config. "The file says X" is not that.
- **Before editing a config to change behaviour, find the consumer.** Grep for the key. A field no code reads is a comment with syntax highlighting, and setting it produces a convincing paper trail of a decision that never took effect.
- When a system has precedence rules (build type over flavour, local over inherited, environment over file), assume the rule is in play for the variant you did not check. Precedence documented in a comment is not precedence enforced by a test.
- **When a control's enforcement depends on a third party, assert the WIRE EFFECT.** Capture what the dependency was CALLED WITH (record the call arguments in the mock), or better, assert the observable downstream effect. Applies to payment SDKs, auth headers, telemetry tags, webhook signatures — anything whose value only matters once someone else forwards it.
- **Read the dependency's SHIPPED source for the field you are relying on**, and confirm the consumer sits on your code path. A getter with four call sites, none of them on the path you take, is a name that agrees with you and a mechanism that does not.
- **Verify a test by breaking the fix and confirming the test fails.** Apply it to every property the change claims, not only the headline one — in the case above the same technique had already proven a sibling fix in the same change, and would have caught this one on day one.
- Fix at the layer that resolves, not the layer that is convenient. In the signing case the tempting fix — set it on the build type — would have applied the wrong identity to every other flavour, which the suite explicitly forbade. See [[safeguard-the-operation-not-the-entry-point]].
- **Never RE-DERIVE a value the tool will resolve for itself.** A fourth case: a scheduler sized its work plan by recomputing the parallel worker count from the same inputs the test runner uses, instead of reading the count the runner had actually resolved. The two formulas agreed until one of them was tuned, after which the plan described a run that never happened. If the consumer exposes its resolved value, read it; a faithful reimplementation of someone else's resolution is a copy that starts drifting the day you ship it.
- Related: [[probe-behaviour-not-version-stamps]] (behaviour outranks self-reported state) and [[unenforced-absence-invariant]] (a claim nothing enforces).
