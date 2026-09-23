---
id: an-unauthenticated-duplicate-entry-is-not-an-outage
title: One endpoint can have two server entries with independent auth — an unauthenticated duplicate is not evidence the capability is down
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
The same MCP endpoint was reachable through two registrations at once — a plugin bundled its own server entry for the URL, and the operator also had a first-party connector to the identical URL. The command-line listing showed the connector Connected and the plugin entry needing authentication, permanently, because the two do not share tokens. The plugin entry never had to be signed in, because the connector served every tool. Signing the duplicate in was still worth offering as an optional one-time step: it cleared the recurring "requires authentication" notice and delivered the tools under the plugin's own pre-approved names. Calling that sign-in useless is what kept agents from ever suggesting it.

**Agents read that warning as an outage.** Across a sample of transcripts, most "I cannot reach the service" reports traced to this single belief — the large majority from misreading the unauthenticated duplicate, a smaller share from hunting for a hardcoded plugin-scoped tool name that no longer matched. The service was healthy in every one of them.

**Why:** a startup notice naming an unauthorized server describes ONE registration's credential state, not the capability's availability. Two entries pointed at the same underlying service can carry independent, unrelated auth states, and the healthy one is easy to miss when the unhealthy one is the one that prints a warning.

**How to apply:**
- Before reporting a blockage or prescribing a sign-in, check whether another registered entry already serves the same URL and is connected. State the finding as "entry {{X}} needs auth, but entry {{Y}} serves the same endpoint and is live" — never "the service is down."
- **Never hardcode a tool prefix** in a hook, a matcher, a skill, or a document. A plugin-bundled server yields a stable `mcp__plugin_{{PLUGIN}}_{{SERVER}}__*` prefix, while a connector to the very same URL yields `mcp__{{CONNECTOR_UUID}}__*`, where the identifier is per-connector and per-machine, so no fixed string matches it.
- Instructions must name the BARE tool name and cover both prefix shapes, and must say to search the whole toolset — including DEFERRED tools, which a startup listing does not show — before concluding a tool is absent ([[tool-listing-is-scope-filtered]]).
- A bare-name search can also return a different, genuinely dead duplicate that happens to share the name. What you find must still be invoked successfully before you call it proof of reachability — a match in the listing is a candidate, not a confirmation.

Related: [[tool-listing-is-scope-filtered]] (the complementary direction: absence from a listing is a statement about your credential), [[static-instructions-teach-discovery]], [[unauthenticated-tool-layer-is-not-a-wall]], [[fix-the-doc-not-the-security-matcher]].
