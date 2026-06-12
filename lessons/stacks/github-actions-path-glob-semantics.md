---
id: github-actions-path-glob-semantics
title: GitHub Actions path filters — `*` does not cross `/`, `**` does; don't port globs between systems
scope: [stack:github-actions]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
In a GitHub Actions workflow `paths` / `paths-ignore` filter, `*` matches within a single path segment and does **not** cross `/`, while `**` **does** cross `/`. So `**.md` matches markdown anywhere in the tree (including nested), whereas `*.md` matches only root-level markdown.

**Why:** A `paths-ignore: ['**.md']` meant to skip docs-only changes will *also* skip a deploy when a nested `.md` is the only thing that changed — which can silently suppress a content deploy you wanted. If you only mean root docs, write `*.md` (root-only). Getting the glob wrong fails open (deploys when it shouldn't) or fails closed (skips a deploy it should run), and both are quiet.

**How to apply:**
- To ignore only root-level docs: `*.md`. To ignore docs anywhere: `**.md` — and be sure you really mean "anywhere."
- **Do not port a glob between systems unchecked.** The same glob string means different things in different tools: a platform's build-watch-path globs may treat `*` as recursive, the opposite of GitHub Actions. The cross-system contrast IS the lesson — re-read each system's glob rules before copying a pattern from one config into another.
