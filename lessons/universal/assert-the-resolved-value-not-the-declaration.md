---
id: assert-the-resolved-value-not-the-declaration
title: Assert the value the system resolves, not the one the config declares — precedence rules and unread flags live in the gap
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 2
---
A declaration in a config file is an input to a resolution, not the outcome of one. Tests and reviews that read the declaration confirm the input and say nothing about what the system will actually use. Two failures with the same shape, from one week:

**Precedence silently overrode a correct declaration.** A build variant declared the signing identity it should ship with, and that declaration was correct. But in this build system a *build-type* config outranks a *flavour* one, and the toolchain auto-creates a build type signed with a machine-local developer key. The variant that actually shipped kept taking the machine key. Every test passed throughout — they pinned the DECLARATION and the bug was in the RESOLUTION. The config file even stated the precedence rule, in a comment reasoning about a sibling variant that never ships.

**A flag nobody read made a decision that never happened.** A verification channel was "demoted" by setting `required: false` on it. Nothing in the codebase reads `required` — the verdict model computes *verified* from the absence of failures, deliberately, so that a flag cannot wave a real failure through. The demote therefore never took effect, and the channel went on hard-failing every release verified on a host lacking one optional tool, about a path nobody had published to in two months.

**Why:** Both are the same gap. Someone edited a declaration, reasoned about the intended effect, and never observed the resolved value. Reviewing the diff cannot close it: the diff is correct in both cases. Only the resolved value — the key the artifact was actually signed with, the field the verdict function actually reads — carries the answer, and it lives one layer below the file being edited.

**How to apply:**
- Assert on the RESOLVED artifact or the RESOLVED value: inspect the produced artifact's signature/identity, print the value the consuming function reads, dump the merged effective config. "The file says X" is not that.
- **Before editing a config to change behaviour, find the consumer.** Grep for the key. A field no code reads is a comment with syntax highlighting, and setting it produces a convincing paper trail of a decision that never took effect.
- When a system has precedence rules (build type over flavour, local over inherited, environment over file), assume the rule is in play for the variant you did not check. Precedence documented in a comment is not precedence enforced by a test.
- Fix at the layer that resolves, not the layer that is convenient. In the signing case the tempting fix — set it on the build type — would have applied the wrong identity to every other flavour, which the suite explicitly forbade. See [[safeguard-the-operation-not-the-entry-point]].
- Related: [[probe-behaviour-not-version-stamps]] (behaviour outranks self-reported state) and [[unenforced-absence-invariant]] (a claim nothing enforces).
