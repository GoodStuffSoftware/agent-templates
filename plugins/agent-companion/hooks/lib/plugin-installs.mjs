// installed_plugins.json readers shared by the spawn guard (which stamps its
// own install scope into every spawns.jsonl row), the SessionStart ladder
// check, the agent-definition resolver and the daily scout (which compares
// the guard version a spawn ran under against what is installed for that
// same scope).
//
// Pure helpers: every function takes the paths and values it needs as
// arguments, so this module imports nothing from context.mjs and context.mjs
// can import it without a cycle. Nothing here throws; an unreadable or
// malformed file reads as "no installs known", which every caller treats as
// "stay silent".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function installedPluginsFile(claudeDirPath) {
  return join(claudeDirPath, 'plugins', 'installed_plugins.json');
}

export function readInstalledPlugins(claudeDirPath) {
  try {
    const j = JSON.parse(readFileSync(installedPluginsFile(claudeDirPath), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// Windows paths arrive with backslashes and inconsistent case; both sides of
// every comparison are normalised the same way.
export function normalizePath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// True when `child` is `parent` or sits somewhere below it.
export function pathUnder(child, parent) {
  const a = normalizePath(child);
  const b = normalizePath(parent);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`);
}

// Every entry for one plugin base name (the part of the key before "@"),
// across every scope and marketplace. Each entry carries its own `key`.
export function pluginEntries(installedJson, baseName) {
  const out = [];
  const table = installedJson && (installedJson.plugins || installedJson);
  if (!table || typeof table !== 'object' || Array.isArray(table)) return out;
  for (const key of Object.keys(table)) {
    if (key.split('@')[0] !== baseName) continue;
    const raw = table[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const e of list) {
      if (e && typeof e === 'object' && typeof e.version === 'string' && e.version) out.push({ ...e, key });
    }
  }
  return out;
}

// The entry that applies to a session in `cwd`: the most specific project
// (or local) scope entry whose projectPath covers cwd, else the user entry.
// Same load order self-update.mjs documents (project shadows user).
export function effectiveEntry(entries, cwd) {
  let userEntry = null;
  let projectEntry = null;
  for (const e of entries) {
    if (e.scope === 'user' || (!e.scope && !e.projectPath)) {
      if (!userEntry) userEntry = e;
    } else if (e.projectPath && cwd && pathUnder(cwd, e.projectPath)) {
      if (!projectEntry || String(e.projectPath).length > String(projectEntry.projectPath).length) projectEntry = e;
    }
  }
  return projectEntry || userEntry || null;
}

// A stable, privacy-safe label for one install scope. The user scope is just
// "user"; a project or local scope is its scope name plus a short hash of the
// normalised projectPath, so a telemetry row can name its scope without ever
// carrying the path itself.
export function scopeKey(entry) {
  if (!entry) return null;
  const scope = entry.scope || 'user';
  if (scope === 'user' || !entry.projectPath) return scope;
  const h = createHash('sha256').update(normalizePath(entry.projectPath)).digest('hex').slice(0, 12);
  return `${scope}:${h}`;
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1 / 0 / 1, or null when either side is not a version. Directional on
// purpose: callers ask "is A OLDER than B", never "do they differ".
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
export function versionBelow(a, b) {
  return compareVersions(a, b) === -1;
}

// Where a running copy of the plugin lives: "cache" when it is under the
// harness's plugin cache (an installed copy, current or orphaned), else
// "checkout" (a --plugin-dir load or a source tree). Only a cache copy can be
// a stale install; a checkout is the operator's own tree, whatever version.
export function copySource(root, claudeDirPath) {
  return pathUnder(root, join(claudeDirPath, 'plugins', 'cache')) ? 'cache' : 'checkout';
}
