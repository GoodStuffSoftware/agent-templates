## 2026-09-28 - a brief that says "isolate this path, and report on the real one" builds an undetectable mix-up ({{PROJECT}})

- **The failure:** a lead briefed a subagent to point a shared-state env var at a scratch file for safety, and separately to report that shared file's record count before and after. The agent reported **1 entry** in a file that actually held **470**. It had read its own scratch file and named the real path. The claim reached the lead as catastrophic shared-state truncation on a machine where a dozen sessions depended on that file.
- **Why it beat every check.** The number was specific, the quoted path was correct, the agent had genuinely performed the isolation it claimed, and the finding was exactly the sort of thing you want escalated loudly. There was nothing incoherent to notice. Alarm is what shortcuts verification, so the most alarming reports are the ones most likely to be relayed unverified.
- **The brief caused it.** Asking one agent to *redirect* a path and to *report on the original* makes two paths live in its head with one name in its output. Ask for BOTH values explicitly — "the real file's count and your scratch file's count" — so a mix-up surfaces as two numbers that disagree rather than one number that is simply wrong. A single figure with a path attached is unfalsifiable from the outside.
- **Lead-side rule:** verify an alarming claim at the named location yourself before acting on it or passing it upstream. This cost nothing here because the check was one command; relaying it would have sent an operator chasing a data-loss incident that never happened.
- **Same family, same day, different tools:** a test runner's result laundered by `| tail -n` so the pipeline reported the filter's exit status instead of the run's; a deploy exit code that said nothing about whether the thing it deployed was live. In all three the tool's success channel and the outcome being claimed were never connected. The generalisation that covers them: **ask what specifically would have had to fail for this signal to look bad, and whether that thing was even in the chain you measured.**

## A scheduled job needs a "registered but not yet observed" state, or it gets marked done on deploy day

**Date:** 2026-09-28 · **Context:** shipping a project's first scheduled (cron) function

Companion to the deploy-evidence entry below, which covers why a green deploy is not a live feature.
This is the narrower, reusable fix for the scheduled-job case specifically: the problem is not only
that people misread the signal, it is that **the status vocabulary has no word for the true state**,
so the default recorded outcome is "done".

Deploying a scheduled job proves the scheduler REGISTERED it. It proves nothing about whether it has
ever fired or ever succeeded. Those are different facts, and for any cadence longer than "every few
minutes" they are separated by a real, possibly multi-day window. A weekly job deployed on a Thursday
cannot be confirmed until the following Monday. During that window "succeeded" is a lie and "failed"
is also a lie, so a runbook offering only those two options will record success — on deploy day, from
an exit code.

**The technique, three parts:**

1. **Make the job write a heartbeat record every run, including failed runs.** A run that fails and
   leaves no trace is indistinguishable from a schedule that never fired, which is the ambiguity that
   costs the debugging time. Keep TWO timestamps, not one: `lastRunAt` advancing on every run, and
   `lastOkAt` advancing only on a clean run.

2. **Make the record readable without credentials** — a narrowly-scoped public read on that ONE
   record, never the collection, and never write. This is what lets the confirmation run from any
   host: a deploy box, a laptop, a CI job holding no service account. A check that needs a credential
   is the check most likely not to run. Keep identifying data and error TEXT out of it; publish the
   failing keys or dates and leave the messages in the log.

3. **Give the runbook the missing third state, by name.** Record `deployed, unconfirmed` until a run
   has actually been observed, and say plainly that it is a real state rather than a soft success.
   Then the two timestamps give a three-way diagnosis that points at different fixes:
   - **no record at all** → the scheduler never fired; the job registration itself is missing or broken
   - **`lastRunAt` fresh, `lastOkAt` absent or stale** → it IS firing and the work is failing; go to the logs
   - **both fresh** → confirmed healthy; only now mark it done

**Two traps worth stating in the same breath:**

A staleness check on the heartbeat must be sized to the CADENCE. Moving a job from daily to weekly
while leaving a 48-hour staleness window turns a healthy producer into a permanently-failing check —
and a check that always fails trains everyone to ignore it, which is the original disease wearing a
new coat.

And a staleness check does not substitute for the first-run confirmation: before anything has ever
run there is no record, so a well-built check correctly reports "not applicable" or "could not check"
rather than failing. That is right, and it means nothing blocks on a scheduler that has simply never
fired. Only the explicit first-run confirmation catches that.

