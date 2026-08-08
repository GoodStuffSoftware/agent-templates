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

### 2026-08-07 — a wide agent fan-out starves the host, and the damage surfaces as "flaky tests" somewhere else

- **Trigger:** an orchestrator session fanned out a large number of parallel agents on a memory-constrained laptop. Later, an unrelated task's pre-push gate failed three times. The first two failures were the same spec hitting a hardcoded timeout; the third was two *different* specs failing in two *different* modes — one reading an empty log file a piped child process should have written to, the other reporting that 2 of 5 external-process queries had genuinely errored rather than run slow. Three diagnostic rounds went into the tests and into hunting orphaned processes from a previously-documented leak. Only then did anyone measure the machine: **0.4 GB free of 13.7 GB**, with the agent fleet itself the single largest consumer. The session had starved the box and then spent three rounds debugging its own symptom, one layer too low.
- **Is it generic?** Yes. Stripped: the machine, the vendor, the projects, the repo, the specific specs. The reusable kernel is that **concurrent agents are full OS processes, and fan-out width is a resource decision, not only a parallelism decision.** Under memory pressure, failures do not appear in the agent layer where the cause lives — they appear wherever something spawns a subprocess, shells out, or depends on I/O timing. Those failures are *nondeterministic*, which is precisely the signature people label "flaky test" and then investigate at the test layer. The tell that distinguishes the two: a **timeout** is consistent with a fragile budget, but an **error return** from an operation that normally succeeds means the resource wasn't there. Also note the self-inflicted loop — the same session that widened the fan-out was the one debugging the result, with no visibility into its own footprint.
- **Target:** a new tagged file under `lessons/` — tags: `agent-process`, `resource-budget`, `false-flake`, `diagnosis-order`. Predicate: `requires: {}` (holds on any host; only the threshold is machine-specific).
- **Proposed change:**

  ```markdown
  # Budget fan-out width against the host's memory, not just against the task

  Each concurrent agent is a full process with its own footprint (a few hundred
  MB is typical). Deciding how wide to fan out is therefore a resource decision
  as much as a parallelism one, and on a constrained host the two answers differ
  sharply.

  What makes this hard to catch is that the damage does NOT land in the agent
  layer. It lands wherever the machine is asked for something it no longer has:

  - tests that spawn real subprocesses or shell out
  - anything reading a file another process is still writing
  - operations with a fixed time budget
  - external process/system queries

  These fail NONDETERMINISTICALLY, which reads as "flaky test." So the
  investigation starts at the test, and the test is fine.

  **Diagnostic order.** When a subprocess-spawning or I/O-timing test fails
  nondeterministically, measure free memory BEFORE reading the test. If free
  memory is low, stop investigating the test — free resources and retry.

  **The distinguishing tell.** A *timeout* is consistent with a merely fragile
  budget. An *error return* from an operation that normally succeeds — a query
  that fails outright, a file that is empty rather than late — means the
  resource was absent, not slow. Two different failure modes across two
  unrelated specs in one run is a host signal, not a test signal.

  **The trap.** The session that widened the fan-out is usually the one
  debugging the symptom, and it has no view of its own footprint. Treat
  "several unrelated things got flaky at once" as evidence about the machine
  before it is evidence about the code.

  Before a wide fan-out: check free memory. On a constrained host, prefer
  sequential batches over maximum concurrency — and remember the ceiling is the
  host's, not the task's.
  ```
- **Applied?** `no`

### 2026-08-07 — "safe because X is never used" is a tripwire, and the comment saying so is what disarms the alarm

