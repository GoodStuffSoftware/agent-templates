# anthropic/shared — cross-project rules (discovery page)

The cross-project rules an agent team relies on **live as individually-tagged lessons** in the top-level [`lessons/`](../../lessons/) tree, so a project pulls in exactly the ones its profile matches. This folder's [`cross-project-rules.md`](cross-project-rules.md) is a **discovery page** — the stable target template defs point at, teaching how to find the current lessons. It deliberately enumerates none of them: hand-synced lists drift (see the `static-instructions-teach-discovery` lesson).

## Why this exists

The agent defs in `basic-site/` (and future templates) are deliberately thin on general rules — they hold only the *project-specific application* and point elsewhere for the general principle. The authoritative wording of each rule is its lesson file in [`lessons/`](../../lessons/) (single source of truth). The page here is the stable target those defs point at; the quick map itself is the generated [`lessons/INDEX.md`](../../lessons/INDEX.md), which regenerates with every lesson change.

For the routing model — axes, AND/OR tag semantics, the most-specific-wins cascade, lesson lifecycle, and both flows — see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## How to use it

- **Reading a template def** that points at `anthropic/shared/cross-project-rules.md` — follow it to the generated [`lessons/INDEX.md`](../../lessons/INDEX.md), then open the lesson for the full wording.
- **Composing a project's applicable rules** — run `node scripts/compose.mjs --profile <project>/.claude/.template.lock`; it emits the "Lessons in effect" section from the tree.
- **Setting up a global file** — copy the relevant lessons' guidance into your own `~/.claude/CLAUDE.md` and specialize it.
- **Contributing a generic improvement** — write/refine a tagged lesson in [`lessons/`](../../lessons/) (see the top-level [`CONTRIBUTING.md`](../../CONTRIBUTING.md) → Harvesting) and regenerate the index (`node scripts/compose.mjs --index`). Nothing in this folder needs a matching hand-edit; don't grow rule bodies back into it.

## What's NOT here

- Rule bodies — they live in `lessons/`, one per file. This folder only points at them.
- Project-specific values (paths, domains, names) — those live in a project's filled-in `CLAUDE.md`, never here.
- Tooling-vendor specifics beyond the Claude Code agent model — this folder lives under `anthropic/` for that reason.
