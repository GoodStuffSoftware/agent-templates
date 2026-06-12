# ARCHITECTURE — the living-library model

This is the **canonical reference** for how the library is structured and how knowledge flows through it. Other docs defer to this one for the model and keep only their own process steps: [HYDRATION.md](HYDRATION.md) (down-flow), [CONTRIBUTING.md](CONTRIBUTING.md) (up-flow + harvesting), [README.md](README.md) (overview).

---

## 1. Two layers, deliberately separated

The library holds two different kinds of thing, and keeping them apart is the central design decision:

| Layer | What it is | Where it lives | Example |
|-------|-----------|----------------|---------|
| **Templates** | *Scaffolding* — the files you instantiate into a project: rosters, agent defs, `CLAUDE.md.template`, placeholder tables. | Vendor folders (`anthropic/`, future `openai/`, …) | `anthropic/basic-site/agents/site-builder.md` |
| **Lessons** | *Knowledge* — one hard-won rule per file, tagged with the dimensions it applies to. | The top-level `lessons/` tree | `lessons/agent-process/first-action-read-only.md` |

**The rule of separation:**
- **Templates reference lessons.** A template's `CLAUDE.md` carries a generated "Lessons in effect" section composed from the library; it does not re-state the lesson bodies.
- **Lessons never embed template scaffolding.** A lesson states a portable rule and its rationale. It names no roster, no placeholder map, no specific agent file.

Why split them: scaffolding and knowledge change on different clocks and fan out differently. A template change affects only projects hydrated from *that* template. A lesson change can affect *every* project whose profile matches the lesson's tags, regardless of which template it came from. Mixing the two would couple an orthogonal fan-out to the wrong unit.

---

## 2. The axes — a scope-tag vocabulary

Every lesson carries a `scope` — a list of tags drawn from a fixed set of **axes**. Each axis answers one question about *when* a lesson applies:

| Axis | Tag form | Means "applies when…" | Examples |
|------|----------|------------------------|----------|
| Universal | `universal` | …always. | a docs-hygiene rule true everywhere |
| Agent process | `agent-process` | …the project uses an agent team. | delegation, briefing, stall-prevention |
| Vendor | `vendor:<id>` | …you're using that AI coding tool. | `vendor:anthropic` (Claude Code mechanics) |
| Stack | `stack:<id>` | …that tech is in the stack. | `stack:nuxt`, `stack:cloudflare-pages`, `stack:github-actions`, `stack:vite`, `stack:git`, `stack:ci` |
| Environment | `env:<id>` | …you're on that OS/shell. | `env:windows`, `env:wsl`, `env:macos` |
| Archetype | `archetype:<id>` | …the project is that shape. | `archetype:basic-site`, `archetype:advanced-app` |

A seventh scope — `project` — exists *conceptually* (a lesson that only makes sense for one product) but **never appears in this library**. Project-local lessons stay in the project. If a "lesson" can't be stated without naming a specific project, it isn't generic and doesn't belong here (see [CONTRIBUTING.md](CONTRIBUTING.md) → the "is this generic?" test).

---

## 3. Tag semantics — AND across axes, OR within an axis

This is the part to get right. A lesson's `scope` list is read as a **conjunction of axis-groups**, where each group is a **disjunction**:

- **Different axes → AND.** `scope: [stack:nuxt, env:windows]` means *Nuxt **and** Windows* — the lesson applies only to a project that is both. Narrowing.
- **Same axis → OR.** `scope: [stack:nuxt, stack:vite]` means *Nuxt **or** Vite* — either one triggers it. Widening.
- **Combined.** `scope: [stack:nuxt, stack:vite, env:windows]` = `(nuxt OR vite) AND windows`.

Read it as: group the tags by axis; within a group, any match counts; across groups, all groups must match.

`universal` and `agent-process` are special: they match **every** agent-team project unconditionally (they have no `<id>` to disambiguate). A lesson tagged `[universal]` is always in effect; `[agent-process]` is in effect for any project that runs an agent team.

---

## 4. Cascade — conflict resolution, most-specific wins

