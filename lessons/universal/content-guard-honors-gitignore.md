---
id: content-guard-honors-gitignore
title: A repo content-guard must scan the committable set, not the raw working tree
scope: [universal, stack:git]
status: active
since: 2026-06-13
provenance: [contrib-1]
corroborated: 1
---
A repo content-guard (a secret/token scanner, a banned-string linter, a PII sweep — any check that fails the build when a forbidden string appears in a file) must enumerate the **committable set**: files git tracks plus untracked files that are not gitignored. It must NOT walk the raw working tree, because the working tree contains gitignored files that hold real secrets BY DESIGN and can never be committed.

**Why:** A guard that walks the raw working tree (skipping only `.git/` and `node_modules/`) ignores the rest of `.gitignore`. A gitignored file that legitimately holds forbidden tokens — a maintainer-only de-anonymization map, a `.env`, a local provenance file — then trips the guard on the developer's machine. Meanwhile CI passes, because gitignored files are absent on a fresh checkout, so the failure is local-only and contradicts a green pipeline. The developer is blocked by a false positive on content that was never going to be committed, and the natural "fix" (deleting or genericizing the legitimately-secret local file) is exactly the wrong move.

**How to apply:**
- Enumerate via `git ls-files --cached --others --exclude-standard` (`--cached` = tracked, `--others` = untracked, `--exclude-standard` honors `.gitignore` + `.git/info/exclude` + global excludes). That set is precisely "what could be committed," which is what the guard exists to protect.
- Add a graceful fallback for when git is unavailable (not a repo / git absent): degrade to a raw working-tree walk and emit a stderr note that `.gitignore` is no longer honored — never silently change the scanned set.
- The guard's file set should match the question "could this file be committed?" — not "does this file exist on disk?" If the answer to the first is no, the guard has no business reading it.
- This generalizes any content-guard, but the concrete mechanism is git-specific; non-git VCS need their own "ignored-aware" enumeration.
- Related to [[branch-what-deploys]] (both turn on the distinction between what ships/commits and what merely sits in the working tree).
