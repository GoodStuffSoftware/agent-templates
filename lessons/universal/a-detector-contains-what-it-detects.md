---
id: a-detector-contains-what-it-detects
title: A detector contains what it detects — scope the exception to the one file and rule, never disable the check
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A detector's own definition necessarily contains a copy of exactly what it is built to catch, so a self-scan over the whole tree trips on the detector itself. That is not a false positive about the codebase — it is a true positive about a file that is supposed to hold the forbidden content, on purpose, as its entire job.

Two incidents, same shape. First: a copy linter that fails a build when forbidden marketing tokens appear anywhere in product copy necessarily lists those same tokens in its own denylist, so a whole-tree scan flags the linter's source file every run. The wrong fixes are both tempting: skipping the hook hides the finding and breaks the project's own no-skip rule, and editing the denylist to dodge the match neuters the linter entirely. The right fix is a registered exception scoped to exactly that one file and exactly that one rule, recorded in a reviewable exception register rather than silently special-cased in code. Second: a guard that pattern-matches the literal text of a bypass flag in any command also fires on prose that merely DISCUSSES refusing to use that flag — a documentation edit explaining why a bypass is forbidden reads, to the pattern matcher, as an actual bypass attempt.

**Why:** the tempting fixes both destroy the thing that makes the check worth having. Skipping the run means the check never protects anything on that path again. Editing the denylist to avoid self-matching removes exactly the entries doing the work. Neither actually solves "the detector's own file legitimately contains what it detects" — only a scoped exception does, because it lets the check keep running everywhere else at full strength.

**How to apply:**
- When a detector matches its own definition file, add a narrow exception naming the exact file and the exact rule it is exempt from — never broaden the rule and never skip the run.
- Keep exceptions in one reviewable register (a file, a manifest, an annotated allowlist) rather than scattered as inline suppressions, so the accumulated exemptions stay visible as a set.
- **The register itself accretes and needs auditing.** One case found an exception register already silently suppressing hundreds of findings across a dozen files, with a single category dominating the list — nobody had looked at it as a whole in a long time. Audit the register before it becomes load-bearing camouflage, and require each entry to name the rule it exempts, the file it applies to, and the reason, so a reviewer can tell a legitimate self-reference from a rule someone quietly gutted.
- For a guard that pattern-matches literal text, test it against prose that discusses the forbidden pattern without attempting it — a guard that cannot tell "doing X" from "explaining why not to do X" will train people to route around it the same way a guard that inverts in a neighboring context does ([[a-guard-reused-across-contexts-can-invert]]).
- Related: [[guard-coverage-enumerate-issuing-surfaces]], [[exempt-the-generated-field-not-the-file]].
