---
id: guard-hooks-deny-teach-ack
title: Guard risky tool calls with hooks that deny without an ack marker, teach in the deny message, and fail open
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Enforce safety rules at the tool boundary, not only in instructions: pre-tool-use guard hooks DENY risky calls (destructive git, memory writes, deploys) unless the call carries an explicit **ack marker** — and the protocol grants the marker only after the prerequisite verifiably succeeded. Example: destructive git against a shared branch is denied unless the command carries an ack token that is granted only after a timestamped backup ref has been pushed and the push verified. Register hooks in exec form (argv array), not shell-string form, so quoting survives every shell and OS.

Three design principles:
1. **Fail open on hook error.** A guard that crashes must allow-and-log, not block — otherwise a hook bug bricks the guarded tool entirely. Corollary: monitor for silently erroring hooks, because fail-open masks a dead guard (see [[powershell-pipe-bom-breaks-json]]).
2. **Deny message = teaching text.** The denial states the rule, the prerequisite, and the exact ack syntax, so the agent self-corrects in one round instead of retry-flailing.
3. **Ack markers = audit trail.** The marker travels in the command line itself, so the transcript and shell history record that the prerequisite was claimed for that exact call.

**Why:** Instruction-level rules decay under context pressure — a long session eventually forgets or rationalizes around them; a hook enforces regardless of what the model currently remembers. But naive hooks fail two ways: fail-closed guards convert their own bugs into outages of the guarded tool, and bare "denied" responses produce blind retries that cost more than the risk they prevent. The deny-unless-ack shape threads the needle: the risky call stays possible, the prerequisite becomes unskippable, and every use leaves evidence.

**How to apply:**
- Pick the risky call classes; write a pre-tool-use hook per class that pattern-matches the call and checks for its ack marker.
- Grant the ack only from the prerequisite's success path (backup ref pushed and verified, ledger entry appended, …) — never preemptively.
- Put the rule, the recovery steps, and the exact ack syntax in the deny message.
- Wrap the hook body in a top-level catch → allow + log.
- Test the DENY path explicitly, not just the allow path ([[powershell-pipe-bom-breaks-json]]).
