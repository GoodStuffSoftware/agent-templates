// Shared memory-retrieval engine, imported by scripts/memory-search.mjs (the
// CLI) and hooks/lib/memory-brief.mjs (the spawn-time pointer function).
//
// The corpus is every *.md under ~/.claude/projects/*/memory/, recursing into
// subdirectories like archive/. It is STRICTLY READ-ONLY here: this module
// never writes, moves, or renames anything under a memory/ directory. The
// only thing it writes is its own derived index cache, in the plugin data
// dir, which is disposable and rebuilt from source at will.
//
// No embeddings, no dependency, no ANN index. At ~435 files / ~1.5MB this is
// well inside exhaustive-BM25 territory — see the module banner in
// scripts/memory-search.mjs for the "why not incremental" reasoning.

import {
  readFileSync, readdirSync, statSync, lstatSync, existsSync, writeFileSync,
} from 'node:fs';
import {
  join, relative, sep, resolve, dirname,
} from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// --- Corpus location -------------------------------------------------------

// AGENT_COMPANION_MEMORY_ROOT exists so tests can point this at a scratch
// corpus instead of the operator's real ~/.claude/projects.
export function memoryRoot() {
  return process.env.AGENT_COMPANION_MEMORY_ROOT || join(homedir(), '.claude', 'projects');
}

// Walk <root>/<project>/memory/** for *.md files, recursing into
// subdirectories (archive/, etc). Fails open to an empty list — a missing or
// unreadable projects root is "no corpus yet", not a crash.
export function discoverFiles(root) {
  const out = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = entry.name;
    const memDir = join(root, project, 'memory');
    if (!existsSync(memDir)) continue;
    walkMd(memDir, memDir, project, out);
  }
  return out;
}

function walkMd(dir, memRoot, project, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walkMd(full, memRoot, project, out); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    // POSIX-style separators so the cache is stable across OSes and diffable.
    const fileRel = relative(memRoot, full).split(sep).join('/');
    out.push({
      project,
      absPath: full,
      fileRel,                       // path relative to THIS project's memory/ dir
      relKey: `${project}/${fileRel}`, // cache key: relative to the corpus root
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
}

// --- Tokenizer ---------------------------------------------------------

// Tiny built-in stopword list, deliberately short — the brief calls for "no
// stopword list beyond a tiny built-in set", not real linguistic filtering.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'with',
  'as', 'by', 'from', 'not', 'if', 'so', 'do', 'does', 'did', 'has', 'have',
]);

// Lower-case alphanumeric tokens, length >= 2, no stemming.
export function tokenize(text) {
  const matches = String(text).toLowerCase().match(/[a-z0-9]+/g);
  if (!matches) return [];
  return matches.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// --- Chunking ------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```/;
const MAX_CHUNK_CHARS = 2000;

// Split a file's text on ATX headings (# .. ######), carrying a heading-trail
// breadcrumb (e.g. "Setup > Windows notes") for each chunk. A file with no
// headings comes back as a single chunk with an empty trail.
//
// Headings are ignored while inside a fenced code block (``` ... ```) — memory
// files are full of shell/JS snippets, and a `# comment` line inside one is
// not a section heading. Getting this wrong would chunk a code sample into
// garbage on every `#` it contains.
export function chunkFile(text) {
  const lines = String(text).split(/\r?\n/);
  const chunks = [];
  const stack = []; // [{ level, text }], innermost last
  let buf = [];
  let inFence = false;

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ heading: stack.map((s) => s.text).join(' > '), text: body });
    buf = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; buf.push(line); continue; }
    const m = !inFence && line.match(HEADING_RE);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
      continue;
    }
    buf.push(line);
  }
  flush();

  // NOT chunks.flatMap(splitLarge) — flatMap passes (value, index, array) to
  // its callback, and splitLarge's second parameter is `max`; the index would
  // silently override the 2000-char default, hitting 0 on the very first
  // chunk and turning the hard-split loop below into an infinite one.
  return chunks.flatMap((c) => splitLarge(c));
}