When two lessons speak to the same situation, the **more specific** one wins. Specificity order (most → least):

```
project  >  archetype  >  stack  >  env  >  vendor  >  agent-process  >  universal
```

So a `stack:nuxt` lesson overrides a `universal` lesson on the same point; an `archetype:advanced-app` lesson overrides a `stack:*` one. (`project` sits at the top but lives only in the project, never here.)

**Ties and true conflicts** — two *active* lessons at the same specificity that genuinely contradict — are not allowed to coexist silently. Resolve them one of two ways:
- **Supersession** — mark the loser `status: superseded` with `superseded_by: <winner-id>` (see §5). The composer then drops it.
- **Human review** — if neither should win outright, a maintainer reconciles them (merge, re-scope, or split). The invariant: **no two active lessons may contradict.**

---

## 5. Lesson lifecycle & identity

Each lesson is one file with YAML frontmatter:

```yaml
---
id: kebab-stable-slug          # identity — never reused, even after deprecation
title: One-line statement of the lesson
scope: [stack:nuxt]            # see §2–3
status: active                 # active | deprecated | superseded
superseded_by:                 # a lesson id; set ONLY when status: superseded
since: 2026-06-12              # when it entered the library
provenance: [contrib-1]        # anonymized contributor ids ONLY (see §7)
corroborated: 1                # count of independent sources observing it
---
The lesson body. **Why:** the failure/observation behind it. **How to apply:** concrete guidance.
```

**Identity rules:**
- **`id` is the stable identity** used for dedup, cross-references, and supersession. Once assigned, an id is **never reused** for a different lesson — even if the original is deprecated.
- **Status:**
  - `active` — in force; the composer includes it.
  - `deprecated` — no longer good advice, but kept for history; the composer **excludes** it.
  - `superseded` — replaced by a better lesson; set `superseded_by: <id>`; the composer **excludes** it (the successor carries the truth).
