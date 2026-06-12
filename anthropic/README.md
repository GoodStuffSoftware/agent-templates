# anthropic/ — Claude Code agent templates

Templates targeting **Anthropic's Claude Code** agent model. Everything here assumes:

- **Named sub-agents** defined as `.claude/agents/<name>.md` files with YAML frontmatter carrying `name`, `description`, `model` (`haiku` / `sonnet` / `opus`), `effort` (`low` / `medium` / `high` / `xhigh` / `max`), `color`, and `tools`.
- **An orchestrator + teammates model** — a `team-lead` main session that routes work, and worker teammates that `SendMessage` each other and persist across turns (spawned with a `team_name`).
- **A user-level kernel** — these templates are deliberately thin on cross-project rules because they assume a global `~/.claude/CLAUDE.md` carries them (model-routing, delegation, worktree/write-target/dev-server discipline, docs hygiene). For portability, the library also ships a **self-contained generic copy** of that kernel at [`shared/cross-project-rules.md`](shared/cross-project-rules.md) so the templates are useful even to someone who doesn't have that global file.

---

## What's in here

```
anthropic/
  README.md            ← this file
  shared/              ← the portable cross-project rules kernel (self-contained)
    README.md
    cross-project-rules.md
  basic-site/          ← lean agent team for a simple marketing / content site
    README.md
    CLAUDE.md.template
    agents/site-*.md
```

- **`shared/`** — a vendor-neutral, self-contained generic version of the cross-project rules an agent team relies on (commit conventions, stall-prevention, reviewer-pairing, worktree / write-target / dev-server discipline, docs hygiene, model routing). Templates *reference* it rather than duplicating it.
- **`basic-site/`** — the minimal-roster kit (explorer + builder + reviewer + server-minder) plus optional architect + debugger add-ons, for a simple content/marketing site on a `main` + per-branch-preview branch model.

**Planned (not yet built):** `advanced-app/` — a heavier roster derived from a real interactive-app team (more roles, a staging tier, migration/deploy discipline). Mentioned in the top-level [README](../README.md); not included in this pass.

---

## How this folder fits the library

This is one **vendor folder**. The library is organized by AI-coding-tool vendor because agent conventions (how sub-agents are declared, how they communicate, what the model/effort knobs are) are vendor-specific. Sibling vendor folders (`openai/`, `google/`, …) are planned but not created yet — see the top-level [README](../README.md) for the vendor-folder model and the living-library philosophy (down = hydrate into a project, up = contribute generic improvements back).

To instantiate a template from here into a project, follow [`HYDRATION.md`](../HYDRATION.md). To contribute a generic improvement back, follow [`CONTRIBUTING.md`](../CONTRIBUTING.md).
