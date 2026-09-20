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
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { claudeDir } from './context.mjs';

// --- Corpus location -------------------------------------------------------

// AGENT_COMPANION_MEMORY_ROOT exists so tests can point this at a scratch
// corpus instead of the operator's real ~/.claude/projects. claudeDir()
// itself honours AGENT_COMPANION_HOME_OVERRIDE/CLAUDE_CONFIG_DIR — this used
// to call raw homedir() directly, so a full audit.mjs run (which builds
// ctx.memoryDir unconditionally) read and could print the REAL operator's
// memory files even with the override set.
export function memoryRoot() {
  return process.env.AGENT_COMPANION_MEMORY_ROOT || join(claudeDir(), 'projects');
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

// --- Frontmatter -------------------------------------------------------
//
// Most memory files are frontmatter-led (name/description keys, then prose)
// with no markdown headings at all, so chunkFile() above hands back a single
// chunk with an empty heading trail whose raw text starts with the "---"
// block itself. Parsed ONCE per file here and carried on every chunk from
// that file (fmName/fmDescription/fmFirstLine) — this is DISPLAY-ONLY:
// chunk.text is left exactly as chunkFile produced it, so the frontmatter
// stays fully part of what BM25 matches against (name/description are
// excellent match terms, and part of why ranking is already good). Handles
// both LF and CRLF line endings — files on this machine have both.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text) {
  const s = String(text);
  const m = s.match(FRONTMATTER_RE);
  if (!m) return { name: '', description: '', firstLine: '' };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  let firstLine = '';
  for (const line of s.slice(m[0].length).split(/\r?\n/)) {
    const t = line.trim();
    if (t) { firstLine = t; break; }
  }
  return { name: fm.name || '', description: fm.description || '', firstLine };
}

// --- Breadcrumb / snippet display fallbacks ---------------------------------
//
// A heading trail is the best breadcrumb when one exists. Below that, a
// frontmatter-led file's own `name` (a short slug/title) is far more useful
// than the literal string "(no heading)", which asserts nothing at all.
// `description` is the next-best thing, truncated so a long one-liner
// doesn't blow out a display line. The filename stem is the last resort,
// always available, never empty.
function fileStem(fileRel) {
  const base = String(fileRel).split('/').pop() || String(fileRel);
  return base.replace(/\.[^.]+$/, '');
}

export function breadcrumb(chunk, max = 80) {
  if (chunk.heading) return chunk.heading;
  if (chunk.fmName) return chunk.fmName;
  if (chunk.fmDescription) {
    const d = chunk.fmDescription;
    return d.length > max ? `${d.slice(0, max - 1)}…` : d;
  }
  return fileStem(chunk.file);
}

// A chunk whose raw text STARTS with the frontmatter delimiter is the file's
// first chunk (frontmatter is always at the top) — its raw text opens with
// "---\nname: ...\n---", which is useless as a snippet. Swap in the
// frontmatter description, or the first real prose line when there is no
// description, so the snippet shows content instead of YAML keys.
const FRONTMATTER_START_RE = /^---\r?\n/;

export function displayText(chunk) {
  if (FRONTMATTER_START_RE.test(chunk.text)) {
    if (chunk.fmDescription) return chunk.fmDescription;
    if (chunk.fmFirstLine) return chunk.fmFirstLine;
  }
  return chunk.text;
}

// --- Index build / cache ---------------------------------------------------

// Bump this whenever the SHAPE of a cached chunk or cache record changes —
// a new field, a renamed one, anything a reader downstream now assumes is
// there. Freshness below is judged only against SOURCE files (mtime/size,
// or head/default sha for the merge-status cache); none of that can notice
// that the code which turns a source file into a cached record changed.
// That gap is exactly what shipped in 0.13.1: it added fmName/fmDescription/
// fmFirstLine to every chunk without bumping this constant, so an
// already-built cache kept passing its freshness check and every hit kept
// rendering the pre-frontmatter way (filename breadcrumb, raw "---" YAML
// snippet) until someone ran `--rebuild` by hand. Every loader that reads a
// cache here must compare its stored `schema` against this constant and
// treat a mismatch — including a cache with no `schema` key at all, i.e.
// written by older code than that check — as stale.
const INDEX_SCHEMA = 2;

