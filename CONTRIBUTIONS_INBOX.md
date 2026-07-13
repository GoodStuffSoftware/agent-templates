# Contributions Inbox

A holding area for generic improvements contributed back from real projects when no pull-request workflow is available. Entries here are **not yet applied** — a maintainer folds each one into its proper template/shared file (see [CONTRIBUTING.md](CONTRIBUTING.md) → "Where it goes") and then removes it from this file.

**This is a queue, not a home.** A change isn't "done" while it's only in the inbox.

## How to add an entry

Append a new dated entry at the **top** of the list (newest first), using the template below. Before adding it, run `node scripts/leak-check.mjs` — the entry must contain no real-world tokens (generalize specifics to `{{PLACEHOLDERS}}` or generic examples first).

```markdown
### YYYY-MM-DD — <short title>

- **Trigger:** what surfaced this (the gotcha / better step / missing rule).
- **Is it generic?** the result of the "is this generic?" test — what specifics were stripped, what reusable kernel remained.
- **Target:** where it should land (e.g. `anthropic/basic-site/agents/site-builder.md`, or `anthropic/shared/cross-project-rules.md`).
- **Proposed change:** the actual generalized text / diff, with `{{PLACEHOLDERS}}` in place of any real values.
- **Applied?** `no` (a maintainer flips this to `yes` and removes the entry once folded in).
```

---

## Entries

### 2026-01-01 — EXAMPLE (delete me) — add a "confirm bound port" note to the builder

- **Trigger:** a builder agent in a project reported a dev URL on `:{{DEV_PORT_BASE}}` when the server had actually fallen back to the next port, sending a reviewer to debug the wrong process.
- **Is it generic?** Yes. The only project-specific bit was the literal port number → replaced with `{{DEV_PORT_BASE}}`. The reusable kernel: "report the exact bound 'Local:' URL, never the requested port" — applies to any project with a port-falling-back dev server.
- **Target:** `anthropic/basic-site/agents/site-builder.md` (and it's already reflected in `anthropic/shared/cross-project-rules.md` §5.4).
- **Proposed change:** _(example only — this rule already exists in the template; this entry is just to show the format)_ ensure the builder's local-verification step says "report the EXACT 'Local:' URL the dev server prints (never the requested port — dev servers fall back `:{{DEV_PORT_BASE}}`→`:{{DEV_PORT_BASE}}+1`→… when a port is taken)."
- **Applied?** n/a — example entry. Delete when a real contribution arrives.
