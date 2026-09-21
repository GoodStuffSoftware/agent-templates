---
id: hide-flag-rides-the-console-creating-spawn
title: On Windows the hide-window flag must ride the spawn that CREATES the console — a supervisor's own flag does not reach it
scope: [env:windows]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
On Windows, a "hide the window" option only covers the process a supervisor launches directly. If that process itself shells out one or more times before the real program runs, whichever descendant first needs a console allocates one — and that flag never rode along.

The incident: a background dev server run under a process supervisor kept opening a visible terminal window even though the supervisor's own window-hide option was set. The real spawn chain was supervisor → package runner → shell → the dev server, and the package runner passed nothing down about hiding a window. On a machine where the modern terminal application is the default console host, that allocation is a real focus-stealing window, not a flicker.

**Measure the variants before believing any fix; two of the three obvious ones do nothing.** Same box, same supervisor, three one-minute runs: app-level flag plus a shell hop with no flag on the inner spawn → VISIBLE; app-level flag plus the flag on the inner spawn → hidden; app-level flag with no shell hop but the executable spawned without the flag → VISIBLE. So both "drop the shell hop" and "set the flag on the supervisor entry" read as plausible fixes on paper, and both fail in practice. An operator watching the screen confirmed each result independently — the cheapest possible oracle, worth reaching for whenever the symptom is something a human can see happen.

**Why:** the flag is a per-spawn creation attribute, not an inherited environment value. Every hop in a shell-out chain is a fresh spawn, and only the hop that actually allocates the console (the one whose target is not already attached to one) needs the flag — but there is no way to know which hop that is without tracing the chain or measuring.

**Count the window hosts; do not eyeball a flash.** A hidden console still creates a console-host process, so the mere presence of that process proves nothing about visibility. The reliable signal is a NEW terminal-application or console-window-host process appearing during the run: snapshot the process list before, diff it after, and report the count — not an impression.

**The symptom that reads as "it reopens by itself" is usually the supervisor doing its job, not a leak.** Closing the window kills the server; the supervisor restarts it; the window returns within seconds; the loop feels like malware rather than tooling. Rule this out before escalating.

**How to apply:**
- Trace the full spawn chain (supervisor → runner → shell → target) before touching any single hop's flag; the flag belongs on whichever hop actually allocates the console, which may not be the first or the last.
- Prefer eliminating the shell hop entirely (spawn the target executable directly) over threading a hide flag through every intermediate layer — fewer hops means fewer places the flag can fail to ride along.
- Verify with a process-list diff across the run, not a visual glance, and re-run each candidate fix independently rather than stacking changes and hoping.
- Distinguish "window came back because the app un-hid it" from "window came back because the supervisor restarted a killed process" before writing up a fix.

Related: [[track-the-generator-ignore-the-output]], [[assert-the-resolved-value-not-the-declaration]], [[a-silent-guard-needs-a-canary]].
