# Contributions Inbox

A holding area for generic improvements contributed back from real projects when no pull-request workflow is available. Entries here are **not yet applied** — a maintainer folds each one into its proper template/shared file (see [CONTRIBUTING.md](CONTRIBUTING.md) → "Where it goes") and then removes it from this file.

**This is a queue, not a home.** A change isn't "done" while it's only in the inbox.

## How to add an entry

Append a new dated entry at the **top** of the list (newest first), using the template below. Before adding it, run `node scripts/leak-check.mjs` — the entry must contain no real-world tokens (generalize specifics to `{{PLACEHOLDERS}}` or generic examples first).

```markdown
### YYYY-MM-DD — <short title>

- **Trigger:** what surfaced this (the gotcha / better step / missing rule).
- **Is it generic?** the result of the "is this generic?" test — what specifics were stripped, what reusable kernel remained.
- **Target:** where it should land. For a **rule, gotcha, or hard-won lesson** this is a new tagged file under `lessons/` — knowledge is never pasted into an agent def or into `anthropic/shared/cross-project-rules.md` (that page is a pointer and enumerates nothing). Use a template path (e.g. `anthropic/basic-site/agents/site-builder.md`) only for scaffolding changes.
- **Proposed change:** the actual generalized text / diff, with `{{PLACEHOLDERS}}` in place of any real values.
- **Applied?** `no` (a maintainer flips this to `yes` and removes the entry once folded in).
```

**Placement note:** entries go under `## Entries` below, newest first — not above this section, and not below the fold history. Entries drifted out of that section in both the 2026-08-31 and 2026-09-07 folds, which is easy to do and harmless, but the queue reads correctly only when every pending entry lives in one place.

---

## Entries

### 2026-09-07 — Committing an analysis is not delivering it

- **Trigger:** a recurring scheduled agent wrote a complete, correct four-part interpretation into a long report file on a feature branch, then reported only its one-sentence headline, because the task's own REPORT step asked for "the headline". The branch was unmerged, so the analysis the task existed to produce was unreadable by the person who commissioned it. The operator had to ask for it explicitly. Every number in the run was right; the deliverable still did not arrive.
- **Is it generic?** Yes. Stripped: the project, the document, the analysis domain. Kernel: a recurring task whose output is a JUDGMENT must state in its own instructions that the judgment is reproduced in full in the report. Left to inference, an agent under a general "be terse" rule will compress exactly the part that was the deliverable, and a file written to a branch or a path the reader cannot reach counts as undelivered. Terseness rules must carry an explicit carve-out for the artifact the task was bought to produce.
- **Target:** new lesson under `lessons/`, e.g. `lessons/deliver-the-judgment-not-a-pointer-to-it.md` (tags: reporting, scheduled-tasks, deliverables).
- **Proposed change:**
  ```markdown
  # Deliver the judgment, not a pointer to it

  When a task's deliverable is an interpretation (a written read, a recommendation, a
  verdict), its instructions must say the interpretation is reproduced VERBATIM and IN
  FULL in the report, under its own heading. Naming it ("report the headline", "note the
  conclusion") invites compression of the one thing that mattered.

  Two failure modes this prevents:

  - **Terseness bleed.** A standing "keep reports short" rule is about PROCESS noise. An
    agent that applies it to the analysis has followed the letter and lost the deliverable.
    State the carve-out where the terseness rule lives, not only in the task.
  - **Undelivered artifacts.** Content written to {{BRANCH_OR_PATH}} that the reader cannot
    open has not been delivered, regardless of how correct it is. Committed is not
    delivered; a link the reader cannot resolve is not delivery either.

  Test when writing any recurring task: if the agent reported ONLY what this step names,
  would the person get what they commissioned? If no, the step is underspecified.
  ```
- **Applied?** `no`

### 2026-09-07 — Identify a shell by ancestry and `uname`, never by command-not-found

