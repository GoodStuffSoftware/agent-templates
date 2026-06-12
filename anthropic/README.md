# anthropic/ — Claude Code agent templates

Templates targeting **Anthropic's Claude Code** agent model. Everything here assumes:

- **Named sub-agents** defined as `.claude/agents/<name>.md` files with YAML frontmatter carrying `name`, `description`, `model` (`haiku` / `sonnet` / `opus`), `effort` (`low` / `medium` / `high` / `xhigh` / `max`), `color`, and `tools`.
- **An orchestrator + teammates model** — a `team-lead` main session that routes work, and worker teammates that `SendMessage` each other and persist across turns (spawned with a `team_name`).
- **A user-level kernel** — these templates are deliberately thin on cross-project rules because they assume a global `~/.claude/CLAUDE.md` carries them (model-routing, delegation, worktree/write-target/dev-server discipline, docs hygiene). The portable, project-neutral mirror of the *recurring gotchas* now lives as tagged lessons in the top-level [`lessons/`](../lessons/) tree, composed per-project by [`scripts/compose.mjs`](../scripts/compose.mjs); [`shared/cross-project-rules.md`](shared/cross-project-rules.md) is a thin digest pointing at them. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the model.

---

## What's in here

```
anthropic/
  README.md            ← this file
  lessons-harvester.md ← agent def: UP-flow automation (harvest project learnings → propose lessons)
  shared/              ← thin digest mapping each cross-project rule to its lesson id
    README.md
    cross-project-rules.md
  basic-site/          ← lean agent team for a simple marketing / content site
    README.md
    CLAUDE.md.template
    agents/site-*.md
```

- **`lessons-harvester.md`** — a Claude Code agent def that automates the up-flow: it diffs a real project's agent defs + rules, classifies the generic learnings onto the library's axes (see [`../ARCHITECTURE.md`](../ARCHITECTURE.md)), scrubs them, and drafts proposals for a human to gate. It never auto-commits.
- **`shared/`** — formerly the full inline rules kernel; now a thin **digest** that maps each cross-project rule to its lesson id. The rule bodies live as tagged lessons in the top-level [`../lessons/`](../lessons/) tree (single source of truth), composed per-project by [`../scripts/compose.mjs`](../scripts/compose.mjs).
- **`basic-site/`** — the minimal-roster kit (explorer + builder + reviewer + server-minder) plus optional architect + debugger add-ons, for a simple content/marketing site on a `main` + per-branch-preview branch model.

**Planned (not yet built):** `advanced-app/` — a heavier roster derived from a real interactive-app team (more roles, a staging tier, migration/deploy discipline). Mentioned in the top-level [README](../README.md); not included in this pass.

---

## How this folder fits the library

This is one **vendor folder**. The library is organized by AI-coding-tool vendor because agent conventions (how sub-agents are declared, how they communicate, what the model/effort knobs are) are vendor-specific. Sibling vendor folders (`openai/`, `google/`, …) are planned but not created yet — see the top-level [README](../README.md) for the vendor-folder model and the living-library philosophy (down = hydrate into a project, up = contribute generic improvements back).

To instantiate a template from here into a project, follow [`HYDRATION.md`](../HYDRATION.md). To contribute a generic improvement back, follow [`CONTRIBUTING.md`](../CONTRIBUTING.md).
