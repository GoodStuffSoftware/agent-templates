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

---

## Entries

### 2026-08-28 — Validating against a known-good example is not validating against the schema

- **Trigger:** A published extension manifest was rejected at install time as invalid. It had been
  authored by copying the shape of a working, installed extension from the same ecosystem — a
  reasonable-looking move. But the reference did not use the one optional section the new manifest
  needed, so the field that was wrong had nothing in the reference to be compared against, and the
  omission was structurally invisible. The toolchain shipped a `validate` subcommand the whole time;
  running it took one second and named the exact field and the exact reason.
- **Is it generic?** Yes. Stripped: the tool, the manifest format, the field. The kernel is that a
  working example proves only that ITS OWN feature subset is valid. Copying one gives you a plausible
  artifact with no coverage of anything the example did not exercise — and the gaps are precisely
  where you are least able to notice them, because there is no line to compare against. Whenever a
  format has a real validator, the example is a starting point and the validator is the check; they
  are not substitutes. Corollary: before publishing any manifest, config, or schema-bound artifact,
  look for a first-party `validate`/`lint`/`check` command and run it — the cost is seconds and the
  failure it prevents lands on users, not on you.
- **Target:** new tagged lesson under `lessons/universal/`. Related to the "verify a harness
  capability against the shipped artifact, not its documentation" entry — same root shape, which is
  trusting a plausible secondary source when an authoritative one is available locally.
- **Proposed change:** For any schema-bound artifact, run the format's own validator before shipping,
  and wire that validator into the project's audit or CI so it cannot regress. Treat "I copied a
  working example" as an unverified claim, not as verification.
- **Applied?** `no`

### 2026-08-28 — Fail-open error handling hides the bug that caused the failure

- **Trigger:** A set of enforcement hooks was deliberately written to fail open — any exception
  falls through and allows the operation — so that a guard could never break a working session.
  Correct for safety. But a genuine parse bug (a byte-order mark on piped input made the payload
  parse throw) was then swallowed by that same catch, and every hook silently became a no-op.
  The output was empty, the exit code was zero, and "guard ran and found nothing wrong" looked
  exactly like "guard never ran". It was caught only by testing against a target KNOWN to trip
  the alarm and getting silence.
- **Is it generic?** Yes. Stripped: the platform, the hook API, the specific encoding bug. The
  kernel is that fail-open and fail-silent are separable, and conflating them is what makes
  fail-open dangerous: the safety property (never block real work) does not require the
  diagnostic property (never report why). A guard that swallows an exception should still record
  it somewhere its monitoring can see. Corollary for testing: a guard can only be verified
  against an input that SHOULD trigger it — a passing run over clean input proves nothing,
  because a completely dead guard produces the identical result.
- **Target:** new tagged lesson under `lessons/universal/`. Closely related to the
  "guard that stops matching is indistinguishable from one never tripped" entry above — this is
  the same hazard one level down, inside the guard rather than in its matcher.
- **Proposed change:** Fail open on the ACTION, never on the RECORD. Every swallowed exception in
  a guard increments a counter or writes a line that monitoring reads. Verify guards with inputs
  designed to trip them, never only with clean inputs.
- **Applied?** `no`

### 2026-08-28 — An omitted sub-agent model is a decision to pay the lead's rate

- **Trigger:** Four top-tier agents ran concurrently on a task that warranted none. No routing rule had
  been broken, because no model had ever been *chosen* — a sub-agent spawned without an explicit `model`
  inherits the MAIN session's model, so a premium lead silently makes every worker premium. The team's
  written rules all governed the act of choosing a tier, and were therefore aimed at a decision that
  never happened.
- **Is it generic?** Yes. Stripped: the model names, the vendor, the project. The reusable kernel is that
  a delegation default which inherits the caller's tier converts one expensive decision into N of them,
  invisibly. Any orchestration system with per-worker capability settings and an inheritance fallback has
  this hazard. Corollary worth stating with it: a rule that governs an explicit choice cannot catch a
  failure that happened by default — audit your DEFAULTS separately from your RULES.
- **Target:** new tagged lesson under `lessons/agent-process/` (scope `[agent-process]`).
- **Proposed change:** State the rule as: always set the worker's tier explicitly at spawn; treat an
  omitted tier as an affirmative decision to pay the orchestrator's rate. Where the harness supports it,
  make the default cheap rather than inherited.
