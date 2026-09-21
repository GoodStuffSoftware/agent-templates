---
id: credentials-never-reach-an-error-path
title: Treat every error path in credential-handling code as a publication surface
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 2
---
Code that fetches, parses, or forwards a secret must assume its error text will be published — to a log, a terminal, a ticket, a chat transcript, a crash reporter. An exception message that interpolates "the value being processed" is a credential disclosure whenever that value is the credential.

The instance: a helper script fetched a bearer token into a variable and accepted a boolean switch parameter. In a shell where parameter and variable names collide case-insensitively, the switch silently shadowed the variable holding the fetched output; the failed assignment then ECHOED the raw token into the error text — and into the session transcript that recorded it. The token had to be rotated.

**Why:** Success paths get reviewed for secret handling; error paths get written once, in a hurry, by interpolating whatever local is in scope. And the disclosure is durable in a way the process is not — the value lives on in logs and transcripts long after the run.

**A second face: the gate's own report is a publication surface.** A leak-detection gate running as part of a public repository's CI pipeline was built to name what it caught — echoing the offending text or the blocked output as proof the gate worked. On a public repository, CI logs are themselves public, so that echo published exactly the secret the gate had just stopped from shipping. The gate did its job and leaked anyway, through its own success report.

**A third face, named this time as a specific recurrence: a failed assignment can echo the value it failed to assign.** In a case-insensitive variable namespace (PowerShell is the common offender), a parameter name colliding with another in-scope variable differing only in case again produced an error message that contained the OTHER variable's value — a credential — which landed in both the CI log and the session transcript that recorded the run. Same mechanism as the original instance, confirmed as a recurring shape rather than a one-off: this class of collision reliably produces this class of leak wherever a language or shell resolves names case-insensitively.

**How to apply:**
- Never interpolate a raw value into an error message in credential-handling code. Report the SHAPE instead: length, prefix, "empty", "not JSON", "HTTP {{STATUS}}".
- Hold secrets in memory only, and wrap the fetch-and-parse in a handler that raises a purpose-written error rather than letting the underlying exception through with its payload.
- Beware name collisions in the language or shell you are in — some resolve variable and parameter names case-insensitively, so a switch named `{{FLAG}}` and a variable named `{{flag}}` are the same identifier. Give credential-holding variables distinctive names that cannot collide with a parameter.
- If a secret does reach an error path, rotate it — do not reason about who saw it. Record the rotation where the next operator will look.
- A related diagnostic tell worth keeping: when a request traverses an edge gate before reaching an origin's own auth, the two rejections have different SHAPES — the edge returns a sign-in page (HTML), the origin returns a clean `401` (JSON). Reading the shape tells you which layer rejected you and therefore which credential is stale.
- On any gate whose job is to catch and report a leak, treat the REPORT as a second leak surface: on a public repository (or any log a wider audience can read), emit the category of what was caught — never the matched text — when running in CI, and reserve full detail for a local-only run ([[a-pushed-workflow-can-read-repo-secrets]]).
- Enumerate EVERY surface that renders an error before calling a credential-handling path safe — CI logs, session transcripts, crash reporters, bug trackers — and treat each one as public until proven otherwise. A fix that stops one surface from echoing a secret and leaves the others untouched is not a fix, it is a narrower leak.