**Why it bit:** the deadline that would have surfaced a dead scheduler early was removed by a
backfill, which was good news that quietly deleted the forcing function. Coverage was extended three
months, so a scheduler that registered and never fired would have gone unnoticed until the data ran
out. The confirmation step became the only remaining detector at exactly the moment it stopped
feeling urgent.

**Generalises to:** any cron/scheduled function, any queue consumer, any job whose first execution is
later than its deployment.

---

## A successful deploy is evidence only about the legs it actually shipped

**Date:** 2026-09-28 · **Context:** three agents converged on a wrong conclusion about a deploy pipeline

Two related traps, found together. Both are about mistaking a green signal for a verified outcome.

**1. Scope the evidence to the leg.** Three independent agents concluded a deploy pipeline's
function-deploy stage had not run for seven weeks. Each had queried the run history for runs whose
*target* was that stage. But the stage also runs as a STEP inside a full-scope bundle run, which
that filter never matches. The evidence was in the build logs the whole time. "No run with
target X" means "no standalone X run" — not "X never ran". Three agents agreeing was not three
agents being right; they had all made the same query mistake, so their agreement carried no
independent information.

**2. A green deploy is not a live feature.** In the same codebase, three separate incidents where
a deploy reported success while the deployed thing was dark: a conditionally-declared secret that
was never bound because module scope was evaluated before config load (the runtime still received
the config, so the feature ran unprotected and every payment verification failed); a deploy wrapper
that reported a hard refusal as a timeout or a possible success; and a scheduled job whose deploy
exited 0 while nothing proved it would ever fire.

**Lesson:** confirmation means reading the DEPLOYED ARTIFACT or a runtime signal — the live
revision, a version poll armed before the deploy fired, a heartbeat record, the endpoint actually
answering. Never an exit code, never "no errors in the log" (runs predating per-step capture retain
no stdout at all, so "no error" can mean "no logs"). Treat an ambiguous deploy result as a failure.
A tool that calls a hard failure maybe-fine is worse than the failure.

**Corollary:** keep declarations that gate deploy-time validation UNCONDITIONAL. A required value
that must exist everywhere is a cheap, loud problem; one silently skipped by a flag that was
undefined at scan time is an expensive, quiet one. Where the dependency is genuinely inert in some
environment, a placeholder value satisfies the existence check — verify by tracing the validation
call chain, since existence checks and value reads are usually different code paths.

## Progress-tracker fields are not documents — check for a silent write-time cap

**Date:** 2026-09-28 · **Context:** agent handoff via a task-board card

A coordinating agent wrote long-form guidance into a task board's *step / subtask label*
fields — a NOT-IN-SCOPE list, and "four ways the verified state differs from this card" —
then briefed its successor that **the steps mattered more than the card description**.

The board capped every label at 200 characters **at write time**, silently. No error, no
warning, no truncation marker. Three of the four stated contradictions were never stored.
The successor was pointed at content that did not exist, and burned a subagent proving the
remainder was unrecoverable rather than merely hard to fetch.

**Lesson, generalised:** before putting load-bearing prose into any field of a tracker,
wiki, issue label, commit trailer or API metadata blob, check whether that field has a
length cap and whether the cap is enforced on WRITE (lossy) or on DISPLAY (recoverable).
Short structured fields are usually the former. Progress fields track progress; long-form
content belongs in a description, an attachment, or a file under version control.

**Corollary for handoff authors:** never tell a successor that one container outranks
another without verifying the content actually survived the write. Read your own handoff
back through the same interface the successor will use.

**Corollary for handoff readers:** a field ending mid-sentence is evidence of a write-time
cap, not of a fetch problem. The remainder is gone — ask the author instead of hunting.

# Contributions Inbox

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

### 2026-09-28 — An ignore rule protects a spelling, not a concept — audit deny-lists by what they miss

