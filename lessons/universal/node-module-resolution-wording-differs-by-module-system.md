---
id: node-module-resolution-wording-differs-by-module-system
title: Node's "module not found" wording differs by module system — CJS names a module, ESM names a package
scope: [universal]
requires: {}
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms: [cannot find module, cannot find package]
sessions: 37
---
Node reports a failed dependency resolution differently depending on which module system asked for it. CommonJS (`require`) produces `Error: Cannot find module '<path>'`. The ESM resolver produces a differently-shaped, `Error:`-unprefixed message: `Cannot find package '<name>' imported from <path>`. Both mean the same underlying thing — something in `node_modules` that the resolver expected is not where it looked — but they are two distinct message shapes, not variants of one.

Measured across this operator's real session corpus: the CJS wording alone recurred in 37 distinct sessions across 30 projects; the ESM wording recurred separately, across a *different* set of specific package names each time (eslint's own dependencies, `acorn`, `firebase-admin`, `express` — 12+ distinct packages combined) but the identical surrounding phrase, in another 30+ sessions across a dozen projects. The fact that the ESM shape recurs with the package name varying and the wrapper text fixed is itself the signal that this is a generic resolution-plumbing issue (a hoisting quirk, a lockfile out of sync with `node_modules`, an install that did not finish) rather than any one package being broken.

**Why:** a `Cannot find module` reader who has only ever seen the CJS wording will not recognize `Cannot find package '<x>' imported from <y>` as the same class of problem, and will waste time treating a package-specific instance as a bug in that one package instead of checking the resolution plumbing generally.

**How to apply:**
- Treat both wordings as the same diagnostic starting point: is the named module/package actually present in `node_modules` at the resolved location, and does the lockfile agree with what is on disk?
- `npm ci` (or the equivalent for the package manager in use) over `npm install` when the symptom shows up after a branch switch or a merge — a stale, partially-hoisted `node_modules` reproduces this reliably.
- For the ESM shape specifically, the missing name is very often a *transitive* dependency of something you do depend on directly (a peer of a devDependency, e.g. a linter or its parser) rather than something to add to `package.json` yourself — check what pulls it in before adding it as a direct dependency.
- If the failure is inside a monorepo/workspace, confirm which workspace's `node_modules` the resolver is actually walking — a thin root manifest with the real dependency tree one directory down is a known way this class of error gets mis-diagnosed (see this repository's own `docs/adr/0002-stack-scoped-gotcha-retrieval.md`, Decision part 4, for the same shape of problem in a different context).
