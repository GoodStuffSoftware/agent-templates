#!/usr/bin/env node
// Memory search — index and rank the operator's memory corpus with BM25.
//
// The corpus is every *.md under ~/.claude/projects/*/memory/ (recursing into
// archive/, etc — see hooks/lib/memory-index.mjs). At ~435 files / ~1.5MB
// total, exhaustive BM25 scoring runs comfortably inside a script invocation;
// there is no case here for an ANN index or embeddings, and this plugin ships
// zero dependencies, so BM25 is the correct answer rather than a compromise.
//
// The index is cached as JSON in the plugin data dir and rebuilt whenever any
// source file is newer than the cache or the file set changed — see
// needsRebuild() in the shared engine. Rebuilding this corpus is fast, so the
// cache buys convenience, not correctness: simplicity beats incrementality.
//
// Usage:
//   node memory-search.mjs "<query>"
//   node memory-search.mjs "<query>" --project best-sudoku
//   node memory-search.mjs "<query>" --limit 5 --json
//   node memory-search.mjs "<query>" --rebuild
//   node memory-search.mjs --stats

import { dataDir } from '../hooks/lib/context.mjs';
import {
  memoryRoot, loadOrBuildIndex, search, corpusStats,
} from '../hooks/lib/memory-index.mjs';

// A small hand-rolled parser rather than has()/val(): this is the first
// script in the plugin that mixes a positional argument (the query) with
// value-taking flags, and has()/val() alone can't tell a flag's VALUE from a
// second positional.
function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['--project', '--limit']);
  const out = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { out.values[a] = argv[++i]; continue; }
    if (a.startsWith('--')) { out.flags.add(a); continue; }
    out.positional.push(a);
  }
  return out;
}

const indexCacheNote = (d) => `${d}/memory-index.json`;

function snippet(text, max = 150) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const args = parseArgs(process.argv.slice(2));
const jsonOut = args.flags.has('--json');
const forceRebuild = args.flags.has('--rebuild');
const statsOnly = args.flags.has('--stats');
const projectFilter = args.values['--project'] || null;
const limit = Math.max(1, Number(args.values['--limit']) || 10);
const query = args.positional[0] || '';

const root = memoryRoot();
const dataDirPath = dataDir();

const { index, rebuilt } = loadOrBuildIndex({
  root, dataDirPath, forceRebuild, rebuildIfStale: true,
});

if (statsOnly) {
  const s = corpusStats(index);
  if (jsonOut) {
    console.log(JSON.stringify({
      root, cache: indexCacheNote(dataDirPath), builtAt: index.builtAt, rebuilt, ...s,
    }, null, 2));
  } else {
    console.log(`memory-search — ${root}`);
    console.log(`  projects   : ${s.projects}`);
    console.log(`  files      : ${s.files}`);
    console.log(`  chunks     : ${s.chunks}`);
    console.log(`  source     : ${s.bytes} bytes`);
    console.log(`  index      : ${s.indexBytes} bytes (${indexCacheNote(dataDirPath)})`);
    console.log(`  built      : ${index.builtAt}${rebuilt ? ' (just rebuilt)' : ' (from cache)'}`);
  }
  process.exit(0);
}

if (!query.trim()) {
  console.error('memory-search: need a query — node memory-search.mjs "<query>" [--project x] [--limit n] [--json] [--rebuild] [--stats]');
  process.exit(2);
}

const hits = search(index.chunks, query, { limit, projectFilter });

if (jsonOut) {
  console.log(JSON.stringify({
    query, project: projectFilter, limit, rebuilt, count: hits.length,
    hits: hits.map((h) => ({
      score: h.score, project: h.chunk.project, file: h.chunk.file,
      heading: h.chunk.heading, snippet: snippet(h.chunk.text),
    })),
  }, null, 2));
  process.exit(0);
}

if (!hits.length) {
  console.log(`memory-search: no matches for "${query}"${projectFilter ? ` in project~="${projectFilter}"` : ''}`);
  process.exit(0);
}

for (const h of hits) {
  const heading = h.chunk.heading ? h.chunk.heading : '(no heading)';
  console.log(`${h.score.toFixed(3).padStart(7)}  ${h.chunk.project} · ${h.chunk.file} · ${heading}`);
  console.log(`        "${snippet(h.chunk.text)}"`);
}
