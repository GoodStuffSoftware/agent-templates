---
id: read-numbers-through-the-api-not-the-console
title: Read recurring numbers through the vendor's API, never by driving their web console
scope: [agent-process]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
An agent pulling advertising performance figures by driving the vendor's web console hit a compounding set of failures — date-range controls that silently refuse to apply, screenshots that time out on heavy dashboards, and an accessibility tree that drops table cells so the numbers simply are not in the extracted page. Each failure is quiet and produces a plausible-looking partial answer, which is worse than an error. The vendor's official client library returned the same figures in one query.

**Why:** a web console is built for a human's eyes and a human's patience with retries; a browser-driven agent inherits neither. A control that "silently refuses to apply" looks, from the accessibility tree, identical to one that applied correctly — there is no error to catch. An API call either returns the field or fails loudly.

**How to apply:**
- For any RECURRING numeric or report read, use the vendor's API client. Reserve browser automation for surfaces that genuinely have no API, and for one-off visual confirmation.
- When you must use the console, treat a missing cell as a failed read rather than a zero — a dropped table cell in the accessibility tree and a genuine zero-value metric are indistinguishable unless you go looking, so default to "unread," not "empty."
- Keep the query text in a script in the repository so the next session does not re-derive it, and so the exact fields and filters used are reviewable.
- Query-language gotchas are the reason to keep the script: enumerated fields can come back as protocol-buffer integers rather than names, and a wrong enum constant silently selects a different category with no error.

Note the related failure mode of an agent-driven browser pane whose geometry cannot be trusted ([[non-painting-browser-pane-lies]]) and the prior step of looking for a credentialed client the repository already ships ([[unauthenticated-tool-layer-is-not-a-wall]]).

Related: [[delegate-wide-queries-the-result-set-lands-in-you]].
