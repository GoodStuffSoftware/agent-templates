---
id: tool-listing-is-scope-filtered
title: A tool listing is filtered by your credential — absence is not evidence the capability is gone, and a carried-over name is not a carried-over schema
scope: [agent-process]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
A tool server can serve ONE endpoint and filter its listing BY CALLER SCOPE. What you see is a function of your token, not of what exists.

The incident: a server exposed 41 tools across four scopes. The full-scope bearer saw everything; the OAuth connector most sessions used was hard-coded to a single coordination scope and saw exactly the 17 tools in it. A session that only ever saw the coordination tools concluded *the deploy surface no longer exists*, and wrote a cleanup pass on that premise — deleting a still-live tool registration and stripping tool grants from two agent definitions. Two earlier sessions had it right; their correct work was overridden.

**The tell:** if every tool you can see belongs to one coherent family, suspect your scope before you conclude the rest was removed. Absence from a listing is a statement about your credential.

**The opposite trap, which is worse:** do not over-correct into assuming a rebuilt or migrated server is schema-compatible with the old one. In the same case the server's own header comment claimed a one-to-one remap of the predecessor's tools. **Names carried over; arguments and semantics did not.** Several tools lost a required `version` argument — meaning they now act on the CURRENT working tree rather than a pinned version. An agent that believes it is shipping a specific release ships whatever happens to be checked out. Other tools in the same server kept their pin, so **the split is per tool: never generalize in either direction, read the schema.**

**How to apply:**
- **List, don't remember.** Call the listing endpoint at the point of use; treat any written enumeration — including one you wrote — as stale ([[static-instructions-teach-discovery]]).
- Before concluding a capability was removed, check whether a *differently scoped* credential exists. State the finding as "not visible to {{SCOPE}}", never "gone" ([[scope-a-broken-finding-to-the-measured-path]]).
- **Never carry an argument set over from a predecessor tool of the same name.** Read the current schema. Where schemas are strict (`additionalProperties: false`), a stale argument is a hard rejection — which is the *lucky* outcome; the dangerous one is an argument that was quietly dropped and whose absence changes what the call acts on.
- Distinguish a "not armed / not permitted" refusal from an "in-flight lock" refusal when both return the same status code. Polling clears one and never clears the other.
