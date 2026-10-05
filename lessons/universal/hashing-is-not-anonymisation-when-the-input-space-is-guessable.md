---
id: hashing-is-not-anonymisation-when-the-input-space-is-guessable
title: Hashing is not anonymisation when the input space is guessable — a readable hash list is a membership oracle
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A staging access gate admitted testers by matching SHA-256 hashes of their email addresses against an allowlist, and the proposed improvement was to mirror an external tester list into a readable datastore document, still as hashes, so the client could check membership without a server round-trip. The hash list was treated as if it protected the identities on it. It does not.

**A readable list of hashed identifiers leaks membership whenever the identifier space is guessable.** Emails, usernames, phone numbers, employee IDs and customer numbers all are. Anyone who can read the list can hash a candidate and look for the digest, which answers "is this specific person on the list?" — usually the exact question the list was meant to keep private. Enumerating the whole list is harder, but confirming a guess is the attack that matters and it is cheap.

Three proposed fixes that do not work:
- **Requiring authentication to read the list** narrows the audience, but every reader downloads the whole list and can test any candidate offline, indefinitely, after one read.
- **A salt that ships with the list** (client-side verification needs the client to have it) raises cost per guess, not the property.
- **Slow hashes** (bcrypt/scrypt/argon2) price out bulk enumeration but not confirming one address already suspected.

**The shape that works:** do not ship the membership set at all. Put the lookup behind a server endpoint that takes the identity from a VERIFIED credential (a signed token the caller already holds), never a caller-supplied parameter, and returns a verdict about that caller only. It answers "am I a member?" and cannot be asked about anyone else; nothing is enumerable because nothing is enumerated. If the upstream source supports a single-identity query, query one identity rather than fetching the set and filtering locally.

**Availability:** a server-side check adds a network dependency to an access decision, so choose the failure direction deliberately. Failing open defeats the gate; failing closed on every transient error locks out legitimate users. A workable default is asymmetric caching — a positive verdict cached long and honoured through a generous grace window when the lookup is down, a negative verdict cached briefly, deny only when there is no usable cached verdict ([[a-mitigation-that-delays-a-symptom-delays-the-diagnosis]]).

**Observability:** a gate that fails closed silently is indistinguishable from one correctly denying everyone. Emit a signal on the *unavailable* branch specifically (never on ordinary denials, which are the gate working), and keep identities out of it, or the telemetry reintroduces the leak the design just removed.

Related: [[timing-correlation-deanonymizes-id-free-streams]], [[a-silent-guard-needs-a-canary]].
