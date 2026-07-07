---
id: powershell-pipe-bom-breaks-json
title: Windows PowerShell 5.1 pipes prepend a BOM that breaks JSON.parse — strip it, and distrust an all-ALLOW hook test
scope: [env:windows]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Piping a test payload from Windows PowerShell 5.1 into a node script (`'{"tool":"x"}' | node hook.mjs`) delivers stdin prefixed with a UTF-16 byte-order mark — PS 5.1's default pipeline encoding for native programs — and `JSON.parse` throws on it. Any stdin-JSON consumer that will ever run or be tested on Windows must strip a leading BOM (and tolerate UTF-16 input) before parsing.

The compounding trap: guard hooks are deliberately fail-open ([[guard-hooks-deny-teach-ack]]), so a hook that throws on the BOM ALLOWS everything. A PowerShell pipe-test suite that comes back all-ALLOW therefore looks like a passing run while actually proving the hook never parsed a single payload. Treat an all-ALLOW pipe-test as a red flag until a must-deny case has been observed to DENY.

**Why:** PowerShell 5.1 encodes pipeline text to native programs with a BOM-carrying default encoding, unlike PowerShell 7+ or POSIX shells. The same hook passes its tests on macOS/Linux/pwsh and silently dies on Windows — or the agent host delivers clean UTF-8 in production while manual pipe tests deliver BOMs, so the hook works for real calls and fails only under test (or vice versa). Fail-open design makes the breakage invisible: nothing errors user-visibly; the guard just stops guarding.

**How to apply:**
- In the script: strip a leading byte-order mark (U+FEFF; on the wire, a UTF-16LE `FF FE` or UTF-8 `EF BB BF` prefix) from stdin before `JSON.parse`.
- In tests: always include at least one payload that MUST be denied; if it comes back ALLOW, the harness or its encoding is broken — not the rule.
- When results look suspiciously uniform, cross-check one delivery path against another (temp file vs pipe, PS 5.1 vs pwsh).