- **Trigger:** a cross-environment data-migration function copied a user's auth claims verbatim between environments. A comment on that code read, in substance, "this is a defensive no-op — no such claims are used today." It was accurate when written. A later change introduced a privilege-bearing claim, and in doing so converted the no-op into a privilege-escalation path: an administrator in a low-trust environment could grant the claim to a fresh account there, migrate that account to production, and arrive with production administrator rights. The migration code had six documented containment controls; every one of them governed WHICH environment could be written to, and none inspected WHAT was being written. The feature author never opened that file — it was not part of the change, and nothing in the change's own diff pointed at it. An adversarial reviewer found it only by asking what ELSE consumes the thing being introduced.
- **Is it generic?** Yes. Stripped: the platform, the products, the claim name, the projects. The reusable kernel is that a comment of the form *"this is safe because X does not exist / is not used / is always empty"* is a **conditional assertion with no enforcement**. Its truth depends on a global property of the system that nothing checks and that any future change may silently revoke. Two consequences make it worse than an ordinary stale comment. First, the failure is **non-local**: the change that invalidates it happens somewhere else, by someone who has no reason to read this file, so no diff ever shows the assertion becoming false. Second, the comment is **actively load-bearing in the wrong direction** — it does not merely become wrong, it discourages the very inspection that would catch it. A reader who arrives with a doubt is talked out of it by a sentence that was true years ago.
- **Target:** a new tagged file under `lessons/` — tags: `security`, `stale-comment`, `non-local-invariant`, `review-scope`, `assumption-drift`.
- **Proposed change:**

  ```markdown
  # "Safe because X is never used" is an unenforced invariant — treat it as a tripwire, not a reassurance

  Somewhere in most codebases is a comment shaped like: "this copies everything
  verbatim, which is fine — nothing sensitive is stored here today." Or "no-op:
  we never populate that field." Or "unreachable: that mode is disabled."

  Each states a fact about the whole system, records it in ONE local file, and
  then relies on it forever with nothing enforcing it. It is an invariant with
  no guard.

  The danger is not that it goes stale. Plenty of comments go stale harmlessly.
  It is that this kind goes stale NON-LOCALLY and INVISIBLY:

  - The change that falsifies it happens in a different file, by someone with no
    reason to read this one. No diff ever shows the assertion flipping.
  - The comment then argues AGAINST the inspection that would catch it. Someone
    who arrives suspicious reads a confident sentence and moves on. A silent
    hazard is bad; a hazard with a reassuring sign on it is worse.

  Two habits:

  1. **When you introduce X, grep for prose that assumes X's absence.** Not just
     callers, not just types — comments. Search the words, not the symbols:
     "never", "no-op", "not used", "always empty", "cannot happen". The code that
     breaks may compile perfectly and have no reference to your change at all.
  2. **When you WRITE such a comment, make it enforceable or make it a denial.**
     Prefer an allowlist over a denylist so the next addition is safe by default;
     prefer a test that asserts the invariant over a sentence that asserts it.
     If you truly cannot enforce it, write it as a WARNING about what would break
     ("if a privileged field is ever added here, this becomes an escalation
     path") rather than as an all-clear. The same knowledge, aimed so that it
     alerts the future reader instead of dismissing them.

  For reviewers: when a change introduces a new KIND of thing, the blast radius
  is not the diff. Ask what else in the system handles that kind generically —
  copiers, serialisers, exporters, sync jobs, backup and migration paths. Generic
  machinery is exactly what treats a new privileged thing as just another value.
  ```
- **Applied?** `no`

### 2026-08-07 — a hardcoded reply-to address in a briefing template fails silently, and silence reads as progress

