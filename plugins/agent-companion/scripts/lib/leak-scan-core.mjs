// leak-scan-core.mjs — the GENERIC leak-detection engine, owned by the
// (public, project-agnostic) agent-companion plugin.
//
// This mirrors classes 2/3/4 of agent-templates' own scripts/leak-check.mjs
// (derived names, private absolute paths, machine-structure warnings) plus
// the scanning/file-enumeration machinery — DELIBERATELY a separate,
// independently-maintained copy, not a shared import. scripts/leak-check.mjs
// promises "zero dependencies, copy this one file anywhere and it just
// runs" — that portability is load-bearing (the publication-leak sweep
// exercises it directly by copying just that file into a throwaway repo;
// see leak-sweep-canary.mjs), so it cannot import back into this plugin
// without breaking the moment it's copied elsewhere. See that file's own
// header for the cross-reference. Keep the generic classes in sync by hand.
//
// Used directly by the plugin's publication-leak sweep to scan a
// THIRD-PARTY repo that has no leak-check of its own — with NO literal-token
// list at all by default (a public plugin ships no one's real names), plus
// an optional private token file the operator may point at (never inside
// the scanned repo — see publication-sweep.mjs).
//
// Deliberately NOT here: class 1 (a fixed hex-decoded literal list) — that
// is inherently repo-specific private data, not a generic capability.
//
// Zero dependencies beyond Node builtins.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve, basename, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

// --- Class 3: private absolute paths ----------------------------------------
export const PLACEHOLDER_USERS = new Set([
  'you', 'your', 'yourname', 'your-name', 'your_name', 'yourusername', 'your-user',
  'user', 'username', 'user-name', 'user_name', 'users', 'me', 'name', 'someone',
  'somebody', 'example', 'alice', 'bob', 'carol', 'jdoe', 'john', 'jane', 'janedoe',
  'johndoe', 'dev', 'developer', 'runner', 'public', 'default', 'all', 'shared',
  'admin', 'administrator', 'guest', 'operator', 'maintainer', 'x', 'xxx', 'foo',
  'bar', 'me2', 'home', 'ubuntu', 'vscode', 'node', 'root', 'codespace', 'codespaces',
  'linuxbrew', 'runneradmin', '...', '…',
]);
export const PLACEHOLDER_PROJECTS = new Set([
  'acme', 'acme-app', 'acme-web', 'acme-api', 'my-project', 'myproject', 'my-app',
  'myapp', 'project', 'projects', 'your-project', 'yourproject', 'repo', 'my-repo',
  'your-repo', 'example', 'example-project', 'foo', 'bar', 'baz', 'app', 'demo',
  'sample', 'x', 'xyz', 'project-name', 'projectname', 'name', 'other-project',
  'some-project', '...', '…', '*',
]);