- **Trigger:** two separate exclusion lists in one codebase were each found, on the same day, to cover one spelling of the thing they were meant to exclude while leaving near-identical variants exposed. In both cases the list's existence made reviewers assume the category had been considered. It had — and the wrong member of it was named.
- **Is it generic?** Yes. Stripped: the project, the tools, the file names. Reusable kernel: a deny-list is a list of strings, not a statement of intent, but it reads to a later reviewer as a statement of intent. The presence of a plausible-looking entry actively suppresses the question "what else belongs here?"
- **Target:** `lessons/` — new tagged lesson file (not scaffolding). Tag for security review and for config review; applies to `.gitignore`, deploy/upload ignore lists, bundler excludes, log redaction rules, secret scanners and lint ignores alike.
- **Proposed change:**

  **A deny-list tells you what someone thought of, not what is covered.** The failure is not an empty list — an empty list gets noticed. It is a list with one or two reasonable-looking entries, which reads as evidence the category was handled and therefore stops anyone looking further.

  Two real instances, same day, same codebase:
  - A deployment upload ignore list excluded exactly one environment-file pattern — the one that appears in the tool's own documentation examples — while the project's actual generated env files, named by a different convention, were uploaded on every deploy. Env files had plainly been considered. The wrong pattern was covered.
  - A source-control ignore rule covered one hyphenated spelling of a credential filename. The camelCase spelling — the one the cloud provider's own documentation uses, and therefore the likelier one for a person to create by hand — was unignored, so a single `git add -A` would have committed it.

  Note the shared shape: in both cases the covered spelling was the one from the *documentation*, and the exposed spelling was the one from *practice*. Deny-lists tend to be written while reading docs and exercised while writing code.

  **How to audit one properly:**
  - **Enumerate by category, then check coverage — never read the list and judge it plausible.** Ask "what are all the files that would be catastrophic here?" and test each against the rule.
  - **Test the rule, do not read it.** Most ignore mechanisms have a query mode (`git check-ignore -v <path>` and equivalents). Probe a file that does not exist yet; that is the case you care about. Reading a pattern tells you what you think it means.
  - **Check anchoring as well as spelling.** Whether a pattern applies at any depth or only at the root is a second, independent failure mode, and it is invisible in the pattern text to most readers.
  - **Distinguish "is not there" from "cannot be added."** Untracked-but-unignored is one careless command from committed. Those are different states with different risks, and only the second is safe.
  - **Prefer a broad pattern plus deliberate, commented exceptions** over an enumeration of the specific things someone happened to think of. Verify mechanically that the intended exceptions survive the broadening.

- **Applied?** `no`

### 2026-09-28 — A mitigation that delays a symptom also delays the diagnosis

- **Trigger:** designing an access check that depends on a network lookup. To stop a transient outage locking out every legitimate user, a successful verdict was cached and honoured through a long grace window when the lookup was unavailable. Correct design — but it means that if the underlying credential is ever rotated and one copy is missed, nothing appears wrong until the grace expires, and the failure then surfaces days later looking like an unrelated outage.
- **Is it generic?** Yes. Stripped: the product, the access check, the credential, the specific windows. Reusable kernel: every mechanism that keeps a system working through a fault — caching, retries, fallbacks, graceful degradation, generous timeouts — converts a loud immediate failure into a quiet delayed one. That is usually the point. It is also a cost, it is almost never written down, and it is invisible precisely because the system is behaving as designed.
- **Target:** `lessons/` — new tagged lesson file (not scaffolding). Tag for resilience/design review and for runbooks; it belongs wherever fallback behaviour is being chosen.
- **Proposed change:**

  **State the diagnostic cost of every resilience mechanism, next to the mechanism.** A cache, a retry, a fallback path or a grace window buys availability by absorbing a fault. What it spends is the signal that the fault happened. The system keeps working, nobody investigates, and the eventual failure arrives decoupled in time from its cause — often long enough that the obvious suspect is whatever changed most recently, which is the wrong thing.

  This is worse than an ordinary hidden failure in one specific way: **nobody suspects a component that is working as designed.** An outright bug attracts attention. A grace window doing exactly its job, while masking a misconfiguration behind it, does not.

  Three practical consequences worth building in:

  - **Pair every fallback with a signal.** When the system serves from a degraded path — cache-on-error, fallback transport, retry-after-failure — emit something an operator can see, even though the user saw no problem. Availability and observability are separate goals, and the mechanism that delivers the first will silently cost you the second unless you ask for both.
  - **Write the lag into the runbook, in time units.** Not "responses may be cached" but "a failure here will not be visible for up to N days." Whoever debugs it later needs the size of the gap between cause and symptom, because that is the number that tells them how far back to look.
  - **Enumerate the things that can silently invalidate the dependency**, especially credential rotation and config moves. If a secret or endpoint lives in several places, list every one, and mark which copy is the one whose omission fails quietly rather than loudly.

  **A useful asymmetric default, where it fits:** cache a positive result long and honour it through a generous grace window when the dependency is unavailable, but cache a negative result only briefly. Availability is preserved for anyone already known-good, while a newly-valid subject is not trapped behind a stale denial. The asymmetry is the point — the two directions have different costs and should not share a TTL.

