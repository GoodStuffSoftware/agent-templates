# Contributions Inbox

A holding area for generic improvements contributed back from real projects when no pull-request workflow is available. Entries here are **not yet applied** — a maintainer folds each one into its proper template/shared file (see [CONTRIBUTING.md](CONTRIBUTING.md) → "Where it goes") and then removes it from this file.

**This is a queue, not a home.** A change isn't "done" while it's only in the inbox.

## 2026-09-09 landing-crew session ({{PROJECT}})

- **A merge box that rebases sources itself will refuse anything it cannot auto-resolve; rebase locally onto the CURRENT integration tip immediately before every trigger.** Observed: a one-commit branch three docs commits behind was refused. Pattern: backup ref, local rebase, push --force-with-lease, trigger; repeat per landing because each merge moves the tip.
- **Hold long waits in a cheap foreground worker, not a background loop in the lead.** A haiku-tier agent runs a node poll script (2-minute interval, ~9.5-minute runs, exit 0 on idle / 3 on still-running) and returns once with the verdict; the lead blocks on it. Background shell loops time out and wake the lead for empty turns, and can die with the host.
- **Shared-box E2E capacity degrades across an evening of gates** (free memory 6.6 GB to 2.9 GB, auto-reduced from 4 workers to 1); timing-sensitive cases then fail 3 of 3. Read the runner plan lines before blaming the test, and card the orphan reaper.
- **Deferred connector-prefixed MCP tools surface only after the first tool call**; a "plugin needs authentication" banner is a separate login. Search the toolset for the capability name under any prefix before falling back to REST.
- **Stack a small reviewed fix under a larger reviewed branch so one gate lands both** when gates are the bottleneck; keep them as distinct commits.

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

**Placement note:** entries go under `## Entries

## Entries

### 2026-09-11 — A case-insensitive platform hides a case-sensitive bug

- **Trigger:** A helper built an environment-variable name from a lowercase
  identifier — `{{ENV_PREFIX}}_${lowercaseKey}` — while the platform that sets
  the variable uppercases the key itself
  (`{{ENV_PREFIX}}_${lowercaseKey.toUpperCase()}`). `process.env` property
  lookup is case-insensitive on {{OS_A}} but case-sensitive on {{OS_B}} and
  {{OS_C}}, so the lookup worked by accident on a {{OS_A}} development machine
  and silently returned every option's default everywhere else, including
  cloud and hosted runtimes. The bug was latent for months because no config
  value had ever actually been set until a real user set one from a
  non-{{OS_A}} host.
- **Is it generic?** Yes — strip the specific env-var prefix and the plugin
  name; the reusable kernel is platform-dependent case sensitivity around any
  identifier a program builds itself (env var names, file paths, headers),
  verified only on the one platform where the mismatch happens not to matter.
- **Target:** a new lesson under `lessons/env/`.
- **Proposed change:** the lesson is that **a case-insensitive platform hides
  a case-sensitive bug**. Code that builds an environment-variable name from a
  lowercase identifier, when the platform that exports it uppercases the key,
  works perfectly on {{OS_A}} and fails silently everywhere else — no error,
  just defaults, so it survives every local test on the developer's own
  machine and only appears on a different OS, typically in CI or a hosted
  runtime nobody debugs interactively. Generalize past env vars: whenever
  correctness depends on case, path separators, or line endings, "it works on
  my machine" is evidence about the platform, not the code — and a config
  value that silently falls back to a default is far more dangerous than one
  that throws, because nothing ever reports it. Fix pattern: normalize the
  case (or separator/line-ending) explicitly at the lookup site instead of
  relying on the platform to paper over the mismatch, and prefer failing
  loudly over falling back silently when a value was supposed to be set.
- **Applied?** `no`

### 2026-09-11 — A version bump does not invalidate every downstream cache

- **Trigger:** a plugin published through a marketplace was updated and verified green by every
  local check — the marketplace cache commit, the installed-version report, the manifest version
  match — yet a separate hosted client that also consumes the same marketplace kept serving the
  previous version's hooks and skills. The update sequence run on the local machine never touched
  the hosted client's own cache; it is a different cache, on a different machine, with no shared
  refresh path. The fix that worked was removing the hosted client's copy of the marketplace and
  re-adding it — a version bump alone did not invalidate it.
- **Is it generic?** Yes — it applies to any artifact distributed through a cache that more than
  one client consumes independently, not just this plugin system.
- **Target:** a new lesson under `lessons/agent-process/`.
- **Proposed change:** the lesson is that **"verified" is scoped to the cache you verified**. When
  one artifact is consumed by two clients with independent caches, a green check on one says
  nothing about the other, and the failure is silent on the stale side — it serves old code rather
  than erroring. Enumerate every consumer of a published artifact and verify each one separately,
  or state plainly which ones were not checked. Corollary: a version bump does not necessarily
  invalidate a downstream cache; some caches require explicit removal and re-add rather than an
  update-in-place.
- **Applied?** `no`

### 2026-09-11 — An integration gate catches what a builder's self-report does not

- **Trigger:** A builder agent reported `{{VALIDATE_CMD}}` as passing ("Validation passed") in its
  completion report. An independent integration step run later, on the merged tree, found that same
  command exiting non-zero: the skill it had just authored had YAML frontmatter with an unquoted
  `Triggers: ` inside a plain scalar, which terminates the scalar. The skill would have loaded with
  **empty metadata and never triggered** — a silent failure, not a crash. Everything else the builder
  reported was accurate and independently reproduced, so this was not a careless agent; it was a
  self-report of a check that was either run at the wrong moment or not re-run after a later edit.
- **Is it generic?** Yes. Any pipeline where the agent that writes the code is also the agent that
  reports the verification has this hole, regardless of tool or language. It is sharper for
  **manifest/frontmatter validation** specifically, because the failure mode is silent degradation
  rather than an error at runtime — nothing downstream would have complained.
- **Target:** a new lesson under `lessons/agent-process/`.
- **Proposed change:** *Re-run the validating command at the integration point, on the merged tree,
  and treat the builder's report of it as a claim rather than a result.* A builder's self-verification
  is still worth demanding — it catches most things cheaply and early — but it is evidence, not proof,
  because it is taken at a moment the builder chooses and on a tree only the builder has seen. Put the
  authoritative run where nothing can be edited after it: the same place the merge happens, with an
  explicit "if this fails, do not publish" rule. Corollary for briefs: tell the integrator the expected
  passing output, so a *changed* result is as visible as a failing one.
- **Applied?** `no`

` below, newest first — not above this section, and not below the fold history. Entries drifted out of that section in both the 2026-08-31 and 2026-09-07 folds, which is easy to do and harmless, but the queue reads correctly only when every pending entry lives in one place.

