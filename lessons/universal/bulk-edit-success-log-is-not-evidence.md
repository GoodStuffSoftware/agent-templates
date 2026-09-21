---
id: bulk-edit-success-log-is-not-evidence
title: A bulk edit's success log is not evidence — read a changed file, and assert your input's shape
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 2
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

**Same shape, a different degenerate container: PowerShell unrolls a single-element outer array.** A find-and-replace script built its list of `(find, replace)` pairs with one outer array constructor around a single pair. PowerShell silently UNROLLS a one-element array-of-arrays into a flat array, so instead of one pair the loop received the pair's two elements directly as top-level items. Indexing "element zero, position zero" and "element zero, position one" then indexed into a STRING's characters rather than into the intended pair. A bulk find-and-replace built this way corrupted every file it touched — wrong characters substituted throughout — threw nothing, and logged success for the whole run, because from the loop's perspective every iteration completed normally.

**How to apply (continued):**
- Force the array shape explicitly whenever a collection might have exactly one element — wrap the construction so PowerShell cannot unroll it (comma-operator prefix or an explicit type-cast on the outer collection), and don't rely on the literal syntax alone.
- Prefer an exact-match edit tool that fails loudly on a miss over string-surgery loops for any multi-file edit — this is the same preference the original incident already argues for, and it defends against this container-unrolling failure mode too, not just the pair-vs-string one.
