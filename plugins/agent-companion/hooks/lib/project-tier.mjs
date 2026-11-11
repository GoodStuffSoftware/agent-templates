// Project tiers, resolver and loader. A project tier says how much checking a change
// needs before it lands: `push` (Push on your word), `risk` (Risk-tiered), `gates`
// (Full gates). The wording of each tier lives in lib/tier-text.mjs; this file only
// answers "which project is this folder, and which tier did the user give it".
//
// The user's file is <configDir>/project-tiers.json:
//   {"default":"risk","sessionLine":true,"reviewEveryChange":false,
//    "landing":"pr|direct",
//    "projects":{"<repo folder name or full path>":"push|risk|gates"
//                or {"tier":"push|risk|gates","landing":"pr|direct"}}}
// `landing` (optional, top level and per project) says how work lands: `pr` through a pull
// request, `direct` by commit and push to the branch the brief names. Absent: the plugin says
// nothing about landing. A project's own landing wins over the top-level one.
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
import { configDir, homeRoot } from './context.mjs';

export const TIER_IDS = ['push', 'risk', 'gates'];
export const DEFAULT_TIER = 'risk';
export const LANDING_MODES = ['pr', 'direct'];
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

// --- The project from the brief (a spawn whose session folder is not inside a repo) ---
// A lead often starts a session in a folder that HOLDS several repos and hand-made worktrees; the workers then
// work in those. The session folder alone says "no project", so the repo is read from the absolute paths the
// brief names. Bounded: at most MAX_BRIEF_MATCHES path-shaped tokens are looked at, at most MAX_BRIEF_CANDIDATES
// distinct ones are checked on disk, and a token longer than MAX_BRIEF_PATH is skipped unread.
const MAX_BRIEF_CANDIDATES = 40;
const MAX_BRIEF_MATCHES = 4000;
const MAX_BRIEF_PATH = 1000;
const MAX_BRIEF_CHARS = 200000; // only the first 200,000 characters of a brief are scanned for paths
// A path starts at a drive letter (C:/ or C:\), "~/" or a POSIX "/", and not in the middle of a word, a URL
// or a relative path (the character before it is none of the excluded ones). It ends at white space or a quote.
const BRIEF_PATH_RE = /(?<![A-Za-z0-9_.~/\\:-])(?:[A-Za-z]:[\\/]|~[\\/]|\/(?![/\s]))[^\s"'`<>|*?[\]\u0000]*/g;
const PLUGIN_LINE = '[agent-companion:'; // lines the plugin itself added to a brief (a tier clause names plugin paths)

const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

// A brief token -> an absolute, normalised path, or null (not usable). Never touches the disk.
function briefCandidate(raw) {
  if (raw.length > MAX_BRIEF_PATH) return null;
  const tail = /[\s.,;:!?)\]}>'"`*]+$/;
  // trailing punctuation, then a :line[:col], then punctuation again ("a.mjs:12." and "(a.mjs:12)" both work)
  let s = raw.replace(tail, '').replace(/:\d+(?::\d+)?$/, '').replace(tail, '');
  if (s.length < 3) return null;
  if (/^[a-zA-Z]:/.test(s)) {
    if (process.platform !== 'win32') return null; // a drive-letter path means nothing here
    return normalisePath(s);
  }
  if (s.startsWith('~')) s = join(homeRoot(), s.slice(2));
  return normalisePath(s);
}

