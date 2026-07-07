---
id: docs-living-or-historical
title: Classify every docs directory as LIVING or HISTORICAL RECORD and maintain each by its class
scope: [universal]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Give every documentation directory an explicit class, and let the class dictate maintenance:

- **LIVING** — must track reality. When a rule or file it references moves, the doc is repointed **in the same commit** as the move. A stale reference in a LIVING doc is a defect.
- **HISTORICAL RECORD** — an immutable log (postmortems, dated decisions, superseded plans). Never retro-edit stale references; instead prepend a dated reconciliation note at the top ("Reconciliation note (YYYY-MM-DD): paths/decisions below predate <change>; current truth lives in <successor>").

Retire a root-level doc by MOVING it to an archive directory with a dated banner naming its successor — never delete-in-place, never leave a stale file at the root. The docs index is updated in the same commit as every add, move, or retire.

**Why:** Undeclared docs rot in both directions. Living docs go stale — agents and new contributors follow references into files that moved months ago — while historical docs get "helpfully" rewritten, destroying the record of what was actually true or decided at the time. Without a declared class, a maintainer (human or agent) cannot tell whether fixing a stale reference is a repair or vandalism. Same-commit repointing and indexing keep the tree consistent at every commit rather than eventually; dated banners make an archived doc self-describing to whoever lands on it later.

**How to apply:**
- Declare the class per docs directory, in the directory's README or the docs index.
- LIVING: a file/rule move and its doc repoints are one commit — grep the docs tree before committing any move.
- HISTORICAL RECORD: content is frozen; corrections arrive only as dated notes prepended at the top.
- Retiring: move to the archive dir, add a dated banner naming the successor, update the index — one commit.
- Uncommitted working docs (live status, handoffs) are a third class entirely — see [[handoff-doc-live-state]].
