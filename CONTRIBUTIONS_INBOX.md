# Contributions Inbox

## 2026-09-19 - a check whose expected value came from the thing being checked cannot fail ({{PROJECT}})

- **The shape to hunt for: an assertion derived from the implementation it is supposed to test.** A sanitizer replaced
  punctuation with hyphens; its unit test asserted the output did not contain `@` or the domain, and passed *because*
  the transform had removed exactly those characters. Content survived, readable, and was newly shipped to a public
  unauthenticated endpoint. Fix the guarantee rather than the wording: validate the whole input against the real shape
  of what is allowed and bucket everything else, then rewrite the test to assert on what SURVIVES, not on what is
  absent.
- **It recurs one level up, in the reviewer.** The same session's reviewer pre-computed the expected post-rebase file
  byte-for-byte and SENT IT to the implementer before checking the work. A later match would have proven transcription,
  not correctness. Verify against sources neither party authored (what the upstream ref actually contains), and treat a
  matching hash as a bonus rather than as the evidence. That reviewer's own independent check then came back FAIL while
  the hash matched; the fault was a bug in its own checker. Had it trusted the hash it would have been right by luck.
- **Mutation-test every guard test: break the production code, confirm the named test goes red, restore.** In one batch
  five of six mutations were caught by the specifically-named test; the sixth slipped past the test named for exactly
  that job because of a case-sensitivity blind spot, and was only caught by two unrelated tests. Ask a reviewer which
  tests it did NOT mutate, and whether any surviving test shares the flaw shape it already found.
- **Do not let a bound be specified by someone who has not counted.** A reviewer-specified length bound would have
  silently bucketed a real, valid, longer value into the catch-all, deleting a whole failure mode from the data with no
  symptom. The implementer checked the actual vocabulary, widened the bound and added a test asserting every known key
  survives validation. Guard the class, not the instance.

## 2026-09-19 - prove outcomes by the result, never by an exit code ({{PROJECT}})

- **A push exited 141 (SIGPIPE) with the pre-push gate already GREEN and a "recorded green pass" log line, while the
  remote ref had not moved.** Twice on one branch. A green gate plus a plausible exit code both read as success and
  neither was. Every brief that asks a worker to push must require the remote ref and the local ref reported side by
  side with an explicit MATCH / DOES NOT MATCH; "pushed, exit 0" is not evidence. Generalises: a `204` from an ingest
  endpoint means the payload was accepted, not that the record exists.
- **A diff against a base that moved renders the missing commits as DELETIONS.** Diffing a feature branch against an
  advanced integration tip showed ~2400 deletions across unrelated subsystems and read exactly like a worker having
  destroyed half the repo; the true diff against the actual merge base was 42 deletions. Check the merge base before
  believing a large deletion count, and before accusing anyone.
- **Untracked scratch files silently defeat a clean-tree-gated CI short-circuit.** Two audit notes written into a
  worktree by an earlier agent kept the tree dirty, so the pre-push "inherited green" path never fired and every push
  ran a full suite: roughly six unnecessary runs at four to six minutes each. The fix was two `rm` commands. Orchestrators
  should send agent scratch output to a scratch directory OUTSIDE the repo, and check `git status --porcelain` including
  untracked when test runs seem unexpectedly slow.
- **When a release carries no version bump, build a version-independent deploy marker.** Confirm a unique string from the
  new code is ABSENT from every served bundle chunk immediately before deploying; its appearance afterwards then proves
  the code is live regardless of what any version field says. Take the baseline on the exact host you will test, not a
  sibling host you assume serves the same build - and note that an app resolving an API endpoint relative to its own
  origin means probing the endpoint on the wrong host proves nothing.

## 2026-09-19 - an empty error log is not evidence of health: audit what the code CAPTURES ({{PROJECT}})

- **A live, correct crash pipeline can record nothing and still be read as "no problems".** A {{APP}} owner suspected a
  broken sign-in because conversions were low. The error backlog held zero auth entries, and an agent nearly reported
  that as health. Reading the code showed the auth error mapper sent only a small config-class set of error codes to the
  capture API; every other failure (blocked popup, closed popup, network, rate limit, unsupported environment, and the
  default branch) became UI text only, and the redirect-completion handler swallowed its errors with no UI and no
  telemetry. Absence of records was a property of the instrumentation, not of the system.