---

### 2026-09-09 — Never pipe a test gate through `tail`: you discard the evidence and the exit code

- **Trigger:** a CI-style gate ran the unit suite as `<test-runner> 2>&1 | tail -6`. The run reported 2 failed test FILES, but `tail` kept only the summary and discarded the FAIL lines, so the failing files could never be named. Worse, the failure set turned out to be non-deterministic under load, so re-running could not recover the lost names — the evidence was gone permanently. A second defect rode along: in a pipeline the shell reports the LAST command's exit status, so `$?` was `tail`'s `0` and the gate looked like it passed.
- **Is it generic?** Yes. Stripped: the runner, the project, the specific failing files. The kernel is about how you capture output from any gate that can fail: truncation is destructive when the interesting content is in the middle, and pipelines lie about exit codes by default. Applies to test runners, linters, builds, deploy scripts — anything whose failure detail you might need after the fact.
- **Target:** a new tagged file under `lessons/` — tags `testing`, `ci`, `shell`, `diagnostics`.
- **Proposed change:**

  > **Capture gate output in full; never truncate it in the pipeline.**
  >
  > Write the complete output to a file and read the file:
  >
  > ```bash
  > {{RUNNER}} > "{{OUT}}" 2>&1; status=$?
  > grep -nE 'FAIL|Error|✕' "{{OUT}}" | head -40
  > ```
  >
  > Two distinct failures come from `{{RUNNER}} | tail -N`:
  > 1. **The evidence is destroyed.** Failure detail is emitted *before* the summary, so a tail window sized to catch the summary discards exactly the part naming what broke. When the failure is non-deterministic, re-running does not recover it — that information is gone for good.
  > 2. **The exit code is wrong.** A shell pipeline reports the LAST command's status, so a failing run piped into a succeeding `tail`/`head`/`grep` looks like success. Capture the status from the runner directly, or set `pipefail` where the shell supports it.
  >
  > Truncate only when *displaying* something you have already stored. The stored artifact is the source of truth; the terminal view is a convenience.
  >
  > Corollary for flaky suites: when a failure will not reproduce, the run that captured it was your only sample. Treat full-output capture as a precondition for investigating flakiness at all, not as something to add after a flake appears.

