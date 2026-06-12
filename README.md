# agent-templates

A **living library of agent-team templates** for AI coding tools. Instantiate a template into a project (down-flow / *hydration*), and contribute generic improvements back to the library (up-flow / *contribution*). The library is the source of truth; a project is an instantiation = **template + placeholder values**.

This repo is vendor-agnostic and project-agnostic by construction. It contains no real project, person, path, or domain — only reusable templates and the process for using them. A [leak-check](scripts/leak-check.mjs) guard enforces that.

---

## The vendor-folder model

Agent conventions are **tool-specific**: how you declare a sub-agent, how agents communicate, what the model/effort knobs are, and what the orchestration model looks like all differ between AI coding tools. So the library is organized by **vendor folder** at the top level:

```
agent-templates/
  README.md               ← this file
  ARCHITECTURE.md         ← the canonical design: two layers, axes, tag semantics, flows
  CONTRIBUTING.md         ← UP-flow: contribute / harvest generic improvements back
  HYDRATION.md            ← DOWN-flow: instantiate + re-hydrate a project
  CONTRIBUTIONS_INBOX.md  ← fallback contribution log (when no PR is available)
  LICENSE-NOTE.md         ← license is TBD — a note for the maintainer
  .github/workflows/
    leak-check.yml        ← runs leak-check in CI on every push + pull request
  scripts/
    leak-check.mjs        ← fails if any file contains a real-world token
    compose.mjs           ← profile-matched lesson composition + INDEX + fan-out
  lessons/                ← KNOWLEDGE layer: one tagged lesson per file
    INDEX.md              ← generated: id — title — [scope] — status
    universal/  agent-process/  stacks/  env/
  examples/
    sample.template.lock  ← a v2 lock (profile + values) for trying compose
  anthropic/              ← TEMPLATE layer for Anthropic's Claude Code agent model
    README.md
    lessons-harvester.md  ← agent def: UP-flow automation (harvest → propose)
    shared/               ← thin digest pointing at the tagged lessons
    basic-site/           ← lean agent team for a simple marketing / content site
```

- **`anthropic/`** — templates for **Claude Code**: named sub-agents (`.claude/agents/*.md` with `model` + `effort` frontmatter), a `team-lead` orchestrator, and `SendMessage` teammate comms. See [`anthropic/README.md`](anthropic/README.md).

**Planned vendor folders** (not created yet — added when there's a real template to seed them): `openai/`, `google/`, and others as the tooling landscape grows. Empty vendor dirs aren't committed; a folder appears when its first template does.

**Planned templates** (not in this pass): `anthropic/advanced-app/` — a heavier roster derived from a real interactive-app team (more roles, a staging tier, migration/deploy discipline). The current pass ships only `anthropic/basic-site/`.

---

## The living-library philosophy

The library holds **two layers**: *templates* (scaffolding you instantiate — rosters, agent defs, the `CLAUDE.md` skeleton) and *lessons* (knowledge — one hard-won rule per file in [`lessons/`](lessons/), tagged with the dimensions it applies to). Templates *reference* lessons; lessons embed no scaffolding. A project records a **profile** (vendor / archetype / stacks / env) in its lock file, and [`scripts/compose.mjs`](scripts/compose.mjs) selects exactly the lessons whose tags match — so a new lesson can light up every existing project whose profile fits (the *fan-out* signal). The full model — axes, the AND/OR tag semantics, the most-specific-wins cascade, lesson lifecycle, and both flows — is in **[ARCHITECTURE.md](ARCHITECTURE.md)**; this section is just the overview.

The library is meant to *flow in both directions*:

### Down-flow — hydration (library → project)

You instantiate a template into a project: copy the template's files, fill every `{{PLACEHOLDER}}` from a values table, and record what you did in a `.claude/.template.lock` file so the project can be **re-hydrated** later (pull the latest library, re-apply your recorded values, merge the updates in). Project-local customizations live in a protected zone that re-hydration never overwrites.

→ Full process in **[HYDRATION.md](HYDRATION.md)**.

### Up-flow — contribution (project → library)

When a change you make in a real project touches an agent def, a rule, or a convention that is **generic** — i.e. it would help other projects, not just this one — you generalize it (real specifics → placeholders), scrub it (run leak-check), and contribute it back so every future hydration benefits. Scaffolding fixes land in a template; a rule or gotcha lands as a tagged **lesson** in [`lessons/`](lessons/). The [`lessons-harvester`](anthropic/lessons-harvester.md) agent automates detecting + classifying + drafting these from a project's history (a human always gates what lands). This extends the "keep your agent defs and rules as living documents" maintenance habit one level up: improvements don't just land in the current project, they flow back to the library.

→ Full process in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Together: **down = hydrate, up = contribute.** A fix made once in a project becomes a fix every future project inherits.

---

## Quick start

1. Pick a vendor + template (currently: `anthropic/basic-site`).
2. Follow [HYDRATION.md](HYDRATION.md) to instantiate it into your project.
3. Build. When you improve something generic, follow [CONTRIBUTING.md](CONTRIBUTING.md) to send it back.

Before any contribution lands, run the guard:

```
node scripts/leak-check.mjs
```

It exits nonzero (and prints `file:line`) if any file contains a real-world token (a project/product name, domain, user home path, handle, name, email, or a git-SHA-like hex run). Generic examples (`acme.com`, `C:\Users\you\dev\acme`, `{{PLACEHOLDER}}`) are fine. The same guard runs in CI on every push and pull request ([`.github/workflows/leak-check.yml`](.github/workflows/leak-check.yml)), so the no-project-specifics guarantee is enforced, not just a local convention.

---

## License

**License is not yet chosen — see [LICENSE-NOTE.md](LICENSE-NOTE.md).** The intent is a permissive license (MIT or similar), but the maintainer picks and adds the actual `LICENSE` file. Until then, treat this as all-rights-reserved by default.
