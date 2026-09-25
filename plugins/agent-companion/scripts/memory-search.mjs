#!/usr/bin/env node
// Memory search — index and rank the operator's memory corpus with BM25.
//
// Two independent scopes, searched together by default:
//   user — every *.md under ~/.claude/projects/*/memory/ (recursing into
//          archive/, etc — see hooks/lib/memory-index.mjs). This is the
//          operator's auto memory, and it lives on THIS machine only — a
//          cloud session has no such directory at all.
//   repo — the checked-out repository itself, resolved by walking up from
//          --cwd (or process.cwd()) to the nearest .git. This is the ONLY
//          scope a cloud session has, and it covers content this plugin
//          does not otherwise put in context: agent definitions (which load
//          only when that agent runs), skills (which contribute only their
//          description until invoked), nested CLAUDE.md (lazy-loaded), and
//          docs/ (not loaded at all).
//
// At ~435 user-corpus files / ~1.5MB total, and a repo scope capped at 8MB
// by default, exhaustive BM25 scoring runs comfortably inside a script
// invocation; there is no case here for an ANN index or embeddings, and this
// plugin ships zero dependencies, so BM25 is the correct answer rather than
// a compromise.
//
// Each scope's index is cached as its own JSON file in the plugin data dir
// (the repo one keyed by a hash of the repo root, so several checked-out
// repos or worktrees never share a cache) and rebuilt whenever any source
// file is newer than the cache, the file set changed, or (repo scope only)
// the glob/size config changed — see needsRebuild()/needsRepoRebuild() in
// the shared engine.
//
// Usage:
//   node memory-search.mjs "<query>"
//   node memory-search.mjs "<query>" --scope repo
//   node memory-search.mjs "<query>" --project <name>
//   node memory-search.mjs "<query>" --limit 5 --json
//   node memory-search.mjs "<query>" --rebuild
//   node memory-search.mjs --stats
//   node memory-search.mjs --stats --cwd /path/to/some/repo

import { dataDir, opt } from '../hooks/lib/context.mjs';
import {
  memoryRoot, loadOrBuildIndex, search, corpusStats, indexCachePath,
  findRepoRoot, loadOrBuildRepoIndex, corpusStatsRepo, repoIndexCachePath, parseRepoGlobs,
  DEFAULT_REPO_GLOBS, DEFAULT_REPO_MAX_FILE_BYTES, DEFAULT_REPO_MAX_TOTAL_BYTES,
  breadcrumb, displayText, getMergeStatus, mergeStatusLabel, resolveMemoryScopeDir,
} from '../hooks/lib/memory-index.mjs';

// A small hand-rolled parser rather than has()/val(): this is the first
// script in the plugin that mixes a positional argument (the query) with
// value-taking flags, and has()/val() alone can't tell a flag's VALUE from a
// second positional.
function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['--project', '--limit', '--scope', '--cwd']);
  const out = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { out.values[a] = argv[++i]; continue; }
    if (a.startsWith('--')) { out.flags.add(a); continue; }
    out.positional.push(a);
  }
  return out;
}

function snippet(text, max = 150) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const args = parseArgs(process.argv.slice(2));
const jsonOut = args.flags.has('--json');
const forceRebuild = args.flags.has('--rebuild');
const statsOnly = args.flags.has('--stats');
// --here scopes the user-scope pool to THIS session's own project, resolved
// the same way hooks/lib/memory-brief.mjs's nudge/pointers modes do (see
// resolveMemoryScopeDir() in hooks/lib/memory-index.mjs) — an EXACT match
// against the resolved directory, not the fuzzy substring --project does.
// This is the fix made reachable from the CLI: from a worktree cwd,
// --project <name> already worked by luck (a substring match against the
// whole corpus), but there was no way to ask "just my own project" and get
// the MAIN repo's store instead of the empty worktree-encoded one.
const hereFlag = args.flags.has('--here');
const projectFilter = args.values['--project'] || null;
const limit = Math.max(1, Number(args.values['--limit']) || 10);
const query = args.positional[0] || '';
const cwdArg = args.values['--cwd'] || process.cwd();
// Computed unconditionally (cheap — existsSync checks plus, at most, two
// short-timeout git calls) rather than only when --here is passed, so
// --stats can always show which store this cwd resolves to — the exact
// before/after check for the worktree-scope bug this flag exists to fix.
const hereScope = resolveMemoryScopeDir({ cwd: cwdArg, root: memoryRoot() });
if (hereFlag && hereScope.source === 'worktree-unresolved') {
  console.error('memory-search: --here: memory scope unresolved (git unavailable): this worktree\'s own '
    + 'memory could not be located, so --here searches no user memory. Retry, or drop --here.');
}

