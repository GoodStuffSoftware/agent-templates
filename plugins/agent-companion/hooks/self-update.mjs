// SessionStart + UserPromptSubmit — say when THIS SESSION is running an
// older copy of the plugin than what is installed.
//
// Keeping a plugin current is the harness's job: Claude Code's own plugin
// autoupdater runs at startup whenever its auto-updater switch is on, and the
// built-in commands (`claude plugin marketplace update`, `claude plugin
// update`) cover the case where it is off — the daily local scout runs them.
// This hook does not update anything. It does the one thing none of those
// can: tell a LIVE session, in terms it can act on right now, that the copy
// it is running is older than the copy on disk.
//
// Two ways that happens, both covered by firing at both events below:
//  - A session started before an update landed, and is still running the old
//    hooks/skills. `/reload-plugins` fixes this without losing context — and
//    a sub-agent spawned by this session inherits whatever its parent has
//    loaded, so one stale parent quietly makes every child it spawns stale
//    too. SessionStart alone would miss this case entirely, because nothing
//    about session start changes when an update lands mid-session.
//  - Less common but observed once: on desktop, a session can load from an
//    app-extracted per-session bundle rather than the installed cache copy,
//    and that bundle stayed on an older version across a full restart. So
//    "stale" is not only a running-session problem; SessionStart still needs
//    to check, because the loaded copy can already be behind at startup.
//
// The running version is read from the plugin.json of the copy THIS FILE is
// executing from (via import.meta.url, falling back to CLAUDE_PLUGIN_ROOT) —
// that is definitively the running copy, independent of whatever cache path
// or bundle it was loaded from. The installed version is read from
// installed_plugins.json. Only an OLDER running copy notifies: newer means a
// developer is deliberately running a working tree, and equal means nothing
// to say. Shown once per session per (running, installed) pair, so an
// operator who does not act on the first notice is not nagged on every
// prompt, but a second update landing while they are still on the first
// stale copy notifies again.
//
// Channel: systemMessage only, no hookSpecificOutput.additionalContext — shown
// to the user, never added to the model's context, zero tokens. That is the
// same convention this file used before this change (contrast
// memory-budget.mjs and scout-surface.mjs, which deliberately add
// additionalContext because their findings ARE meant for the model), and it
// matches the official hooks documentation: "For UserPromptSubmit hooks, use
// hookSpecificOutput.additionalContext instead [of systemMessage] to inject
// text into Claude's context" (Claude Code hooks guide) — systemMessage alone
// surfaces to the user only, on every hook event, including both events this
// file is registered for.
//
// Zero side effects, zero tokens on a quiet day. Fails open on every error.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  readStdin, opt, passthrough, stateFile, readJson, writeJson,
} from './lib/context.mjs';

// Overridable only for tests (case 6-9 in the plugin's verification suite
// need to point at fixture files without touching the operator's real
// ~/.claude). Never read from anywhere but this env var + os.homedir().
function homeRoot() {
  return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();
}

// The running copy, read from ITS OWN plugin.json — not from CLAUDE_PLUGIN_ROOT
// alone and not from parsing the cache path, both of which assume a specific
// load shape (marketplace cache) that an app-extracted per-session bundle does
// not follow. import.meta.url is the one thing that cannot lie about which
// file is actually executing.
function runningPlugin() {
  try {
    const here = fileURLToPath(import.meta.url); // .../hooks/self-update.mjs
    const root = join(dirname(here), '..');
    const pj = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (pj && pj.version && pj.name) return { name: pj.name, version: pj.version };
  } catch { /* fall through to the env fallback */ }
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (!root) return null;
    const pj = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (pj && pj.version && pj.name) return { name: pj.name, version: pj.version };
  } catch { /* give up: no running-version answer, stay silent */ }
  return null;
}

// Installed version for this plugin, preferring the user-scope entry — the
// same shape self-update.mjs has always read, generalised to tolerate more
// than one marketplace key sharing the plugin name.
function installedVersion(pluginName) {
  try {
    const path = join(homeRoot(), '.claude', 'plugins', 'installed_plugins.json');
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const table = j.plugins || j;
    let best = null;
    for (const key of Object.keys(table)) {
      if (key !== pluginName && !key.startsWith(`${pluginName}@`)) continue;
      const entries = table[key];
      const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
      const user = list.find((e) => e && e.scope === 'user');
      if (user) return user.version || null;
      if (!best) best = list[0];
    }
    return best?.version || null;
  } catch {
    return null;
  }
}

// Numeric per-component semver compare (major.minor.patch only — this plugin
// never ships prerelease/build suffixes). Returns null when either string
// does not parse, so callers can treat "can't tell" the same as "no news":
// stay silent rather than guess with a string comparison that would call
// "0.9.0" newer than "0.13.2".
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_FILE = 'version-notice-shown.json';

// { "<session_id>": { shown: ["0.13.2>0.14.0", ...], at: <ms> } }
// `at` is the last time this session got a NEW pair notified, and is what
// pruning keys off — a session that stops existing (ended, or the operator
// moved on) has its record dropped a week later so the file cannot grow
// without bound across the life of a machine.
function loadState() {
  const file = stateFile(STATE_FILE);
  const st = readJson(file, {});
  const now = Date.now();
  const pruned = {};
  for (const [sid, rec] of Object.entries(st)) {
    if (rec && typeof rec.at === 'number' && now - rec.at <= WEEK_MS) pruned[sid] = rec;
  }
  return { file, state: pruned };
}

try {
  const p = readStdin();
  if (!opt('version_notice', true)) passthrough();

  const running = runningPlugin();
  if (!running) passthrough(); // no answer for "what am I running": stay silent

  const installed = installedVersion(running.name);
  if (!installed) passthrough(); // no installed_plugins.json, or no entry: stay silent

  const cmp = compareSemver(running.version, installed);
  if (cmp === null || cmp >= 0) passthrough(); // unparseable, equal, or running is NEWER: silent

  const sessionId = String(p.session_id || 'unknown');
  const pairKey = `${running.version}>${installed}`;
  const { file, state } = loadState();

  const prevShown = new Set(state[sessionId]?.shown || []);
  if (prevShown.has(pairKey)) {
    writeJson(file, state); // still persist the prune even when this call is a no-op
    passthrough();
  }

  prevShown.add(pairKey);
  state[sessionId] = { shown: [...prevShown], at: Date.now() };
  writeJson(file, state);

  process.stdout.write(JSON.stringify({
    systemMessage: `${running.name}: this session is running ${running.version} but ${installed} `
      + 'is installed — type /reload-plugins to load it (its sub-agents pick it up too).',
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