- **Applied?** `no`

### 2026-08-28 — A guard that stops matching is indistinguishable from one never tripped

- **Trigger:** Building enforcement hooks against a harness whose tool names can change between versions.
  A hook whose matcher no longer matches anything does not error — it silently allows everything, and its
  denial count is zero. Zero denials is exactly what a perfectly-behaving team also produces, so the two
  states are indistinguishable from the metric alone.
- **Is it generic?** Yes. Stripped: the tool names, the vendor, the hook API. The kernel: for any guard
  whose "success" signal is the ABSENCE of events, silence is ambiguous between working and broken. Such
  a guard needs a periodic liveness probe that deliberately triggers it and asserts it fired — and the
  monitoring should treat a sustained zero as a reason to run that probe, not as good news.
- **Target:** new tagged lesson under `lessons/universal/`.
- **Proposed change:** Any guard measured by non-events ships with a canary that provokes a known
  violation and asserts the denial. Sustained zero-violation counts trigger the canary rather than
  reassure.
- **Applied?** `no`

### 2026-08-28 — Enforcement fails open; detection must not

- **Trigger:** Designing a guard that must restrict the main orchestration thread while never interfering
  with worker agents. The identifier distinguishing them is settable at runtime and its value set can grow
  as the harness adds new worker kinds. Blocking on "not a known worker type" would break every future
  worker; allowing silently would let the guard quietly become inert.
- **Is it generic?** Yes. Stripped: the field name, the harness, the type values. The kernel is a split
  most guard designs conflate: the ENFORCEMENT path should require positive confirmation and default to
  allowing (so an unrecognized case never breaks work), while the DETECTION path should record every
  unrecognized case (so drift surfaces instead of accumulating). Fail-open and fail-loud are not opposites
  and belong in the same guard.
- **Target:** new tagged lesson under `lessons/universal/`.
- **Proposed change:** Guards enforce on allowlists, never denylists; anything outside the allowlist is
  permitted AND logged for review. Under-enforcement is the safe failure; silent under-enforcement is not.
- **Applied?** `no`

### 2026-08-28 — Verify a harness capability against the shipped artifact, not its documentation

- **Trigger:** Two research agents returned contradictory answers about which tool name a lifecycle hook
  must match to intercept agent spawns. Both cited documentation; one cited a specific page and line.
  Grepping the installed binary settled it in one command — and revealed the losing answer had named a
  DIFFERENT tool entirely (a task-list tool, not the spawn tool). The binary even shipped an error string
  distinguishing the two, written for exactly this confusion. A guard built on the wrong name would not
  have errored; it would simply never have fired.
- **Is it generic?** Yes. Stripped: the tool names, the vendor, the file path. The kernel: for any
  integration keyed on an exact identifier, the shipped artifact is authoritative and cheap to interrogate
  (strings/grep), while documentation lags releases and third-party summaries hallucinate confidently.
  Second kernel, worth its own line: when two agents disagree on a load-bearing fact, do not average them
  or pick the better-cited one — go to the primary artifact.
- **Target:** new tagged lesson under `lessons/agent-process/` (scope `[agent-process]`).
- **Proposed change:** Before shipping an integration keyed on an exact external identifier, confirm the
  identifier against the installed artifact. Treat agent disagreement on such a fact as a signal to
  consult the artifact, never as a tie to be broken by citation quality.
- **Applied?** `no`


### 2026-08-26 — Read WHICH error message fired before forming a theory about the cause

- **Trigger:** A payment-verification failure was one step from being diagnosed as a missing server-side
  config flag. The function emits two near-identical user-facing strings from two different failure paths:
  one from the `catch` (the request threw — network/parse, no usable response) and one from the response
  check (the server answered and declined, with the status interpolated). The config-flag theory predicted
  the SECOND string, carrying an HTTP status. The string the user actually saw was the FIRST. The flag was
  never involved, and turned out to be correctly set all along. One grep for the literal string separated
  the two paths and killed a config hunt before it started.
