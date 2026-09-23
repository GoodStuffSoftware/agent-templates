# ADR 0002 — retrieving gotchas by symptom, scoped to the project's stack, at the moment a tool call fails

**Status:** Accepted
**Date:** 2026-09-21
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

> Builds on `docs/memory-layer-evaluation.md` (§7.2a, §7.2b, §7.3, §9) and does not
> contradict it. That evaluation recommended BM25 retrieval plus a spawn-time nudge as
> Tier 1, and it is shipped (`hooks/lib/memory-brief.mjs`, default mode `nudge`, gated
> behind `memory_search`/`memory_brief`, both default-off). This ADR does not touch that
> path. It adds a second, independent retrieval trigger — mid-task, not spawn-time — for
> a class of knowledge the spawn-time nudge structurally cannot reach: a gotcha that only
> becomes relevant once a specific command has already failed in a specific way.

## Context — storage is not the problem

Verified on this operator's machine, 2026-09-21: 438 memory files (2.3 MB) across 13
projects under the native Auto Memory store, plus 204 curated lesson files under
`lessons/` in this repository — 642 files combined. An inbox-to-lesson fold runs roughly
weekly (recorded folds: 2026-08-31, 2026-09-07, 2026-09-14, and 2026-09-18–20 per
`CONTRIBUTIONS_INBOX.md`, which reads "everything queued through 2026-09-21 was folded")
and is current as of this ADR. ADR 0001's vault gives the memory corpus git history.
`memory_search` / `memory_brief` / `memory_vault` are all enabled features in this
plugin. BM25 search works as designed — a real query against the corpus returned the
correct lesson at rank 1 (§7.2b's calibration table).

None of that is the gap. Two things are:

**1. Retrieval never fires at the moment of need.** Every delivery path this plugin
ships today runs once, at spawn, before the agent has done anything. What reaches an
agent from that path is either nothing (mode `off`), a ranked content block (mode
`pointers`, non-default), or — the shipped default — one relevance-blind line saying a
searchable corpus exists and how to query it (`buildMemoryNudge()` in
`hooks/lib/memory-brief.mjs`). The nudge is relevance-blind **by design, not by
omission**: that same file's module banner documents, with a calibration table, that no
BM25 threshold — absolute or relative — separates "genuinely about a documented topic"
from "long enough to share a few incidentally rare tokens" on this corpus, and instructs
future maintainers not to re-derive this by re-tuning the threshold. That finding is
correct and this ADR does not revisit it. But it means the corpus has no mechanism at
all for the moment that actually matters for a gotcha: the ten seconds after a command
fails, when the agent has a concrete symptom in hand and the lesson that explains it may
already be sitting in the corpus, unread, because nothing pointed at it and the spawn-time
nudge already fired (or never mentioned this specific failure) turns ago.

**2. Stack scoping is authored, never detected.** `lessons/` frontmatter already carries
`scope:` (a browsing/cascade axis: `universal`, `agent-process`, `vendor:<id>`,
`stack:<id>`, `env:<id>`, `archetype:<id>` — `project` is a seventh, conceptual-only axis
that is never actually written into a library file, per `AXIS_ORDER` in
`scripts/compose.mjs`) and `requires:` (a machine-evaluated AND-predicate over `os`,
`harness`, `stack`, `substrate`, `repo`, with `|`-separated alternatives read as OR —
`REQUIRES_KEYS` in the same file). `scripts/compose.mjs --profile <lock>` already matches
a project's profile against both: AND across axes, OR within an axis for `scope:`;
every key must hold for `requires:`, failing **closed** when a project's profile never
declared a key at all (verified by `compose.mjs --selftest`, which asserts this as a
named regression case: `os:windows` must not reach a profile that never said it was
Windows). The matching engine is real and tested. What is missing is upstream of it:
nothing reads a project's own filesystem to infer what its profile *is*. The profile
lives entirely in a hand-typed `profile` block inside `.claude/.template.lock`
(`HYDRATION.md` §2) — `vendor`, `archetype`, `stacks[]`, `env[]` in the documented
example, with `compose.mjs`'s `readProfile()` additionally reading `os`, `harness`,
`repo`, `substrates` from the same block (verified by reading the function; not yet
reflected in `HYDRATION.md`'s own example). A project that never hydrated from this
library, or hydrated once and never updated its lock file as dependencies changed, has no
profile at all — verified by grep: there is no code path anywhere in this repository that
lists a directory or reads a manifest to populate `stacks[]`.

Measured usage of the existing vocabulary, `scripts/compose.mjs --selftest` and a direct
count against `lessons/`, 2026-09-21: 204 lessons total; 104 scoped `[universal]` only;
64 scoped `[agent-process]` only; 12 scoped exactly `[universal, stack:git]`; **25 of 204
carry a non-empty `requires:`.** That last number corrects an earlier approximate
estimate of "~15 of ~194" — the library has grown since that estimate was made, and the
exact figure is now cheap to get from `compose.mjs --selftest`'s own tagged-count line,
so there is no reason to keep the approximation. The conclusion the approximate number
was already pointing at holds, and holds more strongly at the precise one: **gating a new
retrieval feature on `requires:` alone would exclude roughly seven in eight lessons**,
because `requires:` is a narrow machine predicate for the rare case that needs one
(most `stack:git`-scoped lessons above ship with `requires: {}` — the `scope:` tag alone
is already the gate that matters for them), while `scope:` is the vocabulary actually
carrying stack information at scale. Any design that gates on `requires:` and ignores
`scope:` is gating on the vocabulary almost nobody uses.

## Decision — six parts

**Add a second, independent retrieval path: a literal, high-precision match between a
tool failure's error text and a `symptoms:` key authored on an existing lesson or memory
file, fired the instant the failure happens, filtered by a detected — not just
hand-typed — project stack.** No new store. No score. No injection into a session that
never failed.

### 1. A new optional `symptoms:` frontmatter key

Added to existing lesson and memory files: a list of short, literal, distinctive
fragments of failure text. A file without the key simply does not participate in this
retrieval path — it stays exactly as reachable as it is today through search and the
spawn-time nudge. All 642 existing files (204 lessons, 438 memory files) stay valid with
zero edits. No migration, no new directory, no new file format.

The two systems this key attaches to are not symmetric today, and pretending otherwise
would ship a feature that silently does nothing on one of them. `scripts/compose.mjs`'s
frontmatter reader already parses arbitrary keys generically — inline lists
(`symptoms: [a, b]`) and block lists (`- item` continuation lines) both work with zero
parser changes, because `parseFrontmatter()` in that file has never been specific to the
five keys it currently validates. Native memory files are different:
`hooks/lib/memory-index.mjs`'s `parseFrontmatter()` (verified by reading it) tokenizes
every `key: value` line internally but **returns only `name`, `description`, and
`firstLine`** — every other key, including a new `symptoms:`, is parsed and then
discarded before it reaches any caller. That function's regex
(`/^(\w[\w-]*):\s*(.*)$/`) also only captures a single-line scalar; it does not follow
`- item` continuation lines at all, so a block-style `symptoms:` on a memory file would
silently yield an empty value even if the return shape were widened. Concretely: memory
files need either inline-list syntax (`symptoms: [x, y]`) or a small parser extension —
this is not a passive consequence of adding the key, it is a real, small, mechanical
change, scoped in Build order below.

### 2. Retrieval triggers on `PostToolUseFailure`

Confirmed directly against the live hook documentation while writing this ADR (not
inherited from an earlier draft): `PostToolUseFailure` is a real, distinct event —
the lifecycle table states plainly that `PostToolUse` fires "after a tool call
succeeds" and `PostToolUseFailure` fires "after a tool call fails." They are not the
same event with a field that happens to be empty on success; a hook registered only on
`PostToolUse` never receives a failure at all. The event's payload follows the same
shape already documented for `PreToolUse` (`tool_name`, `tool_input`, `tool_use_id`,
plus the common fields every event gets — `session_id`, `cwd`, `transcript_path`,
`hook_event_name`, and `agent_id`/`agent_type` when firing inside a subagent), with
`tool_error` as the field specific to the failure itself. This ADR treats the existence
of `PostToolUseFailure`, its success/failure split from `PostToolUse`, and its common
field set as directly verified; `tool_error`'s exact shape (a plain string) is treated as
verified by the research this ADR is finalizing, not independently re-confirmed line by
line against the doc's own dedicated example (the live page is long enough that a fetch
of it truncates before reaching that specific section) — worth a quick direct check
before Phase 3 of Build order below, cheap insurance for a load-bearing field.

**The matcher MUST cover `Bash|PowerShell`.** Confirmed directly: the hook matcher
syntax accepts a pipe- or comma-separated list of exact tool names
(`Edit|Write` / `Edit, Write`), and the documentation's own Windows-specific example
matcher is written `Bash|PowerShell` — because Claude Code exposes PowerShell as a
**separate tool** from Bash, not a Bash variant, and a matcher written as bare `Bash`
silently never sees a PowerShell failure. This is not a hypothetical: this exact
plugin's own `hooks/hooks.json` already carries the precedent
(`"matcher": "^(Bash|PowerShell|Edit|Write|NotebookEdit|Read|Grep|Glob)$"`, on
`delegation-guard.mjs`'s `PreToolUse` registration) — the convention already exists
locally, which is exactly why it is easy to forget to repeat it on a *new* hook
registration. **Named hazard: matcher scope creep by omission.** A gotcha-retrieval
hook shipped with a bare `Bash` matcher would work perfectly in every manual test run
from a Bash-first shell, ship, and then simply never fire for a large share of real
failures on this operator's primary Windows/PowerShell sessions — silently, with no
error anywhere, because a non-matching matcher is indistinguishable from "nothing
failed." That is precisely the shape of bug that makes a feature look inert for weeks:
nothing crashes, nothing logs, the feature just never has an opinion.

**Constraint this imposes, mirroring §7.2a's finding about `PreToolUse`/`^Agent$`:** if
any other hook is later registered on the same `PostToolUseFailure` matcher and also
returns `hookSpecificOutput.additionalContext`, whichever runs first does not
necessarily compose with a second — verify against current hook-chaining behavior before
assuming two `PostToolUseFailure` hooks both contribute (`PreToolUse`'s single-
`updatedInput`-wins behavior was the documented failure mode there; `PostToolUseFailure`
is a different event and untested here). Cheapest mitigation: keep this logic as a
single hook script, the same discipline `hooks/lib/memory-brief.mjs` already follows for
the `PreToolUse`/`^Agent$` matcher.

### 3. Matching is literal, not scored

A normalized substring match between the (normalized) `tool_error` text and a
(normalized) `symptoms:` key — nothing summed, nothing ranked, no term-frequency
weighting of any kind. This is **not** the rejected BM25-nudge idea wearing a new name,
and the distinction is the entire reason this design is safe to default on: BM25 in
§7.2b was being asked to judge **topical relevance** — is this brief plausibly about the
same subject as that lesson? — a genuinely unanswerable question from a term-frequency
score alone, as the calibration table proved (a long nonsense query outscored a short
on-topic one). A symptom key is not a topic; it is closer to a fingerprint. `"fatal: not
a valid object name"` is not *about* git rebases the way a paragraph of prose is about a
topic — it either appears verbatim in the failure text or it does not, and when authored
with any care it appears in vanishingly few failure modes other than the one it was
written for. High precision from near-uniqueness is a different claim than high
precision from a tuned score, and it is the reason a fixed, un-calibrated substring test
is defensible here where a fixed BM25 threshold was proven not to be.

That precision is only as good as the keys authored, so two guards are proposed
(**not yet calibrated against real data — this is a proposal for Build order, not a
measured constant**, the same honesty §7.2b insists on for its own threshold):
a minimum normalized key length, and a rejection rule at authoring time for a candidate
key that is a bare, common runtime word (`error`, `failed`, `exception`, `ENOENT` alone,
with nothing else) rather than a distinctive fragment. Both numbers should be set by
running a candidate guard against the real corpus once a first batch of `symptoms:` keys
exists (Build order, Phase 6), the same way §7.2b's BM25 thresholds were set from real
calibration data rather than guessed — do not ship a guessed constant labeled as if it
were measured.

**Normalization must handle character-encoding damage.** Measured directly in this
operator's own older session transcripts: some contain double-encoded UTF-8, where a
character like an em dash (`—`) — originally valid UTF-8 — was at some point mis-decoded
as a single-byte codepage and then re-encoded as UTF-8 a second time, producing
multi-character mojibake in place of the original byte sequence. A `symptoms:` key
authored by copy-pasting failure text out of a clean rendering (an editor, a terminal
that decodes correctly) would contain the real character; a live `tool_error` sourced
from a damaged transcript, or vice versa, would contain the mangled one, and a byte-level
substring test would silently never match either direction. The fix is symmetric
normalization: run both the stored key and the live `tool_error` text through the same
Unicode-normalization-plus-mojibake-repair pass before comparing, never compare raw
bytes. This is a concrete, testable normalization function, not a policy statement —
scoped as its own unit in Build order.

### 4. Stack scoping reuses the existing vocabulary and adds the missing detection step

No new tags. The axis vocabulary (`universal`, `agent-process`, `vendor:<id>`,
`stack:<id>`, `env:<id>`, `archetype:<id>`, ids open within an axis) and the
`requires:` predicate keys (`os`, `harness`, `stack`, `substrate`, `repo`) are exactly
`scripts/compose.mjs`'s existing `KNOWN_AXES` / `REQUIRES_KEYS`, unchanged. Given the
measured usage above — 25 of 204 lessons (roughly one in eight) carry any `requires:`
predicate at all, against 104 + 64 = 168 of 204 (roughly five in six) carrying only the
two axis-only tags `universal` / `agent-process` — the honest read is that `scope:` is
where the stack signal actually lives today, and `requires:` is reserved for the minority
of lessons that need a hard machine gate on top of it (`stack:git`-scoped lessons split
roughly evenly between `requires: {}` and a real `requires: { stack: git }` in the sample
read directly from `lessons/universal/`). A design that only consults `requires:` would
therefore miss the vocabulary five in six lessons actually use to say what they're
about.

**Decision: detect the project's stack from its filesystem, cache the result, and let a
hand-authored `.claude/.template.lock` `profile` block override the detection whenever
one is present.** Detection is cheap: one directory listing plus dependency **names**
(not versions) read out of a manifest already fingerprinted two real projects in this
operator's portfolio unambiguously during scoping for this decision — a `package.json`
naming Vue/Vite-family packages is not the same detected stack as one naming a
server-framework family, and neither needs anything beyond names already present on
disk. The cache belongs with this plugin's other disposable, regenerable state
(`memory-index-repo-*.json` is the existing precedent in the same plugin data
directory — see `plugins/agent-companion/docs/TELEMETRY.md`), never the durable state
root, because it is fully reconstructible from the filesystem at any time. A present
`.template.lock` wins over a fresh detection, matching the precedence `compose.mjs`
already establishes for lesson composition — this is one more consumer of the same
`profile` block, not a second, competing notion of "what stack is this."

This has a known failure shape, named explicitly rather than left implicit: **a
monorepo, or a thin root manifest.** At least one project in this operator's portfolio is
exactly this shape — a near-empty manifest at the repository root, with the dependency
list that actually names the stack one directory down, inside a workspace package.
Filesystem-fingerprint detection run naively at the root would read that thin manifest,
find little or nothing in it, and either mis-scope the project as bare/universal-only or
silently detect nothing. This is carried into "What would have to be true for this to be
wrong" below rather than treated as solved here, because it is not solved here — the
two-project fingerprinting check performed for this decision confirmed detection works
for an ordinary single-manifest layout, not that it is robust to this shape.

### 5. Capture-on-miss replaces batch backfill

When a failure matches no `symptoms:` key, the normalized signature is logged, not
discarded. Over time this produces a frequency-ranked list of real, recurring,
uncaptured failures — mined by how often they actually happen on this operator's real
sessions rather than by luck or a one-off sweep, at zero standing cost beyond the log
line itself. **The retrieval feature becomes its own backfill driver**: every miss is a
candidate lesson, ranked by real recurrence, which is a strictly better prioritization
signal than anything a batch crawl can produce, because a batch crawl over old
transcripts has no way to weight "this keeps happening" over "this happened once, three
months ago."

Pair every candidate with a dedup check before treating it as new: search the machine's
existing cross-project session-transcript search for the candidate signature. A
candidate whose hits are entirely inside sessions that already did a library-fold pass
(§9's distinction between the corpus and the work-tracking layer that indexes session
content) is already captured somewhere in the corpus under different wording — a
near-duplicate, not a gap, and belongs in reconciliation (§7.3 item 9 of the evaluation),
not a new lesson. A candidate whose hits are only in raw discovery sessions — the
failure happening live, never contributed back — is a genuine, still-open gap, and is the
one worth authoring a `symptoms:` key and a lesson for.

### 6. No batch transcript crawl

This reverses what looks like the obvious plan — a harvester already exists
(`plugins/agent-companion/scripts/transcript-harvest.mjs`) and already produces a
reviewable digest of pre-digested compaction summaries, cheaply (measured: 546
compaction summaries across 26 projects, free of any per-file model cost, in about 70
seconds). The case against using it as the primary source for this feature is not cost,
it is shape. Two measurements settle it: **87% of that digest (473 of 546 summaries)
comes from a single project family** — so a batch crawl over it would train this
feature's seed data almost entirely on one project's failure modes, precisely backwards
for a feature whose whole second half is about generalizing across stacks — and,
separately, **compaction summaries are not gotcha-shaped**. They exist to preserve task
continuity across a compaction boundary — what the session was doing, what is still
pending — not to preserve "this tool lied about its exit code." A summary sampled
directly during this evaluation was project narrative end to end, with no technical
gotcha content in it at all. The cheap path is cheap precisely because it mines a
different seam than the one this feature needs. **Conclusion: the digest stays on disk
exactly as `transcript-harvest.mjs` already leaves it — a free, grep-able artifact for a
human or a targeted future query — and nothing in this feature reads it into a model
automatically.** Capture-on-miss (part 5) is the sanctioned backfill mechanism instead,
because it mines the seam that actually contains gotchas: live failures, as they happen.

## Alternatives considered

### 1. A dedicated new gotcha store

A fourth place to look, purpose-built for symptom-keyed entries, instead of a new
frontmatter key on the two stores that already exist. **Rejected.** The evaluation this
ADR builds on already ran this argument for every hosted/external memory candidate it
considered (§5) and landed on augmenting the incumbent rather than replacing or
duplicating it; the same logic applies one level down. Native memory and the `lessons/`
library are already two places a fact about "what is true, or what went wrong, on this
project" can live, reconciled loosely by convention (§9 treats the corpus and the
work-tracking layer as complements precisely because neither subsumes the other, and a
third store would need the same reconciliation story worked out from scratch). A new
store competing with two indexes that already work adds a permanent reconciliation
burden — which file is authoritative when the same gotcha gets written twice? — without
fixing the actual gap identified in Context, which is *delivery at the moment of need*,
not a shortage of places to write things down.

### 2. Embedding/semantic retrieval

Score `tool_error` against a vector index of known gotchas instead of a literal
substring test. **Rejected for this narrow case.** It adds a dependency and a model or
API call to a plugin whose entire existing discipline is zero dependencies and
Node-builtins-only (the same reasoning §7.3 item 4 already used to prefer BM25 over
embeddings for topical search generalizes here). More importantly, it solves a problem
this design does not have: an error signature is chosen specifically to be a
near-unique, high-precision key, which is exactly the case where a substring test is
already correct and an embedding model adds latency and a new failure mode
(model unavailable, embedding drift between the key's authoring time and match time)
for no precision gain. This gets revisited honestly if scope ever widens past
failure-shaped knowledge — matching a vague natural-language description of a problem
to a lesson is a topical-relevance question again, and topical relevance is precisely
where §7.2b already showed lexical scoring breaks down without semantics to fall back
on.

### 3. Topical BM25 injection at spawn (existing `pointers` mode)

Just turn on the mode that already ships. **Rejected**, on the evidence already in the
code, not new evidence: `hooks/lib/memory-brief.mjs`'s own module banner states plainly
that pointer mode is "gated off by default" because no fixed or relative BM25 threshold
separates a genuinely on-topic brief from a long, plausible-sounding, off-topic one on
this corpus, and instructs maintainers not to re-derive this by re-tuning `minScore` —
"the next tuning pass will hit the same wall." Reaching for this mode to solve the
retrieval-at-failure problem would be re-running a calibration already proven not to
converge, applied to a new symptom besides.

### 4. `PreToolUse` interception — catching a known-bad command before it runs

Match the **command about to run** against a library of known-bad shapes and block or
warn before it executes, instead of matching the **error text after** it fails. This
deserves a fair hearing, not a strawman: it is genuinely attractive, and strictly better
than this ADR's design wherever it applies, because it prevents the wasted turn instead
of explaining it afterward — the mechanism is also already proven inside this exact
plugin (`spawn-guard.mjs` and `delegation-guard.mjs` both already intercept `PreToolUse`
today, so there is no open question about whether the interception point works).
**Rejected as the *primary* mechanism**, for one specific reason: it requires predicting
failure from command *text*, which is a strictly harder and lower-precision problem than
matching *the failure's own text* after the fact. The same command succeeds in one repo
and fails in another depending on state a static pattern over the command string cannot
see (a missing file, an unset env var, a lockfile in a different state) — `tool_error` is
the actual outcome, `tool_input` is only a prediction of one. **Recorded as the natural
follow-on**, not discarded: capture-on-miss (part 5) will surface gotchas whose real
trigger is a command *shape* rather than a specific error string — "never run this
particular flag combination on this stack" is a `PreToolUse` rule, not a
`PostToolUseFailure` match — and when that pattern shows up in the frequency ranking, the
existing `PreToolUse` interception point in this plugin is exactly where it belongs.

### 5. Batch transcript mining

Covered in Decision, part 6, on measurement (87% single-project-family concentration;
sampled summaries carry no gotcha content). Not repeated here.

### 6. Injecting on every spawn

The nudge that already ships (`buildMemoryNudge()`, default mode). **Rejected as a
solution to this specific gap**, because it already is the shipped answer to a different
one: it is relevance-blind by design (the same text regardless of what the brief is
about) and fires once, at spawn, before anything has gone wrong. §7.2b's own framing
already anticipates this feature would eventually be needed rather than treating the
nudge as sufficient forever — the nudge says "a corpus exists, look if you think it's
relevant"; it has no mechanism for "you just hit exactly this."

## Why default-ON, unlike the vault

ADR 0001's vault ships default-off because turning it on has an immediate, unconditional
effect the moment the option flips: a second, permanent, git-versioned copy of someone's
personal memory corpus starts being written to disk, whether or not anything about their
setup is unusual. `memory_search` / `memory_brief` ship default-off for a related but
distinct reason stated directly in their own `plugin.json` descriptions — a public
plugin should not start reading and ranking a stranger's personal corpus without them
opting in, even read-only.

This feature is different in kind, not just degree: **it cannot do anything at all until
a human has written at least one `symptoms:` key.** On today's corpus — 642 files, zero
of them carrying `symptoms:` — the feature is inert by construction the moment it ships,
regardless of this default. A `PostToolUseFailure` hook that queries an empty index for
symptom keys and finds none behaves identically whether the master switch is on or off:
silent, zero-cost beyond one hook invocation's fixed overhead per failed `Bash`/
`PowerShell` call. A capability that is *provably* silent until someone deliberately
authors the data it needs does not need a switch to protect a user from surprise
behavior, because there is no behavior to be surprised by until they have already acted.
It still gets one — `gotcha_retrieval` (boolean, default `true`), following the same
master-switch convention every other feature in this plugin's `userConfig` already uses,
with `gotcha_retrieval_capture` (boolean, default `true`) as the sub-switch for
capture-on-miss logging specifically, mirroring how `memory_brief_mode` sits underneath
`memory_brief` — the point of this section is the *default*, not the switch's existence.

## What would have to be true for this to be wrong

Falsifiable conditions, strongest first.

1. **The unverified mechanism.** Whether `hookSpecificOutput.additionalContext` returned
   by a hook firing during a *subagent's* tool call lands in that subagent's own context
   or the parent's is not stated anywhere in the live hook documentation — confirmed
   directly while researching this ADR: a targeted fetch for the routing behavior of
   `SubagentStart`'s `additionalContext` specifically found no discussion of it at all.
   The evidence available is strong but indirect: a `SubagentStart` hook's
   `additionalContext` was observed, in the evaluation this ADR builds on, landing
   **only** in the subagent's own transcript (`isSidechain: true`, keyed by `agentId`),
   with zero occurrences in the parent transcript — routing is per-agent for that event.
   `PostToolUseFailure` is a different event, so this ADR's status on the question is
   **strong evidence, not proof**. This plugin already ships a second, independent data
   point in the same direction without having set out to test it:
   `hooks/subagent-brevity.mjs`'s `SubagentStart` handler exists specifically because
   the brevity contract needs to land inside the *subagent's own* prompt, and its
   shipped design (self-heal via `additionalContext` only when the marker is absent from
   `agent_prompt`) behaviorally depends on that routing being correct — it is corroborating,
   not independent proof, since it rests on the same unverified assumption rather than a
   separate confirmation of it.
   **How to read the answer out of the transcripts (2026-09-22 revision — this used to
   be a blocking synthetic probe; see Build order, Phase 1, for why it no longer is):**
   the shipped hook already emits `[agent-companion: gotcha]` via `additionalContext` on
   every real match, whether the failure happened on the main thread or inside a
   subagent, with `agent_id`/`agent_type` present on the payload whenever it fires
   inside one. That is the same check the old synthetic probe would have performed,
   available for free from ordinary use instead of a one-off setup: once a real
   `PostToolUseFailure` has matched a seeded symptom inside a subagent, grep that
   subagent's own transcript and its parent's transcript for the marker. Presence in the
   former and absence in the latter confirms per-agent routing for this event
   specifically, closing the gap between "strong evidence" and "proven" — a real failure
   and a real transcript are strictly more faithful evidence than a contrived `exit 1`
   run once and thrown away. **Graceful degradation if it lands in the parent instead:**
   the feature is diminished, not useless — the lead session still sees the gotcha and
   can relay it, so even the worst-case answer leaves this worth shipping, just less
   automatically than hoped for subagent-heavy sessions.
   **Check-up 2026-09-23 — NO DATA; still open.** The one-day follow-up grepped every
   local transcript for the marker. None of the hits came from a real firing. Each one
   was the build session's own text: its brief, the hook source, test assertions, and
   manual `node hooks/gotcha-retrieval.mjs < payload` runs whose stdout came back as an
   ordinary `tool_result`. None was a hook attachment. The check used each record's
   `isSidechain` field, with `agentId` as a cross-check. It found zero
   `"hookEvent":"PostToolUseFailure"` attachment records anywhere. That is not because
   nothing failed: 51 transcripts written since the ship contain `"is_error":true` tool
   results. The hook could not have fired. The installed plugin is `0.22.0` at
   `82f1782`, which is `main`, and this branch (`5de1869`) is not merged. So no installed
   copy of `hooks/gotcha-retrieval.mjs` exists, and no `gotcha-capture/misses.jsonl`
   exists under any `plugins/data/agent-companion-*` directory. The `gotcha_retrieval`
   option is at its default (on), and 7 lessons on this branch carry `symptoms:` keys,
   so merging and reinstalling is enough to start collecting. The reading method above
   still holds. Re-run it once the hook has been installed for a while.
2. **Symptom keys proving too variable to match literally.** Locale-dependent error
   text, absolute paths embedded in the message, a version number that changes every
   release, and the encoding damage in Decision part 3 are all ways a real symptom key
   could fail to match a real failure it was written for. If this turns out to be common
   rather than occasional, literal matching stops being high-precision-by-near-uniqueness
   and the case against embeddings in Alternatives item 2 weakens.
3. **Stack detection misfiring on a monorepo or a thin root manifest.** Named directly
   in Decision part 4: at least one real project in this operator's portfolio has a
   near-empty root manifest with the real dependency list one directory down. If
   root-only detection is what ships, that project either gets mis-scoped or scoped as
   bare — worth testing against explicitly before trusting detected scope over "no scope
   information available."
4. **Capture-on-miss logging a flood of one-off signatures instead of a useful frequency
   ranking.** The value case in Decision part 5 assumes recurring failures cluster into a
   short list of genuinely common signatures. If real failure text is noisy enough that
   almost nothing repeats verbatim (a distinct temp path or PID in most messages, say),
   the miss log becomes a large, low-signal list instead of a ranked backfill driver, and
   the normalization pass in part 3 would need to work much harder than "fix mojibake and
   fold case" to be useful here too.
5. **`tool_error`'s shape varies by tool type.** This ADR treats it as a plain string
   uniformly, per Decision part 2. If an MCP tool's failure carries a structured error
   object rather than a flat string, literal matching against that subset of tools
   either needs a stringify step or silently never matches — worth checking against a
   real MCP tool failure, not just `Bash`/`PowerShell`, before assuming uniform coverage.

## Build order

Phases in execution order. There used to be a blocking "Phase 0" synthetic experiment
ahead of Phase 1, gating the routing question in "What would have to be true for this to
be wrong," item 1. It is gone as of 2026-09-22 — see Phase 1 below for the replacement —
so execution now starts directly at the frontmatter change, and nothing downstream waits
on a one-off probe that a real failure will exercise just as well.

**Phase 1 — Frontmatter, shipped instrumented instead of gated on a synthetic probe.**
Add `symptoms:` as a documented optional key. No change needed to `scripts/compose.mjs`'s
frontmatter reader (already generic over keys and list shapes). Extend
`hooks/lib/memory-index.mjs`'s `parseFrontmatter()` to surface `symptoms` in its return
value, and to follow `- item` continuation lines for it specifically (or require
inline-list syntax on memory files and document that constraint) — both are small,
mechanical, and testable in isolation from everything else.

This phase also absorbs the old, separate "Phase 0" gate. That phase existed to settle
the open question in "What would have to be true for this to be wrong," item 1 — whether
a `PostToolUseFailure` hook's `additionalContext`, firing inside a subagent, lands in
that subagent's own transcript or the parent's — via a dedicated synthetic probe (a
planted marker, a contrived `exit 1`) run once before anything else could build on the
answer. The replacement decision: ship the hook instrumented from Phase 3 onward and let
the routing question answer itself from real use, because every ordinary
`PostToolUseFailure` firing inside a subagent thereafter is a trial of exactly the same
mechanism the synthetic probe would have exercised — a real failure with a real
transcript to grep is strictly more faithful evidence than a one-off contrived run, and
it costs nothing extra to collect since the hook is shipping regardless. There is no
longer a gate to clear before Phase 3; Phase 3 ships on schedule, and "What would have to
be true for this to be wrong" item 1 now describes how to read the answer out of the
transcripts this produces, not a precondition for shipping it.

**Phase 2 — The literal-match engine, as pure functions.** Normalization (Unicode
normalization plus the mojibake repair from Decision part 3), the minimum-length and
generic-key rejection guard, and the substring test itself — none of this needs a hook
wired up to be tested. Unit tests should include must-fail cases the way
`compose.mjs --selftest` already models (a guard that can only pass proves nothing).

**Phase 3 — Wire the `PostToolUseFailure` hook.** Matcher `Bash|PowerShell` — never bare
`Bash`. On a match, emit `additionalContext` naming the matched gotcha and where it lives
(file path, matched key). Add a telemetry row per match attempt to a new
`telemetry/gotcha-matches.jsonl` stream, following this plugin's existing convention
(`spawns.jsonl`, `denials.jsonl`) of measuring a guard's behavior rather than trusting it
silently — a feature whose match rate cannot be queried is exactly the "looks inert for
weeks and nobody can tell why" failure this ADR already named once.

**Phase 4 — Capture-on-miss.** Log the normalized signature on every non-match. Build the
frequency report and the dedup check against the machine's existing cross-project
transcript search (Decision part 5) once there is enough miss data to rank.

**Phase 5 — Stack-scoping.** Filesystem fingerprint detector, cached in the plugin's
disposable cache area, overridden by a present `.claude/.template.lock` profile. Layered
on top of Phase 3 rather than gating it — a project with no detected stack still gets
`universal`/`agent-process`-scoped symptom matches, so this phase is a precision
refinement, not a blocker for shipping the core mechanism.

**Phase 6 — Seed data.** Author `symptoms:` on a first batch of existing high-traffic
lessons — the `stack:git`-scoped dozen and a handful of `agent-process` lessons are
natural first candidates, since nothing matches anything until keys exist. Use this batch
to actually calibrate the Phase 2 guards against real data, per Decision part 3.

**Not in this build — explicitly deferred:** `PreToolUse` command-shape interception
(Alternatives item 4), to be picked up once capture-on-miss data shows which recurring
gotchas are better caught before the command runs than after it fails.