- **Trigger:** an orchestration doctrine file instructed, verbatim, that every subagent brief must end with `Report via SendMessage(to="team-lead")`. That address is only valid in one harness shape. In a session where the team was implicit (the spawn tool's own description said the team parameter was deprecated and ignored), no agent named `team-lead` existed — the orchestrator was addressed as `main`. Four agents were spawned with the stale wording. Each one independently discovered the address was unreachable and fell back, one of them reporting *"no agent named team-lead is reachable — messaging you as main."* Cost was one wasted turn per spawn. The latent cost is worse: an agent that does not think to fall back drops its report entirely, and a dropped report is indistinguishable from an agent still working.
- **Is it generic?** Yes. Stripped: the project, the harness names, the agent names, the specific tool. The reusable kernel is that **a briefing template hardcodes a piece of environment state — the orchestrator's address — that the template cannot know.** It is a generic instance of a broader class: any doctrine file that embeds an identifier resolved at runtime will eventually be read in an environment where that identifier is wrong. The failure mode is the interesting part, not the address itself: a bad reply-to address fails *silently and asymmetrically*. The sender believes it reported; the recipient sees nothing; and the recipient's default reading of "nothing" is "still running," so the error masquerades as normal operation rather than surfacing as an error.
- **Target:** a new tagged file under `lessons/` — tags: `briefing`, `orchestration`, `silent-failure`, `environment-coupling`, `template-hygiene`.
- **Proposed change:**

  ```markdown
  # Don't hardcode the reply-to address in a briefing template — resolve it, or make the brief self-healing

  Briefing doctrine likes to end with a required closing line: "report back via
  {{MESSAGE_TOOL}} to {{ORCHESTRATOR_NAME}} when done." The instruction is right. The
  hardcoded name in it is a bet that every future session has the same topology, and
  that bet loses quietly.

  Orchestrator addressing is environment state, not doctrine. Depending on how a
  session was created, the parent may be a named teammate ({{ORCHESTRATOR_NAME}}) or a
  distinguished built-in endpoint ({{MAIN_ENDPOINT}}). The spawning tool's own
  description usually says which — e.g. if it documents the team parameter as
  deprecated or ignored, there is no named lead to address.

  Two rules:

  1. **Resolve before briefing.** Read the spawn tool's description once at session
     start and use the address it implies for every brief that session.
  2. **Write self-healing briefs when unsure.** "Report to the orchestrator — address
     it to {{MAIN_ENDPOINT}}; if that does not resolve, use {{ORCHESTRATOR_NAME}}."
     Costs one clause, removes the whole failure class.

  The reason this is worth a rule rather than a shrug is the shape of the failure. A
  bad address does not raise anything the orchestrator can see. The worker believes it
  delivered; the orchestrator receives nothing; and "nothing received" is the same
  signal as "still working." So the error does not present as an error — it presents as
  patience. Any doctrine that tells a lead to wait on a report is, in this state,
  telling it to wait forever.

  Generalises past addressing: **whenever a template embeds an identifier that is
  resolved at runtime — an address, a branch, a port, a path, a channel — either
  resolve it at the point of use or make the instruction degrade gracefully.** Prefer
  the failure that is loud over the one that looks like waiting.
  ```
- **Applied?** `no`

### 2026-08-06 — an over-scoped claim closes the question; two agents did it to each other in one thread

- **Trigger:** an agent observed that a particular browser tool froze CSS transitions and refused screenshots. True, and directly measured. It then wrote that down as a property of "agent browser contexts" — a category — and put it in a handoff doc. For several days afterwards nobody investigated an open animation question; they routed around it, because the doc said the measurement was impossible. When a second agent finally measured a *different* browser, it reported normal behaviour: page visible, frame loop live, animation clock tracking wall-clock to 0.03ms. The blocker had never existed outside the one tool. The second agent then immediately wrote "so the suspension is a property of agent browser contexts specifically" — generalising from its own single sample, in the same message where it was discussing the first agent's identical error.
- **Is it generic?** Yes. Stripped: the tools, the projects, the agent names, the specific API. Two reusable kernels. First, the cost of an over-scoped claim is not that it is wrong — it is that it **converts an open question into a closed one**, and closed questions do not get re-measured. A wrong answer invites correction; a wrong *scope* silently removes the reason to look. Second, and the reason to write it down at all: naming a bias confers no immunity from it. Both agents committed the same error hours apart while explicitly discussing that error.
- **Target:** a new tagged file under `lessons/` — tags: `scope-creep`, `false-blocker`, `documentation-harm`, `self-verification`.
- **Proposed change:**

  ```markdown
  # Write down what you measured, not what it implies about the category

  You tested one tool, one environment, one version, one account. When you record the
  result, the sentence wants to grow: "tool X does not do Y" becomes "tools of this kind
  do not do Y." Resist it, because the two sentences have very different consequences
  once someone else reads them.

  A wrong ANSWER invites correction — someone re-runs it and disagrees. A wrong SCOPE
  removes the reason to run anything. It reads as settled, so the question stops being
  asked. Measured cost in one case: several days and multiple agents routing around a
  blocker that existed in exactly one tool, because a true observation about that tool
  had been filed as a property of the class.

  **When recording a limitation, name the thing you actually touched.** If the scope
  genuinely is broader, say what makes you think so and mark it as inference:

      MEASURED: {{TOOL}} at {{VERSION}} does not {{BEHAVIOUR}}.
      INFERRED (untested): other {{CATEGORY}} tools may share this — not checked.

  The split costs one line and preserves the reason to look.

  **And do not expect awareness to protect you.** In the case this came from, the agent
  that corrected someone else's over-generalisation committed the identical one in the
  same message. Knowing the failure mode is not a control for it. What works is the
  mechanical habit above — writing MEASURED and INFERRED as separate lines — because it
  operates on the artifact rather than on your attention.
  ```
- **Applied?** `no`

### 2026-08-06 — a union merge silently eats the shared closing delimiter; parse-check every resolved file

- **Trigger:** two agents each appended a new test at the end of the same test file on separate branches. Git factored out the trailing line common to both appended blocks — the closing delimiter — and presented it ONCE below the conflict as ordinary context. The obvious resolution ("keep both, they're independent tests") produced two test bodies and one closer. The file silently stopped parsing. It happened twice in a single conflict-mapping exercise, the second time to an agent who already knew about it. Reading the resolution did not catch either instance; a parse check caught both.
- **Is it generic?** Yes. Stripped: the language, the repo, the branch and agent names, the test framework. The reusable kernel is that a union resolution is only safe when the two sides share no trailing token — and appending sibling blocks to a file guarantees they do. The secondary kernel is diagnostic: the resulting failure is at FILE granularity, which misreads as a semantic conflict between the two changes and sends you hunting for a logic interaction that does not exist.
- **Target:** a new tagged file under `lessons/` — tags: `merge-resolution`, `false-diagnosis`, `silent-corruption`, `verification`.
- **Proposed change:**

  ```markdown
  # "Keep both sides" is not safe when both sides end the same way

  When two branches each APPEND a block at the end of a file, the appended blocks end
  with the same closing token — `});`, `}`, `end`, `)`, `</div>`. Git treats that shared
  trailing line as **context common to both sides**, so it appears exactly once, below
  the `>>>>>>>` marker, outside the conflict region.

  Resolve by keeping both bodies and you keep **two blocks and one closer.** The file no
  longer parses.

  Nothing about this looks wrong. No line was deleted by anyone — a line simply was never
  duplicated. The diff reads as a clean union. Every block is individually well-formed.
  Review by reading does not catch it; it has been missed by reviewers who knew the
  failure mode.

  **The diagnostic trap is the expensive half.** The build or suite then fails at *file*
  granularity rather than at *block* granularity. That reads as "these two changes are
  jointly incompatible," so the investigation goes looking for a semantic interaction
  between two changes that are, in fact, entirely independent. A file-level parse error
  immediately following a hand-resolved conflict is this until proven otherwise.

  **The check.** After resolving any conflict, before running anything else, parse every
  file you touched:

      git diff --name-only --diff-filter=U | xargs -n1 {{PARSE_CHECK_COMMAND}}

  (`node --check`, `python -m py_compile`, `ruby -c`, `tsc --noEmit`, a compiler front
  end — whatever is cheapest for the language.) Make it automatic after every resolution
  rather than something you remember when appending "feels likely." It costs milliseconds
  and it is the only check that finds this.

  **Highest-risk shape:** test files, because appending at the end is the ordinary way to
  add one, so two people adding tests to the same file collide here by default.
  ```