- **Is it generic?** Yes. Stripped: the product, the payment provider, the flag name, the file path. The
  reusable kernel is that a call which can fail BOTH by throwing AND by receiving a negative response
  normally emits different messages per path, so the message already in hand is free evidence about which
  half failed — and it costs one grep to read. Corollary worth stating with it: a theory that predicts a
  *different* observable than the one you actually have is already refuted, before any investigation.
  Distinct from the existing "reproduce, don't theorize" lesson: this one is about mining evidence you were
  ALREADY handed, not about generating new evidence.
- **Target:** new tagged file under `lessons/`, suggested slug `read-which-error-fired-before-theorising`.
- **Proposed change:**
  > **Read which error fired before theorising about the cause.**
  > When a code path can fail by throwing *and* by receiving a negative response, it usually reports those
  > two cases with different wording. Before investigating a suspected cause, grep the exact message the
  > user or the log actually produced and find which branch emits it. That single fact often eliminates a
  > whole class of causes for free.
  > Then apply the check in reverse: state what your candidate theory *predicts* the observable would be.
  > If the prediction does not match the observable in hand, the theory is already refuted — stop and pick
  > another, rather than starting an investigation that cannot confirm it.
  > Example shape: `{{SYMPTOM_A}}` ("could not reach {{SERVICE}}") is emitted only from the `catch` block,
  > while `{{SYMPTOM_B}}` ("could not confirm yet ({{STATUS}})") is emitted only when a response came back
  > and was rejected. A misconfiguration that returns `{{STATUS}}` can therefore only ever produce
  > `{{SYMPTOM_B}}`; observing `{{SYMPTOM_A}}` rules it out without touching the config.
- **Applied?** no

---

_Append new entries above this line, newest first. The queue was drained by the 2026-08-24 fold._

---

## Fold history

- The twelve entries dated 2026-07-27 through 2026-08-02 were folded into `lessons/` on 2026-08-03 (`Applied? yes`, entries removed per the maintainer flow above).
- The thirteen entries dated 2026-08-03 through 2026-08-08 were folded into `lessons/` on 2026-08-10 (`Applied? yes`, entries removed). Twelve landed as new lesson files; the "write down what you measured, not what it implies about the category" entry was folded BY MEANING into the existing `scope-a-broken-finding-to-the-measured-path` lesson (title widened, `corroborated` raised) rather than duplicated.
- The six entries dated 2026-08-10 through 2026-08-16 were folded into `lessons/` on 2026-08-17 (`Applied? yes`, entries removed). Five landed as new lesson files (`assert-the-guard-saw-something`, `probe-behaviour-not-version-stamps`, `monitor-default-target-is-part-of-the-finding`, `a-suppress-verdict-expires`, `answer-no-such-thing-not-i-wont`); the "match a claim's scope to its evidence's scope" entry was folded BY MEANING into `scope-a-broken-finding-to-the-measured-path` (the entry itself flagged the near-duplicate; `corroborated` raised to 3) rather than added as a sixth file. The same fold added three lessons harvested from the source project's merge history and extended three existing lessons.
- The twelve entries dated 2026-08-17 through 2026-08-22 were folded into `lessons/` on 2026-08-24 (`Applied? yes`, entries removed). Ten landed as new lesson files (`staff-the-shared-layer-before-fanning-out`, `background-agents-die-with-their-host`, `absence-observed-is-not-absence-explained`, `review-docs-against-the-code-seam`, `resumed-session-has-birth-capabilities`, `fresh-fire-wake-handle-costs-a-session`, `delete-the-test-with-its-dead-subject`, `a-pure-wrapper-dies-with-its-service`, `bulk-edit-success-log-is-not-evidence`, `rebuild-an-unrepresentable-tree-with-plumbing`). Two were folded BY MEANING into existing lessons rather than duplicated: "assert the wire effect, not the local variable" into `assert-the-resolved-value-not-the-declaration` (third case added, title widened, `corroborated` raised to 3), and "resurrect stopped subagents by messaging them" into `recovery-from-silent-teammates` (`corroborated` raised to 2). The same fold added eight lessons harvested from the source project's merge history and decision ledger, and extended `verify-at-destination-prove-the-target` with the transforming-intermediary case. Note: the entry on fresh-fire wake handles AMENDED its sibling — a fresh session acts FOR a session-bound durable name without registering, because reclaim-by-register enumerates to `<name>-N`; both lessons landed carrying the corrected version.
