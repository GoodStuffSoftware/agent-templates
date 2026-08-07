---
id: secret-resolution-fallback-chain
title: Resolve a shared secret through a first-hit-wins chain ending in a fail-safe — not a single required env var
scope: [universal]
requires: {}
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 1
---
When many small entry points need the same credential — hooks, supervised daemons, one-shot scripts a scheduler spawns, CLIs run by hand — requiring each of them to find a named environment variable already injected makes every new environment a configuration chore and every rotation an edit in N places. One environment that misses the injection fails quietly and differently from the rest.

Resolve the credential through one shared helper with an ordered chain instead:

1. **The already-injected value** (explicit argument, then the env var) — the fast path, unchanged for environments that do inject it.
2. **A secret-manager lookup** (`{{SECRET_MANAGER_CLI}}`) keyed by a stable secret id, gated on the bootstrap credential the environment already carries. This is the step that makes a rotation propagate with zero per-environment config.
3. **A fail-safe empty value** that callers treat as "unauthenticated — no-op", never an exception.

Cache the result per process, *including* the empty one, so a missing or broken secret CLI is invoked once rather than on every call.

**Why:** The chain moves the configuration surface from "every environment × every rotation" down to "one bootstrap credential per environment". Ending in a fail-safe rather than a throw matters just as much: these callers are hooks and background daemons where the credential is optional-by-design, and a resolver that raises turns a missing optional secret into a hard failure of a tool call or a supervised process that had no reason to care. Caching the negative result is what stops a fail-safe from becoming a per-call subprocess spawn.

**How to apply:**
- Put the chain in one module every entry point imports. Two entry points resolving the same secret two ways is the bug this prevents.
- Never throw out of the resolver, and never log the resolved value or its length — log only which step answered.
- Inject the secret-manager invoker as a parameter so the chain is unit-testable without the real secret store: cover each step, the cache, and the both-missing case.
- Keep the bootstrap credential itself out of the chain's outputs — it is the one value that still has to be present in the environment, and that is the point.
- Document the secret id, not the secret, in the repo.
