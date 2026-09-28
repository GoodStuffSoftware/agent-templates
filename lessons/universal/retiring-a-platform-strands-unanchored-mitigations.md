---
id: retiring-a-platform-strands-unanchored-mitigations
title: Retiring a platform silently strands mitigations that lived only in its config or its own-invoked modules
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
When a build or deploy platform is retired and work moves to a new host, a careful removal can explicitly keep every module that still has an independent live caller — and still lose mitigations that had no anchor at all: settings baked into the old platform's own process environment, and code whose only callers were routes or handlers INSIDE the file being deleted. Each one later resurfaces as what looks like a brand-new failure on the new platform, sometimes discovered only weeks after the fact, because the new host never had the coverage to begin with.

The incident, confirmed three separate times on one migration: an environment-variable mitigation that existed only in the old platform's process config (a required timeout override with no equivalent set anywhere on the new host); a cleanup routine whose only callers lived inside the very file being deleted, so nothing referenced it and nothing flagged its removal as a decision; and a coverage gap that predated the deletion by about a month, because the new host had never been wired into the old routine in the first place — the gap opened silently well before anyone chose to remove the code.

**Why it keeps happening:** an itemized, careful retirement audits modules by "does anything else still call this" — a sound test for code with callers outside the file. It has no test at all for a mitigation with no code anchor: config set in the old platform's own process environment, or a handler whose only callers are siblings in the same file. Both fall through without anyone making a decision about them.

**How to apply:**
- Before diagnosing a failure on a newly migrated platform as novel, check whether the fix already existed on the platform being retired — search that platform's history and its process/environment config for a mitigation with the same name or shape, not just its module tree.
- When retiring a platform, separately inventory: (a) modules with external callers (the easy case, already handled by "who still imports this"), (b) settings baked into the platform's own process/runtime config, and (c) code whose only callers are inside the file(s) being deleted. Category (a) migrates by following its callers; (b) and (c) need an explicit decision, because nothing will surface their absence until something breaks.
- Assume a coverage gap for anything in categories (b)/(c) may already predate the retirement itself — the new host may never have had the mitigation, not merely lost it at cutover.
