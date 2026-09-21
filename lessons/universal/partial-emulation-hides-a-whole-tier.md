---
id: partial-emulation-hides-a-whole-tier
title: A harness that boots only some of the platform's services silently disables every code path in the rest
scope: [universal]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 2
---
An integration harness that starts a platform's local services with an **allow-list** (`--only {{SERVICE_A}},{{SERVICE_B}}`) has drawn a coverage boundary that no failing test will ever reveal. Code living in an omitted service does not fail — it does not run. Every spec passes, because the thing that would have broken was never executed.

The incident: a suite booted a cloud platform's emulators for auth and the database, and never for the server-side event handlers, which run in a **separate** process the list omitted. So no trigger fired in any spec, in any job, ever. Meanwhile a test file's own header comment asserted the handlers were "exercised by the end-to-end suite". Believing that comment cost a full round of analysis. Note the subtlety that makes it plausible: the handler *is* a database trigger, and the database emulator *was* running — but a database trigger still executes inside the **handler** runtime; the database alone only stores the write.

The gap is not merely a missing test. It hides changes that are only observable when the handler runs. Here, adding a server-stamped field created a parent record **earlier in the lifecycle** than before, which fired an unrelated promotional-grant handler and gave away paid access to an account nobody had ever signed into. The promotion was live at the time. Every automated suite passed. It was caught only by standing the omitted service up **by hand**, once, as a deliberate manual verification.

**Why:** an allow-list is written to make the harness start faster or more reliably, at a moment when the omitted service is not on anyone's mind. From then on it is invisible: the config is not where anyone looks for coverage, the specs are green, and any comment claiming coverage ages into a false statement that nothing contradicts.

**How to apply:**
- Before trusting **any** "covered by the integration suite" claim, read what the harness **actually starts** — the emulator/service list, the compose file, the container set. Never the test name, never a comment.
- When a change touches a tier the harness does not run, (a) say so explicitly rather than letting the suite's green stand in for it, (b) prove it once with a manual run of that tier and record the run as a checklist entry, and (c) file the harness gap as its own item with the measured cost of closing it (which build steps, which config keys, which readiness probes).
- Do **not** bolt new harness infrastructure onto an unrelated change to satisfy a literal acceptance criterion. State the deviation instead; the infrastructure is its own piece of work and deserves its own review.
- Treat a comment asserting coverage as a claim to verify, and fix it in the same pass — a stale coverage claim is worse than no claim, because it stops the next reader from checking.
- Related: [[did-not-run-is-a-third-outcome]] (the per-check version of the same silence), [[a-gate-that-exists-vs-a-gate-that-covers]], and [[green-means-not-broken]].

**The same gap shows up on the client side of an emulation, not just the server side.** A platform's refusal to complete sign-in inside an embedded in-app browser is decided by runtime signals the browser exposes, not by its user-agent string — so a spoofed user-agent reproduces nothing and proves nothing, in either direction. Only a real device running a real embedded browser is evidence about that behavior. Likewise, an automated test browser engine does not necessarily enforce the same storage-partitioning and privacy mechanisms as the real mobile browser it stands in for, so a green test run in that engine is weak evidence about a privacy-related bug the real browser exhibits.

- Before trusting any emulation — a spoofed header, a headless test browser, an emulator profile — name the **specific mechanism** under test and confirm the emulator actually implements that mechanism, not merely the surface around it. A user-agent string is surface; the runtime signal a platform keys its behavior on is the mechanism.
