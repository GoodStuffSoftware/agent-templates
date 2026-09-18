// SessionStart + UserPromptSubmit — say when THIS SESSION is running plugins
// older than what is actually installed, for EVERY installed plugin, not just
// this one.
//
// Keeping a plugin current is the harness's job: Claude Code's own plugin
// autoupdater runs at startup whenever its auto-updater switch is on, and the
// built-in commands (`claude plugin marketplace update`, `claude plugin
// update`) cover the case where it is off — the daily local scout runs them.
// This hook does not update anything. It answers one question:
//
//   Was any plugin updated after this session last loaded its plugins?
//
// "Loaded" happens at SessionStart (source startup/resume) and again on
// `/reload-plugins` — which does NOT fire SessionStart, but does write an
// unambiguous `Reloaded: N plugins · ...` record into the session transcript.
// So `loadedAt` for a session is the LATER of: the last real SessionStart, and
// the newest such marker seen in the transcript. Once observed, both are
// persisted per session_id, because the marker scrolls out of a transcript
// that keeps growing, and a persisted fact does not need to stay visible to
// stay true.
//
// A plugin is stale in this session iff its applicable installed_plugins.json
// entry's `lastUpdated` is after `loadedAt`. "Applicable" is the user-scope
// entry, or a project-scope entry whose projectPath covers this session's cwd
// when one exists (project shadows user, same as the harness's own load
// order). Nothing else — no snapshots, no version diffing.
//
// One thing timestamps alone cannot catch: on desktop, a session can load
// from an app-extracted per-session bundle rather than the installed cache
// copy, and that bundle can already be behind AT STARTUP — loadedAt is "now"
// at that point, so no installed_plugins.json entry will ever look newer than
// it. The running-vs-installed VERSION check (self-check, via import.meta.url
// so it can't be fooled by cache-path assumptions) is the only thing that
// catches that case, so it stays, merged into the same stale set so the two
// mechanisms never produce two notices.
//
// Shown once per session per distinct (plugin, lastUpdated) pair, so an
// operator who does not act on the first notice is not nagged on every
// prompt, but a second update landing while they are still stale notifies
// again.
//
// Channel: systemMessage only, no hookSpecificOutput.additionalContext — shown
// to the user, never added to the model's context, zero tokens. Matches the
// official hooks documentation: "For UserPromptSubmit hooks, use
// hookSpecificOutput.additionalContext instead [of systemMessage] to inject
// text into Claude's context" (Claude Code hooks guide) — systemMessage alone
// surfaces to the user only, on every hook event, including both events this
// file is registered for.
//
// Zero side effects, zero tokens on a quiet day. Fails open on every error.

import {
  readFileSync, openSync, fstatSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  readStdin, opt, passthrough, stateFile, readJson, writeJson,
} from './lib/context.mjs';