const scopeArg = (args.values['--scope'] || 'all').toLowerCase();
if (!['user', 'repo', 'all'].includes(scopeArg)) {
  console.error(`memory-search: --scope must be user, repo, or all (got "${scopeArg}")`);
  process.exit(2);
}
const wantUser = scopeArg !== 'repo';
const wantRepo = scopeArg !== 'user';

const root = memoryRoot();
const dataDirPath = dataDir();

// --- User scope --------------------------------------------------------
let userIndex = { chunks: [], files: {}, builtAt: null };
let userRebuilt = false;
if (wantUser) {
  ({ index: userIndex, rebuilt: userRebuilt } = loadOrBuildIndex({
    root, dataDirPath, forceRebuild, rebuildIfStale: true,
  }));
}

// --- Repo scope ----------------------------------------------------------
// Resolution honors the same config keys the spawn-time hook reads via
// opt() — repo scope can be turned off, and its globs/caps are tunable —
// but --cwd lets a caller (or this CLI's own tests) resolve a repo other
// than "wherever this process happens to be running", which matters for a
// hook whose cwd is the payload's cwd, not this script's own.
const repoEnabled = opt('memory_search_repo', true);
const repoGlobs = parseRepoGlobs(opt('memory_search_repo_globs', DEFAULT_REPO_GLOBS.join(',')));
const repoMaxFileBytes = Math.max(1, opt('memory_search_max_file_kb', DEFAULT_REPO_MAX_FILE_BYTES / 1024)) * 1024;
const repoMaxTotalBytes = Math.max(1, opt('memory_search_max_repo_mb', DEFAULT_REPO_MAX_TOTAL_BYTES / (1024 * 1024))) * 1024 * 1024;
const repoFound = repoEnabled ? findRepoRoot(cwdArg) : null;
// Never fetches (see the banner in hooks/lib/memory-index.mjs) — compared
// against the LOCAL copy of origin's refs, i.e. as of the last fetch/clone.
const mergeStatus = repoFound ? getMergeStatus(repoFound.root, dataDirPath) : null;

let repoIndex = null;
let repoRebuilt = false;
if (wantRepo && repoFound) {
  ({ index: repoIndex, rebuilt: repoRebuilt } = loadOrBuildRepoIndex({
    root: repoFound.root,
    dataDirPath,
    globs: repoGlobs,
    maxFileBytes: repoMaxFileBytes,
    maxTotalBytes: repoMaxTotalBytes,
    forceRebuild,
    rebuildIfStale: true,
  }));
}

function scopeLabel(h) {
  const scope = h.chunk.scope || 'user';
  if (scope === 'repo') {
    const label = mergeStatusLabel(mergeStatus);
    const tag = label ? ` [${label}]` : '';
    return { scope, place: `repo${tag} · ${h.chunk.file}` };
  }
  return { scope, place: `${h.chunk.project} · ${h.chunk.file}` };
}

// File count for hereScope.dir, from the already-loaded user index — same
// relKey-prefix counting buildMemoryNudge() uses, so --stats reports the
// exact same number a spawn's nudge line would.
function hereFileCount(index, dir) {
  if (!dir) return 0;
  let n = 0;
  for (const relKey of Object.keys(index?.files || {})) {
    if (relKey.slice(0, relKey.indexOf('/')) === dir) n++;
  }
  return n;
}

