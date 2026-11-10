// Project tiers, resolver and loader. A project tier says how much checking a change
// needs before it lands: `push` (Push on your word), `risk` (Risk-tiered), `gates`
// (Full gates). The wording of each tier lives in lib/tier-text.mjs; this file only
// answers "which project is this folder, and which tier did the user give it".
//
// The user's file is <configDir>/project-tiers.json:
//   {"default":"risk","sessionLine":true,"reviewEveryChange":false,
//    "projects":{"<repo folder name or full path>":"push|risk|gates"}}
// It is UNTRUSTED INPUT (hand-edited): a malformed file, an unknown value or a wrong
// shape falls back to the defaults, is listed in `problems`, and never throws.
//
// Naming: "tier" already means a MODEL tier in this plugin, so every field this
// feature emits is called project_tier.
//
// A project is the MAIN repo's folder name, whichever worktree of it the session runs in.
// The resolver is filesystem-only (no git process): a hook runs at every spawn.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDir } from './context.mjs';

export const TIER_IDS = ['push', 'risk', 'gates'];
export const DEFAULT_TIER = 'risk';
const MAX_WALK = 12;

// A path with forward slashes, no trailing slash, resolved against cwd when relative.
// On Windows an MSYS-style `/c/dir` becomes `C:/dir`. Case is kept (display); compare with pathKey().
export function normalisePath(p) {
  let s = String(p ?? '').trim();
  if (process.platform === 'win32') s = s.replace(/^[\\/]([a-zA-Z])(?=[\\/]|$)/, '$1:');
  s = resolve(s).replace(/\\/g, '/');
  if (s.length > 1 && !/^[a-zA-Z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return s;
}
const pathKey = (p) => normalisePath(p).toLowerCase();

// A config key is a path when it has a separator or a drive letter, else a repo folder name.
export function isPathKey(k) {
  const s = String(k ?? '').trim();
  return /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s) || s === '.' || s === '..';
}

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

// The folder name of a repo: `foo.git` (a bare common dir) is `foo`.
const repoName = (dir) => basename(dir).replace(/\.git$/i, '') || null;

// { name, mainRoot, ownRoot } for the repo the folder belongs to, or null outside a repo.
//   mainRoot: the MAIN checkout (or the bare common dir), the same for every worktree.
//   ownRoot: the folder that holds this `.git` (the worktree itself, or the main checkout).
// A worktree's `.git` is a FILE `gitdir: <main>/.git/worktrees/<n>` (absolute, or relative with
// git's worktree.useRelativePaths); that dir's `commondir` file points at `<main>/.git`.
// A submodule's `.git` file has no commondir: it is its own project.
export function repoOf(cwd) {
  try {
    if (!cwd) return null;
    let dir = resolve(String(cwd));
    for (let i = 0; i < MAX_WALK; i += 1) {
      const dotGit = join(dir, '.git');
      if (isDir(dotGit)) return { name: repoName(dir), mainRoot: normalisePath(dir), ownRoot: normalisePath(dir) };
      if (isFile(dotGit)) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
        if (m) {
          const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
          let common = null;
          try {
            const c = readFileSync(join(gitdir, 'commondir'), 'utf8').trim();
            if (c) common = isAbsolute(c) ? c : resolve(gitdir, c);
          } catch { /* no commondir: not a linked worktree */ }
          if (common) {
            // <main>/.git -> the main checkout; a bare dir (foo.git) is itself the repo.
            const main = basename(common) === '.git' ? dirname(common) : common;
            const name = repoName(main);
            if (name) return { name, mainRoot: normalisePath(main), ownRoot: normalisePath(dir) };
          }
        }
        return { name: repoName(dir), mainRoot: normalisePath(dir), ownRoot: normalisePath(dir) };
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fail open: no project */ }
  return null;
}

// The project name for a folder (the main repo's folder name), or null outside a repo.
export function projectOf(cwd) {
  return repoOf(cwd)?.name || null;
}

export function tiersPath() {
  return join(configDir(), 'project-tiers.json');
}

const tierId = (v) => (typeof v === 'string' && TIER_IDS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

// The parsed, validated config. Never throws.
// { path, exists, default, sessionLine, reviewEveryChange, entries: [{key, tier, isPath}], problems: [string] }
export function loadTiers() {
  const out = { path: null, exists: false, default: DEFAULT_TIER, sessionLine: true, reviewEveryChange: false, entries: [], problems: [] };
  try {
    out.path = tiersPath();
    if (!existsSync(out.path)) return out;
    out.exists = true;
    if (!isFile(out.path)) {
      out.problems.push('is not a file (a folder is there instead): using the defaults');
      return out;
    }
    let raw;
    try { raw = JSON.parse(readFileSync(out.path, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
      out.problems.push(`not valid JSON (${String(e.message || e).slice(0, 80)}): using the defaults`);
      return out;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.problems.push('top level is not an object: using the defaults');
      return out;
    }
    if ('default' in raw) {
      const d = tierId(raw.default);
      if (d) out.default = d; else out.problems.push(`"default" must be one of ${TIER_IDS.join(', ')} (got ${JSON.stringify(raw.default)}): using ${DEFAULT_TIER}`);
    }
    for (const f of ['sessionLine', 'reviewEveryChange']) {
      if (!(f in raw)) continue;
      if (typeof raw[f] === 'boolean') out[f] = raw[f];
      else out.problems.push(`"${f}" must be true or false (got ${JSON.stringify(raw[f])}): using ${f === 'sessionLine'}`);
    }
    if ('projects' in raw) {
      if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
        out.problems.push('"projects" must be an object of name or path to tier: ignored');
      } else {
        for (const [k, v] of Object.entries(raw.projects)) {
          const key = k.trim();
          const t = tierId(v);
          if (!key) out.problems.push('a project with an empty name was ignored');
          else if (!t) out.problems.push(`project "${key}": "${String(v).slice(0, 40)}" is not one of ${TIER_IDS.join(', ')}: ignored (the default applies)`);
          else out.entries.push({ key, tier: t, isPath: isPathKey(key) });
        }
      }
    }
  } catch (e) {
    out.problems.push(`could not be read (${String(e?.message || e).slice(0, 80)}): using the defaults`);
  }
  return out;
}

// The full answer for a folder:
// { project, tier, source: 'assigned'|'default'|'none', by: 'path'|'name'|null, key, mainRoot, ownRoot, config }
// A path key matches the main repo's root or the worktree's own root (case-insensitive, slashes
// normalised) and wins over a name key. Outside a repo: the default tier, source 'none'.
export function tierDetail(cwd) {
  let cfg;
  try { cfg = loadTiers(); } catch { cfg = { default: DEFAULT_TIER, sessionLine: true, reviewEveryChange: false, entries: [], problems: [] }; }
  const repo = repoOf(cwd);
  const base = { project: repo?.name || null, mainRoot: repo?.mainRoot || null, ownRoot: repo?.ownRoot || null, config: cfg };
  if (!repo) return { ...base, tier: cfg.default, source: 'none', by: null, key: null };
  try {
    const roots = new Set([repo.mainRoot.toLowerCase(), repo.ownRoot.toLowerCase()]);
    let hit = null;
    for (const e of cfg.entries) {
      if (e.isPath && roots.has(pathKey(e.key))) hit = { ...e, by: 'path' }; // the last duplicate wins, like JSON
    }
    if (!hit) {
      for (const e of cfg.entries) {
        if (!e.isPath && e.key.toLowerCase() === repo.name.toLowerCase()) hit = { ...e, by: 'name' };
      }
    }
    if (hit) return { ...base, tier: hit.tier, source: 'assigned', by: hit.by, key: hit.key };
  } catch { /* fall through to the default */ }
  return { ...base, tier: cfg.default, source: 'default', by: null, key: null };
}

// { project, tier, source } -- source 'assigned' (the user gave this project a tier), 'default'
// (no entry for it) or 'none' (not inside a repo). Never throws.
export function tierFor(cwd) {
  try {
    const d = tierDetail(cwd);
    return { project: d.project, tier: d.tier, source: d.source };
  } catch {
    return { project: null, tier: DEFAULT_TIER, source: 'none' };
  }
}