- **Trigger:** a project banned its agents' Bash tool for four months on the strength of one "verification": a PowerShell cmdlet typed into the Bash tool failed with `/usr/bin/bash: line 1: Write-Output: command not found`, which was read as proof the tool ran inside a Linux VM. That output is identical under a Windows-native POSIX layer (MSYS2 / Git for Windows mounts itself at `/usr/bin/bash` too). The ban had been true on an earlier machine where the agent harness itself ran inside the VM; after a PC migration the tool was native and nobody re-tested. Measured cost on the new box: the mandated shell was ~2.5x slower per glue call, used ~8x the memory, and errored on ~1 in 12 tool calls; a hook was hard-denying the faster tool.
- **Is it generic?** Yes. Stripped: the project, the shells' names, the incident dates. Kernel: a negative result ("X is not found") only proves the absence of X, never the identity of the thing you ran it in. Two different runtimes can share the same error text. A rule whose premise is an environment fact must name the environment it was measured on, and be re-measured after that environment changes (machine migration, harness upgrade, OS reinstall).
- **Target:** new lesson under `lessons/`, e.g. `lessons/prove-the-runtime-not-the-error-text.md` (tags: verification, environment-drift, shell).
- **Proposed change:**
  ```markdown
  # Prove the runtime, not the error text

  Before a rule says "tool {{TOOL}} runs in {{RUNTIME_A}}", prove it with evidence that
  distinguishes A from B: `uname -s` / `$OSTYPE` inside the shell, the process's parent
  chain from the host OS (`ps`, `Get-CimInstance Win32_Process`), or the executable path
  the host spawned. "Command not found" and "no such file" cannot distinguish runtimes.

  Stamp every environment-dependent rule with WHERE it was measured
  ("measured {{DATE}} on {{MACHINE}}"). After a machine migration, harness upgrade, or OS
  reinstall, the stamp is stale and the rule is a hypothesis again — re-measure before
  a guard keeps enforcing it. A one-line probe at session start is cheaper than four
  months of the wrong shell.
  ```
- **Applied?** `no`

---

_Append new entries above this line, newest first._

---

## Fold history

