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

_Append new entries above this line, newest first. The queue was drained by the 2026-08-24 fold._

---

## Fold history

- The twelve entries dated 2026-07-27 through 2026-08-02 were folded into `lessons/` on 2026-08-03 (`Applied? yes`, entries removed per the maintainer flow above).
- The thirteen entries dated 2026-08-03 through 2026-08-08 were folded into `lessons/` on 2026-08-10 (`Applied? yes`, entries removed). Twelve landed as new lesson files; the "write down what you measured, not what it implies about the category" entry was folded BY MEANING into the existing `scope-a-broken-finding-to-the-measured-path` lesson (title widened, `corroborated` raised) rather than duplicated.
- The six entries dated 2026-08-10 through 2026-08-16 were folded into `lessons/` on 2026-08-17 (`Applied? yes`, entries removed). Five landed as new lesson files (`assert-the-guard-saw-something`, `probe-behaviour-not-version-stamps`, `monitor-default-target-is-part-of-the-finding`, `a-suppress-verdict-expires`, `answer-no-such-thing-not-i-wont`); the "match a claim's scope to its evidence's scope" entry was folded BY MEANING into `scope-a-broken-finding-to-the-measured-path` (the entry itself flagged the near-duplicate; `corroborated` raised to 3) rather than added as a sixth file. The same fold added three lessons harvested from the source project's merge history and extended three existing lessons.
- The twelve entries dated 2026-08-17 through 2026-08-22 were folded into `lessons/` on 2026-08-24 (`Applied? yes`, entries removed). Ten landed as new lesson files (`staff-the-shared-layer-before-fanning-out`, `background-agents-die-with-their-host`, `absence-observed-is-not-absence-explained`, `review-docs-against-the-code-seam`, `resumed-session-has-birth-capabilities`, `fresh-fire-wake-handle-costs-a-session`, `delete-the-test-with-its-dead-subject`, `a-pure-wrapper-dies-with-its-service`, `bulk-edit-success-log-is-not-evidence`, `rebuild-an-unrepresentable-tree-with-plumbing`). Two were folded BY MEANING into existing lessons rather than duplicated: "assert the wire effect, not the local variable" into `assert-the-resolved-value-not-the-declaration` (third case added, title widened, `corroborated` raised to 3), and "resurrect stopped subagents by messaging them" into `recovery-from-silent-teammates` (`corroborated` raised to 2). The same fold added eight lessons harvested from the source project's merge history and decision ledger, and extended `verify-at-destination-prove-the-target` with the transforming-intermediary case. Note: the entry on fresh-fire wake handles AMENDED its sibling — a fresh session acts FOR a session-bound durable name without registering, because reclaim-by-register enumerates to `<name>-N`; both lessons landed carrying the corrected version.
