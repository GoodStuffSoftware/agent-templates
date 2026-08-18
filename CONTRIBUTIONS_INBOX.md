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

### 2026-08-17 — Delete the dead code and its test together; a test that outlives its subject is a tax, not a guard

- **Trigger:** a flaky test kept failing a pre-push gate and blocking unrelated work. It only failed inside the full concurrent suite (it spawned real OS processes and blew a default per-test timeout); in isolation it passed every time. The standing backlog entry proposed raising the timeout or mocking the probe. The actual answer was that the subsystem it guarded had been retired months earlier and replaced elsewhere — so the test had **no remaining subject**, and every proposed fix was maintenance on a corpse.
- **Is it generic?** Yes. Stripped: the specific tool, language, test framework, and what the retired subsystem did. The reusable kernel is a triage question, not a technology fact.
- **Target:** new tagged file under `lessons/` (a triage rule). Adjacent to any existing lesson about root-causing rather than suppressing a flake — this is the case where the root cause is *upstream of the code*.
- **Proposed change:**

  > **Before you fix a flaky test, check whether its subject still exists.** When a test fails only under load and passes in isolation, the reflex is to widen the budget, mock the slow dependency, or retry. Ask first: *is the code this test guards still reachable, still shipped, still run by anyone?* If it is dead, the fix is to delete the test **together with the code it tests** — not to make a guard on unreachable code cheaper to run.
  >
  > Two failure modes this prevents, in both directions:
  > - **Raising the timeout only** leaves a test that costs wall-clock on every push forever and asserts nothing about behaviour anyone can observe.
  > - **Deleting the test only** is worse: it silently drops coverage while leaving the code in the tree, so the next reader assumes the code is live and untested.
  >
  > Establish "dead" by evidence, never by reputation: nothing listening on its port, its endpoints returning 404, no process supervisor entry, no caller in the import graph. Then trace what *else* the removal touches before deleting — a retired subsystem's directory usually holds a mix of dead modules and shared ones that live code still imports. Deleting the directory wholesale breaks the survivors; classify per module and relocate the ones with live callers.
- **Applied?** `no`

### 2026-08-17 — A "thin client" wrapper is exactly as dead as the server it wraps

- **Trigger:** a retirement was scoped as "delete the server and its UI". A separate component — a protocol adapter exposing that server's API as tools for other programs — was not in scope and looked independent. Reading its source header settled it in one line: *"this module holds NO logic of its own"*; every one of its ~30 operations was a single HTTP call to the dead server. Because its registration file was committed, it auto-loaded in **every** session and advertised 30 operations that could only ever return "unreachable". Leaving it would have preserved the precise failure the retirement existed to stop: an agent picking a plausible-looking tool that cannot work.
- **Is it generic?** Yes. Stripped: the protocol, the tool names, the transport, the product. The kernel is a scoping rule for retirements plus the "advertised but non-functional" hazard.
- **Target:** new tagged file under `lessons/` (scoping/retirement rule).
- **Proposed change:**

  > **When retiring a service, follow its clients — a pure wrapper dies with it.** Adapters, proxies, SDK shims, and tool/plugin registrations that hold no logic of their own are not separate components; they are the service's surface in another protocol. Grep the wrapper for its transport call (`fetch`, RPC stub, socket) and check whether *every* operation routes through it. If so, it goes in the same change.
  >
  > Treat an **auto-registering** wrapper as higher severity than ordinary dead code, not lower. Dead code that nobody imports is inert; a committed registration that loads in every session actively advertises capabilities to whoever is choosing what to call next, and they will fail only at call time. The remedy is deletion plus removing the registration — and, because a stray local registration can reappear, an ignore rule so it is never committed again.
  >
  > This crosses a scope boundary, so surface it rather than expanding silently: state the evidence (the header claim, the call-path grep, the auto-registration) and let the requester decide. "Not in the list I was given" is not the same as "out of scope".
- **Applied?** `no`

### 2026-08-17 — Verify a bulk text edit by reading a changed file, not by trusting the script's success log