if (statsOnly) {
  if (jsonOut) {
    const out = {};
    if (wantUser) {
      out.user = {
        root, cache: indexCachePath(dataDirPath), builtAt: userIndex.builtAt, rebuilt: userRebuilt, ...corpusStats(userIndex),
        here: { ...hereScope, fileCount: hereFileCount(userIndex, hereScope.dir) },
      };
    }
    if (wantRepo) {
      out.repo = repoFound
        ? {
          root: repoFound.root,
          isWorktree: repoFound.isWorktree,
          branch: repoFound.branch,
          defaultRef: mergeStatus?.defaultRef ?? null,
          ahead: mergeStatus?.ahead ?? null,
          unmergedLabel: mergeStatusLabel(mergeStatus) || null,
          cache: repoIndexCachePath(dataDirPath, repoFound.root),
          builtAt: repoIndex.builtAt,
          rebuilt: repoRebuilt,
          ...corpusStatsRepo(repoIndex),
        }
        : { root: null, note: repoEnabled ? 'no repo found (no .git from --cwd upward)' : 'repo scope disabled (memory_search_repo=false)' };
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  console.log('memory-search — two scopes');
  if (wantUser) {
    const s = corpusStats(userIndex);
    console.log(`  user scope — ${root}`);
    console.log(`    projects   : ${s.projects}`);
    console.log(`    files      : ${s.files}`);
    console.log(`    chunks     : ${s.chunks}`);
    console.log(`    source     : ${s.bytes} bytes`);
    console.log(`    index      : ${s.indexBytes} bytes (${indexCachePath(dataDirPath)})`);
    console.log(`    built      : ${userIndex.builtAt}${userRebuilt ? ' (just rebuilt)' : ' (from cache)'}`);
    console.log(`    here       : ${hereScope.dir || '(none)'} — ${hereFileCount(userIndex, hereScope.dir)} file(s) [resolved via ${hereScope.source}]`);
  }
  if (wantRepo) {
    if (!repoFound) {
      console.log(`  repo scope — ${repoEnabled ? 'no repo found upward of ' + cwdArg : 'disabled (memory_search_repo=false)'}`);
    } else {
      const s = corpusStatsRepo(repoIndex);
      console.log(`  repo scope — ${s.root}`);
      console.log(`    worktree   : ${s.isWorktree ? `yes (branch ${s.branch || '?'})` : 'no'}`);
      if (mergeStatus) {
        const label = mergeStatusLabel(mergeStatus) || 'none (up to date)';
        console.log(`    vs default : ${mergeStatus.defaultRef} — ${mergeStatus.ahead} commit(s) ahead — ${label}`);
      } else {
        console.log('    vs default : unknown (detached HEAD, no default ref found, or git error)');
      }
      console.log(`    files      : ${s.files}${s.skippedForSize ? ` (${s.skippedForSize} skipped for size)` : ''}`);
      console.log(`    chunks     : ${s.chunks}`);
      console.log(`    source     : ${s.bytes} bytes${s.truncated ? ' — TRUNCATED by the total-size cap, index is partial' : ''}`);
      console.log(`    index      : ${s.indexBytes} bytes (${repoIndexCachePath(dataDirPath, s.root)})`);
      console.log(`    built      : ${repoIndex.builtAt}${repoRebuilt ? ' (just rebuilt)' : ' (from cache)'}`);
    }
  }
  process.exit(0);
}

if (!query.trim()) {
  console.error('memory-search: need a query — node memory-search.mjs "<query>" [--scope user|repo|all] [--project x] [--here] [--limit n] [--json] [--rebuild] [--stats] [--cwd path]');
  process.exit(2);
}

const pool = [];
if (wantUser) pool.push(...(userIndex.chunks || []));
if (wantRepo && repoIndex) pool.push(...(repoIndex.chunks || []));

// --here narrows the USER-scope half of the pool to an EXACT match against
// resolveMemoryScopeDir()'s answer — see its precedence in
// hooks/lib/memory-index.mjs. Repo-scope chunks are left alone: repo scope
// already resolves to exactly one repo for this cwd (findRepoRoot above),
// so it is already "here" by construction and has no cross-project mixing
// to narrow.
const searchPool = hereFlag
  ? pool.filter((c) => c.scope !== 'user' || c.project === hereScope.dir)
  : pool;

const hits = search(searchPool, query, { limit, projectFilter });

if (jsonOut) {
  console.log(JSON.stringify({
    query, scope: scopeArg, project: projectFilter, here: hereFlag ? hereScope : null, limit, count: hits.length,
    hits: hits.map((h) => {
      const { scope, place } = scopeLabel(h);
      return {
        score: h.score, scope, place, file: h.chunk.file, heading: breadcrumb(h.chunk), snippet: snippet(displayText(h.chunk)),
      };
    }),
  }, null, 2));
  process.exit(0);
}

if (!hits.length) {
  const hereNote = hereFlag ? ` --here=${hereScope.dir || '(none)'}` : '';
  console.log(`memory-search: no matches for "${query}"${projectFilter ? ` in project~="${projectFilter}"` : ''} (scope=${scopeArg}${hereNote})`);
  process.exit(0);
}

for (const h of hits) {
  const heading = breadcrumb(h.chunk);
  const { place } = scopeLabel(h);
  console.log(`${h.score.toFixed(3).padStart(7)}  ${place} · ${heading}`);
  console.log(`        "${snippet(displayText(h.chunk))}"`);
}