- **Rule: before reporting "no errors in X", enumerate what reaches X.** Grep every catch/error branch on the path and
  classify each as captured / beaconed / user-visible only / silently swallowed. Report the silent set as a finding in
  its own right. The same applies to a metric that reads zero: prove the emitter can fire at all (a sibling event that
  DOES land is the cheapest control) before concluding the underlying behaviour never happened.
- **Pair it with a known-good positive control.** The owner had signed in that day. Checking that one known event
  through every layer (identity provider, database record, analytics) separated "the funnel is empty" from "the
  measurement is broken" in one pass, and found a second, unrelated gap: one analytics surface had been silent for days.
- **When instrumentation is the gap, ship the capture BEFORE the fix.** Otherwise the fix cannot be evaluated, and a
  config change with a visible cost (here, a domain move that logs every existing user out once) gets argued from
  theory. Fingerprint the new signal into the existing dedup model (one row per unique error with counts and
  first/last-seen timestamps) rather than adding a per-occurrence log, so volume stays gate-able.

## 2026-09-19 - a forked child registered as ephemeral cannot be messaged by its parent ({{PROJECT}})

- **An ephemeral bus identity is send-only.** A parent forked a child session and briefed it to register on the agent bus as
  ephemeral (the usual shape for a one-task worker). When the parent later had context for the child, the send was
  refused (`skipped: ephemeral`), with nothing queued. If the parent may need to reach the child, brief a non-ephemeral
  registration under a stable name. For a child on the same machine, the session channel (list sessions by title, then
  send a message into that session) works as a fallback and queues behind the current turn of the child.

## 2026-09-19 - contributing to someone else's codebase: reuse their helpers, prove "ours is better" ({{PROJECT}})

- **Workers extending an upstream author's code tend to invent a new helper every time.** Across a multi-agent session
  on a third-party plugin/loader codebase, one-shot workers kept writing their own widgets, config accessors and utility
  structs, even where the author's SDK or other repos already had one. Two copies of the same widget even landed in two
  sibling repos. Every parallel system makes an upstream contribution harder to accept. Put three rules in every writer
  brief: use the author's helpers unchanged by default (search their SDK, headers and sibling repos first); keep your own
  only with a concrete advantage (correctness, thread safety, no per-frame I/O); factor out a helper at 3+ repeats.
- **Gate the change with an adversarial helper-reuse review before pushing.** Use verdicts REUSE-AVAILABLE /
  MODIFIED-THEIR-HELPER / PARALLEL-SYSTEM / OURS-BETTER / NEEDS-HELPER / JUSTIFIED-NEW. The reviewer must try to refute
  each finding (is the helper reachable, equivalent, thread-safe for this caller?) before it counts. "Different style" is
  never OURS-BETTER.
- **Check the author's own docs before assuming a platform limit.** A worker hand-drew an icon because "the font has no
  glyphs beyond ASCII". The author's docs said the UI library loads any glyph from the bundled icon font on demand, so
  one character would have done it.

## 2026-09-18 - a quarantined file resurrected by a copy-only sync, and a focus-steal traced by wake timing ({{PROJECT}})

- **A local quarantine does not hold while a copy-only sync still has the file remotely.** A stale app-state file was
  moved out of the live store to stop a side effect. Weeks later it was back, with its ORIGINAL modification time, because
  the roaming sync tool pushes with `copy` (never deletes on the remote) and a later pull restored the remote copy. The
  tell is a file mtime older than the quarantine date. Fix it on both sides: move the remote copy to a quarantine path too,
  or write a newer local version (e.g. set the state via the app) so newest-wins overwrites the remote. Check that the
  tool's exclude setting is actually wired before relying on it; here it was declared but never consumed.
- **Trace an intermittent focus-steal by what starts just BEFORE the stealing window, not by what runs a lot.** Poll the
  foreground window plus new-process creation (with parent chains) into a log. The busiest process near each event (shell
  spawns every few seconds) was a coincidental match. The real signal was a service instance (a UNC-path filesystem
  redirector) starting a fraction of a second before every VM wake, at a fixed ~35s cadence. Validate a watcher script with
  a parse check before backgrounding it: a non-ASCII dash broke a PowerShell 5.1 script, and the watcher "ran" while
  capturing nothing.
- **When polling can't name the culprit, a built-in kernel file trace can - no third-party tools.** A long-running process
  opening a path shows no process-start event, so process watchers only narrow the field. On Windows, one elevated
  script names it: `logman start <name> -p Microsoft-Windows-Kernel-File 0x90 0x4 -o <file>.etl -ets` (keywords =
  FILENAME + CREATE), snapshot the process list during the window, `logman stop`, then `Get-WinEvent -Path <etl> -Oldest`
  and keep events whose string properties match the path. It showed the app's main process opening a stale session's
  working folder, which several rounds of elimination had only suspected.