- **Applied?** `no`

### 2026-09-08 — A denylist security rule makes DEPLOY ORDER a security property

- **Trigger:** a spec's deploy note said a new server-trusted field was "admin-only either way, so there is no client-facing window", and justified the rules-before-code ordering as mere tidiness. It was false. The document's rules had no key *allowlist* — only a *denylist* of fields the owner may not write — so any field not named in that list was fully client-writable. The rules deploy was the only thing making the field admin-only. Shipping the writing code first would have opened a live self-grant window on a paid entitlement, repeatable from throwaway accounts until the cap drained. The reviewer proved it by deleting the field from the denylist and watching every deny assertion flip to "Expected request to fail, but it succeeded". The *instruction* had been right all along; the *reason* attached to it told operators the order did not matter.
- **Is it generic?** Yes. Stripped: the product, the field name, the entitlement, the vendor's rules language. The reusable kernel is a property of allowlist-vs-denylist authorization generally — under a denylist, a field is server-trusted only from the moment its denylist entry is LIVE, so the write-side deploy must never precede the policy deploy. A second, sharper kernel: a correct instruction paired with a false justification is more dangerous than no instruction, because the justification is what a future engineer reasons from when deciding whether the instruction still applies.
- **Target:** a new tagged file under `lessons/` — tags `security`, `deploy-ordering`, `authorization`, `documentation`.
- **Proposed change:**

  > **Under a denylist, deploy order is a security property.**
  >
  > When an authorization policy protects fields by naming what callers may NOT write (a denylist) rather than what they MAY write (an allowlist), every field not yet named is writable by default. A "server-only" field is therefore server-only only from the moment its policy entry is DEPLOYED — not from the moment it is committed.
  >
  > So: **deploy the policy before the code that writes the field.** Reversing it opens a window in which clients can forge the field themselves. The window is invisible in code review, because the repository shows policy and code landing together.
  >
  > Check for this whenever adding a field to `{{POLICY_FILE}}`: does the rule enumerate permitted keys, or merely forbidden ones? Confirm it by DELETING your field from the denylist and re-running the negative tests — if they still pass, they were never testing your field.
  >
  > Two traps observed together:
  > - **A parity test between a constant and the policy FILE proves nothing about the DEPLOYED policy.** Those are different artifacts, and the gap between them is exactly the deploy-ordering window. If you need the guarantee, assert against the live policy.
  > - **Create and update paths can carry different preconditions.** A field may be adequately guarded on update yet plantable on create, where fewer clauses apply — often by a brand-new account, which is the cheapest attacker to be.
  >
  > When you correct an ordering instruction, correct its REASON too, and say plainly what the old reason claimed and why it was wrong. Otherwise the discredited rationale gets reconstructed from memory and the safeguard is dropped as pointless.

- **Applied?** `no`

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

## 2026-09-11 — A sub-agent reporting to its spawner needs no address, and giving it one causes misroutes

**Shape:** orchestration / briefing.

Harness-agnostic briefing advice of the form *"report via SendMessage to
`{{ORCHESTRATOR_ALIAS}}`; if that does not resolve, use `{{FALLBACK_ALIAS}}`"*
assumes the spawner is addressable by name. A session started from a
background-task chip is not — it carries a human-readable title, not an agent
name, so **both** aliases fail.

Observed: a writer sub-agent inside such a session found neither address,
searched session transcripts for one that mentioned its worktree name, and
delivered its completion report to the **grandparent** session that had written
the plan. That session had no authority over the work and had to relay it back
down. One wasted hop, and a report that nearly went unread entirely.

**The fix is to remove the address, not to improve it.** A sub-agent spawned
with the Agent tool returns its final message to its spawner automatically —
that return value is the channel, and it cannot misroute. Brief sub-agents to:

- put their ENTIRE report in their final assistant message
- write anything long to a file in the branch, and name the path

Reserve named-address messaging for genuine peers (standing teammates, other
sessions). Never for a sub-agent reporting to the thing that spawned it.

**Generalization:** whenever a brief names a channel, ask whether the channel
is guaranteed to exist in the context the agent will actually run in. A brief
that depends on an unverified channel has no channel.