- **Applied?** `no`

### 2026-08-06 — offer the safe handle before the unsafe one is the only one

- **Trigger:** three separate identity bugs in one codebase in one week, each one an agent deriving identity from a convenient string instead of from an authenticated credential: a transport class treated as an ownership signal; a garbage-collection tombstone's actor field read as the record's owner; a requested name treated as proof of the caller. A fourth was caught *before* it was written — the proposed fix for the third would have had to parse an identifier out of a token name, because the object carrying the real identity was dropped before reaching the request context. That is: **the codebase made the wrong implementation the only available one.**
- **Is it generic?** Yes. Stripped: the language, the auth scheme, the field names. Reusable kernel: when the correct approach requires a handle the code does not expose, every implementer independently reaches for the incorrect one — and each looks locally reasonable. The recurrence is a property of the API surface, not of the people.
- **Target:** a new tagged file under `lessons/` — API/affordance design, adjacent to the existing safeguard-placement lesson. That one is about WHERE a check goes; this one is about whether the correct call is *possible* at the call site.
- **Proposed change:**
  - When the same class of mistake recurs across independent authors, stop treating it as a discipline problem. Ask what handle the correct implementation needs and whether the code exposes it. Three instances by three authors is evidence about the surface.
  - **Ship the safe handle FIRST, as its own change, before the work that needs it.** If it lands as an acceptance criterion *inside* the risky change, the implementer still starts from the unsafe path and has to climb out. Landing it first makes the correct implementation the path of least resistance instead of the one requiring vigilance.
  - Watch for context objects that DROP the field carrying real identity (a normalizer returning a hand-picked subset). The drop is usually invisible and is what forces every downstream caller into a string parse.
  - **A distinction between two similar bug shapes is useless without a search handle.** When filing "these are different problems", give each one a concrete grep target — otherwise a sweep for one silently misses the other and the distinction was decorative.
  - Derive identity from the authenticated credential, never from a parameter naming the subject. A filter like `?subject=<id>` read off the request is not a restriction; it is a lookup by any caller. If it must exist, validate it against the authenticated identity rather than trusting it.
