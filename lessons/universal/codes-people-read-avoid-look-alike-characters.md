---
id: codes-people-read-avoid-look-alike-characters
title: A code a person reads or types must avoid look-alike characters, or be set in a font that tells them apart
scope: [universal]
requires: {}
status: active
since: 2026-11-23
provenance: [contrib-2]
corroborated: 1
---
Invite, promo, referral, verification, order and license codes get misread when 0/O and 1/I/L look alike, and the support cost lands on the person who typed it correctly.

**How to apply:**
- Generate from an alphabet without the look-alikes: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I, L). Show it in upper case and validate with `^[2-9A-HJKMNP-Z]+$`.
- Audit an existing code format by flagging any code that matches `/[0O1IL]/i`.
- A code that must keep those characters (an external format you do not control) is shown in a monospace font with a slashed or dotted zero and distinct 1, l and I, (`font-variant-numeric: slashed-zero`).

**Why:** the fix is cheapest at generation time; once codes are issued, the ambiguous ones live on in emails and printed material.
