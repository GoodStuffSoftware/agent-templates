# anthropic/shared — cross-project rules digest

The cross-project rules an agent team relies on **now live as individually-tagged lessons** in the top-level [`lessons/`](../../lessons/) tree, so a project pulls in exactly the ones its profile matches. This folder's [`cross-project-rules.md`](cross-project-rules.md) is a thin **digest** — a map from each rule to its lesson id — not a second copy of the rule bodies.

## Why this exists

The agent defs in `basic-site/` (and future templates) are deliberately thin on general rules — they hold only the *project-specific application* and point elsewhere for the general principle. The authoritative wording of each rule is its lesson file in [`lessons/`](../../lessons/) (single source of truth). The digest here is a human-browsable index back into that tree, kept so a reader landing in a template def has a quick map without having to grep the whole lessons directory.

For the routing model — axes, AND/OR tag semantics, the most-specific-wins cascade, lesson lifecycle, and both flows — see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## How to use it

- **Reading a template def** that points at `anthropic/shared/cross-project-rules.md` — open the digest, find the rule, follow the lesson id into [`lessons/`](../../lessons/) for the full wording.
- **Composing a project's applicable rules** — run `node scripts/compose.mjs --profile <project>/.claude/.template.lock`; it emits the "Lessons in effect" section from the tree.
- **Setting up a global file** — copy the relevant lessons' guidance into your own `~/.claude/CLAUDE.md` and specialize it.
- **Contributing a generic improvement** — write/refine a tagged lesson in [`lessons/`](../../lessons/) (see the top-level [`CONTRIBUTING.md`](../../CONTRIBUTING.md) → Harvesting), then reflect it as one line in the digest. Don't grow rule bodies back into this folder.

## What's NOT here

- Rule bodies — they live in `lessons/`, one per file. This folder only indexes them.
- Project-specific values (paths, domains, names) — those live in a project's filled-in `CLAUDE.md`, never here.
- Tooling-vendor specifics beyond the Claude Code agent model — this folder lives under `anthropic/` for that reason.