// Cap a chunk at ~2000 chars by splitting on paragraph boundaries (blank
// lines), because some memory files are 28KB session dumps and a
// whole-document hit is useless. A single paragraph longer than that on its
// own gets a hard character split as a last resort, so nothing is unbounded.
function splitLarge(chunk, max = MAX_CHUNK_CHARS) {
  if (chunk.text.length <= max) return [chunk];
  const paras = chunk.text.split(/\n{2,}/);
  const pieces = [];
  let buf = '';
  for (const para of paras) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (buf && candidate.length > max) {
      pieces.push(buf);
      buf = para;
    } else {
      buf = candidate;
    }
  }
  if (buf) pieces.push(buf);

  const bounded = [];
  for (const piece of pieces) {
    if (piece.length <= max * 1.5) { bounded.push(piece); continue; }
    for (let i = 0; i < piece.length; i += max) bounded.push(piece.slice(i, i + max));
  }
  return bounded.map((text) => ({ heading: chunk.heading, text }));
}

// --- Index build / cache ---------------------------------------------------

const INDEX_SCHEMA = 1;

export function buildIndex(root) {
  const files = discoverFiles(root);
  const fileMeta = {};
  const chunks = [];
  for (const f of files) {
    fileMeta[f.relKey] = { mtimeMs: f.mtimeMs, size: f.size };
    let text;
    try { text = readFileSync(f.absPath, 'utf8'); } catch { continue; }
    for (const c of chunkFile(text)) {
      if (!c.text) continue;
      // scope: 'user' is additive — existing readers (checks.mjs et al.) only
      // ever read .project/.file/.heading/.text and are unaffected — but it
      // lets a caller combine this with repo-scope chunks into one pool and
      // still tell the two apart on a hit (see the Repo scope section below).
      chunks.push({
        scope: 'user', project: f.project, file: f.fileRel, heading: c.heading, text: c.text,
      });
    }
  }
  return {
    schema: INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    root,
    files: fileMeta,
    chunks,
  };
}

export function indexCachePath(dataDirPath) {
  return join(dataDirPath, 'memory-index.json');
}

export function loadCache(dataDirPath) {
  try {
    return JSON.parse(readFileSync(indexCachePath(dataDirPath), 'utf8'));
  } catch {
    return null;
  }
}

export function saveCache(dataDirPath, index) {
  try { writeFileSync(indexCachePath(dataDirPath), JSON.stringify(index)); } catch { /* fail open */ }
}

// True when the cache is missing, unusable, or the source file set no longer
// matches: any file added, removed, or newer (mtime/size changed).
export function needsRebuild(cache, root) {
  if (!cache || !Array.isArray(cache.chunks) || !cache.files) return true;
  const files = discoverFiles(root);
  const curKeys = new Set(files.map((f) => f.relKey));
  const cacheKeys = Object.keys(cache.files);
  if (cacheKeys.length !== curKeys.size) return true;
  for (const k of cacheKeys) if (!curKeys.has(k)) return true;
  for (const f of files) {
    const prev = cache.files[f.relKey];
    if (!prev || prev.mtimeMs !== f.mtimeMs || prev.size !== f.size) return true;
  }
  return false;
}

// Load the cached index, rebuilding when forced, missing, or (optionally)
// stale. `rebuildIfStale: false` is what the spawn-time hook uses — it must
// never block a spawn on a reindex, so a stale cache is served as-is and only
// a MISSING cache (first run) pays the one-time build cost.
export function loadOrBuildIndex({
  root, dataDirPath, forceRebuild = false, rebuildIfStale = true,
}) {
  const cache = forceRebuild ? null : loadCache(dataDirPath);
  const stale = !cache || needsRebuild(cache, root);
  if (!cache || (stale && rebuildIfStale) || forceRebuild) {
    const built = buildIndex(root);
    saveCache(dataDirPath, built);
    return { index: built, rebuilt: true, stale: false };
  }
  return { index: cache, rebuilt: false, stale };
}

// --- BM25 ranking ------------------------------------------------------

