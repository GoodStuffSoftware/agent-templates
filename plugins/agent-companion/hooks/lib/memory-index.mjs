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
  readFileSync, readdirSync, statSync, existsSync, writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

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
      chunks.push({ project: f.project, file: f.fileRel, heading: c.heading, text: c.text });
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
