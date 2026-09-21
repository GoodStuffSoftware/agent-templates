---
id: a-per-scope-override-must-be-bidirectional
title: A per-scope override must work in both directions, or it is just a mute button
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
"Global on, this one scope off" is the obvious half of a scoped override. "Global off, this one scope on" is the half that makes the feature actually usable, because it is the only way to carve out a single exception without abandoning the policy everywhere else. An implementation where the global switch is checked first and short-circuits the rest passes a test that only exercises the obvious direction, and fails the useful one silently.

The incident: a precedence chain was written as "if the global setting is off, stop — nothing runs; otherwise check the per-scope setting." That reads as a correct precedence chain in review, because it IS a correct precedence chain for narrowing. It is simply the wrong one for the actual request, which was to enable a single scope while everything else stayed off. The failure never showed up as a bug report about the code being wrong — it showed up as someone asking why their one exception wasn't taking effect, and the code looking, at a glance, entirely reasonable.

**Why:** "global gates the specific" and "the most specific setting wins" produce identical behavior for every case except exactly the one that motivated adding a scoped override in the first place — turning it on somewhere while it's off everywhere else. Reviewers check the direction they can picture (turning something off in one place), and the untested direction is also the one nobody asks for until they need it.

**How to apply:**
- Test both directions explicitly, as two separate named test cases: global-on-scope-off, and global-off-scope-on. A single "override works" test that only exercises one direction gives false confidence.
- Express precedence as "the most specific setting wins," not "the global setting gates the specific one" — the former is symmetric by construction, the latter has a direction baked into its phrasing that will eventually be wrong.
- When someone asks for a scoped exception, find out which direction they actually need before implementing — "turn it off just for X" and "turn it on just for X while everything else stays off" look like the same feature request and are opposite code paths.
- Related: [[re-inject-a-standing-rule-from-a-hook]], [[a-detector-contains-what-it-detects]], [[fail-open-fallback-expires-with-the-flag]].
