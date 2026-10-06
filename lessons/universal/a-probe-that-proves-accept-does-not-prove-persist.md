---
id: a-probe-that-proves-accept-does-not-prove-persist
title: A probe proving an API accepts an operation does not prove the operation persists — name what a check establishes, in the identifier
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Verification by proxy is the most convincing way to be wrong, because a real check ran and really passed. Measured: recovery code would auto-reload a browser only if a guard record could survive that reload. It established "durability" by writing one byte, reading it back **within the same page load**, and declaring the store durable. Two distinct failures hid behind that one probe. A store can accept every write and persist nothing — a stubbed in-memory shim, a hardened embedded webview, per-page-load virtualisation — and the probe still passes. And a store near its quota can accept a one-byte probe and then reject the forty-byte record that follows, so the probe passes and the real write throws. Either way the code reloaded the browser on a guard that did not exist: an unbounded reload loop reached without the failure branch ever firing.

The aggravating factor was a comment, not code. At the decision site it asserted that the system would not auto-reload "without a guard that provably survives the reload". The probe established nothing of the kind. **A comment that overstates what a check proves converts an untested assumption into a documented guarantee, and reviewers stop questioning guarantees.** The code was defensible; the sentence describing it made the gap invisible.

**How to apply:**
- **Name what a probe establishes in the narrowest true terms, in the identifier itself** — "a store accepted a write", not "durable".
- **Verify the operation you depend on, at the size and across the boundary you depend on.** If you need persistence across a reload, nothing observable within one page load can establish it; carry a second defence that does not consult the thing under test (a loop cap held somewhere that survives, a bounded retry count in the URL, a time-based limiter).
- **Test the liar explicitly:** a fake that accepts every write and returns nothing, and a fake that persists within a boundary but not across it. Both are a few lines, both fail instantly against this bug class, and neither is reachable by a test using a working implementation.
- **Prove a new assertion can fail.** From the same branch: an assertion protecting an ordering guarantee would have passed while the guarantee was broken, because it compared against two named neighbours rather than the property it cared about. Break the thing deliberately, watch the test go red, restore, and confirm the tree is clean. A test that cannot fail reads as a guarantee too.

Related: [[prove-the-mutation-landed]], [[a-shared-mock-across-a-boundary-production-does-not-share]], [[prove-the-runtime-not-the-error-text]].
