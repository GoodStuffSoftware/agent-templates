---
id: an-ignore-rule-protects-a-spelling-not-a-concept
title: An ignore rule protects a spelling, not a concept — audit deny-lists by what they miss, by testing paths that do not exist yet
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A deny-list is a list of strings, not a statement of intent, but it reads to a later reviewer as one. A plausible-looking entry actively suppresses the question "what else belongs here?" The failure is not an empty list (that gets noticed); it is a list with one or two reasonable entries, which reads as proof the category was handled.

Two instances, same day, same codebase:
- A deployment upload ignore list excluded exactly one environment-file pattern — the one in the tool's own documentation examples — while the project's actual generated env files, named by another convention, were uploaded on every deploy.
- A source-control ignore rule covered one hyphenated spelling of a credential filename. The camelCase spelling — the one the cloud provider's documentation uses, so the likelier to be created by hand — was unignored, and a single `git add -A` would have committed it.

In both, the covered spelling came from the *documentation* and the exposed one from *practice*. Deny-lists tend to be written while reading docs and exercised while writing code.

**How to audit one:**
- **Enumerate by category, then check coverage.** Ask "what are all the files that would be catastrophic here?" and test each against the rule; never read the list and judge it plausible.
- **Test the rule, do not read it.** Most ignore mechanisms have a query mode (`git check-ignore -v <path>`). Probe a file that does not exist yet; that is the case you care about.
- **Check anchoring as well as spelling:** whether a pattern applies at any depth or only at the root is a second, independent failure invisible in the pattern text.
- **Distinguish "is not there" from "cannot be added".** Untracked-but-unignored is one careless command from committed.
- **Prefer a broad pattern plus deliberate, commented exceptions** over enumerating what someone thought of, and verify mechanically that the intended exceptions survive the broadening.

Applies to `.gitignore`, deploy/upload ignore lists, bundler excludes, log redaction rules, secret scanners and lint ignores alike.

Related: [[a-gate-that-exists-vs-a-gate-that-covers]], [[guard-coverage-enumerate-issuing-surfaces]], [[content-guard-honors-gitignore]].