export function isPlaceholderSegment(seg, set) {
  if (!seg) return true;
  const s = seg.replace(/^["'`(]+|["'`),.;:]+$/g, '');
  if (!s) return true;
  if (/^[<{%$[*]/.test(s)) return true;
  return set.has(s.toLowerCase());
}

const SEP = String.raw`(?:\\\\|\\|/)`;
const SEG = String.raw`([<{%$\[]?[A-Za-z0-9._\-…]+[>}%\]]?)`;
export const PATH_PATTERNS = [
  ['private-path:windows-profile',
    new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:${SEP}Users${SEP}${SEG}`, 'gi'), 1, PLACEHOLDER_USERS],
  ['private-path:posix-home',
    new RegExp(String.raw`(?<![A-Za-z0-9._\-~:])/home/${SEG}`, 'g'), 1, PLACEHOLDER_USERS],
  ['private-path:macos-home',
    new RegExp(String.raw`(?<![A-Za-z0-9._\-~:])/Users/${SEG}`, 'g'), 1, PLACEHOLDER_USERS],
  ['private-path:dev-project',
    new RegExp(String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)${SEP}(?:dev|code|src|projects|repos|work|git)${SEP}${SEG}`, 'gi'), 1, PLACEHOLDER_PROJECTS],
  ['private-path:encoded-claude-project',
    new RegExp(String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]--Users-|(?<![A-Za-z0-9])-(?:home|Users)-)([A-Za-z0-9_.]+)`, 'g'), 1, PLACEHOLDER_USERS],
];

// --- Class 4: machine-structure WARNINGS (never fail) -----------------------
export const WARN_PATTERNS = [
  ['machine-structure:count',
    /\b([1-9]\d+)\+?\s+(?:local\s+|active\s+|live\s+|git\s+|open\s+)?(worktrees?|projects|repos|repositories|directories|dirs|checkouts|clones|sessions)\b/gi],
];

// A bare git SHA: a standalone hex run 7-40 chars long.
export const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
export function isShaFalsePositive(match) {
  if (/^[0-9]+$/.test(match)) return true;
  if (/^[a-f]+$/i.test(match) && match.length < 12) return true;
  return false;
}

// --- Class 2: derived tokens --------------------------------------------------
export const GENERIC_WORDS = new Set(`
a an and the for of to in on at by my our your new old next main master
dev devel development test tests testing tmp temp scratch spike poc sandbox
playground src source lib libs bin build dist out node modules vendor scripts
script docs doc notes misc stuff work workspace workspaces code repo repos
project projects example examples sample samples demo demos backup backups
archive archives copy fork forks clone mirror preview review reviews release
releases staging stage prod production beta alpha canary hotfix fix fixes
feature features branch merge final gate integration e2e ci cd ui ux cli api
app apps web site www server client service services data db config configs
tool tools util utils helper helpers common core shared local remote public
private home user users agent agents plugin plugins template templates skill
skills hook hooks memory claude git github gitlab image images voice audio video
isolation best report reports export exports import stats log logs cache
contrib product products page pages mobile desktop android ios windows linux
mac downloads documents pictures music videos appdata onedrive icloud dropbox
`.split(/\s+/).filter(Boolean));

export const TEMP_SEGMENTS = new Set(['tmp', 'temp', 'scratch', 'bak', 'backup', 'old', 'trash']);

export function segmentsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

export function cleanName(raw) {
  return raw.replace(/^[._]+/, '').trim();
}

export function isUsableName(name, ownSegments) {
  const segs = segmentsOf(name);
  if (segs.length === 0) return false;
  const letters = segs.join('');
  if (letters.length < 4) return false;
  if (/^[0-9a-f-]+$/i.test(name) && /\d/.test(name)) return false;
  if (/^\d/.test(letters) && /^\d+$/.test(letters)) return false;
  if (segs.some((s) => TEMP_SEGMENTS.has(s))) return false;
  if (segs.every((s) => GENERIC_WORDS.has(s) || /^\d+$/.test(s))) return false;
  if (segs.length === 1 && ownSegments.has(segs[0])) return false;
  if (ownSegments.has(`=${segs.join('')}`)) return false;
  return true;
}

export function isUsablePrefix(p, ownSegments) {
  const s = p.toLowerCase();
  if (!/^[a-z][a-z0-9]{1,15}$/.test(s)) return false;
  if (GENERIC_WORDS.has(s) || TEMP_SEGMENTS.has(s) || ownSegments.has(s)) return false;
  return true;
}

export function isUsableUser(u) {
  const s = (u || '').toLowerCase();
  if (s.length < 3) return false;
  if (PLACEHOLDER_USERS.has(s) || GENERIC_WORDS.has(s)) return false;
  return /^[a-z0-9._-]+$/.test(s);
}

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}

export function decodeProjectDir(entry, devBaseNames = ['dev']) {
  let s = entry.replace(/--claude-worktrees-.*$/i, '').replace(/--claude$/i, '');
  const m = /(?:^|-)(?:home|users)-([^-]+)(?:-(.*))?$/i.exec(s);
  if (!m) return { user: null, project: null };
  const user = m[1];
  let rest = m[2] || '';
  if (!rest || rest.startsWith('-')) return { user, project: null };
  if (/^(appdata|temp|tmp|library|onedrive)(-|$)/i.test(rest)) return { user, project: null };
  const bases = [...new Set([...devBaseNames, 'dev', 'code', 'src', 'projects', 'repos'].map((b) => b.toLowerCase()))];
  for (const b of bases) {
    if (rest.toLowerCase() === b) return { user, project: null };
    if (rest.toLowerCase().startsWith(`${b}-`)) { rest = rest.slice(b.length + 1); break; }
  }
  return { user, project: rest || null };
}

export function deriveTokens({
  devRoots = [], claudeProjectsDir = null, tokenFile = null, users = [], ownNames = [], scanRoot = null,
} = {}) {
  const notes = [];
  const ownSegments = new Set(ownNames.flatMap((n) => [...segmentsOf(n), `=${segmentsOf(n).join('')}`]));
  const ownLower = new Set(ownNames.map((n) => n.toLowerCase()));
  const rawNames = new Map();
  const prefixCounts = new Map();
  const counts = { devRootDirs: 0, claudeProjects: 0, agentPrefixes: 0, clusterTokens: 0, tokenFile: 0, users: 0 };
  const usersOut = new Set();
  const explicit = new Set();

  const addName = (raw) => {
    const n = cleanName(raw);
    if (!n || ownLower.has(n.toLowerCase())) return false;
    if (!rawNames.has(n.toLowerCase())) rawNames.set(n.toLowerCase(), n);
    return true;
  };

  const liveRoots = [];
  for (const root of devRoots) {
    const ents = safeReaddir(root);
    if (!ents) continue;
    liveRoots.push(root);
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (addName(e.name)) counts.devRootDirs++;
      const agentsDir = join(root, e.name, '.claude', 'agents');
      const agents = safeReaddir(agentsDir);
      if (!agents) continue;
      const local = new Map();
      for (const a of agents) {
        if (!a.isFile() || !/\.md$/i.test(a.name)) continue;
        const m = /^([A-Za-z][A-Za-z0-9]*)-/.exec(a.name);
        if (m) local.set(m[1].toLowerCase(), (local.get(m[1].toLowerCase()) || 0) + 1);
      }
      for (const [p, c] of local) if (c >= 2) prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1);
    }
  }
  if (devRoots.length && liveRoots.length === 0) {
    notes.push('no dev root found on this machine; project names are not derived from directories');
  }

  if (claudeProjectsDir) {
    const ents = safeReaddir(claudeProjectsDir);
    if (!ents) {
      notes.push('no ~/.claude/projects directory found; its encoded project names are not derived');
    } else {
      const devBaseNames = liveRoots.map((r) => basename(r));
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const { user, project } = decodeProjectDir(e.name, devBaseNames);
        if (user && isUsableUser(user)) usersOut.add(user.toLowerCase());
        if (project && addName(project)) counts.claudeProjects++;
      }
    }
  }

  if (tokenFile) {
    const abs = resolve(tokenFile);
    if (scanRoot && !relative(resolve(scanRoot), abs).startsWith('..') && !isAbsolute(relative(resolve(scanRoot), abs))) {
      throw new Error(`token file ${abs} is inside the scanned tree; keep it outside the repo`);
    }
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch (err) { throw new Error(`cannot read token file ${abs}: ${err.code || err.message}`); }
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, '').trim();
      if (!t) continue;
      const pm = /^prefix:\s*(\S+)$/i.exec(t);
      if (pm) prefixCounts.set(pm[1].toLowerCase(), 99);
      else { rawNames.set(t.toLowerCase(), t); explicit.add(t.toLowerCase()); }
      counts.tokenFile++;
    }
  }

  for (const u of users) if (isUsableUser(u)) usersOut.add(u.toLowerCase());
  counts.users = usersOut.size;

  let names = [...rawNames.values()].filter((n) => explicit.has(n.toLowerCase()) || isUsableName(n, ownSegments));

  const firstSeg = new Map();
  for (const n of rawNames.values()) {
    const segs = segmentsOf(cleanName(n));
    if (segs.length < 2) continue;
    if (!firstSeg.has(segs[0])) firstSeg.set(segs[0], new Set());
    firstSeg.get(segs[0]).add(segs[1]);
  }
  for (const [seg, seconds] of firstSeg) {
    const c = seconds.size;
    if (c < 2 || GENERIC_WORDS.has(seg) || TEMP_SEGMENTS.has(seg) || ownSegments.has(seg) || ownSegments.has(`=${seg}`)) continue;
    if (seg.length >= 5 && isUsableName(seg, ownSegments)) {
      if (!names.some((n) => n.toLowerCase() === seg)) { names.push(seg); counts.clusterTokens++; }
    } else if (isUsablePrefix(seg, ownSegments) && !prefixCounts.has(seg)) {
      prefixCounts.set(seg, 1); counts.clusterTokens++;
    }
  }

  names.sort((a, b) => segmentsOf(a).length - segmentsOf(b).length || a.length - b.length);
  const kept = [];
  for (const n of names) {
    const segs = segmentsOf(n);
    const covered = kept.some((k) => {
      const ks = segmentsOf(k);
      return ks.length <= segs.length && ks.every((s, i) => s === segs[i]);
    });
    if (!covered) kept.push(n);
  }

  for (const n of kept) {
    if (/[-_.\s]/.test(n)) continue;
    const segs = segmentsOf(n);
    if (segs.length < 3 || segs.length > 5) continue;
    const ini = segs.map((s) => s[0]).join('');
    if (isUsablePrefix(ini, ownSegments) && !prefixCounts.has(ini)) prefixCounts.set(ini, 1);
  }

  const prefixes = [...prefixCounts.keys()].filter((p) => prefixCounts.get(p) >= 99 || isUsablePrefix(p, ownSegments));
  counts.agentPrefixes = prefixes.length;
  return { names: kept, prefixes, users: [...usersOut], notes, counts };
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileDerived({ names = [], prefixes = [], users = [] }) {
  const out = [];
  for (const n of names) {
    const segs = segmentsOf(n);
    const allowSpace = !segs.every((s) => GENERIC_WORDS.has(s));
    const sepRe = allowSpace ? '[-_. ]?' : '[-_.]?';
    const body = segs.map(escapeRe).join(sepRe);
    out.push({ label: 'derived-project-name', re: new RegExp(`(?<![A-Za-z0-9\\\\])${body}(?![A-Za-z0-9])`, 'gi') });
  }
  for (const p of prefixes) {
    out.push({ label: 'derived-prefix', re: new RegExp(`(?<![A-Za-z0-9\\\\])${escapeRe(p)}-(?=[A-Za-z0-9*])`, 'gi') });
  }
  for (const u of users) {
    out.push({ label: 'derived-user-handle', re: new RegExp(`(?<![A-Za-z0-9\\\\])${escapeRe(u)}(?![A-Za-z0-9])`, 'gi') });
  }
  return out;
}

export function maskPlaceholders(line) {
  return line.replace(/\{\{[^{}]*\}\}/g, (m) => ' '.repeat(m.length));
}

// Scan one file's text. `literals` is CALLER-SUPPLIED (empty by default here
// — this module ships no one's real names). `exempt` maps a relative path to
// the set of literal LABELS that file is allowed to carry (e.g. a LICENSE's
// own copyright line) — same shape as agent-templates' EXEMPT map.
// A 40-hex-char pinned GitHub Actions SHA (`uses: owner/action@<sha>`) is
// ownership metadata a workflow file is SUPPOSED to carry, not a leak.
// Exempted only when the hex run is immediately preceded by `@` on a line
// whose text up to that point ends a `uses: ...@` step reference.
function isPinnedActionSha(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  if (!before.endsWith('@')) return false;
  return /uses:\s*[^\s@]+@$/.test(before);
}

// `strict`: gates the OPT-IN-ONLY classes — derived project names/prefixes
// and git-sha-like. A repo whose whole purpose is to BE anonymous/generic
// (agent-templates itself) wants those; an ordinary product repo legitimately
// names the operator's own product everywhere and would otherwise drown in
// false positives (measured: ~90% of hits across 8 real swept repos were
// exactly this). Universal regardless of `strict`: private-path (every
// shape), the OS user handle, and the operator's private token file. See
// scanRepo()'s header for how `derived`/`literals` are pre-filtered to match.
export function scanText(text, { rel = '', derived = [], literals = [], exempt = {}, isSelf = false, strict = true } = {}) {
  const hits = [];
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const exemptLabels = exempt[rel];
  lines.forEach((rawLine, i) => {
    const line = maskPlaceholders(rawLine);
    const lower = line.toLowerCase();
    const push = (arr, label, token) => arr.push({ rel, line: i + 1, label, token, text: rawLine.trim() });

    for (const { label, needle } of literals) {
      if (exemptLabels?.has(label)) continue;
      let idx = lower.indexOf(needle);
      while (idx !== -1) { push(hits, label, line.slice(idx, idx + needle.length)); idx = lower.indexOf(needle, idx + needle.length); }
    }

    if (strict && !isSelf) {
      for (const m of line.matchAll(SHA_RE)) {
        if (isShaFalsePositive(m[0])) continue;
        if (isPinnedActionSha(line, m.index)) continue;
        push(hits, 'git-sha-like', m[0]);
      }
    }

    for (const { label, re } of derived) for (const m of line.matchAll(re)) push(hits, label, m[0]);

    for (const [label, re, group, set] of PATH_PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (isPlaceholderSegment(m[group], set)) continue;
        push(hits, label, m[0]);
      }
    }

    for (const [label, re] of WARN_PATTERNS) for (const m of line.matchAll(re)) push(warnings, label, m[0]);
  });
  return { hits, warnings };
}

const IGNORE_DIRS = new Set(['.git', 'node_modules']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|mov)$/i;
// Vendored/minified/generated content: skipped for EVERY class, not just
// git-sha-like. A minified bundle or a lockfile is never going to carry a
// real leak worth reporting, and skipping it entirely (rather than only
// for one class) is the simpler rule and also cuts a large source of
// git-sha-like noise (hashes, integrity strings) at the same time.
const SKIP_PATH_RE = /(^|\/)(vendor|node_modules|dist|build|\.git)\//i;
const SKIP_FILE_RE = /\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;
// Skip anything absurdly large — a generic sweep over an UNKNOWN repo has no
// business reading a multi-hundred-MB file line by line.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
}

export function listCommittableFiles(root) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (resolve(top).toLowerCase() !== resolve(root).toLowerCase()) throw new Error('scan root is not a git top-level');
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter(Boolean).map((rel) => join(root, rel));
  } catch (err) {
    console.error(`leak-scan: note — git enumeration failed (${err.message.split('\n')[0]}); falling back to a raw working-tree walk that does NOT honor .gitignore.`);
    return walk(root);
  }
}

export function mainCheckoutDir(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(resolve(common));
  } catch { return resolve(root); }
}

function safeReaddirPlain(dir) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; } }

export function ownRepoNames(root) {
  const names = new Set([basename(mainCheckoutDir(root))]);
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(url);
    if (m) { names.add(m[1]); names.add(m[2]); }
  } catch { /* no remote */ }
  for (const e of safeReaddirPlain(join(root, 'plugins')) || []) if (e.isDirectory()) names.add(e.name);
  return [...names];
}

// High-level: scan `root` end to end (derive tokens, compile, enumerate
// committable files, scan each). Callers (agent-templates' leak-check.mjs,
// the plugin's own leak-sweep) supply `literals`/`exempt` for anything
// beyond the generic classes here.
//
// `strict` (default true — unchanged behaviour for a direct/CLI caller):
// gates whether devRoot/~/.claude/projects-DERIVED project names/prefixes
// are included, and (via `scanText`) whether git-sha-like runs at all.
// UNIVERSAL regardless of `strict`: private-path (all shapes), the OS user
// handle, and the operator's private token file — those come from a
// SEPARATE deriveTokens() call that never touches devRoots/claudeProjectsDir,
// so a token-file name or the OS handle is still caught even when `strict`
// is false. `scanRepo()`'s caller (the publication-leak sweep) decides
// `strict` per repo: true only for a repo that ships its own
// scripts/leak-check.mjs, carries a `.leak-check-strict` marker file, or is
// explicitly listed — see publication-sweep.mjs.
export function scanRepo({
  root, devRoots: devRootsOpt, claudeProjectsDir: claudeProjectsDirOpt, tokenFile = null,
  users: usersOpt, ownNames: ownNamesOpt, noDerived = false, literals = [], exempt = {},
  strict = true,
}) {
  const resolvedRoot = resolve(root);
  const home = resolve(homedir());
  let derived = [];
  const notes = [];
  let derivedCounts = null;
  if (!noDerived) {
    let devRoots = devRootsOpt;
    if (!devRoots) {
      devRoots = [...new Set([dirname(mainCheckoutDir(resolvedRoot)), join(home, 'dev')].map((p) => resolve(p)))]
        .filter((p) => p.toLowerCase() !== home.toLowerCase());
    }
    const claudeProjectsDir = claudeProjectsDirOpt || join(home, '.claude', 'projects');
    let users = usersOpt;
    if (!users) {
      users = [];
      try { users.push(userInfo().username); } catch { /* no passwd entry */ }
      users.push(basename(home));
    }
    const ownNames = ownNamesOpt || ownRepoNames(resolvedRoot);

    // Universal pass: token-file names/prefixes + OS user handle ONLY —
    // devRoots/claudeProjectsDir deliberately empty here, so nothing derived
    // from "what other projects exist on this machine" leaks into the
    // always-on set.
    const universal = deriveTokens({ devRoots: [], claudeProjectsDir: null, tokenFile, users, ownNames, scanRoot: resolvedRoot });
    notes.push(...universal.notes);
    let names = universal.names;
    let prefixes = universal.prefixes;
    derivedCounts = universal.counts;

    if (strict) {
      const full = deriveTokens({ devRoots, claudeProjectsDir, tokenFile, users, ownNames, scanRoot: resolvedRoot });
      names = [...new Set([...names, ...full.names])];
      prefixes = [...new Set([...prefixes, ...full.prefixes])];
      derivedCounts = full.counts;
      notes.push(...full.notes);
    }
    derived = compileDerived({ names, prefixes, users: universal.users });
  }

  const hits = [];
  const warnings = [];
  for (const file of listCommittableFiles(resolvedRoot)) {
    if (BINARY_EXT.test(file)) continue;
    const relForSkip = relative(resolvedRoot, file).split(sep).join('/');
    if (SKIP_PATH_RE.test(relForSkip) || SKIP_FILE_RE.test(relForSkip)) continue;
    let st;
    try { st = statSync(file); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    const rel = relative(resolvedRoot, file).split(sep).join('/');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // A file literally named .../scripts/leak-check.mjs is, by convention in
    // this ecosystem, a leak-check script that legitimately carries a table
    // of hex-encoded literal tokens (exactly to keep the real strings out of
    // its own source — see agent-templates' scripts/leak-check.mjs). Those
    // hex rows are long hex runs and trip the git-sha-like class otherwise —
    // a false positive on EVERY repo that adopts the same hex-hiding trick
    // this plugin's own sweep is built to encourage. Exempt that one class
    // for that one filename shape, same spirit as the original script's own
    // narrow "isSelf" carve-out, generalised to any repo's own copy.
    const isSelf = /(^|\/)scripts\/leak-check\.mjs$/.test(rel);
    const r = scanText(text, { rel, derived, literals, exempt, isSelf, strict });
    hits.push(...r.hits);
    warnings.push(...r.warnings);
  }
  return { hits, warnings, notes, derivedCounts };
}
