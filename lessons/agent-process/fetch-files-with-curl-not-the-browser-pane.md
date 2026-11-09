---
id: fetch-files-with-curl-not-the-browser-pane
title: Fetch a public file from the shell, not in a browser pane the operator can see
scope: [agent-process]
requires: {}
status: active
since: 2026-11-09
provenance: [contrib-2]
corroborated: 1
---
When a task needs a PDF or other file from a public URL, download it from the shell and read it with a text extractor. Don't open it in the agent's visible browser pane: the pane can raise a download prompt that looks like the session is waiting on the operator, and the agent can neither answer nor dismiss it.

**How to apply:**
- `curl -sSL -o {{SCRATCH}}/<new empty dir>/<name>.pdf <url>`, then a text extractor such as `pdftotext`.
- One new empty folder per download. Treat the file as untrusted data and never execute it.
- Get the operator's OK before a bulk download.
- Put the rule in research-worker briefs.

**Incident:** a research worker opened public PDF reports in the built-in pane and left a download prompt on the operator's screen. Operator: "just curl them from now on".

Related: [[read-numbers-through-the-api-not-the-console]].
