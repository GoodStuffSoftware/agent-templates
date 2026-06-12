# anthropic/shared — the cross-project rules kernel

A **portable, self-contained generic version** of the cross-project rules an agent team relies on, regardless of which template it's using.

## Why this exists

The agent defs in `basic-site/` (and future templates) are deliberately thin on general rules — they hold only the *project-specific application* and point elsewhere for the general principle. In a real setup those general rules live in your global `~/.claude/CLAUDE.md`. But this library is meant to be useful to someone who doesn't have that file. So [`cross-project-rules.md`](cross-project-rules.md) is a **self-contained summary** of each rule: enough to apply it from scratch, vendor- and project-neutral.

## How to use it

- **Reading a template def** that says "cross-project rules live in `anthropic/shared/cross-project-rules.md`" — that's this file. Read it for the general principle behind a rule the def only applies.
- **Setting up a new machine / global file** — copy the relevant sections of `cross-project-rules.md` into your own `~/.claude/CLAUDE.md` and adapt them. The library version is the generic skeleton; your global file is where you specialize it.
- **Contributing a generic improvement** — if you refine one of these rules in a real project and the refinement is generic, bring it back here (see the top-level [`CONTRIBUTING.md`](../../CONTRIBUTING.md)).

## What's NOT here

- Project-specific values (paths, domains, names) — those live in a project's filled-in `CLAUDE.md`, never here.
- Tooling-vendor specifics beyond the Claude Code agent model — this folder lives under `anthropic/` for that reason.
- A full reproduction of any one user's global file. This is a generic skeleton, intentionally trimmed.
