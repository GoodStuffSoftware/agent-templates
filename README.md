# agent-templates

A **living library of agent-team templates** for AI coding tools. Instantiate a template into a project (down-flow / *hydration*), and contribute generic improvements back to the library (up-flow / *contribution*). The library is the source of truth; a project is an instantiation = **template + placeholder values**.

This repo is vendor-agnostic and project-agnostic by construction. It contains no real project, person, path, or domain — only reusable templates and the process for using them. A [leak-check](scripts/leak-check.mjs) guard enforces that.

---

## The vendor-folder model

Agent conventions are **tool-specific**: how you declare a sub-agent, how agents communicate, what the model/effort knobs are, and what the orchestration model looks like all differ between AI coding tools. So the library is organized by **vendor folder** at the top level:

```
agent-templates/
  README.md               ← this file
  CONTRIBUTING.md         ← UP-flow: contribute generic improvements back
  HYDRATION.md            ← DOWN-flow: instantiate + re-hydrate a project
  CONTRIBUTIONS_INBOX.md  ← fallback contribution log (when no PR is available)
  LICENSE-NOTE.md         ← license is TBD — a note for the maintainer
  scripts/
    leak-check.mjs        ← fails if any file contains a real-world token
  anthropic/              ← templates for Anthropic's Claude Code agent model
    README.md
    shared/               ← portable cross-project rules kernel (self-contained)
    basic-site/           ← lean agent team for a simple marketing / content site
```

- **`anthropic/`** — templates for **Claude Code**: named sub-agents (`.claude/agents/*.md` with `model` + `effort` frontmatter), a `team-lead` orchestrator, and `SendMessage` teammate comms. See [`anthropic/README.md`](anthropic/README.md).

**Planned vendor folders** (not created yet — added when there's a real template to seed them): `openai/`, `google/`, and others as the tooling landscape grows. Empty vendor dirs aren't committed; a folder appears when its first template does.

**Planned templates** (not in this pass): `anthropic/advanced-app/` — a heavier roster derived from a real interactive-app team (more roles, a staging tier, migration/deploy discipline). The current pass ships only `anthropic/basic-site/`.

---

## The living-library philosophy

The library is meant to *flow in both directions*:

### Down-flow — hydration (library → project)

You instantiate a template into a project: copy the template's files, fill every `{{PLACEHOLDER}}` from a values table, and record what you did in a `.claude/.template.lock` file so the project can be **re-hydrated** later (pull the latest library, re-apply your recorded values, merge the updates in). Project-local customizations live in a protected zone that re-hydration never overwrites.

→ Full process in **[HYDRATION.md](HYDRATION.md)**.

### Up-flow — contribution (project → library)

When a change you make in a real project touches an agent def, a rule, or a convention that is **generic** — i.e. it would help other projects, not just this one — you generalize it (real specifics → placeholders), scrub it (run leak-check), and contribute it back so every future hydration benefits. This extends the general "keep your agent defs and rules as living documents" maintenance habit one level up: improvements don't just land in the current project, they flow back to the template.

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

It exits nonzero (and prints `file:line`) if any file contains a real-world token (a project/product name, domain, user home path, handle, name, email, or a git-SHA-like hex run). Generic examples (`acme.com`, `C:\Users\you\dev\acme`, `{{PLACEHOLDER}}`) are fine.

---

## License

**License is not yet chosen — see [LICENSE-NOTE.md](LICENSE-NOTE.md).** The intent is a permissive license (MIT or similar), but the maintainer picks and adds the actual `LICENSE` file. Until then, treat this as all-rights-reserved by default.
