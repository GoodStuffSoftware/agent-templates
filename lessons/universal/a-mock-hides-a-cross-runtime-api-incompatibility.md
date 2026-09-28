---
id: a-mock-hides-a-cross-runtime-api-incompatibility
title: A mock hides exactly the layer that differs between runtimes — validate a runtime-sensitive option inside the real runtime, not just against a mock
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Unit tests hosted in one runtime (e.g. Node, running under a general-purpose test runner) cannot see an API rejection that only the TARGET runtime (an edge/serverless runtime, a browser, a mobile platform) throws. A mocked dependency makes this worse, not better: the mock replaces exactly the layer where the two runtimes disagree, so the test suite can pass while asserting a value the real runtime would reject outright.

The incident: a security fix hardened an outbound fetch with a `redirect` option value accepted by two of three possible values. The change passed 146 unit tests and a mutation-testing run, then a later review found the option value was one the edge runtime rejects at call time — Node, where the tests ran, accepts it; the edge runtime accepts only the other two. The test suite's mocked fetch never inspected the option, and one assertion actively pinned the broken value, so the suite enforced the bug rather than catching it.

**Why:** mutation testing proves the tests pin the code; it says nothing about whether the code is valid on the runtime that will actually execute it. A mock replaces the one thing a cross-runtime compatibility bug lives in — the real implementation's validation of its own inputs — so the more thoroughly a dependency is mocked, the less a passing suite says about runtime compatibility.

**How to apply:**
- For any runtime-sensitive options object (fetch init, a platform API call, anything with an enum-like value one runtime validates differently from another), export a small builder function so it can be constructed and exercised in isolation.
- Add ONE test that runs inside the REAL target runtime's own binary (its own `test`/`run` command, launched from the normal test script) and constructs the real object against the real runtime — not a mock of it. Prove the test is load-bearing by mutating the value back and watching it fail.
- Keep that runtime-native test in the default test command so it runs in CI and at the deploy gate, not as an optional extra.
- When a review proposes a platform-API option as a fix, ask for either a citation of the target runtime's own source/docs for that exact option, or a run inside that runtime — vendor docs for one runtime do not bind another.
- Related: [[prove-the-runtime-not-the-error-text]] (identical-looking error text can come from either of two runtimes; this is the mirror case — identical-looking PASSING tests can come from a runtime the code will never actually run on) and [[run-the-formats-own-validator]] (a working example, or a passing mock, only proves coverage of the subset it exercises).
