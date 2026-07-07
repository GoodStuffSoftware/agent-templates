---
id: dev-server-request-contract
title: A dev-server request is fulfilled by a clickable tunnel URL from a daemonized server, not a process report
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
When the user asks for a dev server, the deliverable is a **clickable URL that works from wherever the user is** — a tunnel URL whenever they may not be on localhost — not a report that a process was started. Structurally: dev servers run under a **detached daemon process manager** (windowless, survives the agent's turn and session end, resurrectable on boot), with the manager's **process dashboard as the visibility layer**. A visible console window is reserved for one-off operations the user actually wants to watch.

**Why:** A server started as a child of an agent turn dies or orphans when the turn ends ([[dev-servers-persistent-owner]]) — the user clicks the reported URL minutes later and gets connection-refused. A process report ("server running on port NNNN") outsources the last mile to the user: find the port, check it's really up, assemble the URL, discover it's unreachable off-machine. And console windows as a visibility mechanism don't scale — they clutter the desktop, get closed by accident (killing the server), and show liveness, not health. The daemon manager is the strongest form of the persistent-owner rule: the owner isn't an agent at all, so no agent lifecycle can take the server down with it.

**How to apply:**
- Contract: answer "start a dev server" with the verified, clickable URL — verify the actually-bound URL first ([[verify-actual-bound-url]]), and hand out the tunnel URL (e.g. `https://dev.{{PROJECT_DOMAIN}}` or an ephemeral tunnel) when the user may be off-localhost.
- Run servers under a detached daemon manager (`{{PROCESS_MANAGER}}`, pm2-style: windowless, survives turn end, boot-resurrectable).
- Visibility = the manager's dashboard/status command, not console windows.
- Visible consoles only for user-watched one-offs (an interactive migration, a first-run build).