- **Applied?** `no`

### 2026-09-28 — Four ways a claim survives scrutiny it should not have survived

- **Trigger:** three agent sessions spent several hours disputing whether a deploy path was blocked. The claim cycled through four incompatible states — refused, disproved, unexercised, actually fine — and every transition came from a flaw in how the claim was checked rather than any change in the system. Separately, in the same session, a documented agent-to-agent request ("please warn us before shipping X") was restated as an operator-imposed freeze and propagated three hops into a branch's code comments. Nobody acted wrongly on any of it, so it cost only time — but each of the four failures is reusable and none is specific to deploys.
- **Is it generic?** Yes, and unusually so. Stripped: the product, the tool, the subsystem, the specific claims. Reusable kernel: four distinct mechanisms by which a false claim passes verification, all of which get *more* likely as more agents look at something, not less.
- **Target:** `lessons/` — new tagged lesson file (not scaffolding). Tag for multi-agent verification and for decision records. Relevant to any workflow where agents check each other's findings or inherit claims from briefs, cards or handoffs.
- **Proposed change:**

  **1. Agreement between agents who share a method is not corroboration — it is a shared blind spot.** Three sessions independently queried a run history by a `target` field, all found nothing, and all concluded the same wrong thing. The agreement felt like triangulation. It was one method run three times. Independent confirmation requires a different *method*, not a different agent: a second agent running your query is a reliability check on the query, not on the answer. When agents agree, ask what they each did — if the procedure was the same, you have one observation.

  **2. A wrong premise that produces the right conclusion is the hardest kind to catch, because the outcome vouches for it.** An agent asserted a constraint that was stronger than the truth. It happened to yield the correct decision for the case at hand, so nothing challenged it, and it was one message away from being written into a durable record as settled fact — with a second agent's endorsement attached. Premises that produce *wrong* answers get caught by the wrong answer. Premises that produce right answers have to be checked on their own, deliberately, and almost never are. When a conclusion is confirmed, that is not evidence for the reasoning that reached it.

  **3. A claim inherited from a brief, card or handoff is a claim, not a fact — and the most perishable claims are the ones describing a blocker.** Blockers are what get fixed, so a note saying "X is blocked" decays faster than almost anything else a handoff can contain. Worse, the document asserting it may have been revised to retract it while the quote stays in circulation: in this case the very card being cited as the blocker had already been rewritten to say "nothing is blocked today." Say "the brief told me X" rather than "X", until you have checked. The two sound alike and commit you to very different things.

  **4. A constraint's author determines its authority, and every summary strips the author.** A peer's request ("warn us before this ships") and an operator's instruction ("do not ship this") read almost identically once compressed into an index line, a handoff bullet or a brief — but they license completely different actions. Once the author is gone, a request reliably drifts upward into a mandate, because treating a request as binding looks like diligence and nothing ever pushes back on it. Two sessions independently deferred real work on a constraint that turned out to be nobody's. **Before treating a recorded constraint as the operator's, find the sentence naming who asked for it.** If you cannot find that sentence, say "the brief calls this a freeze" and not "there is a freeze."

  This one is the most dangerous of the four, because of how it interacts with (2): **a false premise that prescribes the same conduct as the true one is invisible by construction.** "There is a freeze" and "warn them before shipping" both produce careful behaviour, so nothing looks wrong, no outcome contradicts it, and no suspicion ever arrives to trigger a check. That is the whole point — the source check has to be a standing habit, not a response to doubt, because in exactly the cases that matter most the doubt never comes.

  **A practical corollary for correcting one.** When you find that a constraint was never real, do not simply delete it. Work out what the true obligation is and write THAT in its place — here, a duty to notify rather than a bar on shipping. A correction that removes a false constraint and leaves nothing behind invites the opposite error later, by someone who now believes there was never anything to respect. And when the false version has already been committed to a durable record, prefer a correcting entry on top over a rewritten history: the record of having believed it, propagated it and then found it baseless is more useful to the next reader than a clean past in which the failure never happened.

  **Two corollaries about the artefacts themselves.**

  **A warning comment that is wrong is worse than no comment,** because it recruits the next reader into the bug with the authority of someone who appeared to have thought about it. If a comment states a guarantee ("these cannot disagree", "this is always safe"), it should say what mechanism enforces it, so a reader can check the mechanism rather than trust the assurance.

  **Record "this can be done and should not be" rather than "this cannot be done."** They close a decision identically and read identically to whoever arrives next — but only the first leaves them able to reopen it on new information, and only the first is true when an option was found and rejected. A decision record that overstates impossibility is a premise failure aimed at the future.

