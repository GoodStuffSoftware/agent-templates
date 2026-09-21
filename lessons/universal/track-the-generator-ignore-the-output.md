---
id: track-the-generator-ignore-the-output
title: Track the generator, ignore its output — a template that produces per-checkout config belongs in the repo
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A per-checkout configuration file is correctly gitignored because its values are machine-shaped — a port, a local path, a device id. That correctness hides a trap: the TEMPLATE that generates the file is a different artifact with a different governance answer, and it is easy to leave it ungoverned by analogy with the file it produces.

The incident: a fix to a recurring local-environment problem was implemented by editing the template that seeds each checkout's local config. The generated config file was gitignored, as it should be. But the template itself sat untracked in a home directory, outside any repository — while the hook that COPIES the template into every new checkout had been committed in the repository all along. Half of the mechanism was reviewed, versioned, and would follow the project to a new machine; the other half was one person's local file, unreviewable, unversioned, and invisible to anyone else who ran the same checkout hook and got nothing.

**Why:** "gitignore the generated file" is the correct and obvious call, and it gets made once, early, and never revisited. Nobody separately asks "and where does the generator live?" because the generator doesn't look like config — it looks like a script, and scripts feel like they belong wherever the author happens to keep them. The two questions get conflated into one answer, and the answer that's right for the output is wrong for the source.

**How to apply:**
- Track the generator (template, seed script, scaffolding) in the repository; gitignore only the per-checkout output it produces.
- Resolve machine-specific values at RUNTIME inside the generator (env lookups, host detection) rather than baking a specific machine's values into a tracked template — a tracked template with one machine's values hardcoded is not actually generic.
- Keep a fallback path for checkouts created before the generator existed or changed — a missing or stale generated file should regenerate on next use, not fail silently forever ([[fail-open-fallback-expires-with-the-flag]] for the shape of that fallback's own expiry).
- Put the sanctioned way to invoke the generator behind a named package script, not a remembered command line. "How we run this" that lives only in an agent's memory gets re-derived wrongly next time; a named script is the thing a brief can point at, and the place a safety flag stays attached ([[hide-flag-rides-the-console-creating-spawn]]).
- When auditing "is this properly versioned," ask the question twice — once for the artifact, once for whatever produced it. A `.gitignore` entry answers only the first.

Related: [[branch-what-deploys]], [[static-instructions-teach-discovery]].
