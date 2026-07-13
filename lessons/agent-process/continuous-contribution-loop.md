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
3. **FOLD (periodic, e.g. weekly).** A scheduled or kicked-off session in the library repo reads the inbox PLUS the project's recent memory files, decision ledger, and merge history; runs the "is this generic?" test; dedups against the lessons index *by meaning* (raise `corroborated` or extend an existing lesson rather than duplicate); authors properly tagged lesson files; empties the folded inbox entries per the maintainer flow (flip `Applied?` to yes, remove the entry); regenerates the index; runs the leak guard; and lands the result via the library's contribution path (PR or direct commit — maintainer policy; see the fold self-checks below).

The fold trigger stays THIN: its prompt just points at this lesson as the process definition. Refining the process means editing this lesson — never the trigger.

**Why:** One-shot harvests decay. Knowledge learned mid-session is context-free by release time and expensive to reconstruct at harvest time; a library seeded once and never fed stops being a living library. Capture at the moment of learning costs a few lines (the context is already loaded), the sweep is a one-question checklist clause, and the fold becomes mechanical because entries arrive pre-sanitized. Splitting capture (project side, instant) from fold (library side, deliberate) keeps project sessions fast while preserving the scrub discipline on everything that lands (and the human gate, where the maintainer wants one).

**How to apply (what a project wires locally):**
- **Ladder step** — append to {{PROJECT}}'s knowledge-routing ladder: "generic reusable technique → in ADDITION to its project-local home, append a sanitized entry to `{{LIBRARY_PATH}}/CONTRIBUTIONS_INBOX.md` (newest first; `{{LEAK_GUARD_CMD}}` must pass). The lead appends — subagents are sandboxed out of `{{LIBRARY_PATH}}`."
- **Checklist clause** — add to {{RELEASE_CHECKLIST}}: "Did this work teach a generic technique? → library inbox append."
- **Scheduled trigger** — a {{SCHEDULER}} job (weekly is a good default) starts a session in `{{LIBRARY_PATH}}` with a thin prompt: "Run the FOLD step of the `continuous-contribution-loop` lesson over the inbox and {{PROJECT}}'s activity since the last fold."
- **Landing path** — per the library maintainer's policy: a PR when review is wanted, a direct commit when not. The non-negotiables either way: the leak guard runs green BEFORE the commit, dedup-by-meaning happened against the index, and the index regenerates in the same commit.
- **Fold self-checks** (each bought by a real misstep):
  - *Tag-generality:* if a lesson's own body claims broader applicability than its scope tags ("applies to any X" under a `stack:` tag), widen the scope before landing — tags exactly as narrow as true, no narrower.
  - *No verbatim source material:* code/config examples are reconstructed generic snippets, never pasted from the source project — a token-list leak guard cannot recognize proprietary logic; that scrub is the fold session's judgment, not the guard's.
  - *Guard-coverage honesty:* the leak guard scans committable file contents only — commit messages and branch names are NOT scanned. Whether source-project names may appear in commit metadata is explicit maintainer policy; "leak guard green" says nothing about it.
  - *LIVING-artifact sweep:* after landing lessons, regenerate or repoint every artifact that enumerates lessons (index, digests, counts) in the same commit ([[docs-living-or-historical]]) — and prefer de-hardcoding such enumerations to the generated source ([[static-instructions-teach-discovery]]).
