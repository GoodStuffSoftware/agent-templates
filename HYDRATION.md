# HYDRATION — instantiating and re-hydrating a project

**Principle:** the library is the source of truth. A project is an *instantiation* of a template:

```
project = template + placeholder values
```

Because a project records the template name, the library version it came from, and the placeholder values it filled, it can be **re-hydrated** later: pull the updated template, re-apply the same values, and merge the improvements in — without clobbering the project's own local customizations.

This doc covers the DOWN-flow (library → project). For the UP-flow (project → library) see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 1. First-time instantiate

1. **Pick a template.** e.g. `anthropic/basic-site`.

2. **Copy the template files into the project:**
   - Agent defs → `<project>/.claude/agents/` (rename `site-*` → `<prefix>-*` to match your `{{AGENT_PREFIX}}`).
   - The `CLAUDE.md.template` → `<project>/CLAUDE.md`.
   - (Optional) Read the template's own README for any kit-specific steps.

3. **Fill every `{{PLACEHOLDER}}`.** Each template ships a placeholder table in its README. Build a values map for your project, e.g.:

   | Placeholder | Your value |
   |-------------|------------|
   | `{{PROJECT_NAME}}` | `acme.com` |
   | `{{COMPANY}}` | `Acme LLC` |
   | `{{REPO_PATH}}` | `C:\Users\you\dev\acme` |
   | `{{SITE_DOMAIN}}` | `acme.com` |
   | `{{STACK}}` | `Nuxt 4 + Vue 3 + Tailwind` |
   | `{{HOST}}` | `Cloudflare Pages` |
   | `{{AGENT_PREFIX}}` | `acme` |
   | … | … |

   Find-replace every placeholder across the copied files.

4. **Resolve any `[REPLACE: ...]` markers** the template left in place (brand voice, brand-source path, forms/analytics, etc.). These are spots the template can't fill for you.

5. **Write the lock file** (next section) so the project can be re-hydrated.

6. **Run leak-check on the LIBRARY side, not the project side.** The project legitimately contains real values now — leak-check is the library's guard, not the project's. Don't run it against your filled-in project.

---

## 2. The `.claude/.template.lock` convention

A hydrated project keeps a lock file at `<project>/.claude/.template.lock`. It records exactly what was instantiated, so re-hydration is deterministic. JSON shape:

```json
{
  "template": "anthropic/basic-site",
  "libraryCommit": "<commit-sha-of-agent-templates-at-hydration-time>",
  "hydratedAt": "2026-06-12",
  "values": {
    "PROJECT_NAME": "acme.com",
    "COMPANY": "Acme LLC",
    "REPO_PATH": "C:\\Users\\you\\dev\\acme",
    "SITE_DOMAIN": "acme.com",
    "STACK": "Nuxt 4 + Vue 3 + Tailwind",
    "HOST": "Cloudflare Pages",
    "PREVIEW_MECHANISM": "per-branch preview URLs",
    "PKG_MANAGER": "npm",
    "DEV_CMD": "npm run dev",
    "DEV_PORT_BASE": "3000",
    "AGENT_PREFIX": "acme",
    "TEAM_PREFIX": "acme"
  }
}
```

- **`template`** — which template this project was hydrated from.
- **`libraryCommit`** — the agent-templates commit the files came from. This is the "from" point of a future re-hydration diff.
- **`values`** — the placeholder map. The single source of truth for re-applying the template after an update.

The lock file lives in the **project**, never in this library. (The library's `.gitignore` excludes `.template.lock` defensively, so a stray one never gets committed here.)

---

## 3. Re-hydrate (pull library updates into a live project)

When the library improves a template you've hydrated, re-hydrate to inherit the improvement:

1. **Update your local clone of the library** (`git pull`) and note the new commit.
2. **Render the OLD template** at `libraryCommit` with your recorded `values` → this reproduces the files you originally got. Call this `base`.
3. **Render the NEW template** at the new library commit with the same `values` → call this `next`.
4. **Three-way merge:** apply the `base → next` diff onto your project's *current* files (which may have drifted via local edits). This brings in the library's changes while preserving yours. In practice:
   - Where you never touched a templated file, it updates cleanly.
   - Where you edited a templated line, you get a normal merge conflict to resolve by hand.
5. **Update `.template.lock`** — bump `libraryCommit` to the new commit and `hydratedAt` to today.

A thin helper is fine here (a documented find-replace driven by the `values` map, or a small render-then-`git merge-file` script), but **the process above is the deliverable** — don't over-engineer a heavy generator. The lock file + a values-driven find-replace is enough to make re-hydration repeatable.

---

## 4. The protected zone — what re-hydration must NEVER overwrite

A real project accumulates customizations that are **project-local and not part of any template**. Re-hydration must never clobber these. Keep them in a clearly-marked protected zone, one of:

- **A separate `CLAUDE.local.md` file** — anything here is 100% project-owned; re-hydration never touches it. Put project-only rules, secrets-handling notes, one-off conventions here. (Reference it from the main `CLAUDE.md` so agents still read it.)
- **A marked section inside a templated file** — for customizations that must live inside `CLAUDE.md` itself, put them under a heading the re-hydration step is told to skip:

  ```markdown
  ## Project-local (not templated)
  <!-- Everything below this heading is project-owned. Re-hydration must not overwrite it. -->
  ...your project-only rules...
  ```

**Rule:** the re-hydration merge treats `CLAUDE.local.md` and any `## Project-local (not templated)` section as protected — it carries them through untouched. Everything else is fair game for template updates. Document which convention your project uses in the lock file's notes if it's not the default `CLAUDE.local.md`.

---

## Summary

| Step | Action |
|------|--------|
| Instantiate | copy template → fill `{{PLACEHOLDERS}}` from values → resolve `[REPLACE]` markers → write `.template.lock` |
| Re-hydrate | pull library → render base@oldCommit + next@newCommit with same values → 3-way merge onto current files → bump lock |
| Protect | keep project-only customizations in `CLAUDE.local.md` or a `## Project-local (not templated)` section; re-hydration never overwrites them |