// Scores are computed fresh per call, over whatever `chunks` array is passed
// in (already loaded from cache, so this is pure CPU — no disk I/O). No term
// stats are persisted: at this corpus size re-tokenizing on every search is
// well under the cost of the alternative bookkeeping.
export function search(chunks, query, {
  limit = 10, projectFilter = null, k1 = 1.2, b = 0.75,
} = {}) {
  const pool = projectFilter
    ? chunks.filter((c) => c.project.toLowerCase().includes(String(projectFilter).toLowerCase()))
    : chunks;
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !pool.length) return [];

  const tf = [];
  const lengths = [];
  for (const c of pool) {
    const toks = tokenize(c.text);
    lengths.push(toks.length);
    const m = new Map();
    for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
    tf.push(m);
  }
  const avgLen = lengths.reduce((a, x) => a + x, 0) / (lengths.length || 1);
  const N = pool.length;

  const df = new Map();
  for (const t of qTokens) {
    let n = 0;
    for (const m of tf) if (m.has(t)) n++;
    df.set(t, n);
  }

  const scored = pool.map((chunk, i) => {
    let score = 0;
    for (const t of qTokens) {
      const n = df.get(t) || 0;
      if (!n) continue;
      const f = tf[i].get(t) || 0;
      if (!f) continue;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const denom = f + k1 * (1 - b + (b * (lengths[i] / (avgLen || 1))));
      score += idf * ((f * (k1 + 1)) / denom);
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, limit);
}

export function corpusStats(index) {
  const projects = new Set((index.chunks || []).map((c) => c.project));
  const files = Object.keys(index.files || {}).length;
  const chunks = (index.chunks || []).length;
  const bytes = Object.values(index.files || {}).reduce((a, f) => a + (f.size || 0), 0);
  let indexBytes = 0;
  try { indexBytes = Buffer.byteLength(JSON.stringify(index)); } catch { /* best effort */ }
  return {
    projects: projects.size, files, chunks, bytes, indexBytes,
  };
}

// =========================================================================
// --- Repo scope ------------------------------------------------------------
//
// Everything above indexes the USER-scope corpus: ~/.claude/projects/*/memory,
// which lives on the operator's machine and does not exist in a cloud session.
// This section adds a second, independent scope — the checked-out repository
// itself — so retrieval still has something to find when the user corpus is
// absent, and something MORE to find even when it isn't: agent definitions,
// skills, nested CLAUDE.md, and docs/ are all real content this plugin does
// not otherwise load into context.
//
// The two scopes never share a cache file, a chunk shape quirk, or a code
// path further than calling the same tokenizer/chunker/BM25 above — a hit
// always carries `scope: 'user' | 'repo'` so a reader can tell which one
// found it, and repo paths are always relative to the repo root, never to
// the corpus root the way user-scope `file` values are.

export const DEFAULT_REPO_GLOBS = [
  'CLAUDE.md', 'CLAUDE.local.md', '.claude/**/*.md', 'docs/**/*.md', 'lessons/**/*.md',
];
export const DEFAULT_REPO_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_REPO_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

// Shared by every caller that reads the comma-separated
// memory_search_repo_globs userConfig string (the CLI, the spawn-time hook) —
// one parser, so a blank/whitespace-only config value falls back to the
// default the same way everywhere instead of each caller re-deriving it.
export function parseRepoGlobs(raw) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_REPO_GLOBS;
}

// Directory basenames excluded everywhere in the tree, regardless of glob
// config — these are never hand-authored documentation, and node_modules/
// dist/build alone can dwarf the actual corpus by orders of magnitude.
const HARD_EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);

// "vendor" gets narrower treatment than the other four: it is ALSO a
// perfectly ordinary content-category name (this very repo has
// lessons/vendor/, real lesson files about third-party tooling, not a
// vendored dependency tree), so blanket-excluding it would silently drop real
// content from underneath a glob the operator explicitly pointed at that
// directory (docs/**, lessons/**, .claude/**). It is pruned only during a
// WHOLE-REPO walk (a configured glob with no literal directory prefix at
// all, e.g. a custom "**/*.md") — that is the actual accidental-sweep case
// this exclusion exists to guard against; a glob the operator scoped to a
// specific directory is trusted to mean everything under it.
const SOFT_EXCLUDE_DIR_NAMES = new Set(['vendor']);

