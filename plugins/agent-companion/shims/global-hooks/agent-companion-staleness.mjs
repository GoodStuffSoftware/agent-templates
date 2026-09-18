// GLOBAL, FIXED-PATH shim for agent-companion's stale-plugin notice.
//
// Installed once, to ~/.claude/hooks/agent-companion-staleness.mjs, by
// ../../scripts/install-global-hooks.mjs, and registered there as a
// USER-LEVEL SessionStart + UserPromptSubmit hook in ~/.claude/settings.json.
// That registration happens once; this FILE is what actually runs on every
// invocation after that, forever, from that same fixed path.
//
// WHY THIS FILE HAS TO EXIST — verified mechanism:
// A hook script is re-read from disk on every invocation, but only its
// REGISTRATION (which path runs on which event) is bound when a session
// loads. Plugins go stale because an update lands in a NEW versioned folder
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<new-version>/) while an
// already-running session keeps invoking the OLD folder's path for the rest
// of its life. So a staleness CHECKER that lives inside the plugin is itself
// subject to the staleness it reports — a stale session runs a stale
// checker, and it can never notice its own replacement landed.
//
// The fix: this shim never moves, so it is never itself the stale thing.
// Each run it re-resolves whichever agent-companion copy is CURRENTLY
// installed from installed_plugins.json, and hands off to THAT copy's real
// checker (hooks/self-update.mjs) — fresh resolution every time, from a path
// that never needs updating because it never changes.
//
// DELIBERATELY SELF-CONTAINED: Node builtins only, no import from the plugin
// it hands off to (not even the shared hooks/lib/context.mjs helpers). This
// file should essentially never need to change, because a user's installed
// copy of it will NOT auto-update on its own — only re-running the installer
// touches it. Anything that needs to evolve with the plugin belongs in the
// checker it hands off to, which DOES get refreshed on every run by the
// resolution step below. If you're tempted to add a feature here, it almost
// certainly belongs there instead.
//
// FAILS OPEN, ALWAYS, SILENTLY: missing plugin entry, missing checker file,
// malformed JSON, anything at all — exit 0, no output. A notice about
// staleness must never be the thing that breaks a session.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

// Same override convention as hooks/self-update.mjs, so a test fixture can
// redirect both this shim and the checker it hands off to by setting ONE
// env var, without touching the real ~/.claude. Never read from anywhere but
// these env vars + os.homedir().
function homeRoot() {
  return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();
}
function installedPluginsPath() {
  return process.env.AGENT_COMPANION_INSTALLED_PLUGINS_OVERRIDE
    || join(homeRoot(), '.claude', 'plugins', 'installed_plugins.json');
}

// The currently installed agent-companion, read fresh from
// installed_plugins.json on every single run. Prefers a user-scope entry
// (the common case, and the one this session actually inherits); falls back
// to the first entry found under any other scope (e.g. a project-scoped
// install) rather than resolving nothing at all when no user-scope row
// exists. Returns { installPath, marketplace } or null.
function resolveInstalled() {
  const j = JSON.parse(readFileSync(installedPluginsPath(), 'utf8'));
  const table = j && (j.plugins || j);
  if (!table || typeof table !== 'object') return null;
  let fallback = null;
  for (const key of Object.keys(table)) {
    if (!key.startsWith('agent-companion@')) continue;
    const marketplace = key.slice('agent-companion@'.length);
    const raw = table[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !entry.installPath) continue;
      if (entry.scope === 'user') return { installPath: entry.installPath, marketplace };
      if (!fallback) fallback = { installPath: entry.installPath, marketplace };
    }
  }
  return fallback;
}

try {
  const resolved = resolveInstalled();
  if (!resolved) process.exit(0);

  const checker = join(resolved.installPath, 'hooks', 'self-update.mjs');

  // Tell the checker it is running as the global hook — this drives the
  // dedup / self-check handoff documented in hooks/self-update.mjs — and
  // point it at the SAME data directory a plugin-registered invocation would
  // use (the `<plugin>-<marketplace>` convention the harness itself uses),
  // so rate-limit and dedup state is shared rather than split across two
  // files that never agree with each other.
  process.env.AGENT_COMPANION_GLOBAL_HOOK = '1';
  process.env.CLAUDE_PLUGIN_DATA = join(
    homeRoot(), '.claude', 'plugins', 'data', `agent-companion-${resolved.marketplace}`,
  );

  // In-process dynamic import, not a child process: the checker reads
  // stdin, writes stdout, and sets its own exit code exactly like a normal
  // hook script does when the harness invokes it directly. Importing it
  // here means all three happen for free through THIS process's own
  // fd0/fd1/exit path — no manual stdio piping, no relaying stdout by hand,
  // and none of a spawned child's ~30-80ms process-startup cost, which
  // matters on UserPromptSubmit's tight budget. It also gives the checker
  // exactly the import.meta.url it needs: resolved against its OWN file, so
  // it correctly reports the version of the copy THIS shim chose to load —
  // never this shim's own (fixed, unversioned) path.
  await import(pathToFileURL(checker).href);
  process.exit(0); // unreachable in practice — the checker always exits itself
} catch {
  process.exit(0);
}