- **Applied?** `no`

### 2026-09-28 — A failed pre-commit hook leaves the index staged, so the next commit lints a stale copy

- **Trigger:** an agent hit a lint error in a pre-commit hook, fixed the error in the worktree, then committed a *different* set of files — and the hook failed again on the error it had just fixed. The hook was re-checking the still-staged copy from the first attempt, not the corrected worktree file.
- **Is it generic?** Yes. Stripped: the project, the linter, the hook manager, the specific files. Reusable kernel: a failed commit aborts the commit but does NOT unstage anything, so a partial-staging workflow silently carries the previous attempt's snapshot into the next one — and staged-file hook runners check the staged snapshot, which is exactly the copy the fix did not touch.
- **Target:** `lessons/` — new tagged lesson file (not scaffolding). Tag for git workflow and for agent commit hygiene; it costs a confusing debug cycle every time and the symptom actively misdirects.
- **Proposed change:**

  **A failed `git commit` leaves the index exactly as it was.** The commit is aborted; nothing is unstaged. That is ordinary git behaviour and it is usually harmless — but it interacts badly with staged-file hook runners (`lint-staged` and equivalents), which deliberately check the STAGED snapshot rather than the working tree.

  The failure sequence:
  1. `git add` a set of files, commit, a hook fails on a lint error.
  2. Fix the error in the working tree.
  3. `git add` a *different* file and commit again.
  4. The hook fails on the same error — because the broken file from step 1 is still staged, and the runner is checking that stale snapshot, not the fix.

  The symptom is actively misleading: the reported error no longer exists in any file you can open, so the natural reading is "the hook is broken" or "the fix did not work." Both are wrong.

  **Fix:** `git reset` with no paths before re-staging. It clears the index and leaves the working tree untouched, so the next `git add` stages the corrected content. Re-add deliberately rather than assuming the previous staging is still what you want.

  **Implication for agents specifically:** an agent committing in logical groups stages a subset per commit, which is precisely the workflow this bites. Treat a hook failure as invalidating the index, not just the commit — and never resolve a repeat hook failure by passing a skip flag (`--no-verify` or equivalent), because the hook is reporting real staged content and skipping it commits the broken snapshot. Also avoid `git stash` as the reflex cleanup here: the stash stack is shared across worktrees and concurrent sessions, so a stash/pop can capture or restore someone else's work. `git reset` touches only your index.

- **Applied?** `no`

### 2026-09-28 — Hashing is not anonymisation when the input space is guessable