export function buildIndex(root) {
  const files = discoverFiles(root);
  const fileMeta = {};
  const chunks = [];
  for (const f of files) {
    fileMeta[f.relKey] = { mtimeMs: f.mtimeMs, size: f.size };
    let text;
    try { text = readFileSync(f.absPath, 'utf8'); } catch { continue; }
    let fm = { name: '', description: '', firstLine: '' };
    try { fm = parseFrontmatter(text); } catch { /* fail open: no fm fields */ }
    for (const c of chunkFile(text)) {
      if (!c.text) continue;
      // scope: 'user' is additive — existing readers (checks.mjs et al.) only
      // ever read .project/.file/.heading/.text and are unaffected — but it
      // lets a caller combine this with repo-scope chunks into one pool and
      // still tell the two apart on a hit (see the Repo scope section below).
      chunks.push({
        scope: 'user', project: f.project, file: f.fileRel, heading: c.heading, text: c.text,
        fmName: fm.name, fmDescription: fm.description, fmFirstLine: fm.firstLine,
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

// True when the cache is missing, unusable, built by code with a different
// (or absent — pre-schema-check) chunk/record shape, or the source file set
// no longer matches: any file added, removed, or newer (mtime/size changed).
export function needsRebuild(cache, root) {
  if (!cache || !Array.isArray(cache.chunks) || !cache.files) return true;
  if (cache.schema !== INDEX_SCHEMA) return true;
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

// --- Merge status (ahead-of-default label) ---------------------------------
//
// Whether a repo root's checked-out branch is "ahead of the default branch"
// is a fact about ANY repo root, not just a worktree — an ordinary clone on a
// feature branch is in exactly the same "not yet on the main line" state.
// This is therefore its own check, independent of worktreeInfo() above:
// worktree-ness stays its own --stats field, and this never asserts
// "unmerged" without having actually compared HEAD against a resolved
// default ref.
//
// NEVER fetches — this runs inside a hook on every subagent spawn, and a
// network call there would be both slow and a surprise. Every comparison is
// against the LOCAL copy of `origin`'s refs, i.e. as of whatever the last
// `git fetch` (or clone) happened to leave behind — a label built from this
// is itself "as of last fetch," not "as of right now."

// Run `git <args>` in `cwd`, no shell, with a short timeout so one hung
// invocation can never hang a spawn on this. Any non-zero exit, timeout, or
// missing git is "could not verify" to every caller here — never thrown.
function runGit(cwd, args) {
  try {
    const r = spawnSync('git', args, {
      cwd, timeout: 2000, encoding: 'utf8', windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '').trim();
  } catch {
    return null;
  }
}

// The local copy of the default branch ref — origin/HEAD's symbolic target
// when set (what `git clone` / `git remote set-head -a` leave behind),
// falling back through the common conventions when it is not set or stale.
// Never touches the network (see banner above).
function resolveDefaultRef(root) {
  const sym = runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym) {
    const m = sym.match(/^refs\/remotes\/(.+)$/);
    if (m && runGit(root, ['rev-parse', '--verify', '--quiet', m[1]])) return m[1];
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (runGit(root, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

// One cache file per repo root (hashed, same convention as the index caches
// above) so several checked-out repos or worktrees never share a cache.
export function mergeStatusCachePath(dataDirPath, root) {
  const hash = createHash('sha256').update(String(root)).digest('hex').slice(0, 16);
  return join(dataDirPath, `memory-merge-status-${hash}.json`);
}

// Returns null — "could not verify, say nothing" — on a detached HEAD, no
// resolvable default ref, or any git error. Otherwise
// { branch, defaultRef, ahead }. Cached in the plugin data dir keyed on the
// HEAD sha *and* the default ref's sha, so an unchanged repo (the common case
// across a burst of spawns) never re-runs `rev-list` at all.
export function getMergeStatus(root, dataDirPath) {
  if (!root) return null;
  try {
    const headSha = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!headSha) return null;
    const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) return null; // detached HEAD: no branch name to label

    const defaultRef = resolveDefaultRef(root);
    if (!defaultRef) return null; // no default to compare against: no label
    const defaultSha = runGit(root, ['rev-parse', '--verify', '--quiet', defaultRef]);
    if (!defaultSha) return null;

    const cachePath = dataDirPath ? mergeStatusCachePath(dataDirPath, root) : null;
    if (cachePath) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (cached && cached.schema === INDEX_SCHEMA
          && cached.headSha === headSha && cached.defaultSha === defaultSha
          && cached.defaultRef === defaultRef && cached.branch === branch
          && Number.isFinite(cached.result?.ahead)) {
          return cached.result;
        }
      } catch { /* no usable cache yet */ }
    }

    const aheadStr = runGit(root, ['rev-list', '--count', `${defaultRef}..HEAD`]);
    const ahead = Number(aheadStr);
    if (!Number.isFinite(ahead)) return null;
    const result = { branch, defaultRef, ahead };

    if (cachePath) {
      try {
        writeFileSync(cachePath, JSON.stringify({
          schema: INDEX_SCHEMA, headSha, defaultSha, defaultRef, branch, result,
        }));
      } catch { /* fail open: just skip caching */ }
    }
    return result;
  } catch {
    return null;
  }
}

// "" when there is nothing unmerged to say — 0 commits ahead, or
// getMergeStatus could not verify at all. Silence is correct there; a wrong
// claim is not.
export function mergeStatusLabel(status) {
  if (!status || !status.ahead) return '';
  return `unmerged:${status.branch} (+${status.ahead})`;
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
    let fm = { name: '', description: '', firstLine: '' };
    try { fm = parseFrontmatter(text); } catch { /* fail open: no fm fields */ }
    for (const c of chunkFile(text)) {
      if (!c.text) continue;
      // scope: 'repo' up front on every chunk — this is the field a caller
      // combining both scopes' chunks into one search pool relies on to know
      // which one it is looking at (see search()'s consumers in
      // scripts/memory-search.mjs and hooks/lib/memory-brief.mjs).
      chunks.push({
        scope: 'repo', project: 'repo', file: f.relPath, heading: c.heading, text: c.text,
        fmName: fm.name, fmDescription: fm.description, fmFirstLine: fm.firstLine,
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

// True when the cache is missing, unusable, built by code with a different
// (or absent) chunk/record shape, built with different config (globs/caps
// changed), or the source file set no longer matches.
export function needsRepoRebuild(cache, root, opts = {}) {
  if (!cache || !Array.isArray(cache.chunks) || !cache.files) return true;
  if (cache.schema !== INDEX_SCHEMA) return true;
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

// =========================================================================
// --- Memory scope resolution ("here") --------------------------------------
//
// Which on-disk project directory under `root` (memoryRoot()) is THIS
// session's own memory store — the "N here" the nudge reports, and the
// project a spawn brief's local-project boost prefers. This used to be a
// substring guess against basename(cwd) (projectLeaf(), formerly in
// memory-brief.mjs) — correct only because it happened to assume the
// SESSION TRANSCRIPT naming rule (literal cwd, encoded) also governs auto
// memory. It does not: a git WORKTREE session's transcript is written to the
// worktree-encoded directory, but its auto memory resolves back to the MAIN
// repository's directory — confirmed directly (a worktree session's own
// system prompt names the main repo's memory/ as its store). A
// worktree-encoded store therefore exists on disk, empty, right next to the
// real one, and the old guess found THAT one: "user 0 here" when the real
// answer was double digits.
//
// Precedence, matching what Claude Code documents
// [https://code.claude.com/docs/en/memory.md]:
//   a) an explicit harness/operator signal — CLAUDE_CODE_PROJECT_DIR_NAME
//      (env, v2.1.234+) or `autoMemoryDirectory` from settings.json — used
//      VERBATIM as the directory name, no further encoding: the harness (or
//      the operator, via settings) already named it, so there is nothing
//      left for us to derive.
//   b) cwd is inside a git worktree: resolve to the MAIN working tree
//      (the parent of `git rev-parse --path-format=absolute
//      --git-common-dir`) and encode THAT instead of the worktree's own
//      path. Any offset between cwd and its own checkout root is preserved
//      onto the main tree, so a session launched in a subdirectory of a
//      worktree resolves to the same subdirectory of the main tree, not its
//      bare root. mainWorktreeDir() returns null for an ordinary
//      (non-worktree) checkout — there, the main tree IS the checkout root,
//      so this candidate would just duplicate (c); leaving it out keeps the
//      reported `source` honest instead of claiming "worktree-main" for a
//      session that was never in a worktree at all.
//   c) the literal cwd, encoded — today's only behaviour, kept as the final
//      fallback.
//
// Each candidate is checked against disk and skipped if nothing exists
// there — a resolution that names a directory with nothing behind it must
// fall through to the next one, not report a confident zero. This is the
// fallback the bug fix specifically requires: a resolution that yields an
// empty directory when a populated one is available is the defect, not a
// feature to preserve. The final candidate (c) is always returned even when
// it too does not exist on disk — "nothing here yet" is allowed to be the
// honest final answer, just never one reached by discarding a better
// candidate first.
//
// This is the ONE function every consumer calls to answer that question —
// the nudge, the pointers-mode local-project boost, and
// scripts/memory-search.mjs's --here flag. None of them may re-derive it
// independently; see hooks/spawn-guard.mjs's module banner for why exactly
// one source of truth matters here specifically (the spawn-time hook merges
// several features into a single updatedInput).

// One character class, one pass, no collapsing: every character outside
// [A-Za-z0-9] becomes its own literal "-". Reproduces the harness's own
// project-directory encoding exactly — verified against every directory
// name actually present under this operator's ~/.claude/projects/,
// including WSL-style keys (e.g. a "\\wsl$\Ubuntu\home\<user>\dev\<repo>"
// path encodes to "--wsl--Ubuntu-home-<user>-dev-<repo>", and a bare
// "/home/<user>/dev/<repo>" path to "-home-<user>-dev-<repo>") and worktree
// keys (e.g. "C--Users-<user>-dev-<repo>--claude-worktrees-<branch>"). A
// literal path separator, a drive-letter colon, and the "." before
// ".claude" all fall into the same non-alnum bucket and each becomes its
// own dash — that is why "\.claude\" encodes to "--claude-" (two dashes),
// not "-.claude-": do not "simplify" this to collapse runs of dashes.
export function encodeProjectDir(p) {
  return String(p || '').replace(/[^A-Za-z0-9]/g, '-');
}

// `autoMemoryDirectory` from settings.json, read-only, checked in the same
// precedence Claude Code documents for settings generally: project-local,
// then project-shared, then user. A project checkout's own settings files
// live under cwd's .claude/ — present in a worktree checkout too, since
// settings.json is ordinarily version-controlled — so this never reads
// anywhere outside claudeDir() and cwd itself, and any parse failure just
// tries the next candidate rather than throwing.
function readAutoMemoryDirectorySetting(cwd) {
  const candidates = [];
  if (cwd) {
    candidates.push(join(cwd, '.claude', 'settings.local.json'));
    candidates.push(join(cwd, '.claude', 'settings.json'));
  }
  candidates.push(join(claudeDir(), 'settings.json'));
  for (const file of candidates) {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      const v = s && typeof s.autoMemoryDirectory === 'string' ? s.autoMemoryDirectory.trim() : '';
      if (v) return v;
    } catch { /* unreadable, missing, or malformed: try the next candidate */ }
  }
  return null;
}

// The main working tree for cwd's repo, offset-preserved — null when cwd is
// not inside a git repo, git is unavailable, or cwd's own checkout root
// (--show-toplevel) already IS the main tree (an ordinary, non-worktree
// checkout: nothing for this candidate to add over the literal-cwd
// fallback). Same fail-quiet discipline as runGit() above (short timeout,
// never throws). Uses git's OWN answer for both the shared .git dir and the
// current checkout's toplevel rather than re-deriving either from the .git
// FILE worktreeInfo() reads — git already gets Windows path/casing quirks
// right and there is no reason to duplicate that parsing here.
function mainWorktreeDir(cwd) {
  const commonDir = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return null; // not a git repo, or git unavailable
  const toplevel = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return null; // can't tell whether cwd's checkout IS the main tree already
  const mainRoot = dirname(commonDir);
  const resolvedMainRoot = resolve(mainRoot);
  const resolvedToplevel = resolve(toplevel);
  // Case-insensitive compare for the "is this actually a worktree" check
  // only (Windows paths are case-insensitive) — the path used to BUILD the
  // result below keeps its original casing from git.
  if (resolvedMainRoot.toLowerCase() === resolvedToplevel.toLowerCase()) return null;
  const offset = relative(resolvedToplevel, resolve(cwd));
  return offset ? join(mainRoot, offset) : mainRoot;
}

export function resolveMemoryScopeDir({ cwd, root } = {}) {
  const memRoot = root || memoryRoot();
  const exists = (dir) => {
    if (!dir) return false;
    try { return existsSync(join(memRoot, dir)); } catch { return false; }
  };

  const candidates = [];

  const envName = String(process.env.CLAUDE_CODE_PROJECT_DIR_NAME || '').trim();
  if (envName) candidates.push({ dir: envName, source: 'env:CLAUDE_CODE_PROJECT_DIR_NAME' });

  const settingName = readAutoMemoryDirectorySetting(cwd);
  if (settingName) candidates.push({ dir: settingName, source: 'settings:autoMemoryDirectory' });

  if (cwd) {
    const mainDir = mainWorktreeDir(cwd);
    if (mainDir) candidates.push({ dir: encodeProjectDir(mainDir), source: 'worktree-main' });
  }

  const literal = cwd ? { dir: encodeProjectDir(cwd), source: 'literal' } : { dir: '', source: 'none' };
  candidates.push(literal);

  for (const c of candidates) {
    if (exists(c.dir)) return c;
  }
  // Nothing on disk matched any candidate — return the most literal guess
  // rather than nothing, so a caller always has SOME directory name to
  // report a (possibly genuinely zero) count against.
  return literal;
}
