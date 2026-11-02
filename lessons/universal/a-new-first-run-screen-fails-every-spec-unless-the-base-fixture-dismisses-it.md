---
id: a-new-first-run-screen-fails-every-spec-unless-the-base-fixture-dismisses-it
title: A new one-time first-run screen fails every end-to-end spec unless the base fixture starts devices as already past it
scope: [universal]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
Shipping a one-time welcome or onboarding screen put every spec that opens the app on a fresh device onto that screen. The first fix seeded the "seen" flag in the shared fixture; follow-up commits were still needed for specs that build their own browser context (they bypass the fixture), and for specs that count storage keys or contexts (the new flag changed the count).

**How to apply:**
- Seed the "seen" flag in the base fixture by default, so every test device starts as one that already dismissed the screen; first-run specs opt out explicitly.
- Grep for specs that construct their own contexts and give them the same seed helper.
- Re-check specs that assert storage contents or context counts.