- **Trigger:** a staging access gate admitted testers by matching SHA-256 hashes of their email addresses against a checked-in allowlist. The proposed fix was to mirror an external tester list into a readable datastore document, still as hashes, so the client could check membership without a server round-trip. The hash list was treated throughout as if it protected the identities on it. It does not.
- **Is it generic?** Yes. Stripped: the product, the gate, the external tester service, the datastore, the specific field and constant names. Reusable kernel: a hash of a low-entropy, enumerable input is a confirm-a-guess oracle, not a one-way veil — so "we only store hashes" is not by itself a privacy property, and the reviewer question is always "how large is the input space?"
- **Target:** `lessons/` — new tagged lesson file (not scaffolding). Tag it for both security review and design review; it most often surfaces while weighing a client-side membership check against a server lookup.
- **Proposed change:**

  **A readable list of hashed identifiers leaks membership whenever the identifier space is guessable.** Email addresses, usernames, phone numbers, employee IDs and customer numbers are all guessable in this sense. Anyone who can read the list can hash a candidate and check for the digest, which answers "is this specific person on the list?" — usually the exact question the list was meant to keep private. Enumerating the whole list is harder, but confirming a guess is the attack that matters, and it is cheap.

  Three corollaries worth stating, because each one gets proposed as the fix and none of them works:
  - **Requiring authentication to read the list does not fix it.** It narrows the audience; every reader still downloads the full list and can test any candidate offline, indefinitely, after a single read.
  - **A salt does not fix it if the salt ships with the list.** Client-side verification requires the client to have the salt, so a per-entry salt travels alongside the hash it protects. It raises cost per guess, not the property.
  - **Slow hashes (bcrypt/scrypt/argon2) narrow but do not close it.** They price bulk enumeration out; they do not stop an attacker confirming one address they already suspect.

  **The shape that does work:** do not ship the membership set at all. Put the lookup behind a server endpoint that takes the identity from a VERIFIED credential (a signed token the caller already holds), never from a caller-supplied parameter, and return a verdict about that caller only. The endpoint answers "am I a member?" and cannot be asked "is `{{SOME_OTHER_IDENTITY}}` a member?". Nothing is enumerable because nothing is enumerated — no list is ever transmitted. If the upstream source supports a single-identity query, query one identity rather than fetching the set and filtering locally.

  **Availability note, since this trade is usually where the design goes wrong:** moving the check server-side introduces a network dependency on an access decision, so state the failure direction deliberately rather than inheriting one. Failing open defeats the gate; failing closed on every transient error locks out legitimate users and is how gates quietly deny everyone. A workable default is asymmetric caching — cache a positive verdict long and honour it through a generous grace window when the lookup is unavailable, cache a negative verdict briefly so newly added members are not stuck behind a stale denial, and deny only when there is no usable cached verdict at all.

  **Observability note:** a gate that fails closed silently is indistinguishable, from the outside, from a gate correctly denying everyone. Emit a signal on the *unavailable* branch specifically — never on ordinary denials, which are the gate working — and keep identities out of that signal, or the telemetry reintroduces the leak the design just removed.

- **Applied?** `no`

### 2026-09-28 — Claude desktop hides sessions per account, but the work files are shared

