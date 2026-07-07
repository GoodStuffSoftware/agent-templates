---
id: no-stall-decision-protocol
title: On an unanswered user-decision point, take the best reversible default, log it durably, and continue
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
When work reaches a decision the user would normally settle and the user isn't actively responding, don't idle. Take the best defensible default — preferring the reversible shape — APPEND an entry to a durable decision ledger, and keep working. The entry records: date, project, the choice and the alternatives it beat, why, the reversal path, and an unreviewed checkbox. Log FIRST, then act on the decision.

Hard-block (stop and wait for the user) for exactly three classes: **irreversible/destructive operations outside standing authorization**, **real-money spends**, and **outward-facing sends** (anything that leaves the machine for other people). Everything else defaults-and-logs.

**Why:** An agent that stalls on every judgment call converts autonomy into a question queue — sessions burn wall-clock waiting for input the task didn't strictly require. An agent that decides silently destroys oversight. The ledger resolves the tension: work continues at full speed, and the user keeps an auditable review queue — every call made on their behalf, each with alternatives, rationale, a documented way back, and a checkbox awaiting review. Keeping the hard-block list to three genuinely unrecoverable classes is what makes the protocol enforceable; a long exception list collapses back into ask-about-everything.

**How to apply:**
- Ledger: one append-only file (e.g. `~/.claude/DECISIONS.md`); fields per entry: date, project, choice over alternatives, why, how to reverse, `[ ] reviewed`.
- Prefer defaults that stay reversible: a flag over a rewrite, a branch over a merge, soft-delete over delete.
- Where possible, enforce the destructive hard-block class with a guard hook rather than convention ([[guard-hooks-deny-teach-ack]]).
- Complements [[heartbeat-over-time-box]]: that lesson stops false aborts on slow-but-progressing work; this one stops idle-waiting at decision points. Both target the same failure — an agent that stops when it shouldn't.