## 2026-09-18 - least privilege for a model-in-the-loop CI job ({{PROJECT}})

- **Routine/agent creation APIs can attach every account connector by default - read the created object back.** A
  scheduled cloud agent created with no connector list returned with all of the account's connectors attached (mail,
  file storage, calendar, an internal ops bus). Its tool allowlist did not remove them. An agent meant only to write
  prose from a file had mail access. Always read back the created object and explicitly clear or enumerate connectors.
- **Repository secrets are readable by a workflow file pushed to ANY branch.** If an automated agent can push branches
  (even a restricted namespace), it can push a workflow that prints the repo's secrets. Put the secrets in a deployment
  environment restricted to the default branch, and trigger the privileged job by schedule or from the default branch -
  never by the agent's push, because a push-triggered run executes the PUSHED branch's copy of the workflow.
- **A leak gate must not print what it blocked when its log is public.** On a public repository, CI logs are public; a
  gate that echoes the offending text or the blocked output publishes the leak it stopped. Report the category only in
  CI (detect via the CI env var) and show detail only locally.
- **Shape a canary to the threat it detects.** A regression that forwards private text reproduces PHRASES; single-word
  overlap with a corpus of full-sentence commit messages is mostly coincidence and made the gate fire on innocent
  output. Fail on shared word-trigrams (containing at least one distinctive word) or on a cluster of 3+ distinctive
  words; log, do not fail, on one or two.
- **State isolation claims at the strength you can prove.** "The agent cannot reach X" was true of the tokens we issued
  but not provable about the platform integration that also grants access. Write the property as it holds and name what
  must be confirmed, rather than letting the stronger claim stand in docs.

## 2026-09-18 - versions pinned from memory, and "not configured" failing like "broken" ({{PROJECT}})

- **Never pin a version from memory - look it up in the same step you write it.** A CI workflow was written with
  a runtime version that was already deprecated on the runners, and an SDK dependency range pinned 57 minor versions
  behind current - both from recall, in a session that HAD looked up the model IDs it used. Recall is training-data
  stale by construction. The lookup is one command (`npm view <pkg> version`, the runtime's release index JSON,
  `gh api repos/<owner>/<repo>/releases/latest`), so make it part of writing the pin, not a later audit. For runtimes
  with LTS lines, treat "current" as newest LTS unless told otherwise, and say which you chose.
- **A scheduled job must distinguish "not set up yet" from "broken".** A digest workflow shipped before its secrets
  existed failed every night: one failure email per day and a row of red crosses on a public repo, for nothing that was
  actually wrong. Gate the work steps on the secrets being present (job-level env from the secrets context, step-level
  `if:` on that env) and emit a notice when skipping; keep checkout and install unconditional so a skipped run still
  proves the toolchain installs. Fail loudly only when configured-and-failing - that is the case worth an email.
- **Evaluate the executor against the task's TRUE consequence, not the convenient one.** Deleting a handful of failed CI
  run records was first classified "low" and evaluated as a fit for the cheapest tier; re-classified honestly as a
  destructive op, the routing table asked for the top tier. The resolution was not to spawn a premium worker for five
  commands but to note the lead was already on that tier and do the one destructive step there, with a per-item check
  before each delete - and push everything else down. Classify first, then find the cheapest executor at that tier.

A holding area for generic improvements contributed back from real projects when no pull-request workflow is available. Entries here are **not yet applied** — a maintainer folds each one into its proper template/shared file (see [CONTRIBUTING.md](CONTRIBUTING.md) → "Where it goes") and then removes it from this file.

**This is a queue, not a home.** A change isn't "done" while it's only in the inbox.

## How to add an entry

Append a new dated entry at the **top** of the Entries list (newest first), using the template below. Before adding it, run `node scripts/leak-check.mjs` — the entry must contain no real-world tokens (generalize specifics to `{{PLACEHOLDERS}}` or generic examples first).