function isExcludedRepoDir(relPosix, pruneSoft) {
  if (relPosix === '.claude/worktrees' || relPosix.startsWith('.claude/worktrees/')) return true;
  const segs = relPosix.split('/');
  const base = segs[segs.length - 1];
  if (HARD_EXCLUDE_DIR_NAMES.has(base)) return true;
  return pruneSoft && SOFT_EXCLUDE_DIR_NAMES.has(base);
}

// Minimal glob -> RegExp, just enough for the shapes this feature actually
// uses (`dir/**/*.ext`, a bare filename, `*.ext`). No dependency is worth
// pulling in for four glob shapes in a plugin that ships zero of them.
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i += 1; continue;
    }
    if ('.+^${}()|[]\\'.includes(c)) { re += `\\${c}`; i += 1; continue; }
    re += c; i += 1;
  }
  return new RegExp(`^${re}$`);
}

// The longest wildcard-free prefix of a glob: a directory to start walking
// from (so a `docs/**/*.md` glob only ever touches the docs/ subtree, not the
// whole repo), or — when the WHOLE glob is wildcard-free — a single literal
// file to existence-check directly (`CLAUDE.md`, no walk needed at all).
function globBase(glob) {
  const parts = String(glob).replace(/\\/g, '/').split('/');
  const lit = [];
  for (const p of parts) {
    if (p.includes('*')) break;
    lit.push(p);
  }
  if (lit.length === parts.length) {
    return { dir: lit.slice(0, -1).join('/'), file: lit[lit.length - 1] || null };
  }
  return { dir: lit.join('/'), file: null };
}

function walkRepoDir(absDir, root, out, pruneSoft) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (entry.isDirectory()) {
      if (isExcludedRepoDir(rel, pruneSoft)) continue;
      walkRepoDir(abs, root, out, pruneSoft);
      continue;
    }
    if (entry.isFile()) out.push(rel);
  }
}

