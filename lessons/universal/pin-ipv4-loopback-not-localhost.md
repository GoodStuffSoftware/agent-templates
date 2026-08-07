---
id: pin-ipv4-loopback-not-localhost
title: Pin local service hosts to the IPv4 loopback literal, not the name `localhost`
scope: [universal]
requires: {}
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 1
---
`localhost` is a name resolved at runtime, not an address. On a host that publishes both loopback records, modern runtimes prefer the IPv6 answer (`::1`) — so a tool that defaults its bind or connect host to `localhost` reaches a different address depending on where it runs. On a minimal container or a CI runner built without an IPv6 loopback, that preference is fatal: the bind fails outright with an address-family error, on a machine where every desktop run of the same config worked.

Pin generated and default host configuration to the IPv4 loopback literal. It resolves identically everywhere, costs nothing on hosts that do have IPv6, and removes an entire class of "works on my machine" from the environment matrix.

**Why:** The failure is maximally expensive relative to its size. It lands at *startup*, usually inside a test harness's global setup or a service's boot, so one unresolvable name takes down the whole run before a single test or request executes — and the error (an address-family/socket failure) points at the network stack rather than at the one word in a config file that caused it. It is also invisible on the machine where the config was written, so it survives review and only appears when the workload moves to a leaner host.

**How to apply:**
- Wherever your tooling generates host config — per-worker test ports, emulator/service suites, dev-server binds, health-check URLs — write the loopback literal, not `localhost`.
- Do this in the *generated* config rather than by patching each tool's default; it is one place, and it keeps working when the tool changes its own default.
- Do not "fix" it by enabling IPv6 on the runner. The runner is allowed to be minimal; the config is what was overspecified.
- Same reasoning applies in reverse for a service that must be reachable over IPv6 — state the address family you mean, in both directions, rather than leaving it to name resolution.
- Pairs with [[verify-actual-bound-url]]: pin the host, then confirm what the process actually bound.
