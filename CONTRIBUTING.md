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

The library has **two layers** (see [ARCHITECTURE.md](ARCHITECTURE.md)): *templates* (scaffolding, in vendor folders) and *lessons* (knowledge, in `lessons/`). Which layer your contribution belongs to determines where it lands.

### Scaffolding (templates)

| What you're contributing | Where it lands |
|--------------------------|----------------|
| A fix/improvement to a specific agent role | that role's def, e.g. `anthropic/basic-site/agents/<role>.md` |
| A new agent role for a class of projects | a new def in the appropriate template's `agents/` |
| A change to the project-CLAUDE skeleton | `anthropic/<template>/CLAUDE.md.template` |
| A whole new template (new project archetype) | a new `<vendor>/<template>/` folder |
| A whole new vendor (different AI coding tool) | a new top-level `<vendor>/` folder + its README |

### Knowledge (lessons)

A **rule, gotcha, or hard-won lesson** is not scaffolding — it lands in `lessons/` as a tagged lesson file, **not** pasted into an agent def or a shared rules doc. To place it, classify it onto the axes (see [ARCHITECTURE.md](ARCHITECTURE.md) §2–3) and let the **first** scope tag pick the directory (cosmetic — routing is by tags):

| First scope tag | Directory |
|-----------------|-----------|
| `universal` | `lessons/universal/` |
| `agent-process` | `lessons/agent-process/` |
| `stack:*` | `lessons/stacks/` |
| `env:*` | `lessons/env/` |
| `archetype:*` | `lessons/archetype/` (created when the first one is written) |

Remember the tag semantics: **AND across axes, OR within an axis** (`[stack:nuxt, env:windows]` = Windows-Nuxt only; `[stack:nuxt, stack:vite]` = either). Use `vendor:<id>` for AI-tool mechanics. A lesson's `id` is its forever identity — never reuse one.

If a change is generic but only relevant to one vendor's agent model, tag it `vendor:<id>`. Vendor-neutral scaffolding still goes in that vendor's folder for now (a top-level shared location is a future refactor); vendor-neutral *knowledge* is just a lesson with no `vendor:` tag.

---

## Contribution path

1. **Preferred — a pull request.** If this library has a remote with PRs enabled, open a PR with the scrubbed change. The PR description states: what triggered it, why it's generic (the "is this generic?" result), and which template/file it lands in. **The `leak-check` CI workflow gates every PR** — it runs automatically on the pull request and the PR cannot be merged while it's red. Don't ask a maintainer to override it; fix the leak instead.

2. **Fallback — the inbox.** If no PR workflow is available (e.g. you're working offline, or the remote isn't set up yet), append a dated entry to **[CONTRIBUTIONS_INBOX.md](CONTRIBUTIONS_INBOX.md)** describing the change, so a maintainer can apply it later. The inbox is a holding area, not the final home — entries get folded into the actual templates and then removed (and that folding-in is itself gated by the leak-check CI on the maintainer's commit).

Either way: the change isn't "done" until it's scrubbed (leak-check green, locally and in CI) and lands in its proper home (a template file or a `lessons/` lesson), not just the inbox.

---

## Provenance anonymization

Lessons carry a `provenance: [contrib-1, contrib-2, …]` field — **anonymized contributor ids only**. The library must **never** record who a contributor really is.

**Why:** the leak-check guard bans real names, handles, and emails (it would fail CI on any of them), and there's no reason to publish contributor identities in a vendor-/project-neutral library anyway. So the public record uses opaque ids; the real id↔person mapping lives **only** with the maintainer.

**How:**
- In any lesson you draft, set `provenance` to anonymized ids (`contrib-1`, `contrib-2`, …). Reuse an existing id for the same source across lessons.
- The real mapping goes in `PROVENANCE.local.md` at the repo root — which is **git-ignored and never committed** (see `.gitignore`). Only the maintainer holds it.
- `corroborated` counts *independent sources* observing a lesson; raise it (don't duplicate the lesson) when a second source confirms it.

---

## Harvesting

Most contribution is manual: you notice a generic improvement and follow the steps above. **Harvesting** automates the *detection* and *first-draft* of that flow across a whole project's history, using the [`lessons-harvester`](anthropic/lessons-harvester.md) agent (a Claude Code agent def, `model: sonnet`, `effort: high`).

Its job, in short (full process in the agent def):
1. **Diff** a source project's agent defs + `CLAUDE.md` (+ `CLAUDE.local.md`) since the last harvest baseline (the project's `.template.lock` `libraryCommit`, or a recorded harvest date).
2. **Run the "is this generic?" test** on each changed rule, then **classify** it onto the axes (minding AND/OR semantics).
3. **Dedup** against `lessons/INDEX.md` *by meaning* — propose raising `corroborated` or a supersession instead of a duplicate.
4. **Scrub** specifics → placeholders/generic examples (leak-check will enforce on commit).
5. **Propose, never auto-commit** — drafts go to a PR or `CONTRIBUTIONS_INBOX.md`; a human gates placement + scrub before anything lands in `lessons/`.
6. **Drift check** — compare the maintainer's private global rules kernel (for Claude Code, `~/.claude/CLAUDE.md`) against `lessons/universal/` + `lessons/agent-process/` and report divergence, so the private kernel and its public mirror don't drift silently.

The routing rules the harvester applies are the axes/tags in [ARCHITECTURE.md](ARCHITECTURE.md); the gate is always a human.