- **`corroborated`** — how many independent sources have observed the lesson. A higher count is stronger evidence; raise it (don't duplicate the lesson) when a second project hits the same thing.

**Placement on disk is cosmetic.** A lesson lives at `lessons/<primary-axis-dir>/<id>.md`, where the directory is chosen by the lesson's **first** scope tag, purely for browsability. **Routing is by tags, never by path** — moving a file between directories changes nothing about when it applies. Directory layout:

```
lessons/
  INDEX.md            ← generated: one line per lesson (id — title — [scope] — status)
  universal/          ← lessons whose first tag is `universal`
  agent-process/      ← first tag `agent-process` (vendor-tagged process lessons may live here too)
  stacks/             ← first tag `stack:*` (or a stack-primary vendor lesson)
  env/                ← first tag `env:*`
```

(`archetype:*`-primary lessons would get an `archetype/` dir when the first one is written; none ship in this seed pass.)

---

## 6. Profiles & matching — how a project selects its lessons

A hydrated project records a **profile** in its `.claude/.template.lock` (schema v2 — full details in [HYDRATION.md](HYDRATION.md)):

```json
{
  "template": "anthropic/basic-site",
  "libraryCommit": "<library-commit-sha>",
  "hydratedAt": "2026-06-12",
  "profile": {
    "vendor": "anthropic",
    "archetype": "basic-site",
    "stacks": ["nuxt", "cloudflare-pages", "github-actions"],
    "env": ["windows"]
  },
  "values": { "…placeholder map…" }
}
```

**A lesson applies to a project iff every axis-group in its `scope` matches the profile**, per the AND/OR semantics of §3:
- `universal` and `agent-process` always match (any agent-team project).
- `vendor:X` matches iff `profile.vendor === X`.
- `stack:X` matches iff `profile.stacks` includes `X`.
- `env:X` matches iff `profile.env` includes `X`.
- `archetype:X` matches iff `profile.archetype === X`.
- Within one axis, ANY listed tag matching is enough (OR); across axes, every present axis-group must match (AND).

> **`libraryCommit` is a placeholder in this library.** Anywhere a commit SHA would appear in library files (this doc, examples, templates) it's written as `{{LIBRARY_COMMIT}}` or `<library-commit-sha>` — never a real hex SHA, because the leak-check guard bans hex runs. A **real project's** `.template.lock` (which lives in the project, not here) holds a real SHA, and that's correct — leak-check guards the library only, so don't "fix" a project lock back to a placeholder.

The matcher is implemented in [`scripts/compose.mjs`](scripts/compose.mjs) (§8).

---

## 7. Provenance anonymization

Lessons carry `provenance: [contrib-1, contrib-2, …]` — **anonymized** contributor ids only. The library **never** records who a contributor really is: the real id↔person mapping lives with the maintainer in a `PROVENANCE.local.md` that is **git-ignored and never committed**. This resolves a direct conflict with the leak-check guard, which bans real names and handles: if provenance held real identities, no lesson could pass CI. The convention is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 8. The flows

### Down-flow — hydrate / re-hydrate (library → project)

Instantiate a template, fill placeholders, record a profile + values in `.template.lock`, and generate the project's "Lessons in effect" section:

```
node scripts/compose.mjs --profile .claude/.template.lock
```

Re-hydration later re-renders the template AND re-composes the lessons against the (possibly updated) library. Full steps in [HYDRATION.md](HYDRATION.md).

### Up-flow — harvest / contribute (project → library)

When a real project learns something generic, it flows back: generalize → scrub → tag onto the axes → propose. The **lessons-harvester** agent (`anthropic/lessons-harvester.md`) automates the detection + classification + scrub-draft, but **never auto-commits** — a human gates placement and scrub. Full steps in [CONTRIBUTING.md](CONTRIBUTING.md) → Harvesting.

### Fan-out signal — re-hydration available

Because lessons are profile-matched, a *new* lesson can light up *existing* projects. The composer surfaces this:

```
node scripts/compose.mjs --profile .claude/.template.lock --since <library-commit-sha>
```

This lists lessons added or changed since the project's recorded `libraryCommit` that **match the project's profile** — the project's signal that re-hydrating would bring in new applicable knowledge.

---

## 9. The whole loop (ASCII)

```
                         ┌─────────────────────────────────────────────┐
                         │                 LIBRARY                      │
                         │   lessons/<axis>/*.md   +   INDEX.md         │
                         └───────▲─────────────────────────┬───────────┘
                                 │ human gate               │ compose (profile match)
                                 │ (placement + scrub)      │
                 ┌───────────────┴───────────┐              ▼
                 │  CONTRIBUTIONS_INBOX.md    │     ┌──────────────────────┐
                 │  / PR (proposals)          │     │  "Lessons in effect"  │
                 └───────────────▲───────────┘     │  in project CLAUDE.md │
                                 │ tag onto axes     └──────────┬───────────┘
                                 │ + scrub                      │ hydrate / re-hydrate
                         ┌───────┴───────┐                      ▼
                         │   HARVESTER   │            ┌────────────────────┐
                         │ (agent, UP)   │◀───────────│   PROJECT          │
                         └───────────────┘  diff      │  learns a lesson;  │
                                  ▲ fan-out signal ───│  .template.lock    │
                                  └────────────────────  profile           │
                                                       └────────────────────┘

   UP-flow:   project learns → harvester tags + scrubs → inbox/PR → human gate → lessons/<axis>
   DOWN-flow: compose(profile) → "Lessons in effect" → project
   FAN-OUT:   new lesson matches an existing profile → compose --since flags "re-hydration available"
```

---

## 10. Invariants (the short list)

1. **Templates reference lessons; lessons embed no scaffolding.**
2. **Routing is by tags, not by path.** Directory placement is cosmetic.
3. **AND across axes, OR within an axis.**
4. **Most-specific wins; no two active lessons contradict.**
5. **`id` is forever** — never reused, even after deprecation.
6. **No real specifics in the library** — no project/person/path/domain/email, and **no real commit SHAs** (leak-check enforces).
7. **Provenance is anonymized**; the real mapping stays in the git-ignored `PROVENANCE.local.md`.
