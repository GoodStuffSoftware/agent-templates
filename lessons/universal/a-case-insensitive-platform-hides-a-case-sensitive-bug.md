---
id: a-case-insensitive-platform-hides-a-case-sensitive-bug
title: A case-insensitive platform hides a case-sensitive bug — and a silent fallback to a default hides it forever
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A helper built an environment-variable name from a lowercase identifier — `{{ENV_PREFIX}}_${lowercaseKey}` — while the platform that sets the variable uppercases the key itself (`{{ENV_PREFIX}}_${lowercaseKey.toUpperCase()}`). Environment lookup is case-insensitive on one major OS and case-sensitive on the others, so the lookup worked **by accident** on the developer's machine and silently returned every option's default everywhere else, including cloud and hosted runtimes. The bug stayed latent for months because no config value had ever actually been set — until a real user set one from a different host.

**Two kernels, and the second is the more dangerous:**

1. **Platform-dependent case sensitivity around any identifier a program builds itself** — environment variable names, file paths, header names — is verified only on the one platform where the mismatch happens not to matter. "It works on my machine" is evidence about the platform, not about the code. The same applies to path separators and line endings.
2. **A config value that silently falls back to a default is far more dangerous than one that throws**, because nothing ever reports it. The feature simply behaves as if unconfigured, which is indistinguishable from the user not having configured it.

**How to apply:**
- Normalize the case (or separator, or line ending) explicitly at the lookup site rather than relying on the platform to paper over the mismatch.
- Prefer failing loudly over falling back silently when a value was supposed to be set: if the caller asked for a named option, an unresolvable name is an error, not a default.
- Test any self-constructed identifier on a case-sensitive filesystem or host at least once — that single run is the whole test ([[clean-clone-cross-os-build-truth]]).

Related: [[assert-the-resolved-value-not-the-declaration]], [[shell-read-encoding-double-encodes]], [[a-silent-guard-needs-a-canary]].