- **Trigger:** a small find/replace script rewrote header comments across six files and reported success for all six. Five were destroyed — every space replaced with `*` — because a one-element list of `[find, replace]` pairs collapsed into a flat two-element list of **strings**, so indexing element `[0]`/`[1]` returned the first two *characters* of a string instead of the two members of a pair. Files with two or more pairs were untouched, which made the corruption look random rather than systematic. Nothing threw; the operation "succeeded".
- **Is it generic?** Yes. The specific collapse rule is one shell's semantics, but the class is broad: any language where a single-element container silently degenerates to its element (or where indexing a string succeeds instead of erroring) turns a nested-data bug into plausible-looking output rather than a crash.
- **Target:** new tagged file under `lessons/` (verification rule). Related to any existing lesson on confirming an edit landed.
- **Proposed change:**

  > **A bulk edit's success log is not evidence.** Scripted multi-file find/replace can "succeed" while writing garbage: nested-data bugs that degrade to string or character operations produce output, not errors. Two habits close it:
  > 1. **Prefer an exact-match edit tool** for multi-file text changes. Failing to find the target string should be a loud error; a hand-rolled replace treats a miss as a no-op and a mis-shaped argument as a different edit.
  > 2. **When you do script it, read one changed file afterwards** — the whole hunk, not a grep for the new string. Grepping for what you inserted confirms the insert and hides the collateral damage around it. Better still, assert the shape of your inputs before looping (`if the element is not a pair, fail`), so a degenerate container throws instead of silently changing meaning.
  >
  > Corollary: when only *some* targets are damaged, suspect input shape, not the edit logic. Uniform bugs corrupt everything; shape bugs corrupt exactly the cases that hit the degenerate path.
- **Applied?** `no`

### 2026-08-17 — A tree a version-control system refuses to check out is still buildable with plumbing

- **Trigger:** an agent running on one OS committed a cache file whose *name* was a legal filename there but structurally impossible on another (it embedded a drive letter and separators from the other platform). Every developer on the second platform was then unable to create a new working copy from that branch at all — the checkout aborted before producing any files. This blocked all local work on the branch, not just that one file, and the obvious fixes were circular: the tools that would let you stage the deletion all refuse to materialize the tree first.
- **Is it generic?** Yes. Stripped: the VCS command names, the OS pair, the file, the project. The kernel is (a) cross-platform filename hazards from heterogeneous agents, and (b) the index-free recovery pattern.
- **Target:** new tagged file under `lessons/` (recovery technique + cross-platform hazard).
- **Proposed change:**

  > **When a commit contains a path your platform cannot represent, build the fix with plumbing that never touches a working tree.** Checkout, index-read, and partial-checkout mechanisms all validate paths, so they all refuse — and one of them may fail *silently into an empty state*, letting you construct and commit an empty tree if you do not check. The escape is to operate on the object graph directly: list the tree entries, filter out the bad one, write a new tree object from that listing, create a commit whose parent is the original tip, point a branch at it, and only then create a working copy.
  >
  > Two mechanical traps in that sequence: the filtered listing must use the **line endings and encoding the plumbing expects** (stray carriage returns get absorbed into filenames, silently renaming everything), and you must **diff the new tree against the old one and confirm it differs by exactly the intended removal** before committing. Verify, do not assume, that your rebuild is a one-line change.
  >
  > Prevention is upstream: when agents run on heterogeneous platforms against one repository, a path that one of them resolves relative to its own filesystem can become a literal filename for the others. Machine-local caches belong outside the repository, and ignore rules should cover the shapes a foreign platform would produce.
- **Applied?** `no`

_Append new entries above this line, newest first. The queue was drained by the 2026-08-17 fold._

---

## Fold history

- The twelve entries dated 2026-07-27 through 2026-08-02 were folded into `lessons/` on 2026-08-03 (`Applied? yes`, entries removed per the maintainer flow above).
- The thirteen entries dated 2026-08-03 through 2026-08-08 were folded into `lessons/` on 2026-08-10 (`Applied? yes`, entries removed). Twelve landed as new lesson files; the "write down what you measured, not what it implies about the category" entry was folded BY MEANING into the existing `scope-a-broken-finding-to-the-measured-path` lesson (title widened, `corroborated` raised) rather than duplicated.
- The six entries dated 2026-08-10 through 2026-08-16 were folded into `lessons/` on 2026-08-17 (`Applied? yes`, entries removed). Five landed as new lesson files (`assert-the-guard-saw-something`, `probe-behaviour-not-version-stamps`, `monitor-default-target-is-part-of-the-finding`, `a-suppress-verdict-expires`, `answer-no-such-thing-not-i-wont`); the "match a claim's scope to its evidence's scope" entry was folded BY MEANING into `scope-a-broken-finding-to-the-measured-path` (the entry itself flagged the near-duplicate; `corroborated` raised to 3) rather than added as a sixth file. The same fold added three lessons harvested from the source project's merge history and extended three existing lessons.
