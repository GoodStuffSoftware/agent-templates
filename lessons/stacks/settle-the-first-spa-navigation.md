---
id: settle-the-first-spa-navigation
title: Wait for the first page to render before a second in-page navigation — a router that has not finalized ignores it
scope: [stack:playwright]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
`page.goto()` resolves on the document's `load` event. For a single-page app that is *early*: the bundle may have loaded, but the app has not necessarily booted and its router's **initial navigation has not finalized**. A second navigation issued inside that window — one that only changes the fragment, so it is a same-document navigation — can be dropped on the floor. The URL updates, the first page stays rendered, and the second route's lazy chunk is never even requested.

The incident: a test seeded a history entry with `page.goto('/#/first')` and immediately called `page.goto('/#/second?x=1')`. About one attempt in three, the second page never appeared; the retry passed, so it read as a load flake for weeks. The trace showed the second navigation landing while the first route's lazy chunk was still in flight. The router in use only begins reacting to history events once it marks itself ready at the end of the first navigation — the DOM listener exists from the moment history is created, but the router's own callback is registered later — so a fragment change inside that window is genuinely invisible to it. Sibling tests in the same file already waited for the first page's root element before navigating again; the flaky one did not.

**Why:** the failure is timing-dependent and self-healing on retry, which is exactly the signature people file under "flaky environment". Nothing errors: a same-document navigation that no listener reacts to is a legal no-op, so the browser, the driver and the app are all behaving correctly.

**How to apply:**
- Before a second in-page navigation, assert the first page actually **rendered**: `await expect(page.locator('{{FIRST_PAGE_ROOT}}')).toBeVisible()`. Waiting for a network-idle style condition is weaker — it says the transport is quiet, not that the router finished.
- The diagnostic tell is a **first-attempt-only** failure at the *second* page's first assertion. Confirm it from the trace: if the second route's module was never fetched, the navigation was ignored, not slow.
- The same hazard applies to any driver whose navigate call resolves on `load`, and to app-code that pushes history immediately after boot. It is not specific to one router; check when yours starts listening.
- Seeding history for a back-button test is the usual reason two navigations end up adjacent. Treat "navigate, navigate" as a code smell and put a render assertion between them by default.
- Related: [[e2e-spec-registration-required]] and [[green-means-not-broken]] — a retry that passes is not evidence about the cause.