```markdown
### YYYY-MM-DD — <short title>

- **Trigger:** what surfaced this (the gotcha / better step / missing rule).
- **Is it generic?** the result of the "is this generic?" test — what specifics were stripped, what reusable kernel remained.
- **Target:** where it should land. For a **rule, gotcha, or hard-won lesson** this is a new tagged file under `lessons/` — knowledge is never pasted into an agent def or into `anthropic/shared/cross-project-rules.md` (that page is a pointer and enumerates nothing). Use a template path (e.g. `anthropic/basic-site/agents/site-builder.md`) only for scaffolding changes.
- **Proposed change:** the actual generalized text / diff, with `{{PLACEHOLDERS}}` in place of any real values.
- **Applied?** `no` (a maintainer flips this to `yes` and removes the entry once folded in).
```

**Placement note:** every pending entry goes under `## Entries` below, newest first — not above that section, and not below the fold history. Entries drifted out of it in the 2026-08-31, 2026-09-07 and 2026-09-14 folds, which is easy to do and harmless, but the queue reads correctly only when every pending entry lives in one place. A free-form entry is fine too — the template is a convenience, not a schema.

## Entries

_(empty — everything queued through 2026-09-14 was folded; see the fold history below.)_

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
- The sixteen entries dated 2026-09-07 through 2026-09-14 were folded into `lessons/` on 2026-09-14 (`Applied? yes`, entries removed) — nine from the `## Entries` section plus seven that had drifted above and below it. Seventeen landed as new lesson files (`a-cli-script-without-a-main-guard-runs-on-import`, `withhold-at-the-payload-not-in-the-prompt`, `prove-a-root-cause-by-reverting-only-it`, `an-unquoted-heredoc-executes-its-content`, `an-ephemeral-instance-can-print-a-first-run-secret`, `hold-a-wait-in-a-cheap-foreground-worker`, `stack-work-behind-a-serialized-gate`, `a-case-insensitive-platform-hides-a-case-sensitive-bug`, `a-version-bump-does-not-invalidate-every-cache`, `re-run-the-gate-at-the-integration-point`, `order-the-brief-so-parking-is-harmless`, `verify-a-citation-before-it-becomes-an-assumption`, `capture-gate-output-in-full`, `under-a-denylist-deploy-order-is-a-security-property`, `deliver-the-judgment-not-a-pointer-to-it`, `prove-the-runtime-not-the-error-text`, `brief-for-the-decision-not-your-conclusion`). Six bullets inside multi-bullet entries were folded BY MEANING into existing lessons rather than duplicated: backgrounded runs dying with a parked agent into `background-agents-die-with-their-host` (a log with no summary is NOT RUN); routing-tool-over-taste into `an-omitted-worker-tier-inherits-the-leads` (effort is definition-locked, so pick the DEFINITION); rebase-before-every-trigger into `promoter-strategy-must-match-target-history`; degrading shared-box capacity into `budget-fan-out-against-host-memory`; deferred connector tools arriving mid-session into `tool-listing-is-scope-filtered` (absence is point-in-time, and a negative listing expires); and canary mis-tuning into `a-guard-reused-across-contexts-can-invert`. One whole entry — "a sub-agent reporting to its spawner needs no address" — was folded into `resolve-the-reply-to-address` as an AMENDMENT (title widened: for a sub-agent the fix is to REMOVE the address, because the spawn tool's return value is the channel), not added as a rival lesson. The same fold added five lessons harvested from the source project's memory files, decision ledger and merge history (`a-recorded-commit-id-dies-at-rebase`, `a-maintenance-write-fires-the-same-triggers`, `your-own-usage-is-in-the-metric`, `revalidate-a-deferred-action-at-execution-time`, `a-default-timeout-shorter-than-cold-start-manufactures-flakes`) and extended eight more existing lessons with new cases (`monitor-default-target-is-part-of-the-finding` → 3, `secret-resolution-fallback-chain` → 3, `correct-a-durable-record-explicitly` → 2, `match-instrument-to-failure-class` → 3, `heartbeat-over-time-box` → 3, `resumed-session-has-birth-capabilities` → 2, `ship-the-safe-handle-first` → 2, `outcome-level-reporting` → 2). Three dedup calls are worth recording: `a-version-bump-does-not-invalidate-every-cache` was kept SEPARATE from `one-switch-two-effects-autoupdate` (same family — a second cache serving the old version — but one is vendor-scoped and about a switch with two effects, the other universal and about independent consumers of one channel; reciprocal cross-links instead); `stack-work-behind-a-serialized-gate` carries the economic case while the safety case (hazard and guard in one release) went into `ship-the-safe-handle-first`, with each pointing at the other; and a candidate "name the funnel stage before blaming the source" was folded into `match-instrument-to-failure-class` as the unfalsifiable-rule case rather than landed as its own lesson.
