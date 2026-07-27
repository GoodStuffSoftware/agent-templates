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

### 2026-07-27 — paginated APIs that sort alphabetically produce confidently wrong analysis

- **Trigger:** an agent pulled a breakdown report from an ads API, analysed the returned rows, and reported firm conclusions ("your two selected targets got 0% of delivery", "tier-1 markets got 4.5%"). The response was paginated AND ordered alphabetically, so only page 0 came back. Every conclusion was drawn from roughly the first letter of the alphabet. The full set — reached by following `pagination.next_url` to exhaustion — ran 122 pages and 6,077 rows, and reversed the findings outright: the entities reported as absent were present, and the largest segments (which happened to start with letters late in the alphabet) had been invisible. The output *looked* complete at every stage: valid JSON, plausible row counts, sensible-looking numbers, no error, no warning.
- **Is it generic?** Yes. Stripped: the vendor, the endpoint, the specific breakdown dimensions, the real row counts. The reusable kernel: **a truncated page of an ordered result set is indistinguishable from a complete small result set, and any aggregate computed over it is wrong without being detectably wrong.** The alphabetical ordering is what makes it dangerous — random ordering would produce obviously-odd samples, whereas alphabetical ordering yields a tidy list that reads as a whole dataset. Applies to any paginated API (ads platforms, CRMs, issue trackers, cloud billing, log search).
- **Target:** `anthropic/shared/cross-project-rules.md` (data-gathering / API section), and worth echoing in any analyst- or researcher-style agent definition that aggregates API results.
- **Proposed change:** add a rule along these lines:

  > **Never aggregate over an unpaginated fetch.** Before computing any total, share, ranking, or "X is absent" claim from an API result set, confirm you have the COMPLETE set: follow `next`/`next_url`/cursor links to exhaustion, or verify the response asserts there are no further pages. Two independent red flags that you are looking at page 0 of an ordered set: (a) the returned keys are clustered at the start of an alphabet or numeric range, and (b) the row count is a suspiciously round number ({{PAGE_SIZE}}, e.g. 50/100/1000/3000). A partial page is indistinguishable from a complete small result — it parses cleanly, sums cleanly, and yields confident wrong answers. Sanity-check by comparing the sum of a breakdown against the known grand total; if the parts do not reconcile to the whole, you are missing pages.
- **Applied?** `no`

### 2026-01-01 — EXAMPLE (delete me) — add a "confirm bound port" note to the builder

- **Trigger:** a builder agent in a project reported a dev URL on `:{{DEV_PORT_BASE}}` when the server had actually fallen back to the next port, sending a reviewer to debug the wrong process.
- **Is it generic?** Yes. The only project-specific bit was the literal port number → replaced with `{{DEV_PORT_BASE}}`. The reusable kernel: "report the exact bound 'Local:' URL, never the requested port" — applies to any project with a port-falling-back dev server.
- **Target:** `anthropic/basic-site/agents/site-builder.md` (and it's already reflected in `anthropic/shared/cross-project-rules.md` §5.4).
- **Proposed change:** _(example only — this rule already exists in the template; this entry is just to show the format)_ ensure the builder's local-verification step says "report the EXACT 'Local:' URL the dev server prints (never the requested port — dev servers fall back `:{{DEV_PORT_BASE}}`→`:{{DEV_PORT_BASE}}+1`→… when a port is taken)."
- **Applied?** n/a — example entry. Delete when a real contribution arrives.
