---
id: notes-span-from-the-last-delivered-version
title: Generated release notes span from the version that channel last received — not from the previous version number
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
A release-note generator that emits "the current version's changelog section" assumes every version reaches every channel. None do. A version can be cut, tagged and never built for a given distribution channel, so the build a user actually receives **spans several versions** — and taking only the newest section hides exactly the change they are updating for.

The incident: a version whose own section was empty (its only change was internal) was about to ship notes reading "maintenance and behind-the-scenes improvements" over the top of a user-visible purchase fix from the previous version, which that channel's users had never received.

The generator gained two modes. With an explicit `--since`, it takes every version newer than the one given — for when you know what is actually live on that channel. Without it, it starts at the current version and **walks back to the most recent version that has real notes**, so nobody has to remember the flag to avoid shipping a vague one.

**Why:** the version number is a property of your repository; what a channel holds is a property of that channel. They diverge the first time a release is skipped, and nothing in the changelog records the divergence.

**How to apply:**
- Take the span from the channel's **last delivered version** where the platform can tell you (query the track/release the channel is serving), and make the walk-back the default fallback rather than a flag someone must remember ([[assert-the-resolved-value-not-the-declaration]]).
- **Test the RENDERED output, not the raw section text.** A version whose only content is an explanatory prose line has text but produces no headings or bullets, so it renders to nothing — testing raw text stops the walk-back on a version that contributes zero, and then lists it as a contributor in the printed source line. Both bugs were found by running it, then pinned by tests.
- Print which versions the notes were assembled from, next to the notes. That single line makes a wrong span visible during review instead of after release.
- Related: [[version-bump-at-integration]] and [[did-not-run-is-a-third-outcome]] — "this channel did not receive that release" is its own state, not a pass.