- **Applied?** no

### 2026-08-05 — reachability is directional: proving you can reach peers proves nothing about peers reaching you

- **Trigger:** an agent acting as the coordination hub was unreachable for ~26 hours and nobody, including the agent itself, noticed. Every health check it ran was of the **outbound** direction — a dispatch log showing 12/12 sends fired with HTTP 200 — and every one passed. The **inbound** path (a background listener process that polls the message bus and resumes sessions) had died on a transient network error and nothing was configured to restart it. Peer messages were durably queued the whole time, so no data was lost and no error surfaced anywhere; the agent simply never woke. It was caught only when a human asked "do you not have a trigger?"
- **Is it generic?** Yes. Stripped: the specific bus product, agent names, host OS paths, and the listener's filename. The reusable kernel is that outbound and inbound reachability are independent channels that share no failure mode, so a green outbound check is not evidence about inbound — and an unsupervised background process is a single point of failure that fails *silently* by design, because a queue that holds messages correctly produces no error. This applies to any agent that is addressable by peers, on any transport.
- **Target:** a new tagged file under `lessons/` — tags: `agent-reachability`, `false-negative`, `background-process`, `self-monitoring`.
- **Proposed change:**

  ```markdown
  # Verify the direction you actually depend on

  If peers are supposed to be able to reach you, **outbound health tells you nothing.**
  Sends succeeding and receives working share no component and no failure mode. An agent
  can dispatch flawlessly to everyone while being completely unreachable itself.

  This fails silently on purpose. A well-built bus **queues** messages for an agent that
  is down — nothing is lost, so nothing errors. The absence of an alarm is the expected
  behaviour of a healthy queue, not evidence that you are reachable.

  **Check the inbound path explicitly:**

  1. **Is the receiving process actually alive?** Not "was it started" — enumerate the
     process now (`{{PROCESS_QUERY}}` matching the listener's command line). A log whose
     last line reads `retrying in 1s` may mean it is retrying quietly, or may mean it died
     mid-retry. Many listeners log only the 1st and every Nth failure, so silence after
     one error line is ambiguous. The process table is not.
  2. **Will anything restart it?** A process started by hand dies with the first crash,
     network blip, sleep or reboot. If the tool has a `status` subcommand, the field that
     matters is the one saying whether it is *registered to start automatically* — not
     whether it is running this second.
  3. **Look for attempts addressed to you**, not just attempts made by you. If the
     transport records delivery outcomes, filter for your own name as the *recipient*;
     an outcome like `no-handle` means peers tried and could not land.

  **Two traps when fixing it:**

  - **Don't arm a handle that points somewhere else.** If the wake mechanism resumes a
     session in a different environment from the one you are in, you have registered a
     *false* handle: peers get a success response, a wrong agent wakes, and the failure is
     now harder to see than when you were plainly unreachable. No handle beats a wrong one.
  - **Don't self-probe a live session.** If your own name is in the listener's resumable
     set, sending yourself a test message resumes the session you are sitting in.
     Verify structurally instead — process alive, plus a fresh registration timestamp on
     your row — and let the next real peer message be the end-to-end proof.

  **Install-time gotcha:** registering a logon-triggered scheduled task often requires
  elevation and fails with a bare "access denied" that wrapper scripts tend to swallow
  into an unhelpful "exited 1". User-scope autostart (a startup-folder entry, a user
  service/agent) usually needs no elevation and is the better default.
  ```
