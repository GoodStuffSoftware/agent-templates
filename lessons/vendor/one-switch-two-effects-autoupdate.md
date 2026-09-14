---
id: one-switch-two-effects-autoupdate
title: One switch, two effects — pinning the CLI silently pins its plugins, and a stale second install scope hides behind a current one
scope: [vendor:anthropic]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-1]
corroborated: 1
---
A marketplace plugin sat at an old version on one machine while the marketplace clone beside it was current. The host has a **native plugin auto-updater** — its own bundle logs "Plugin autoupdate: skipped (auto-updater disabled)" — gated on the *same* switch as the CLI's self-update. So disabling the CLI updater pins every installed plugin too, silently, with no message anyone reads. Compounding it, the same plugin was installed a second time at project scope, which shadowed the user-scope copy and never updated.

Three separable traps in one incident: **one switch with two effects**, **a stale second scope hiding behind a current first one**, and **"installed" is not "loaded"** — an update applies on restart.

**Why:** the switch was set for a defensible reason (pin the CLI) by someone who had no plugins in mind, and its second effect is not stated where it is set. Meanwhile scope shadowing makes the *correct* install visible in one listing and the *effective* install something else, so the version you read is not the version you run.

**How to apply:**
- When plugins look stale, in order: (1) list installs and look for a **second scope** shadowing the one you are reading; (2) check the auto-updater switch — the environment variable *and* the settings key; (3) check whether the **host application injects it**. A desktop host may set it for its own sessions, so terminal sessions update while desktop sessions silently do not, on the same machine, from the same config.
- Do **not** compensate with a start-up hook that spawns the update detached. On Windows a detached child has no console, so the CLI it launches allocates a visible one, and a host restart fires the hook once per session — a cascade of flashing windows. Run the built-in commands (`{{MARKETPLACE_UPDATE_CMD}}` then `{{PLUGIN_UPDATE_CMD}}`) from a **scheduled session** instead, and keep the hook to a side-effect-free notice: "installed X, updating to Y — restart to load it."
- A marketplace entry that declares no `version` is invisible to the host's plugin directory across releases. Declare it and keep it equal to the plugin manifest's own version; the CLI validator enforces the equality once both exist.
- **Grep the shipped bundle for the feature's strings before building a replacement for it.** The auto-updater already existed; only its gate was closed. Building a second one would have been pure cost ([[grep-the-shipped-artifact-not-the-docs]]).
- Related: [[probe-behaviour-not-version-stamps]] and [[assert-the-resolved-value-not-the-declaration]] — the version you read from a manifest is a declaration, not what is loaded.

**Neighbouring lesson:** where this one is about a single switch with two effects, [[a-version-bump-does-not-invalidate-every-cache]] covers the other half of the same family — one published artifact consumed through several INDEPENDENT caches, where verifying the update on your own machine says nothing about a hosted client holding its own copy.
