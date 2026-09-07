---
id: powershell-pipe-bom-breaks-json
title: Windows PowerShell 5.1 puts a BOM on both ends — it breaks JSON.parse on the way in and byte-zero parsers on the way out
scope: [env:windows]
requires: { os: windows }
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 2
---
Piping a test payload from Windows PowerShell 5.1 into a node script (`'{"tool":"x"}' | node hook.mjs`) delivers stdin prefixed with a UTF-16 byte-order mark — PS 5.1's default pipeline encoding for native programs — and `JSON.parse` throws on it. Any stdin-JSON consumer that will ever run or be tested on Windows must strip a leading BOM (and tolerate UTF-16 input) before parsing.

The compounding trap: guard hooks are deliberately fail-open ([[guard-hooks-deny-teach-ack]]), so a hook that throws on the BOM ALLOWS everything. A PowerShell pipe-test suite that comes back all-ALLOW therefore looks like a passing run while actually proving the hook never parsed a single payload. Treat an all-ALLOW pipe-test as a red flag until a must-deny case has been observed to DENY.

**Why:** PowerShell 5.1 encodes pipeline text to native programs with a BOM-carrying default encoding, unlike PowerShell 7+ or POSIX shells. The same hook passes its tests on macOS/Linux/pwsh and silently dies on Windows — or the agent host delivers clean UTF-8 in production while manual pipe tests deliver BOMs, so the hook works for real calls and fails only under test (or vice versa). Fail-open design makes the breakage invisible: nothing errors user-visibly; the guard just stops guarding.

**The write half is the same byte with a different victim.** `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` on this version **prepend a UTF-8 BOM** (PowerShell 7 does not), so any consumer that parses from byte 0 chokes: a commit linter, a strict JSON parser, a `.gitmessage`, a hook input file. Observed twice — a commit-message file written that way was rejected as an **"empty header"** because the BOM landed before the type prefix, and a cloud function's stored credential secret, set from BOM-prefixed content, made the deployed function throw on `JSON.parse` at its first real invocation while the deploy and its verification both reported green. In both cases the error names the *content* ("empty header", "unexpected token"), never the encoding, so the hunt starts in the wrong place.

Write BOM-free instead: `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))`. For anything stored remotely (a secret, an uploaded config), **verify the stored value's first byte** is the one you intended rather than trusting the write. For commit messages specifically, writing the file with an editor tool and using `git commit -F <file>` avoids the whole class.

**How to apply:**
- In the script: strip a leading byte-order mark (U+FEFF; on the wire, a UTF-16LE `FF FE` or UTF-8 `EF BB BF` prefix) from stdin before `JSON.parse`.
- On the write side: never hand a shell-written `-Encoding utf8` file to a parser that reads from byte 0. Use the BOM-free writer above, and treat a "malformed content" error on a file you just wrote as an encoding suspect first.
- In tests: always include at least one payload that MUST be denied; if it comes back ALLOW, the harness or its encoding is broken — not the rule.
- When results look suspiciously uniform, cross-check one delivery path against another (temp file vs pipe, PS 5.1 vs pwsh).
