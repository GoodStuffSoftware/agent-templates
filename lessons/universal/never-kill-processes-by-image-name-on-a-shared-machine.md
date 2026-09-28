---
id: never-kill-processes-by-image-name-on-a-shared-machine
title: On a shared machine, kill only the PIDs you spawned — never by image name
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A cleanup step that kills every process matching an image or executable name (`taskkill /IM node.exe /T`, `pkill node`, `Stop-Process -Name node`) has an unbounded blast radius on any machine running more than one concurrent workload: it takes down a process-manager daemon, every other session's dev servers and tunnels, and any in-flight test or deploy run sharing that name — not just the load the caller itself generated.

The incident: an agent generated synthetic CPU load with a handful of throwaway processes, then cleaned up with a blanket image-name kill, twice. It took out the shared process-manager daemon (which respawned with an empty process list), several unrelated dev previews, a coordination-bus dispatcher, and other sessions' live test and deploy runs on the same box — none of which the agent had spawned or had any way to know about.

**Why:** an image name is not an ownership boundary. Anything else on the box that happens to run under the same executable is indistinguishable to a name-based kill, and a shared machine running several agent sessions guarantees there is always something else.

**A tree-kill's own reported count is not a bound either.** It names only the roots it killed, not every descendant; treat "N killed" as "everything under that name died, children included," never as a ceiling on the damage.

**How to apply:**
- Record the PIDs you spawn at the moment you spawn them, and kill only those PIDs later.
- Never kill by image/process name as a cleanup step, on any machine you don't know for certain is exclusively yours.
- Any orphan-cleanup routine should match the agent's own working-directory path (or another value only its own processes carry) in the command line before it is allowed to kill a match, rather than matching on name alone.
- Prefer generating natural activity over synthetic load when you need test evidence — it removes the need for a cleanup step at all.
- After a blanket kill has already happened: treat every process, daemon, and in-flight run of that image name on the box as a casualty, restore the process manager from its last saved state, and re-check any gate or deploy result whose timing overlaps the incident.