// Overridable only for tests (the plugin's verification suite needs to point
// at fixture files without touching the operator's real ~/.claude). Never
// read from anywhere but these env vars + os.homedir().
function homeRoot() {
  return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();
}
function installedPluginsPath() {
  return process.env.AGENT_COMPANION_INSTALLED_PLUGINS_OVERRIDE
    || join(homeRoot(), '.claude', 'plugins', 'installed_plugins.json');
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

function loadInstalledPlugins() {
  try {
    const j = JSON.parse(readFileSync(installedPluginsPath(), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null; // missing or malformed: no answer, stay silent
  }
}

// Windows paths arrive with backslashes and inconsistent case; normalise both
// sides the same way before comparing.
function normalizePath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
function cwdUnder(cwd, projectPath) {
  const a = normalizePath(cwd);
  const b = normalizePath(projectPath);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`);
}

// One effective installed_plugins.json entry per plugin, for THIS session:
// the project-scope entry whose projectPath covers cwd if one exists
// (project shadows user, same as the harness's own load order), else the
// user-scope entry. Entries for other projects are ignored entirely.
function effectiveEntries(installedJson, cwd) {
  const out = new Map();
  const table = installedJson && (installedJson.plugins || installedJson);
  if (!table || typeof table !== 'object') return out;
  for (const key of Object.keys(table)) {
    const baseName = key.split('@')[0];
    const raw = table[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    let userEntry = null;
    let projectEntry = null;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      if (e.scope === 'user') {
        if (!userEntry) userEntry = e;
      } else if (e.projectPath && cwdUnder(cwd, e.projectPath)) {
        // Prefer the most specific (longest) projectPath match.
        if (!projectEntry || String(e.projectPath).length > String(projectEntry.projectPath).length) {
          projectEntry = e;
        }
      }
    }
    const chosen = projectEntry || userEntry;
    if (chosen && chosen.lastUpdated && chosen.version) out.set(baseName, chosen);
  }
  return out;
}

// Numeric per-component semver compare (major.minor.patch only — none of
// these plugins ship prerelease/build suffixes). Returns null when either
// string does not parse, so callers can treat "can't tell" the same as "no
// news": stay silent rather than guess with a string comparison that would
// call "0.9.0" newer than "0.13.2".
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

// Tail-read the transcript for the newest `Reloaded: ` marker written by
// `/reload-plugins`. Only the last TAIL_BYTES are ever read — a positioned
// read, never the whole file — because a transcript can run into the tens of
// MB and this hook has a 5s budget on UserPromptSubmit.
const TAIL_BYTES = 128 * 1024;

function newestReloadTimestamp(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    // A tail read that doesn't start at byte 0 may begin mid-line; drop that
    // fragment rather than risk a false JSON.parse on a truncated record.
    if (start > 0) lines.shift();

    let best = null;
    for (const line of lines) {
      const t = line.trim();
      // Cheap substring pre-filter before paying for JSON.parse on every line.
      if (!t || t[0] !== '{' || !t.includes('"subtype":"local_command"') || !t.includes('Reloaded: ')) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (rec && rec.type === 'system' && rec.subtype === 'local_command'
        && typeof rec.content === 'string' && rec.content.includes('Reloaded: ') && rec.timestamp) {
        const ms = Date.parse(rec.timestamp);
        if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
      }
    }
    return best;
  } catch {
    return null; // missing/unreadable transcript: no marker, stay silent about it
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_FILE = 'version-notice-state.json';

// { "<session_id>": { loadedAt: <ms|null>, shown: ["name@lastUpdated", ...], at: <ms> } }
// `loadedAt` is this session's best-known "plugins loaded" instant (see the
// header comment). `shown` is every (plugin, lastUpdated) pair already
// notified this session, so a repeat check of an unchanged stale set stays
// silent. `at` is the last time this record was touched at all, and is what
// pruning keys off — a session that stops existing (ended, or the operator
// moved on) has its record dropped a week later so the file cannot grow
// without bound across the life of a machine.
function loadState() {
  const file = stateFile(STATE_FILE);
  const st = readJson(file, {});
  const now = Date.now();
  const pruned = {};
  for (const [sid, r] of Object.entries(st)) {
    if (r && typeof r.at === 'number' && now - r.at <= WEEK_MS) pruned[sid] = r;
  }
  return { file, state: pruned };
}

function buildMessage(prefix, staleList) {
  const shown = staleList.slice(0, 4).map((s) => `${s.name} ${s.version}`).join(', ');
  const extra = staleList.length > 4 ? `, +${staleList.length - 4} more` : '';
  const verb = staleList.length > 1 ? 'were' : 'was';
  return `${prefix}: ${shown}${extra} ${verb} updated after this session loaded its plugins`
    + ' — type /reload-plugins to load them (its sub-agents pick them up too).';
}

try {
  const p = readStdin();
  if (!opt('version_notice', true)) passthrough();

  const sessionId = String(p.session_id || 'unknown');
  const cwd = p.cwd || process.cwd();
  const { file, state } = loadState();
  const rec = state[sessionId] || { loadedAt: null, shown: [] };

  if (p.hook_event_name === 'SessionStart') {
    // Only a real load moves loadedAt. `clear`/`compact` are not plugin
    // reloads and must not reset the baseline.
    if (p.source === 'startup' || p.source === 'resume') rec.loadedAt = Date.now();
  } else if (p.hook_event_name === 'UserPromptSubmit') {
    const marker = newestReloadTimestamp(p.transcript_path);
    if (marker !== null) rec.loadedAt = rec.loadedAt != null ? Math.max(rec.loadedAt, marker) : marker;
  }

  if (rec.loadedAt == null) {
    // No baseline for "what this session loaded" — from either event — and
    // none stored from before. Record now and say nothing: guessing stale
    // without a baseline is exactly the false positive this hook must avoid.
    rec.loadedAt = Date.now();
    rec.at = Date.now();
    state[sessionId] = rec;
    writeJson(file, state);
    passthrough();
  }

  const running = runningPlugin();
  const entries = effectiveEntries(loadInstalledPlugins(), cwd);

  const staleMap = new Map(); // baseName -> entry
  for (const [name, entry] of entries) {
    if (Date.parse(entry.lastUpdated) > rec.loadedAt) staleMap.set(name, entry);
  }
  // Self-check: merges into the SAME map, so a stale self-bundle plus a stale
  // other plugin still produce exactly one notice.
  if (running) {
    const entry = entries.get(running.name);
    if (entry) {
      const cmp = compareSemver(running.version, entry.version);
      if (cmp !== null && cmp < 0) staleMap.set(running.name, entry);
    }
  }

  const shownSet = new Set(rec.shown || []);
  const staleList = [...staleMap.entries()]
    .map(([name, entry]) => ({ name, version: entry.version, key: `${name}@${entry.lastUpdated}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasNew = staleList.some((s) => !shownSet.has(s.key));

  if (staleList.length === 0 || !hasNew) {
    rec.at = Date.now();
    state[sessionId] = rec;
    writeJson(file, state); // still persist the prune / loadedAt even on a no-op
    passthrough();
  }

  for (const s of staleList) shownSet.add(s.key);
  rec.shown = [...shownSet];
  rec.at = Date.now();
  state[sessionId] = rec;
  writeJson(file, state);

  process.stdout.write(JSON.stringify({
    systemMessage: buildMessage(running ? running.name : 'agent-companion', staleList),
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