- The twelve entries dated 2026-07-27 through 2026-08-02 were folded into `lessons/` on 2026-08-03 (`Applied? yes`, entries removed per the maintainer flow above).
- The thirteen entries dated 2026-08-03 through 2026-08-08 were folded into `lessons/` on 2026-08-10 (`Applied? yes`, entries removed). Twelve landed as new lesson files; the "write down what you measured, not what it implies about the category" entry was folded BY MEANING into the existing `scope-a-broken-finding-to-the-measured-path` lesson (title widened, `corroborated` raised) rather than duplicated.
- The six entries dated 2026-08-10 through 2026-08-16 were folded into `lessons/` on 2026-08-17 (`Applied? yes`, entries removed). Five landed as new lesson files (`assert-the-guard-saw-something`, `probe-behaviour-not-version-stamps`, `monitor-default-target-is-part-of-the-finding`, `a-suppress-verdict-expires`, `answer-no-such-thing-not-i-wont`); the "match a claim's scope to its evidence's scope" entry was folded BY MEANING into `scope-a-broken-finding-to-the-measured-path` (the entry itself flagged the near-duplicate; `corroborated` raised to 3) rather than added as a sixth file. The same fold added three lessons harvested from the source project's merge history and extended three existing lessons.
- The twelve entries dated 2026-08-17 through 2026-08-22 were folded into `lessons/` on 2026-08-24 (`Applied? yes`, entries removed). Ten landed as new lesson files (`staff-the-shared-layer-before-fanning-out`, `background-agents-die-with-their-host`, `absence-observed-is-not-absence-explained`, `review-docs-against-the-code-seam`, `resumed-session-has-birth-capabilities`, `fresh-fire-wake-handle-costs-a-session`, `delete-the-test-with-its-dead-subject`, `a-pure-wrapper-dies-with-its-service`, `bulk-edit-success-log-is-not-evidence`, `rebuild-an-unrepresentable-tree-with-plumbing`). Two were folded BY MEANING into existing lessons rather than duplicated: "assert the wire effect, not the local variable" into `assert-the-resolved-value-not-the-declaration` (third case added, title widened, `corroborated` raised to 3), and "resurrect stopped subagents by messaging them" into `recovery-from-silent-teammates` (`corroborated` raised to 2). The same fold added eight lessons harvested from the source project's merge history and decision ledger, and extended `verify-at-destination-prove-the-target` with the transforming-intermediary case. Note: the entry on fresh-fire wake handles AMENDED its sibling — a fresh session acts FOR a session-bound durable name without registering, because reclaim-by-register enumerates to `<name>-N`; both lessons landed carrying the corrected version.
- The eleven entries dated 2026-08-26 through 2026-08-30 were folded into `lessons/` on 2026-08-31 (`Applied? yes`, entries removed). Nine landed as new lesson files (`same-machine-peers-use-the-harness-channel`, `a-local-path-is-not-a-shared-artifact`, `a-gate-that-exists-vs-a-gate-that-covers`, `lockstep-failure-means-shared-singleton`, `run-the-formats-own-validator`, `a-silent-guard-needs-a-canary`, `an-omitted-worker-tier-inherits-the-leads`, `grep-the-shipped-artifact-not-the-docs`, `read-which-error-fired-before-theorising`). Two entries — "fail-open error handling hides the bug that caused the failure" and "enforcement fails open; detection must not" — were folded BY MEANING into ONE lesson, `fail-open-on-the-action-never-on-the-record`, because both reduce to the same split (fail open on the ACTION, record on the DETECTION path); they are the same kernel observed from inside a guard and from its design, so the lesson carries both incidents rather than being counted twice. The closest dedup call was `a-gate-that-exists-vs-a-gate-that-covers` against the existing `guard-coverage-enumerate-issuing-surfaces`: same abstract shape (a guard's coverage is narrower than its rule), but different domain, different scope tag, and different actionable method — landed as a separate lesson with reciprocal cross-links rather than folded in. The same fold added four lessons harvested from the source project's merge history and decision ledger (`commit-before-you-mutate-to-test`, `recursive-delete-follows-a-reparse-point`, `exempt-the-generated-field-not-the-file`, `delegate-wide-queries-the-result-set-lands-in-you`) and extended four existing lessons with new cases (`assert-the-resolved-value-not-the-declaration` → 4, `budget-fan-out-against-host-memory` → 2, `latch-once-only-guards-after-success` → 2, `fan-out-multiplier-at-the-delivery-boundary` → 3).
- The seven entries dated 2026-09-01 through 2026-09-06 were folded into `lessons/` on 2026-09-07 (`Applied? yes`, entries removed) — five from the `## Entries` section plus two that had drifted above and below it. Six landed as new lesson files (`gate-the-write-not-the-aftermath`, `one-switch-two-effects-autoupdate`, `unauthenticated-tool-layer-is-not-a-wall`, `fixed-overlay-cannot-scroll-the-page`, `settle-the-first-spa-navigation`, `partial-emulation-hides-a-whole-tier`). The seventh — the byte-order-mark on written files — was folded BY MEANING into `powershell-pipe-bom-breaks-json` rather than duplicated: that lesson already owned the same byte on the INPUT side, so its title widened to cover both directions and it gained the write-side failures (`corroborated` raised to 2). The same fold added seven lessons harvested from the source project's memory files, decision ledger and merge history (`a-read-that-opens-an-edit-is-a-write`, `a-checkout-is-not-the-running-system`, `promoter-strategy-must-match-target-history`, `bucket-by-the-other-systems-calendar`, `a-category-warning-does-not-name-the-token`, `notes-span-from-the-last-delivered-version`, `find-the-asset-before-you-generate-it`) and extended eight existing lessons with new cases (`shell-read-encoding-double-encodes` → 2, `never-test-in-a-live-deployment-tree` → 2, `reviewer-matches-the-tier-it-reviews` → 2, `record-intentional-absence` → 2, `did-not-run-is-a-third-outcome` → 2, `shared-container-pays-every-dependency` → 2, `review-docs-against-the-code-seam` → 2, `a-silent-guard-needs-a-canary` → 2). Two dedup calls are worth recording: a candidate "enumerate a telemetry pipeline's deliberate suppressors before declaring it broken" was folded into `a-silent-guard-needs-a-canary` rather than landed separately, because both reduce to "an absence carries no information about its own cause"; and `a-checkout-is-not-the-running-system` was kept separate from `grep-the-shipped-artifact-not-the-docs` — same family, but one says the installed artifact beats the docs and the other says your working copy is not the installed artifact, with different methods (fetch and query the live system versus grep the binary) and reciprocal cross-links.
