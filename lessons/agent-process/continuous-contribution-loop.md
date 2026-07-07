---
id: continuous-contribution-loop
title: Wire capture, sweep, and fold steps so project learning flows to the library continuously
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
A project connected to a template/lesson library contributes back through three wired-in steps — not through occasional heroic harvests. Each step is cheap because it fires while the knowledge is already in context, and none of them exposes project specifics, because sanitization happens at capture time.

1. **CAPTURE (in-session, at the moment of learning).** The project's knowledge-routing ladder ([[knowledge-routing-ladder]]) carries an explicit step: *"generic reusable technique? ALSO append a sanitized entry to the library's contributions inbox — placeholders for every real value; the library's leak guard must pass."* The session lead does the append the moment the lesson is learned (subagents are typically sandboxed out of other repos, so this is lead work).
2. **SWEEP (at merge/release time).** The project's release checklist asks: *"did this work teach a generic technique?"* Anything caught here gets the same inbox append. The sweep catches what in-session capture missed.
3. **FOLD (periodic, e.g. weekly).** A scheduled or kicked-off session in the library repo reads the inbox PLUS the project's recent memory files, decision ledger, and merge history; runs the "is this generic?" test; dedups against the lessons index *by meaning* (raise `corroborated` or extend an existing lesson rather than duplicate); authors properly tagged lesson files; empties the folded inbox entries per the maintainer flow (flip `Applied?` to yes, remove the entry); regenerates the index; runs the leak guard; and lands the result via the library's contribution path — a human still gates what lands.

The fold trigger stays THIN: its prompt just points at this lesson as the process definition. Refining the process means editing this lesson — never the trigger.

**Why:** One-shot harvests decay. Knowledge learned mid-session is context-free by release time and expensive to reconstruct at harvest time; a library seeded once and never fed stops being a living library. Capture at the moment of learning costs a few lines (the context is already loaded), the sweep is a one-question checklist clause, and the fold becomes mechanical because entries arrive pre-sanitized. Splitting capture (project side, instant) from fold (library side, deliberate) keeps project sessions fast while preserving the human gate and the scrub discipline on everything that lands.

**How to apply (what a project wires locally):**
- **Ladder step** — append to {{PROJECT}}'s knowledge-routing ladder: "generic reusable technique → in ADDITION to its project-local home, append a sanitized entry to `{{LIBRARY_PATH}}/CONTRIBUTIONS_INBOX.md` (newest first; `{{LEAK_GUARD_CMD}}` must pass). The lead appends — subagents are sandboxed out of `{{LIBRARY_PATH}}`."
- **Checklist clause** — add to {{RELEASE_CHECKLIST}}: "Did this work teach a generic technique? → library inbox append."
- **Scheduled trigger** — a {{SCHEDULER}} job (weekly is a good default) starts a session in `{{LIBRARY_PATH}}` with a thin prompt: "Run the FOLD step of the `continuous-contribution-loop` lesson over the inbox and {{PROJECT}}'s activity since the last fold."
- Fold sessions propose on a branch/PR so the library's CI leak guard and a human review gate every landing.