- **Applied?** `no`

### 2026-08-04 — a headless browser pane that isn't compositing reports frozen geometry

- **Trigger:** verifying a floating-overlay UI change in an agent-driven browser. A `position: fixed` element whose inline style said `width: 1233px` measured **401px** via `getBoundingClientRect()`. There was no layout bug: the pane was not displayed, so it was not compositing frames, so the element's opening CSS transition never advanced and every geometry read returned the frozen *interpolated* value. Roughly an hour was lost chasing a defect that did not exist.
- **Is it generic?** Yes. Stripped: the specific project, component and element sizes. The reusable kernel is that an agent-driven browser that is not painting still runs JS and answers DOM queries truthfully-looking, while silently invalidating (a) any measurement of a transitioning element, (b) any handler driven by `scroll`, and (c) screenshots entirely. That applies to any agent doing browser verification, not to one framework or one app.
- **Target:** a new tagged file under `lessons/` — tags: `browser-verification`, `headless`, `false-negative`.
- **Proposed change:**

  ```markdown
  # Don't trust geometry from a browser pane that isn't painting

  An agent-driven browser pane that is **not displayed does not composite frames**. It still
  executes JS and still answers DOM queries, so it looks healthy — but three classes of
  observation become silently wrong:

  1. **CSS transitions freeze mid-flight.** `getBoundingClientRect()` and
     `getComputedStyle(el).transform` return the frozen interpolated value, not the settled
     one. An element can measure a fraction of its real size for no visible reason.
  2. **`scroll` events are never dispatched**, so scroll-driven handlers look dead.
  3. **Screenshots fail** outright — there is no agent-side workaround; substitute
     DOM/geometry assertions for visual evidence.

  **Before measuring anything, neutralise transitions:**

  ```js
  const s = document.createElement('style');
  s.textContent = '*, *::before, *::after { transition-duration:0s !important; animation-duration:0s !important; }';
  document.head.appendChild(s);
  ```

  Geometry becomes deterministic at once, and this doubles as an honest exercise of the
  `prefers-reduced-motion` path. Re-inject after every navigation — a reload drops it.

  For a handler that needs an event the pane won't deliver, **dispatch it yourself**
  (`el.dispatchEvent(new Event('scroll'))`) and state in the report which behaviour was
  observed naturally and which was simulated. That proves the handler's logic honestly
  without claiming the browser delivered the event.

  **Two adjacent traps in the same family:**
  - The browser **caches ES modules**. A fix that provably exists in the served file
    (confirm with `fetch(url, {cache:'no-store'})`) can have no effect on the page after a
    plain reload. Force a cache-busting navigation instead.
  - The pane can **collapse to zero size** or **navigate itself elsewhere** mid-session.
    Re-assert both the viewport size and `location.href` before trusting a measurement —
    cheapest check is that a known fixture count still matches.

  **The general rule:** when a browser measurement contradicts the inline style you just
  set, suspect the observation before the code.
  ```

- **Applied?** `no`

### 2026-08-04 — a live check against the shared trunk cannot allocate a shared number

