---
id: secret-resolution-fallback-chain
title: Resolve a shared secret through a first-hit-wins chain ending in a fail-safe — ordered by ascending privilege, not a single required env var
scope: [universal]
requires: {}
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 2
---
When many small entry points need the same credential — hooks, supervised daemons, one-shot scripts a scheduler spawns, CLIs run by hand — requiring each of them to find a named environment variable already injected makes every new environment a configuration chore and every rotation an edit in N places. One environment that misses the injection fails quietly and differently from the rest.

Resolve the credential through one shared helper with an ordered chain instead:

1. **The already-injected value** (explicit argument, then the env var) — the fast path, unchanged for environments that do inject it.
2. **A secret-manager lookup** (`{{SECRET_MANAGER_CLI}}`) keyed by a stable secret id, gated on the bootstrap credential the environment already carries. This is the step that makes a rotation propagate with zero per-environment config.
3. **A fail-safe empty value** that callers treat as "unauthenticated — no-op", never an exception.

Cache the result per process, *including* the empty one, so a missing or broken secret CLI is invoked once rather than on every call.

**Why:** The chain moves the configuration surface from "every environment × every rotation" down to "one bootstrap credential per environment". Ending in a fail-safe rather than a throw matters just as much: these callers are hooks and background daemons where the credential is optional-by-design, and a resolver that raises turns a missing optional secret into a hard failure of a tool call or a supervised process that had no reason to care. Caching the negative result is what stops a fail-safe from becoming a per-call subprocess spawn.

**Order the chain by ASCENDING PRIVILEGE, not by convenience.** A second incident: a verification leg needed two test-account logins on a build host, and the obvious answer was the whole-vault access token the developer machine already used. That would have handed the host every keystore, service-account key, and API token in the vault — a large blast radius bought for a small need — when the host already carried a narrower credential that could answer. The chain was rebuilt per field as: injected environment value (nothing required; a container or CI supplies it) → a project-scoped secret manager read using the ambient per-environment identity the job ALREADY runs as → the whole-vault token, last, reached only when the narrower sources cannot answer. The dev-box convenience path stays available and stops being the server path.

**Let the identity boundary do the isolating, not the naming convention.** In that design the secret names carry no environment (`{{APP}}_TEST_LOGIN`, not `{{APP}}_STAGING_TEST_LOGIN`), because each environment's copy lives in its own project. A staging run therefore *cannot* read production's credentials — not by convention, but because the identity it holds has no access. A naming scheme inside one shared store depends on every future caller spelling it correctly forever.

**How to apply:**
- Put the chain in one module every entry point imports. Two entry points resolving the same secret two ways is the bug this prevents.
- Never throw out of the resolver, and never log the resolved value or its length — log only which step answered.
- Inject the secret-manager invoker as a parameter so the chain is unit-testable without the real secret store: cover each step, the cache, and the both-missing case.
- A source that cannot answer — no ambient credential, no permission, no such key — is a MISS, and so is a source that throws: catch it and try the next one. A resolver that propagates an error turns a runner misconfiguration into what reads as a product fault ([[did-not-run-is-a-third-outcome]]).
- Reach for a remote store over its REST API rather than by shelling out to a vendor CLI, unless that CLI is installed everywhere the chain runs. A missing binary is otherwise an invisible extra requirement on every future host.
- Keep the bootstrap credential itself out of the chain's outputs — it is the one value that still has to be present in the environment, and that is the point.
- Document the secret id, not the secret, in the repo.
