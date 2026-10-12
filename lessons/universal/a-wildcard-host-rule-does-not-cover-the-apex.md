---
id: a-wildcard-host-rule-does-not-cover-the-apex
title: A wildcard host allowlist entry does not cover the bare domain — a proxy 403 is the proxy, not the site
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A custom network allowlist for a hosted routine listed `*.{{DOMAIN}}`. A request to `staging.{{DOMAIN}}` passed, while `https://{{DOMAIN}}/...` failed in the run log with `curl: (56) CONNECT tunnel failed, response 403`. The wildcard matches subdomains only, so the apex is a separate host.

**How to apply:**
- List the bare domain as its own line next to the wildcard.
- Read a `CONNECT tunnel failed, response 403` as the egress proxy refusing the host, not the site refusing the request; test the same URL from outside the sandbox before debugging the site.
- When a routine meant to be credential-free runs in an environment, remember it inherits that environment's variables; use an environment with none.
- A creation call with no connector list may attach ALL the account's connectors; clear them with an explicit update and read the result back ([[an-omitted-scope-defaults-to-everything]]).