// Walk up from `cwd` looking for a `.git` entry — a directory for an ordinary
// checkout, a FILE for a worktree (git's own marker: `gitdir: <path>` pointing
// at `<main-repo>/.git/worktrees/<name>`). Returns null when no repo is found
// at all (there is no ~/.claude/projects analogue to fall back to here — "no
// repo" is a normal, silent empty result, same as "no user corpus").
export function findRepoRoot(cwd) {
  let dir;
  try { dir = resolve(String(cwd || process.cwd())); } catch { return null; }
  for (;;) {
    const gitPath = join(dir, '.git');
    let st = null;
    try { st = lstatSync(gitPath); } catch { /* nothing here, keep climbing */ }
    if (st) return { root: dir, ...worktreeInfo(dir, st) };
    const parent = dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

// Given a directory already known to hold a `.git` entry, say whether it is a
// worktree and, if so, which branch it has checked out. A worktree's own
// `.git` is a file (`gitdir: <path-to-main-repo>/.git/worktrees/<name>`); that
// directory's own HEAD names the branch, distinct from the main checkout's.
function worktreeInfo(dir, gitStat) {
  const st = gitStat || (() => { try { return lstatSync(join(dir, '.git')); } catch { return null; } })();
  if (!st || !st.isFile()) return { isWorktree: false, branch: null };
  try {
    const content = readFileSync(join(dir, '.git'), 'utf8');
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return { isWorktree: true, branch: null };
    const head = readFileSync(join(m[1], 'HEAD'), 'utf8').trim();
    const refM = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return { isWorktree: true, branch: refM ? refM[1] : head };
  } catch {
    return { isWorktree: true, branch: null }; // it IS a worktree; branch just unreadable
  }
}

// Discover repo-scope files under `root` matching `globs`, applying the
// per-file size cap and the total-bytes cap. Deterministic: candidates are
// sorted by relative path before either cap is applied, so which files land
// on the wrong side of the total cap never depends on filesystem walk order.
export function discoverRepoFiles(root, {
  globs = DEFAULT_REPO_GLOBS,
  maxFileBytes = DEFAULT_REPO_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_REPO_MAX_TOTAL_BYTES,
} = {}) {
  const empty = { list: [], skippedForSize: 0, truncated: false, totalBytes: 0 };
  if (!root) return empty;

  const list = Array.isArray(globs) && globs.length ? globs : DEFAULT_REPO_GLOBS;
  const patterns = list.map((g) => ({ re: globToRegExp(g), base: globBase(g) }));

  const rootFiles = new Set();
  const startDirs = new Set();
  for (const p of patterns) {
    if (p.base.file) rootFiles.add(p.base.dir ? `${p.base.dir}/${p.base.file}` : p.base.file);
    else startDirs.add(p.base.dir);
  }

  const relCandidates = [];
  for (const rf of rootFiles) {
    const abs = join(root, ...rf.split('/'));
    try { if (statSync(abs).isFile()) relCandidates.push(rf); } catch { /* not present */ }
  }
  for (const startDir of startDirs) {
    const absStart = startDir ? join(root, ...startDir.split('/')) : root;
    // A bare "" start dir means the glob itself had no literal directory
    // prefix (e.g. a custom "**/*.md") — that is the whole-repo sweep the
    // soft vendor/-exclusion guards against; a glob scoped to a specific
    // directory (docs/**, lessons/**, .claude/**) is trusted in full.
    const pruneSoft = !startDir;
    if (startDir && isExcludedRepoDir(startDir, pruneSoft)) continue;
    walkRepoDir(absStart, root, relCandidates, pruneSoft);
  }

  const seen = new Set();
  const matched = [];
  for (const rel of relCandidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!patterns.some((p) => p.re.test(rel))) continue;
    const abs = join(root, ...rel.split('/'));
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    matched.push({
      relPath: rel, absPath: abs, mtimeMs: st.mtimeMs, size: st.size,
    });
  }
  matched.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  let skippedForSize = 0;
  const sized = [];
  for (const f of matched) {
    if (f.size > maxFileBytes) { skippedForSize++; continue; }
    sized.push(f);
  }

  let totalBytes = 0;
  let truncated = false;
  const kept = [];
  for (const f of sized) {
    if (totalBytes + f.size > maxTotalBytes) { truncated = true; continue; }
    totalBytes += f.size;
    kept.push(f);
  }

  return {
    list: kept, skippedForSize, truncated, totalBytes,
  };
}

export function buildRepoIndex(root, opts = {}) {
  const globs = opts.globs && opts.globs.length ? opts.globs : DEFAULT_REPO_GLOBS;
  const maxFileBytes = opts.maxFileBytes || DEFAULT_REPO_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes || DEFAULT_REPO_MAX_TOTAL_BYTES;
  const disc = discoverRepoFiles(root, { globs, maxFileBytes, maxTotalBytes });
  const info = worktreeInfo(root);

  const fileMeta = {};
  const chunks = [];
  for (const f of disc.list) {
    fileMeta[f.relPath] = { mtimeMs: f.mtimeMs, size: f.size };
    let text;
    try { text = readFileSync(f.absPath, 'utf8'); } catch { continue; }
    for (const c of chunkFile(text)) {
      if (!c.text) continue;
      // scope: 'repo' up front on every chunk — this is the field a caller
      // combining both scopes' chunks into one search pool relies on to know
      // which one it is looking at (see search()'s consumers in
      // scripts/memory-search.mjs and hooks/lib/memory-brief.mjs).
      chunks.push({
        scope: 'repo', project: 'repo', file: f.relPath, heading: c.heading, text: c.text,
      });
    }
  }

  return {
    schema: INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    root,
    isWorktree: info.isWorktree,
    branch: info.branch,
    globs,
    maxFileBytes,
    maxTotalBytes,
    skippedForSize: disc.skippedForSize,
    truncated: disc.truncated,
    files: fileMeta,
    chunks,
  };
}

function emptyRepoIndex() {
  return {
    schema: INDEX_SCHEMA,
    builtAt: null,
    root: null,
    isWorktree: false,
    branch: null,
    globs: [],
    maxFileBytes: 0,
    maxTotalBytes: 0,
    skippedForSize: 0,
    truncated: false,
    files: {},
    chunks: [],
  };
}

// One cache file PER REPO ROOT (hashed into the filename) — a machine with
// several checked-out repos, or several worktrees of the same repo, must
// never have one root's cache served for another's.
export function repoIndexCachePath(dataDirPath, root) {
  const hash = createHash('sha256').update(String(root)).digest('hex').slice(0, 16);
  return join(dataDirPath, `memory-index-repo-${hash}.json`);
}

export function loadRepoCache(dataDirPath, root) {
  try {
    return JSON.parse(readFileSync(repoIndexCachePath(dataDirPath, root), 'utf8'));
  } catch {
    return null;
  }
}

export function saveRepoCache(dataDirPath, root, index) {
  try { writeFileSync(repoIndexCachePath(dataDirPath, root), JSON.stringify(index)); } catch { /* fail open */ }
}

// True when the cache is missing, unusable, built with different config
// (globs/caps changed), or the source file set no longer matches.
export function needsRepoRebuild(cache, root, opts = {}) {
  if (!cache || !Array.isArray(cache.chunks) || !cache.files) return true;
  const globs = opts.globs && opts.globs.length ? opts.globs : DEFAULT_REPO_GLOBS;
  const maxFileBytes = opts.maxFileBytes || DEFAULT_REPO_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes || DEFAULT_REPO_MAX_TOTAL_BYTES;
  if (JSON.stringify(cache.globs || []) !== JSON.stringify(globs)) return true;
  if (cache.maxFileBytes !== maxFileBytes || cache.maxTotalBytes !== maxTotalBytes) return true;

  const disc = discoverRepoFiles(root, { globs, maxFileBytes, maxTotalBytes });
  const curKeys = new Set(disc.list.map((f) => f.relPath));
  const cacheKeys = Object.keys(cache.files);
  if (cacheKeys.length !== curKeys.size) return true;
  for (const k of cacheKeys) if (!curKeys.has(k)) return true;
  for (const f of disc.list) {
    const prev = cache.files[f.relPath];
    if (!prev || prev.mtimeMs !== f.mtimeMs || prev.size !== f.size) return true;
  }
  return false;
}

// Mirrors loadOrBuildIndex above, for the repo scope. `root: null` (no repo
// found) degrades to an empty index rather than throwing or touching the
// filesystem — the cloud/no-repo case is a normal empty result.
export function loadOrBuildRepoIndex({
  root, dataDirPath, globs, maxFileBytes, maxTotalBytes, forceRebuild = false, rebuildIfStale = true,
}) {
  if (!root || !dataDirPath) return { index: emptyRepoIndex(), rebuilt: false, stale: false };
  const opts = {
    globs: globs && globs.length ? globs : DEFAULT_REPO_GLOBS,
    maxFileBytes: maxFileBytes || DEFAULT_REPO_MAX_FILE_BYTES,
    maxTotalBytes: maxTotalBytes || DEFAULT_REPO_MAX_TOTAL_BYTES,
  };
  const cache = forceRebuild ? null : loadRepoCache(dataDirPath, root);
  const stale = !cache || needsRepoRebuild(cache, root, opts);
  if (!cache || (stale && rebuildIfStale) || forceRebuild) {
    const built = buildRepoIndex(root, opts);
    saveRepoCache(dataDirPath, root, built);
    return { index: built, rebuilt: true, stale: false };
  }
  return { index: cache, rebuilt: false, stale };
}

export function corpusStatsRepo(index) {
  const files = Object.keys(index?.files || {}).length;
  const chunks = (index?.chunks || []).length;
  const bytes = Object.values(index?.files || {}).reduce((a, f) => a + (f.size || 0), 0);
  let indexBytes = 0;
  try { indexBytes = Buffer.byteLength(JSON.stringify(index)); } catch { /* best effort */ }
  return {
    root: index?.root || null,
    isWorktree: !!index?.isWorktree,
    branch: index?.branch || null,
    files,
    chunks,
    bytes,
    indexBytes,
    skippedForSize: index?.skippedForSize || 0,
    truncated: !!index?.truncated,
  };
}
