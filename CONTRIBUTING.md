# CONTRIBUTING — flowing improvements back to the library

This is the **UP-flow** (project → library). When a change you make in a real project improves something **generic**, you bring it back here so every future hydration inherits it. For the DOWN-flow (library → project) see [HYDRATION.md](HYDRATION.md).

---

## When to contribute (the trigger)

This extends the general agent-maintenance habit — *keep your agent defs, rules, and conventions as living documents* — one level up. Normally, when a session reveals a new gotcha, a better process step, or a missing rule, you update the relevant agent def or rules file **in the project**. The contribution trigger fires when that update is **generic**:

> A project change touches an agent def, a `CLAUDE.md` rule, or a convention, **and** the improvement would help other projects — not just this one.

Examples that SHOULD flow back:
- A stall-prevention or write-target rule that turned out to be missing or wrong in the template.
- A better default for an agent's `model`/`effort`, or a clearer routing description.
- A new reusable agent role that a whole class of projects would want.
- A sharper version of a cross-project rule in `anthropic/shared/cross-project-rules.md`.

Examples that should NOT flow back (project-local — they stay in the project):
- Anything naming the project, its domain, its stack, its brand voice, its file paths.
- A one-off convention that only makes sense for this product.
- Content, copy, or design decisions.

---

## The "is this generic?" test

Before contributing, run the change through this test:

1. **Does it name anything project-specific?** A real project name, domain, path, person, product, brand voice, or stack detail? If yes → strip those specifics.
2. **After stripping the specifics, is there still a reusable kernel?**
   - **Yes** → it's generic. Replace the specifics with `{{PLACEHOLDERS}}` (or generic examples like `acme.com`) and contribute it.
   - **No** — the rule *was* the specifics, nothing reusable remains → it's project-local. Keep it in the project; don't contribute.

If you're unsure, lean toward keeping it project-local. A template polluted with a half-generic rule is worse than a project that kept a useful local one.

---

## The scrub checklist

Before opening a contribution, scrub it:

- [ ] **Generalize specifics → placeholders.** Every real value becomes a `{{PLACEHOLDER}}` (and gets an entry in the template's placeholder table if it's new) or a generic example.
- [ ] **Pick the right home** (see next section).
- [ ] **Run the leak guard:** `node scripts/leak-check.mjs` — it must exit 0. It catches any real-world token you missed (project/product names, domains, user home path, handle, name, email, git-SHA-like hex runs). Fix every hit. **This same guard runs in CI on every push and pull request** (see [`.github/workflows/leak-check.yml`](.github/workflows/leak-check.yml)) and fails the check on any hit — running it locally first just saves a round-trip.
- [ ] **Re-read the diff as a stranger.** Would someone with no knowledge of your project understand and use this? If it only makes sense with your project's context, it's not generic yet.

---

## Where it goes

| What you're contributing | Where it lands |
|--------------------------|----------------|
| A fix/improvement to a specific agent role | that role's def, e.g. `anthropic/basic-site/agents/<role>.md` |
| A new agent role for a class of projects | a new def in the appropriate template's `agents/` |
| A change to the project-CLAUDE skeleton | `anthropic/<template>/CLAUDE.md.template` |
| A cross-project rule (applies regardless of template) | `anthropic/shared/cross-project-rules.md` |
| A whole new template (new project archetype) | a new `<vendor>/<template>/` folder |
| A whole new vendor (different AI coding tool) | a new top-level `<vendor>/` folder + its README |

If a change is generic but only relevant to one vendor's agent model, it goes under that vendor folder. If it's vendor-neutral (a general orchestration principle), it goes in that vendor's `shared/` — or, when there are multiple vendor folders, gets mirrored/lifted to a top-level shared location (a future refactor; for now `anthropic/shared/` is the home).

---

## Contribution path

1. **Preferred — a pull request.** If this library has a remote with PRs enabled, open a PR with the scrubbed change. The PR description states: what triggered it, why it's generic (the "is this generic?" result), and which template/file it lands in. **The `leak-check` CI workflow gates every PR** — it runs automatically on the pull request and the PR cannot be merged while it's red. Don't ask a maintainer to override it; fix the leak instead.

2. **Fallback — the inbox.** If no PR workflow is available (e.g. you're working offline, or the remote isn't set up yet), append a dated entry to **[CONTRIBUTIONS_INBOX.md](CONTRIBUTIONS_INBOX.md)** describing the change, so a maintainer can apply it later. The inbox is a holding area, not the final home — entries get folded into the actual templates and then removed (and that folding-in is itself gated by the leak-check CI on the maintainer's commit).

Either way: the change isn't "done" until it's scrubbed (leak-check green, locally and in CI) and lands in its proper home (a template/shared file), not just the inbox.
