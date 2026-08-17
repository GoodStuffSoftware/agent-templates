---
id: answer-no-such-thing-not-i-wont
title: When a request is misrouted to you, answer "no such thing" — not "I won't"
scope: [agent-process]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 1
---
A peer asks you to do something you cannot do because the *premise* is wrong: you are not that host, you do not own that resource, the path does not exist here. A refusal ("I can't", "I'd rather not") leaves the premise standing and the sender waits on a dead channel.

The incident: an agent sent a peer a set of shell commands to run against a server, opening with "you own the box". The recipient was a workstation that runs a *listener* for that service and holds a checkout of its repo — but is a different operating system entirely, with none of the server's process-inspection surfaces. The tempting replies were "I can't run that" and "I'd rather not restart your service uninvited". Both are misleading in the same way: they imply the machine exists and the recipient merely declined. Naming the category error instead — *this host is not that host* — plus forwarding the commands to the agent actually on the server, closed it in one hop.

**Why:** In a mesh, identity is inferred from weak signals — a name containing the project, holding a clone of the repo, being the listener for the service. Misrouting is therefore normal, not exceptional. And a polite refusal is indistinguishable from a capable-but-unwilling peer, so it corrects nothing: the sender's model of who owns what survives intact and the next request lands in the same place.

**How to apply — reply in three parts:**
1. **Name the category error, plainly.** "There is no such box here", not "I don't have access". Say what you ARE, with a concrete detail that settles it (OS, hostname, missing path).
2. **Do the part you genuinely can.** Being the wrong executor rarely makes you useless. Source you hold, config you can read, history you have — deliver that, and state its staleness so it is weighable.
3. **Route it.** Name the agent or role that *can* run it and forward the request yourself. Returning it to the sender costs a round trip and they already guessed wrong once.

Correct the inference, not just the request. Related: [[registry-identity-and-liveness-honesty]] (do not advertise an identity you cannot honor) and [[check-before-duplicating-a-peers-work]].