- **Trigger:** four unmerged branches, written by three agents in parallel, independently claimed the SAME sequential decision-record number ({{ADR_PREFIX}}121). Every one of them did the correct thing: fetched the current trunk, grepped the decisions file, found the real maximum, incremented. Every one of those checks was right and every one was insufficient, because a check against the trunk cannot see another branch that has not merged. Resolution cost several coordination round-trips and one agent renaming 9 references across 7 files. A fifth branch had already burned the same lesson earlier — it carried a number that had been taken by unrelated work while it sat shelved.
- **Is it generic?** Yes. Stripped: the project, the record type, the specific numbers. The reusable kernel: **any monotonically-allocated shared identifier — ADR/decision numbers, migration ordinals, fixture ports, feature-flag slots, error codes — cannot be safely allocated by reading the trunk when work happens on concurrent branches.** The check is necessary, not sufficient, and nothing local can answer "is this free" until merge time.
- **Target:** a new tagged file under `lessons/` — concurrency / shared-resource allocation. Adjacent to the existing verification-discipline lessons: same family as "a plausible proxy is not the measurement."
- **Proposed change:**
  - Treat trunk-derived allocation of a shared sequential id as a **conflict-prone guess**, not a decision. It is the right first step and it does not settle the question.
  - Prefer identifiers that **cannot collide**: a slug, a date-stamp, a content hash, or an id minted from a single authority. Sequential integers are a shared mutable resource wearing the costume of a constant.
  - If sequential numbering is required (readability, an existing corpus), have **one integrator allocate** — the only actor who can see every branch at once. Agents propose; the integrator assigns.
  - Cheap mitigation when neither is possible: **re-verify immediately before push, not only at authoring time**, and sweep every branch rather than the trunk alone (`git log --all` / per-branch grep). This narrows the window; it does not close it.
  - **Record the renumbering history in the artifact itself.** An entry that silently changed number twice looks authoritative and is unciteable — anything that referenced the old number now points nowhere. One line naming the prior numbers is what makes a late renumber safe.
  - Reviewer prompt: "could two branches in flight both be right about this value?" If yes, it is not a value to derive locally.
- **Why it evades review:** each branch is individually correct and passes its own gates. The conflict does not exist in any single tree — it comes into being only at merge, and only if someone happens to be looking at both.
- **Applied?** no

### 2026-08-03 — normalize line endings before calling two copies "different"

- **Trigger:** installing a vendor plugin that ships the same skills already hand-copied into a user-level directory. A naive per-file hash comparison reported all 11 shared directories as DIFFERING, which reads as "the local copies were customized — don't touch them." Re-comparing after stripping `\r\n` → `\n` showed 10 of 11 were byte-identical in content; the hashes differed only because the hand-copied set had been checked out on Windows with CRLF. The 11th was genuinely different (32 files vs 13, plus real content diffs) and was the only one worth preserving. Deleting on the raw-hash signal would have kept 10 stale unmanaged shadows; trusting a file-count-only check would have destroyed the one real customization.
- **Is it generic?** Yes. Stripped: the vendor, the plugin name, the skill names, the directory paths. Reusable kernel: on any cross-platform checkout, content equality and byte equality are different questions, and the destructive decision hangs on the former. Applies to any dedupe/supersede/migrate step comparing a vendored copy against a local one.
- **Target:** a new tagged file under `lessons/` — verification/measurement discipline. Same family as the "match ids, don't compare dates" entry: a plausible proxy (file hash) standing in for the quantity actually being asked about (content equality).
- **Proposed change:**
  - Before deleting a local copy because a managed/vendored one supersedes it, compare on NORMALIZED content (`(Get-Content -Raw) -replace "\`r\`n","\`n"`, or `git diff --ignore-cr-at-eol` / `diff --strip-trailing-cr`). A raw hash mismatch on a Windows checkout usually means line endings, not edits.
  - Use two independent signals, not one: **file-set difference** (extra or missing paths) answers "was this extended?"; **normalized content difference** answers "was this edited?" Either one non-zero means stop and inspect. Both zero means safe to supersede.
  - Always back up to a timestamped sibling directory before removing, and report the backup path in the same message as the removal — a reversible destructive step still has to be *findably* reversible.
  - Report the per-item verdict, not an aggregate. "10 identical, 1 differs, here's what's extra in that one" is actionable; "the directories differ" is what produces the wrong decision.
- **Applied?** no

### 2026-08-03 — match ids, don't compare dates (four wrong answers from three timestamps)

