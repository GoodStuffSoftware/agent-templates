---
id: find-the-asset-before-you-generate-it
title: Search where finished assets already live before exporting, rendering, or downloading a new one
scope: [agent-process]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
Before generating any asset — a video export, an image render, a PDF, a build artifact, a data extract — search the places finished assets already live. The user has very often produced it already, sometimes twice, and a re-export costs time, occupies a tool the session needs, and leaves duplicate files that someone then has to reconcile.

The correction that bought this: *"Did you check to see if we have it anywhere first? They are already in the downloads folder."* — after a session started a fresh high-resolution re-export of a video the user had exported twice, months earlier, from the very design project the session was reading.

**Why:** generating is the visible, obviously-productive move, and searching feels like a detour. The economics are the reverse: the search is seconds, the export is minutes plus a duplicate the user did not want. And a download or export is usually a **permission-gated** action — finding the existing file skips the ask entirely.

**How to apply:**
- Make the search the **first action** of any "get me the asset" task: the user's downloads directory (filtered by extension, sorted by modification time), the shared drive folder for that asset class, and the repository itself (public assets, docs, marketing directories).
- **Report what you found before producing anything new** — name, date, size — and say which variant you propose to use. Let the user reject a stale one rather than pre-emptively rebuilding.
- Only export when the search comes back empty or the existing variants genuinely do not fit, and say which requirement they failed.
- Record the inventory of known variants where the next session will read it, so the search converges faster next time rather than being repeated from scratch.
- Related: [[check-before-duplicating-a-peers-work]] (the same reflex applied to another agent's output) and [[a-local-path-is-not-a-shared-artifact]] (once found, hand over the content, not a path, unless the recipient shares the filesystem).