- **Trigger:** a user weighing a second Claude account asked what would carry over. An on-disk survey found the desktop session index split by account/org UUID, while transcripts and memory are split by project path. No account switch was actually performed.
- **Is it generic?** Yes. Stripped: the specific account/org identifiers involved (replaced with placeholders below), the exact machine. Reusable kernel: desktop-app UI state can be partitioned per signed-in account while the actual work product (transcripts, memory, config) is partitioned per project path instead — the two partitioning schemes don't match, so an account switch WOULD look like data loss when it isn't.
- **Target:** `lessons/` — new tagged lesson file (not scaffolding).
- **Proposed change:**

  The Claude desktop app keeps its Code-tab session INDEX (sidebar list, titles, archive state) under `%APPDATA%\Claude\claude-code-sessions\{{ACCOUNT_UUID}}\{{ORG_UUID}}\` on Windows, and `local-agent-mode-sessions` is split the same way. Signing into a different account makes the app read a different folder, so earlier sessions drop out of the sidebar — but they are not deleted.

  The actual work product is keyed by PROJECT PATH, not account, and stays usable regardless of which account is signed in: transcripts (`~/.claude/projects/<cwd>/*.jsonl`), auto-memory, `CLAUDE.md`, skills, plugins, and settings. Account identity itself lives in `~/.claude.json` (`oauthAccount`), with credentials in `~/.claude/.credentials.json` — never copy the credentials file when syncing or backing up state.

  **Implication for tooling:** anything that syncs or backs up Claude state should treat the desktop session index as account-partitioned (don't expect it to be complete or stable across account switches) and must never copy credential files. After an account switch, recover "missing" sessions from the transcripts — e.g. CLI resume from inside the project directory — rather than by editing the desktop app's session-index store directly. Separately, `claude.ai`-side state (connectors, cloud sessions, Remote Control, scheduled routines, Artifacts, chat memory) belongs to the signed-in account and does not carry over on a switch at all — it isn't merely hidden, it's genuinely a different account's data. Also note: setting `CLAUDE_CONFIG_DIR` to different values per profile separates ALL local state (not just the session index) per profile — it splits history across profiles rather than sharing it, which is a different mechanism from the per-account sidebar partitioning above.

  **Evidence level:** the per-account folder layout under `%APPDATA%\Claude\claude-code-sessions\` was verified on disk (MEASURED). That the sidebar visibly empties after switching accounts is inferred from that layout (INFERENCE) — not directly observed with a second account signed in.

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
- The sixteen entries dated 2026-09-07 through 2026-09-14 were folded into `lessons/` on 2026-09-14 (`Applied? yes`, entries removed) — nine from the `## Entries` section plus seven that had drifted above and below it. Seventeen landed as new lesson files (`a-cli-script-without-a-main-guard-runs-on-import`, `withhold-at-the-payload-not-in-the-prompt`, `prove-a-root-cause-by-reverting-only-it`, `an-unquoted-heredoc-executes-its-content`, `an-ephemeral-instance-can-print-a-first-run-secret`, `hold-a-wait-in-a-cheap-foreground-worker`, `stack-work-behind-a-serialized-gate`, `a-case-insensitive-platform-hides-a-case-sensitive-bug`, `a-version-bump-does-not-invalidate-every-cache`, `re-run-the-gate-at-the-integration-point`, `order-the-brief-so-parking-is-harmless`, `verify-a-citation-before-it-becomes-an-assumption`, `capture-gate-output-in-full`, `under-a-denylist-deploy-order-is-a-security-property`, `deliver-the-judgment-not-a-pointer-to-it`, `prove-the-runtime-not-the-error-text`, `brief-for-the-decision-not-your-conclusion`). Six bullets inside multi-bullet entries were folded BY MEANING into existing lessons rather than duplicated: backgrounded runs dying with a parked agent into `background-agents-die-with-their-host` (a log with no summary is NOT RUN); routing-tool-over-taste into `an-omitted-worker-tier-inherits-the-leads` (effort is definition-locked, so pick the DEFINITION); rebase-before-every-trigger into `promoter-strategy-must-match-target-history`; degrading shared-box capacity into `budget-fan-out-against-host-memory`; deferred connector tools arriving mid-session into `tool-listing-is-scope-filtered` (absence is point-in-time, and a negative listing expires); and canary mis-tuning into `a-guard-reused-across-contexts-can-invert`. One whole entry — "a sub-agent reporting to its spawner needs no address" — was folded into `resolve-the-reply-to-address` as an AMENDMENT (title widened: for a sub-agent the fix is to REMOVE the address, because the spawn tool's return value is the channel), not added as a rival lesson. The same fold added five lessons harvested from the source project's memory files, decision ledger and merge history (`a-recorded-commit-id-dies-at-rebase`, `a-maintenance-write-fires-the-same-triggers`, `your-own-usage-is-in-the-metric`, `revalidate-a-deferred-action-at-execution-time`, `a-default-timeout-shorter-than-cold-start-manufactures-flakes`) and extended eight more existing lessons with new cases (`monitor-default-target-is-part-of-the-finding` → 3, `secret-resolution-fallback-chain` → 3, `correct-a-durable-record-explicitly` → 2, `match-instrument-to-failure-class` → 3, `heartbeat-over-time-box` → 3, `resumed-session-has-birth-capabilities` → 2, `ship-the-safe-handle-first` → 2, `outcome-level-reporting` → 2). Three dedup calls are worth recording: `a-version-bump-does-not-invalidate-every-cache` was kept SEPARATE from `one-switch-two-effects-autoupdate` (same family — a second cache serving the old version — but one is vendor-scoped and about a switch with two effects, the other universal and about independent consumers of one channel; reciprocal cross-links instead); `stack-work-behind-a-serialized-gate` carries the economic case while the safety case (hazard and guard in one release) went into `ship-the-safe-handle-first`, with each pointing at the other; and a candidate "name the funnel stage before blaming the source" was folded into `match-instrument-to-failure-class` as the unfalsifiable-rule case rather than landed as its own lesson.
- The fifteen entries dated 2026-09-18 through 2026-09-20 were folded into `lessons/` on 2026-09-21 (`Applied? yes`, entries removed) — all fifteen had drifted above the `## Entries` section again. Thirty-eight landed as new lesson files and twenty-two existing lessons were extended; twenty-five of the new files came from the inbox entries and thirteen from the same week's source-project memory files, decision ledger and merge history. Twenty-two bullets or whole entries were folded BY MEANING into existing lessons rather than duplicated: "a gate that runs after the thing it gates is a report" into `gate-the-write-not-the-aftermath` (title widened to cover both altitudes — assert before the write, verify the call ORDER before the deploy; corroborated by three independent sources this week); the second-promotion-path bullet into `safeguard-the-operation-not-the-entry-point`; canary shaping into `a-guard-reused-across-contexts-can-invert`; the one-tool-input-rewrite accumulator into `adjust-a-shared-accumulator-by-delta`; the SIGPIPE-after-green-gate push and the Windows teardown-crash exit code into `exit-code-void-when-output-stream-closes`; "an empty error log is not evidence of health" into `a-silent-guard-needs-a-canary` (→3); the public-CI-log leak gate and the case-insensitive variable collision into `credentials-never-reach-an-error-path`; isolation-claim strength plus MEASURED/NOT MEASURED/INFERENCE tagging into `scope-a-broken-finding-to-the-measured-path` (→4); "not configured" versus "broken" into `did-not-run-is-a-third-outcome` (→3); the send-only ephemeral registration into `registry-identity-and-liveness-honesty`; tool-prefix instability and "grep the repo for a rationale's own counter-example" into `static-instructions-teach-discovery`; one citation backing two claims into `verify-a-citation-before-it-becomes-an-assumption`; the spoofed user-agent and test-browser engine into `partial-emulation-hides-a-whole-tier`; the revert-trap runbook into `record-intentional-absence` (widened from a deliberate REMOVAL to also cover a deliberate ADDITION whose removal looks harmless); the tracked-orchestrator deploy mandate into `one-canonical-deployer`; PowerShell single-element array unrolling into `bulk-edit-success-log-is-not-evidence`; the scheduled runner cloning the default branch into `branch-what-deploys`; the additive-only rules change into `firestore-rules-pre-merge-checklist`; "an error's own suggested remedy can be the cause" into `read-which-error-fired-before-theorising`; and the internal verification server plus per-channel exclusions into `your-own-usage-is-in-the-metric` (→3). Two bullets from two different entries were merged into ONE new lesson, `calibrate-a-bound-against-the-real-distribution` — a reviewer-specified length bound that would have silently bucketed a valid value, and a severity threshold of 25 against a dataset whose maximum was 13 — because both reduce to specifying a bound without counting, and the lesson carries both directions ("blocks everything on day one" and "never fires" are equally broken). Three Windows argument-mangling gotchas (MSYS leading-slash rewriting, cmd.exe eating the caret, a POSIX drive path unresolvable by the runtime) landed as ONE lesson, `windows-shell-layers-mangle-your-arguments`, rather than three. Four dedup calls are worth recording. `an-omitted-scope-defaults-to-everything` was kept SEPARATE from `an-omitted-worker-tier-inherits-the-leads` — identical abstract shape (an omission is an affirmative decision and the default is the costly one) but one is privilege and the other spend, with different scope tags and different methods (read the created object back versus audit your routing defaults); reciprocal cross-links instead. `an-inherited-env-var-beats-the-child-cwd` was kept SEPARATE from `neutralize-ambient-env-in-negative-tests` — the same inheritance mechanism, but one produces a false PASS in a negative test and the other redirects a destructive write onto the real shared system. `reuse-the-authors-helpers-in-someone-elses-codebase` was kept SEPARATE from `staff-the-shared-layer-before-fanning-out` — the same duplication pressure under fan-out, but the stakes (acceptance by a maintainer you do not control) and the method (an adversarial verdict-based reuse review) differ from the internal case's repo gate. And `an-unauthenticated-duplicate-entry-is-not-an-outage` was kept SEPARATE from `tool-listing-is-scope-filtered` as its complementary direction: one reads a PRESENT warning about one registration, the other reads ABSENCE from a listing. Finally, one apparent CONTRADICTION resolved rather than landing: a candidate "send agent scratch outside the repo" read as contradicting `handoff-doc-live-state` ("keep a live status doc in the worktree"), but the existing lesson's doc is gitignored while the incident's files were untracked AND unignored — so it folded in as a reinforcement that the gitignore clause is load-bearing (an untracked, unignored file silently defeats a clean-tree-gated CI short-circuit), with the scratch-directory rule added as a bullet, and no rival lesson was created.
