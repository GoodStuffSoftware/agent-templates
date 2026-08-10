---
id: lifecycle-hook-runs-in-production-installs
title: A build hook on an in-tree path dependency also runs in production installs — and that failure never reproduces locally
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Attaching a build step to a local path dependency (`file:` / workspace-style) as a package lifecycle hook looks like a tidy way to make a fresh checkout self-bootstrapping. It is not, because the same hook fires on the deployment path.

Measured against a throwaway fixture on a current package manager: a `prepare` script on a path dependency runs under a plain install, a lockfile install, **and a production-only lockfile install with dev dependencies omitted.** That last one is what a managed build service runs.

**The failure shape:** the deploy uploads the whole source directory, the build service installs without dev dependencies, and the hook invokes a compiler that is a *dev* dependency. The install fails, so the deploy fails — and it **never reproduces locally**, because locally the dev dependencies are present. The signal points at the deploy platform; the cause is in the manifest.

**It is usually also redundant.** The deploy configuration in that case already had a predeploy step that built the package correctly. The only real gap was *local bootstrap of a fresh working tree* — a much smaller problem than the one the hook created.

**How to apply:**
- Never attach `prepare`/`postinstall` to an in-tree path dependency inside a directory that gets uploaded to a build service. Verify by running the production install shape (`{{INSTALL}} --omit=dev` or equivalent) in a scratch fixture, not by reasoning about it.
- Put the bootstrap where it cannot reach the deploy path: a post-checkout hook and a root `pretest` both run for humans and CI and never for the build service. Note the trade — see [[safeguard-the-operation-not-the-entry-point]] for when an entry-point-only wiring is *not* good enough.
- **Any "works locally, fails only in the build service" install error is a dev-vs-production dependency-resolution difference until proven otherwise.** Compare the two install shapes first; it is a two-minute check that skips an afternoon.
- Related: [[clean-clone-cross-os-build-truth]] (the sibling: what the deploy tree does not carry).
