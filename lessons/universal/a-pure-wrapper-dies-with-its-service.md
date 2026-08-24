---
id: a-pure-wrapper-dies-with-its-service
title: When retiring a service, follow its clients — a wrapper with no logic of its own dies with it
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A retirement was scoped as "delete the server and its UI." A separate component — a protocol adapter exposing that server's API as callable tools for other programs — was not in scope and looked independent: its own directory, its own registration, its own name.

Its source header settled it in one line: *this module holds no logic of its own.* All ~30 of its operations were a single HTTP call to the server being deleted. And because its registration file was committed, it auto-loaded in **every** session and advertised thirty operations that could now only ever return "unreachable" — preserving precisely the failure the retirement existed to stop: an agent picking a plausible-looking tool that cannot work.

**Why:** an adapter, proxy, SDK shim, or tool registration that holds no logic is not a separate component. It is the service's surface in another protocol, and it has exactly the service's lifetime. It reads as independent because packaging boundaries look like ownership boundaries, and they are not.

**How to apply:**
- **Grep the wrapper for its transport call** — the HTTP client, the RPC stub, the socket — and check whether *every* operation routes through it. If so, it belongs in the same change as the service.
- **Treat an auto-registering wrapper as HIGHER severity than ordinary dead code, not lower.** Dead code nobody imports is inert. A committed registration that loads in every session actively advertises capabilities to whoever is choosing what to call next, and they discover the truth only at call time. The remedy is deletion plus removing the registration — and, because a stray local registration can reappear, an ignore rule so it is never committed again.
- **Surface a scope crossing rather than expanding silently.** State the evidence — the header claim, the call-path grep, the auto-registration — and let the requester decide. "Not in the list I was given" is not the same as "out of scope" ([[discovered-staleness-in-scope]]).
- **Watch for the inverse before you delete:** a wrapper directory that also holds a module live code still imports. Classify per module ([[delete-the-test-with-its-dead-subject]]).
- Related: [[static-instructions-teach-discovery]] — an advertised-but-dead capability is the same harm as a stale enumeration, arriving through the tool surface instead of through prose.
