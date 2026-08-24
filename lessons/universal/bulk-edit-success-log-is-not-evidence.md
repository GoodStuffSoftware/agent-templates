---
id: bulk-edit-success-log-is-not-evidence
title: A bulk edit's success log is not evidence — read a changed file, and assert your input's shape
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A small find/replace script rewrote header comments across six files and reported success for all six. Five were destroyed — every space in the header replaced with `*`.

The cause was a shape bug, not a logic bug. A one-element list of `[find, replace]` pairs collapsed into a flat two-element list of **strings**, so indexing element `[0]` and `[1]` returned the first two *characters* of a string instead of the two members of a pair. Files with two or more pairs were untouched, which made the corruption look random rather than systematic. Nothing threw. The operation "succeeded."

**Why:** scripted multi-file text edits fail in a way that produces output rather than errors. Any language where a single-element container degenerates to its element, or where indexing a string succeeds instead of raising, turns a nested-data bug into plausible-looking text. The success log is a report about the loop completing, and the loop did complete.

**How to apply:**
- **Prefer an exact-match edit tool for multi-file text changes.** Failing to find the target string should be a loud error. A hand-rolled replace treats a miss as a no-op and a mis-shaped argument as a *different edit*.
- **When you do script it, read one changed file afterwards — the whole hunk, not a grep for the new string.** Grepping for what you inserted confirms the insert and hides the collateral damage around it. This is the same trap as [[assert-the-guard-saw-something]]: you checked the thing that was always going to be there.
- **Assert the shape of your inputs before looping.** `if this element is not a pair, fail` turns a degenerate container into a crash instead of a silent change of meaning.
- **When only SOME targets are damaged, suspect input shape, not edit logic.** Uniform bugs corrupt everything; shape bugs corrupt exactly the cases that hit the degenerate path — and the survivors are what makes it look like flakiness.
- Related: [[exit-code-void-when-output-stream-closes]] and [[verify-at-destination-prove-the-target]] — three versions of the same rule that the report of an operation is not the operation.
