---
id: a-killed-build-leaves-helpers-a-launcher-mistakes-for-the-app
title: A killed build leaves its helper processes alive — a launcher's process-tree heuristic can mistake them for the running app
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
Stopping a build mid-compile does not always stop the build tool's own helper processes (a symbol/debug-info server, a telemetry uploader, an incremental-build daemon). Those helpers can outlive the build that spawned them, and a launcher that identifies "is the app already running" by walking the process tree for a familiar process name can find one of these orphaned helpers and refuse to start a fresh instance — reporting a launch failure that has nothing to do with the app itself.

The incident: killing a build wrapper mid-compile left compiler helper processes alive in its process tree. The platform's own launcher then treated one of them as the running app and refused to relaunch it, even though nothing app-related was actually running.

**Why:** a process-tree presence check assumes a process family starts and stops as a unit. Build tooling frequently does not: helper processes are spawned for the DURATION of a build step, not tied to the parent's lifetime, and a hard kill of the parent has no way to cascade to them.

**How to apply:**
- Prefer the build tool's own "no daemon reuse" / "no persistent worker" switch when running under automation that may kill the build mid-flight, so there is no long-lived helper to orphan in the first place.
- After a build is stopped abnormally, sweep for helper processes whose recorded parent process no longer exists, and terminate them before the next launch attempt.
- Do this at both ends — right after a build is killed, and again at the next launch/startup — since a helper can also be orphaned by something other than the launcher's own kill.
- A kill-on-close job (or platform equivalent that ties a child's lifetime to its parent) is the more principled fix where the platform offers one — but verify it actually fires under your real conditions (security software holding handles, antivirus, sandboxing) before relying on it instead of the sweep.
- This is the general shape; the specific helper processes and platform APIs available differ by build tool and OS — the pattern itself (killed parent, orphaned helper, launcher misattributes it) is what generalizes.
- Related: [[no-avoidable-slow-work-on-a-launchs-critical-path]] (the companion finding from the same incident — the build being on the critical path at all is what made a killed build likely in the first place).
