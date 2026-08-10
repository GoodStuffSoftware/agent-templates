---
id: shell-read-encoding-double-encodes
title: A shell whose read default is the ANSI codepage double-encodes UTF-8 on every round trip — and nothing errors
scope: [env:windows]
requires: { os: windows }
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
On Windows PowerShell 5.1, `Get-Content` defaults to the system ANSI codepage, **not** UTF-8. Reading a UTF-8 file and writing it back double-encodes every non-ASCII byte: an accented letter becomes two characters, an em dash becomes three. A `Get-Content | ... | Set-Content` round trip over any document containing accents, arrows, dashes or symbols corrupts it — and **nothing errors**. You find out when a human reads the file, or when a reviewer notices a commit whose only content is repairing several files at once.

**How to apply:**
- **Pass `-Encoding UTF8` on the READ, not only on the write.** Most guidance covers the write half and leaves the more damaging half in place.
- Repair is lossless if caught: reverse the mis-decode by reading the mojibake back as ANSI-codepage bytes and re-interpreting as UTF-8. Verify by grepping for the two-character sequences that always appear in double-encoded text.
- **Never do a read-modify-write round trip over a document you are not editing.** Prefer a targeted in-place edit; a whole-file rewrite is what turns an unrelated change into a corruption commit.
- The write half has its own trap: `Set-Content`/`Add-Content` default to the ANSI codepage, and `-Encoding utf8` on this version emits a **BOM** — which downstream parsers reject. See [[powershell-pipe-bom-breaks-json]] for the parsing half of the same round trip.
- The general form of this rule is [[normalize-before-declaring-difference]]: on a platform that rewrites bytes on the way through, byte equality and content equality are different questions.
