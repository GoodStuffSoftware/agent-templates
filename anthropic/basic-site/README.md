# basic-site — agent-team template kit

A reusable kit for standing up a lean agent team to build and maintain a **simple marketing / content site** fast. Drop the agent defs into a new repo, find-replace the placeholders, and you have an orchestrator + worker roster with the stall-prevention, write-target, port-hygiene, and dev-server-ownership conventions already baked in.

Part of the [`anthropic/`](../README.md) vendor folder — these defs target the Claude Code agent model (named sub-agents with `model` + `effort` frontmatter, a `team-lead` orchestrator, and `SendMessage` teammate comms).

_Battle-tested on real-world Claude Code agent teams, then genericized into a reusable kit._

---

## What's in the kit

```
basic-site/
  README.md              ← this file
  CLAUDE.md.template     ← trimmed project-CLAUDE skeleton (find-replace the placeholders)
  agents/
    site-explorer.md       (haiku/low,    cyan)   ─┐
    site-builder.md        (sonnet/medium, green)  │ MINIMAL roster
    site-reviewer.md       (sonnet/high,  purple)  │ (start here)
    site-server-minder.md  (haiku/low,    orange) ─┘
    site-architect.md      (opus/xhigh,   blue)   ─┐ OPTIONAL add-ons
    site-debugger.md       (sonnet/high,  yellow) ─┘ (add when the site outgrows simple)
```

**Minimal roster** (explorer + builder + reviewer + server-minder) covers a simple site end-to-end:
explore → build (1–3 files) → review → preview. The orchestrator (main session) does the planning and multi-file coordination itself.

**Optional add-ons:**
- `site-architect` — add when changes routinely span 4+ files or introduce new abstractions, and you want a dedicated planner + deploy owner.
- `site-debugger` — add when you start hitting recurring non-trivial bugs (build / static-render / hydration / server-function failures).

---

## Assumptions

1. **The cross-project rules kernel exists somewhere your agents can read it.** The kit deliberately does NOT duplicate the general rules — every def and the `CLAUDE.md.template` point to the library's portable [`../shared/cross-project-rules.md`](../shared/cross-project-rules.md) and, once hydrated, to your global `~/.claude/CLAUDE.md` → **"Worktree, write-target & dev-server discipline."** Each def holds only the project-specific application. If neither source exists in your setup, copy the relevant rules from `../shared/` into your global file or strip the pointers.
2. **Branch model: `main` + per-branch previews, NO staging tier.** Production = `origin/main`; feature branches off `origin/main`; the host builds a per-branch preview for isolation. Dev-config (`.claude/`, docs) commits straight to the working branch — never a feature branch. If you actually need a multi-tier staging model, this kit is the wrong starting point.
3. **A persistent owner runs local dev servers**, not transient writer agents — that's what `site-server-minder` is for.

---

## How to use it

> For the full first-time-instantiate + re-hydration process (including the `.template.lock` convention), see the library's [`HYDRATION.md`](../../HYDRATION.md). The quick version:

1. **Copy the agent defs** into the new repo:
   `cp basic-site/agents/*.md <newrepo>/.claude/agents/`
   (Start with the 4 minimal-roster files; add architect/debugger later if needed.)
2. **Rename `site-*` → `<prefix>-*`** to match your chosen `{{AGENT_PREFIX}}` (e.g. `acme-builder.md`). The `name:` frontmatter uses `{{AGENT_PREFIX}}` too, so the find-replace below handles the in-file names; just rename the files to match.
3. **Copy the project-CLAUDE skeleton:**
   `cp basic-site/CLAUDE.md.template <newrepo>/CLAUDE.md`
4. **Find-replace every `{{PLACEHOLDER}}`** across `<newrepo>/.claude/agents/*.md` and `<newrepo>/CLAUDE.md` using the table below.
5. **Resolve the `[REPLACE: ...]` markers** left in `CLAUDE.md.template` (brand voice, brand-source path, forms/analytics).
6. **Sanity-check the OS-specific bits** — `site-server-minder` ships both Windows/PowerShell and macOS/Linux port-diagnosis commands; keep the one for your platform.

---

## Placeholder table

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `{{PROJECT_NAME}}` | Human name of the site/project | `acme.com` |
| `{{COMPANY}}` | Company / studio name | `Acme LLC` |
| `{{REPO_PATH}}` | Absolute path to the repo working dir | `C:\Users\you\dev\acme` |
| `{{SITE_DOMAIN}}` | Production domain | `acme.com` |
| `{{STACK}}` | Framework stack, short form | `Nuxt 4 + Vue 3 + Tailwind` |
| `{{HOST}}` | Hosting platform | `Cloudflare Pages` |
| `{{PREVIEW_MECHANISM}}` | Host's per-branch preview mechanism | `per-branch preview URLs` |
| `{{PKG_MANAGER}}` | Package manager | `npm` (or `pnpm`, `yarn`, `bun`) |
| `{{DEV_CMD}}` | Dev-server command | `npm run dev` |
| `{{DEV_PORT_BASE}}` | Base dev port (server falls back from here) | `3000` |
| `{{AGENT_PREFIX}}` | Agent name prefix | `acme` (→ `acme-builder`) |
| `{{TEAM_PREFIX}}` | Team-name prefix for per-session teams | `acme` (→ `acme-20260608-hero`) |

---

## What the defs already encode (don't re-derive)

These learnings are baked into the relevant defs — keep them when you customize:

- **#2 Write-target is fixed by the initial brief** (builder / architect / debugger). Switching worktree/branch mid-task = STOP, report what's written, wait for a clean re-brief.
- **#3 Report the EXACT bound "Local:" URL** (builder / reviewer / server-minder), never the requested port — dev servers silently fall back when a port is taken.
- **#4 Request a preview, don't spawn your own dev server** (builder / architect / debugger). A persistent owner (`{{AGENT_PREFIX}}-server-minder`) runs local servers; sub-agent servers die on stop and leave stray listeners.
- **#6 Diagnose the right process first** (debugger). Confirm WHICH port/process actually serves the build before diagnosing a failure "on" a port.
- **Team Communication + Stall prevention** (all writer defs): first action read-only + SendMessage, heartbeat at turn start, reports-to-files with a 1-line pointer.

These mirror the general principles in [`../shared/cross-project-rules.md`](../shared/cross-project-rules.md); the defs hold the project-specific application.

---

## Provenance

Genericized from a finalized, real-world set of Claude Code agent defs into a reusable kit. The placeholders mark every spot that was a project-specific value; fill them and the kit resolves to a working roster.
