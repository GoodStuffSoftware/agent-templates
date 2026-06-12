# Cross-project agent-team rules — now tagged lessons

This file used to hold the full cross-project rules kernel inline. **Those rules now live as individually-tagged lessons in the top-level [`lessons/`](../../lessons/) tree**, so they can be routed to a project by its profile (stack/env/vendor/archetype) instead of pasted wholesale. See [`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the model (axes, AND/OR tag semantics, cascade, lifecycle) and compose a project's applicable set with:

```
node scripts/compose.mjs --profile <project>/.claude/.template.lock
```

This page stays as a thin **human-readable digest** — a map from each rule to its lesson id. For the authoritative wording, open the lesson (or the generated [`lessons/INDEX.md`](../../lessons/INDEX.md)); don't restate rule bodies here (single source of truth — the lesson file).

> The model-routing, reviewer-pairing, commit-convention, and docs-hygiene guidance that was previously inline here is general agent-team practice a maintainer keeps in their global agent-config file (for Claude Code, `~/.claude/CLAUDE.md`). The lessons below are the portable, project-neutral mirror of the parts that recur as *hard-won gotchas*; the broader practice lives in that global file.

---

## Digest — rule → lesson id

**Worktree / write-target / dev-server discipline**
- Branch what deploys; dev-config commits straight to the integration branch → `branch-what-deploys`
- Verify merge direction before merging a long-lived branch → `verify-merge-direction`
- Bake the write-target into a writer's initial brief; never redirect mid-flight → `write-target-in-initial-brief`
- Long-lived dev servers belong to a persistent owner, not transient writers → `dev-servers-persistent-owner`
- State the actual bound URL, then verify it before relaying/diagnosing → `report-actual-bound-url`
- Confirm which process actually serves a build before diagnosing it → `diagnose-the-right-process`
- After invalidating a teammate's world, sync it or shut it down → `sync-or-shutdown-stale-teammates`

**Stall prevention & async comms**
- Writer agents open with a read-only diagnostic + liveness report; heartbeat thereafter → `first-action-read-only`
- Design async agent gates idempotently — approvals and reports cross in flight → `idempotent-gates-crossed-messages`

**Deploy / CI**
- Exactly one mechanism may deploy production → `one-canonical-deployer`
- GitHub Actions path-filter glob semantics; don't port globs between systems → `github-actions-path-glob-semantics`

**Stack / environment gotchas**
- Nuxt/Vite dev server walks to the next free port → `nuxt-port-fallback`
- On Windows, the agent tool's Glob may miss the user-profile config dir → `windows-home-config-glob`

---

_To add a cross-project rule, don't edit this digest by hand as the source — write a tagged lesson in `lessons/` (see [`CONTRIBUTING.md`](../../CONTRIBUTING.md) → Harvesting), then reflect it here as one digest line._
