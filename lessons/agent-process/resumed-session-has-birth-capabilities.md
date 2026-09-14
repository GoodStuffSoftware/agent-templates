---
id: resumed-session-has-birth-capabilities
title: A resumed session has the capabilities it was born with — a successful wake is not restored agency
scope: [agent-process]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 2
---
A dormant agent session was cold-woken by firing a resume trigger bound to its session id. The resume verifiably worked: the session event log showed it running within a second, and every server-side signal reported success. It was still useless. The session had been created BEFORE the coordination-bus tooling existed, so it woke with the tool snapshot it was born with — no bus tools at all. It could read the message seeded into its wake turn and act on it in context, but it could not drain its durable inbox, re-register, or reply.

**Why:** resuming restores a session, and a session's tool and plugin surface is fixed at birth. Delivering a turn and restoring agency are different events, and the wake mechanism can only observe the first. So "fired", "delivered", and even "resumed" are all compatible with an agent that cannot do anything you asked.

**How to apply:**
- **Verify a wake by the agent's observed ACTION** — a reply, a registration, a drained inbox, a commit — never by the dispatcher's outcome field. See [[verify-at-destination-prove-the-target]]: the dispatcher is the instrument, the agent's action is the subject.
- **Content delivery can outlive the reply path.** A message seeded into the wake turn reaches the session's context and gets acted on even when the session has no tools to answer with. Use the wake turn to carry the instructions themselves, and do not infer failure from silence alone.
- **The rescue for a capability-frozen session is a FRESH session, not another resume.** A second resume reproduces the same snapshot exactly. Spawn new (current capabilities) and drain the durable inbox from the start cursor. Do NOT expect the fresh session to reclaim the durable name by registering — see [[fresh-fire-wake-handle-costs-a-session]] for why that mints a stray identity instead.
- **Say what the swap costs, honestly.** Name, inbox, and task history survive; the original session's in-context memory does not. Propose it as "we lose what it was holding in its head," never as a transparent restart.
- **Design identity to be durable rather than session-bound** — a name plus an inbox that outlive any one session — precisely so this swap is cheap. Where identity is welded to a session id, every capability upgrade strands the agents that predate it ([[registry-identity-and-liveness-honesty]]).
- The general form of the trap: a capability inventory taken at birth and never refreshed. Same shape as [[verify-tools-then-fall-back-to-a-builtin-agent-type]], where the snapshot is wrong at birth rather than merely old.

**Second case, the same snapshot rule one level down: agent DEFINITIONS load at session start too.** A running sub-agent behaved as if it lacked a tool its definition granted, and as if it could not use the reporting channel — which looks exactly like a missing-tool bug in the definition file. The repository already had both grants committed, one of them at the integration branch's tip when the session began. The session had simply loaded an older snapshot.

**So before creating a branch to "add tool X to agent Y" because a running agent seems to lack it, read the COMMITTED definition** on the integration branch and on the release branch. If the grant is already there, it is a stale-snapshot artifact: change nothing in the repository; the fix takes effect in the next fresh session. Diagnose off committed state, never off the running session's in-memory view ([[a-checkout-is-not-the-running-system]], [[verify-tools-then-fall-back-to-a-builtin-agent-type]]).
