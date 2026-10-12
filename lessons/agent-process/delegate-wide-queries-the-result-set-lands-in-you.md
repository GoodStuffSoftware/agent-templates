---
id: delegate-wide-queries-the-result-set-lands-in-you
title: A wide query over a personal corpus lands its ENTIRE raw result set in the caller's context — delegate it and take back the answer
scope: [agent-process]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 2
---
Search-shaped tools over a personal corpus — mail, documents, chat history, a session transcript store — return the raw matched records, not an answer. Whoever issues the call pays for all of them, in two currencies:

- **Context.** A single broad query can dump more material into the caller than a whole round of delegation would have. In an orchestrator session that context is the scarcest resource on the board, and it is spent on records that will never be read again.
- **Exposure.** A broad match over a personal corpus surfaces unrelated private records alongside the relevant ones. They were not asked for, they are now in the transcript, and they persist there.

**Why:** The cost is invisible at the call site. The tool call looks like one line, the same as any other; the expense arrives in the result, after the decision to make it. That inverts the usual intuition that a quick lookup is cheaper than delegating one.

**How to apply:**
- **Brief a subagent to run the query and return only the conclusion** — the specific fact, the message id, the two sentences that answer the question. The raw set lands in a context that is discarded.
- Say what you want back in the brief, concretely: "return the sender and date of the most recent message matching {{TERMS}}, nothing else." Otherwise the subagent forwards the dump and you have paid twice.
- The exception is a query you already know is narrow — an exact id, a single known document. Locality of the answer, not the apparent simplicity of the call, decides.
- This is [[teammate-reports-to-files]] pointed at tool output rather than at teammate prose: same scarce resource, same fix (a pointer or a conclusion, not the body).
- Where the result must be preserved rather than summarized, have the subagent write it to a file and hand back the path — but only if the reader shares the machine ([[a-local-path-is-not-a-shared-artifact]]).

**Second case, same shape: multi-step browser verification.** An orchestration lead ran several live UI passes itself (navigate, inject a no-transition style, open menus through the DOM, read page text and accessibility trees, repeat). Every page dump stayed in its long-lived context, so every later turn re-read it and compaction came sooner. The output is bulky and the conclusion is a verdict; route by that ratio.
- Send the pass to a mid-tier subagent and take back the verdict plus a few lines of evidence. A browser step sequence is execution, not validation, so not the cheapest tier.
- Price it: the messaging is cheap (a brief of about {{BRIEF_TOKENS}} and a report of about the same); the real overhead is the subagent's cold start (about {{COLD_START_TOKENS}} for one spawn, at the cheaper tier's rate). A single one-call check stays inline; three or more round trips are delegated.
- Probe once, with one read-only call, that the subagent sees the same browser tools and tab; if it does not, use a separate session reached by local messaging.
- Each browser agent gets its own tab (a new tab inherits the operator's signed-in session). Two agents never share a tab.
