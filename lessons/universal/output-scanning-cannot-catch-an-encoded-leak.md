---
id: output-scanning-cannot-catch-an-encoded-leak
title: Scanning output for a path cannot detect a leak that arrives encoded or summarized
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A guard worked by substring-scanning a tool's JSON output for a protected directory path, asserting the string never appeared. It missed the leak on two separate channels: one emitted the directory name with its path separators replaced by dashes — an encoded form containing none of the original path's substrings — and a second emitted only a human-readable label, no path text at all. Both channels read the protected tree and printed nothing a scanner could match.

**Why:** substring-scanning output tests what the process CHOSE TO PRINT, which is never guaranteed to be the same set as what it actually touched. Any transformation between the read and the print — encoding, truncation, summarizing into a label, hashing — defeats a scanner built against the original string, and the transformation does not need to be deliberate obfuscation; a UI-friendly label or a path-safe encoding does the same thing by accident.

**How to apply:**
- When the property under test is "this process must not touch location X," assert on the filesystem access itself — trace the read/write entry points, or point the process's home/config/working directory at a sentinel location and assert the sentinel stays untouched — rather than scanning what the process chose to print.
- If output-scanning is the only available instrument, treat a pass as weak evidence, not proof: enumerate every place the value could be transformed (encoded, hashed, truncated, relabeled) before trusting a clean scan, and add a probe for each transformation you can think of.
- A sentinel-directory assertion is a stronger instrument than output-scanning, but it has its own false-positive source: a third-party binary the code under test shells out to can write into the sentinel on its own first-run initialization, unrelated to the code under test — strip such binaries from `PATH` before asserting, so the assertion measures your own code.

Related: [[credentials-never-reach-an-error-path]], [[withhold-at-the-payload-not-in-the-prompt]], [[a-silent-guard-needs-a-canary]].