// The one repo the brief points at, or null. `sessionCwd` is the (non-repo) folder the session works in.
// Candidates: absolute paths in the brief that exist and are not under the Claude config folder; each resolves to its
// repo with repoOf (a worktree is its main repo). A repo located under the session folder (its main checkout or the
// worktree the brief names is under it) beats a repo elsewhere: exactly one distinct repo there is the answer; with
// none there, exactly one distinct repo among all candidates is. Zero or several: null. Never throws.
export function repoFromBrief(brief, sessionCwd) {
  try {
    let text = typeof brief === 'string' ? brief : '';
    if (!text) return null;
    if (text.includes(PLUGIN_LINE)) text = text.split('\n').filter((l) => !l.includes(PLUGIN_LINE)).join('\n');
    if (text.length > MAX_BRIEF_CHARS) text = text.slice(0, MAX_BRIEF_CHARS);
    const excluded = [join(homeRoot(), '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(pathKey);
    const session = sessionCwd ? pathKey(sessionCwd) : null;
    const seen = new Set();
    const repos = new Map(); // main root (lower case) -> { repo (first path named), wt (first linked worktree named), under }
    let matches = 0;
    for (const m of text.matchAll(BRIEF_PATH_RE)) {
      matches += 1;
      if (matches > MAX_BRIEF_MATCHES || seen.size >= MAX_BRIEF_CANDIDATES) break;
      const abs = briefCandidate(m[0]);
      if (!abs) continue;
      const key = abs.toLowerCase();
      if (seen.has(key) || excluded.some((e) => within(key, e))) continue;
      seen.add(key);
      if (!existsSync(abs)) continue;
      const repo = repoOf(abs);
      if (!repo) continue;
      const mk = repo.mainRoot.toLowerCase();
      const under = !!session && (within(mk, session) || within(repo.ownRoot.toLowerCase(), session));
      const prev = repos.get(mk);
      const linked = repo.ownRoot.toLowerCase() !== mk;
      // keep the first path named for a repo, but a linked worktree named anywhere beats the main checkout: the main checkout alongside is the base, the worktree is where the work (and HEAD) is
      repos.set(mk, { repo: prev ? prev.repo : repo, wt: prev?.wt || (linked ? repo : null), under: under || !!prev?.under });
    }
    const all = [...repos.values()];
    const here = all.filter((r) => r.under);
    const pool = here.length ? here : all;
    return pool.length === 1 ? (pool[0].wt || pool[0].repo) : null;
  } catch { /* fail open: no project from the brief */ }
  return null;
}

export function tiersPath() {
  return join(configDir(), 'project-tiers.json');
}

const tierId = (v) => (typeof v === 'string' && TIER_IDS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

const landingId = (v) => (typeof v === 'string' && LANDING_MODES.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

// The parsed, validated config. Never throws.
// { path, exists, default, landing, sessionLine, reviewEveryChange, entries: [{key, tier, landing, isPath}], problems: [string] }
// entry.tier is null for an object entry that gives only a landing mode (the default tier applies).
export function loadTiers() {
  const out = { path: null, exists: false, default: DEFAULT_TIER, landing: null, sessionLine: true, reviewEveryChange: false, entries: [], problems: [] };
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
    if ('landing' in raw) {
      const l = landingId(raw.landing);
      if (l) out.landing = l; else out.problems.push(`"landing" must be one of ${LANDING_MODES.join(', ')} (got ${JSON.stringify(raw.landing)}): ignored (no landing mode)`);
    }
    for (const f of ['sessionLine', 'reviewEveryChange']) {
      if (!(f in raw)) continue;
      if (typeof raw[f] === 'boolean') out[f] = raw[f];
      else out.problems.push(`"${f}" must be true or false (got ${JSON.stringify(raw[f])}): using ${f === 'sessionLine'}`);
    }
    if ('projects' in raw) {
      if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
        out.problems.push('"projects" must be an object of name or path to tier (or {tier, landing}): ignored');
      } else {
        for (const [k, v] of Object.entries(raw.projects)) {
          const key = k.trim();
          if (!key) { out.problems.push('a project with an empty name was ignored'); continue; }
          const isObj = !!v && typeof v === 'object' && !Array.isArray(v);
          const t = tierId(isObj ? v.tier : v);
          let landing = null;
          if (isObj && 'landing' in v) {
            landing = landingId(v.landing);
            if (!landing) out.problems.push(`project "${key}": landing ${String(JSON.stringify(v.landing)).slice(0, 40)} is not one of ${LANDING_MODES.join(', ')}: ignored`);
          }
          if (isObj && !('tier' in v) && landing) out.entries.push({ key, tier: null, landing, isPath: isPathKey(key) });
          else if (!t) out.problems.push(`project "${key}": ${String(JSON.stringify(isObj ? v.tier : v)).slice(0, 40)} is not one of ${TIER_IDS.join(', ')}: ignored (the default applies)`);
          else out.entries.push({ key, tier: t, landing, isPath: isPathKey(key) });
        }
      }
    }
  } catch (e) {
    out.problems.push(`could not be read (${String(e?.message || e).slice(0, 80)}): using the defaults`);
  }
  return out;
}

// The full answer for a folder:
// { project, tier, landing, source: 'assigned'|'default'|'none', by: 'path'|'name'|null, key, projectSource: 'cwd'|'brief'|'none',
//   landingSource: 'assigned'|'default'|'none', landingBy: 'path'|'name'|null, landingKey, mainRoot, ownRoot, config }
// Tier and landing each resolve on their own: the most specific entry that SETS that field wins
// (a path entry, then a name entry), then the top-level default. An entry that sets only a landing
// mode never hides a tier set by another entry, and the reverse. source/by/key describe the tier;
// landingSource/landingBy/landingKey the landing mode ('default' = the top-level mode, 'none' = no mode).
// A path key matches the main repo's root or the worktree's own root (case-insensitive, slashes
// normalised) and wins over a name key. Outside a repo: the default tier, source 'none'.
// projectSource says where the project came from: 'cwd' (the folder is inside a repo), 'brief' (the folder is not, and
// opts.brief names exactly one repo: see repoFromBrief; tier and landing then come from the same lookup a session inside
// that repo gets, and source/by/key keep their meaning) or 'none'. A folder inside a repo never consults the brief.
export function tierDetail(cwd, opts = {}) {
  let cfg;
  try { cfg = loadTiers(); } catch { cfg = { default: DEFAULT_TIER, landing: null, sessionLine: true, reviewEveryChange: false, entries: [], problems: [] }; }
  let repo = repoOf(cwd);
  let projectSource = repo ? 'cwd' : 'none';
  if (!repo && opts && opts.brief) {
    repo = repoFromBrief(opts.brief, cwd);
    if (repo) projectSource = 'brief';
  }
  const base = { project: repo?.name || null, mainRoot: repo?.mainRoot || null, ownRoot: repo?.ownRoot || null, projectSource, config: cfg };
  const topLanding = cfg.landing || null;
  const fallback = { tier: cfg.default, landing: topLanding, source: 'default', by: null, key: null, landingSource: topLanding ? 'default' : 'none', landingBy: null, landingKey: null };
  if (!repo) return { ...base, ...fallback, source: 'none', landingSource: topLanding ? 'default' : 'none' };
  try {
    const roots = new Set([repo.mainRoot.toLowerCase(), repo.ownRoot.toLowerCase()]);
    const pathHits = cfg.entries.filter((e) => e.isPath && roots.has(pathKey(e.key)));
    const nameHits = cfg.entries.filter((e) => !e.isPath && e.key.toLowerCase() === repo.name.toLowerCase());
    // First the path entries, then the name entries; within one kind the last duplicate that sets the field wins, like JSON.
    const find = (field) => {
      for (const [by, hits] of [['path', pathHits], ['name', nameHits]]) {
        for (let i = hits.length - 1; i >= 0; i -= 1) if (hits[i][field]) return { value: hits[i][field], by, key: hits[i].key };
      }
      return null;
    };
    const t = find('tier');
    const l = find('landing');
    return {
      ...base,
      tier: t ? t.value : cfg.default,
      source: t ? 'assigned' : 'default',
      by: t ? t.by : null,
      key: t ? t.key : null,
      landing: l ? l.value : topLanding,
      landingSource: l ? 'assigned' : (topLanding ? 'default' : 'none'),
      landingBy: l ? l.by : null,
      landingKey: l ? l.key : null,
    };
  } catch { /* fall through to the default */ }
  return { ...base, ...fallback };
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