- **Trigger:** two agents reconciling a work-board backfill against session transcripts on disk spent four round-trips converging on a number. Every wrong step was the same mistake with a different pair of date fields: (1) session START compared against a deletion horizon that ages by LAST WRITE — a session started in May and resumed in July is still on disk; (2) file CREATION time used as a proxy for session start — but copy/move resets it and a resumed session can land in a fresh file, so three June-start sessions carried July creation stamps; (3) one agent then used the other's creation-time count as a CEILING, producing "at least 24 orphaned" when the truth was 22 — a floor the truth sat below. A single pass of matching identifiers gave the exact answer (20 present, 22 absent) with no inference at all.
- **Is it generic?** Yes. Stripped: the platform, the retention window, the record counts, the specific field names. Reusable kernel: distinct date fields name distinct EVENTS, and any claim requiring two dates to refer to the same event should be settled by identifier matching instead. Applies to any reconciliation between two systems that each stamp their own timestamps.
- **Target:** a new tagged file under `lessons/` — verification/measurement discipline. Sits alongside the existing "verify the actual bound URL" lesson; same family (trust the measured identity, not a plausible proxy).
- **Proposed change:**
  - Before comparing two dates, establish they measure the same event. "Created", "started", "last modified", "last seen", "completed" are different quantities — magnitudes are comparable, the events behind them may not be.
  - If a claim NEEDS two dates to refer to the same event, that is the signal to stop and match ids instead. Identifier matching is usually cheap, always exact, and ends the argument.
  - A lower bound the truth sits below is worse than a plain wrong number: a bound invites being leaned on, and being wrong in the conservative-sounding direction is what makes it dangerous. State the raw measurement unless the derivation is airtight.
  - Record measured facts as `{value, checkedAt, checkedOn}` and leave unknowns ABSENT. An absent field says "unknown"; a fabricated default says "checked, and fine" — opposite claims to a later reader.
  - Name the scope of a check in the field itself. A presence check run on one machine cannot distinguish "absent everywhere" from "absent here."
- **Applied?** no

### 2026-08-03 — put safeguards on the operation, not the entry point

- **Trigger:** three separate safeguards in one repo were each found, independently, to be bypassable the same way, and nobody noticed they were one problem until the third turned up. (1) Git hooks wired by npm lifecycle scripts (`prepare`/`pretest`/`prelint`) rather than committed config — a clone where nobody ran one of those blessed commands has `core.hooksPath` UNSET, so commits and pushes silently skip every gate; CI is safe only incidentally because it runs `npm ci` first. (2) A guard preventing the test suite from opening the PRODUCTION database, wired to `pretest` — a direct `node --test path/to/one.test.mjs` skips it, which is the most ordinary thing anyone does when chasing one failing test. (3) A perf fix setting `TMPDIR` for test fixtures, applied inside the gated runner — plain and direct invocations still hit disk.
- **Is it generic?** Yes. Stripped: package-manager specifics, the database name, the repo. Reusable kernel: a safeguard attached to the convenient ORCHESTRATED entry point is absent on the DIRECT path, and the direct path is what people use under time pressure. Consequences ranged from merely slow to able to corrupt production data.
- **Target:** a new tagged file under `lessons/` — safeguard placement / review discipline.
- **Proposed change:**
  - Put a safeguard on the OPERATION, not the entry point. If the risk is "something opens the production database," the check belongs inside the path-resolution function every caller crosses — not in a script someone can route around.
  - When a fix is wired into a wrapper or lifecycle hook, ask explicitly: *what invocation skips this?* Then test that invocation, not just the happy one.
  - Verify the discriminator against the REAL invocation, not a simulated one — read the actual service unit's `ExecStart` and environment and probe under that exact shape. A simulation only proves the guard agrees with your model of the service.
  - Enumerate every real invocation shape before shipping: the service, timers, maintenance scripts, self-update, CI, hand-run commands. A guard that blocks a maintenance script has broken operations rather than protected them.
  - In agent reports, distinguish "the gate FIRED" from "I ran the checker BY HAND." Both are evidence; only the first also protects the next person.
  - **Enumerate every ACTIVATION path too, before stating which invocations are exposed.** The first diagnosis here said "any clone without `npm ci`" — wrong, because one clone had hooks from having run the test suite earlier, as a side effect of testing rather than installing.
- **Why it evades review:** every one of these passes its own gates — lint clean, tests green, commit lands, HEAD moves, remote sha real. The bypass is invisible because nothing fails; the protection simply isn't present.
- **Applied?** no

_The twelve entries dated 2026-07-27 through 2026-08-02 were folded into `lessons/` on 2026-08-03 (`Applied? yes`, entries removed per the maintainer flow above)._
