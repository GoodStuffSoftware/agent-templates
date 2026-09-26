#!/usr/bin/env node
// transcript-harvest.mjs — harvest already-summarised material out of session
// transcripts so a model can propose memories from it.
//
// THIS IS NOT A TRANSCRIPT SEARCH TOOL. Full-text search over transcripts
// already exists elsewhere in the operator's toolchain, and duplicating it
// here was explicitly ruled out. What this script does is different and much
// narrower: session transcripts occasionally contain a PRE-DIGESTED summary —
// written by the model itself at compaction time — and this harvests exactly
// those, nothing else.
//
// --- Why this is cheap even though the corpus is not -----------------------
//
// Transcripts live under ~/.claude/projects/<encoded-project>/ as:
//   <sessionId>.jsonl                       — a main session
//   <sessionId>/subagents/<uuid>.jsonl      — that session's subagent runs
//
// On this operator's machine that is ~8GB across ~4500 files, but ~95% of the
// FILES (and the overwhelming majority of the BYTES — tool output, hook
// attachments, opaque signature blocks) are the subagent half. Compaction is
// overwhelmingly a main-thread event — measured on this corpus, the
// top-level *.jsonl files alone carried every compaction summary found — so
// scanning just those finds essentially all of the harvest for a small
// fraction of the I/O (~1.3GB read, under 9s, for 227 files vs. ~8GB / 4500).
// A long-running subagent COULD compact too, so this is a fast default, not
// an absolute guarantee; --include-subagents opts into the expensive full
// scan when completeness matters more than speed.
//
// --- What we're looking for -------------------------------------------------
//
// A `type:"system"` record with `subtype:"compact_boundary"` (carrying
// `compactMetadata`: trigger, pre/post token counts, etc.), immediately
// followed by a synthetic `type:"user"` record whose message is the
// structured recap Claude Code wrote for itself — intent, decisions, files
// touched, pending work. That pairing is 100% consistent on this operator's
// corpus (verified: 80/80 boundaries had the summary as the very next line),
// and the summary record also carries its own `isCompactSummary:true` flag,
// which we check as the authoritative signal — the boundary is used only to
// pull the compaction metadata (trigger, tokens dropped) alongside it, and a
// text-prefix match is kept as a fallback in case a future format drops the
// flag but keeps the wording.
//
// --- What this is NOT --------------------------------------------------------
//
// A summary is a MODEL-WRITTEN RECOLLECTION of an earlier conversation, not a
// primary source — it can be wrong, incomplete, or written by a session that
// misunderstood its own history. This script only proposes a reviewable
// digest; it never writes a memory file, and harvested content should be
// treated as a LEAD TO VERIFY, never a fact to store directly. See the
// skills/memory-search SKILL.md "Harvesting a lead" section for the
// intended next step (verify, then route through the normal memory-writing
// path — never straight from this digest).
//
// Zero dependencies: Node builtins only.
//
// Usage:
//   node transcript-harvest.mjs                      # harvest everything, write a digest
//   node transcript-harvest.mjs --stats               # measure the corpus, write nothing
//   node transcript-harvest.mjs --project <name> --limit 5
//   node transcript-harvest.mjs --since 2026-08-01
//   node transcript-harvest.mjs --out ./digest.md
//   node transcript-harvest.mjs --include-subagents   # also scan the (huge) subagent half

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { dataDir } from '../hooks/lib/context.mjs';
import {
  transcriptsRoot, discoverTranscripts as discoverShared, readRecords, CompactionTracker, flattenContent,
} from './lib/transcripts.mjs';

// --- Corpus location ---------------------------------------------------

// Same root ~/.claude/projects that hooks/lib/memory-index.mjs walks for
// memory/*.md — this script walks the OTHER half of that same tree (the raw
// session JSONL). AGENT_COMPANION_TRANSCRIPTS_ROOT mirrors that module's own
// AGENT_COMPANION_MEMORY_ROOT override, for the same reason: tests need a
// scratch corpus, not the operator's real sessions. The resolver, the walk
// and the compaction pairing all live in scripts/lib/transcripts.mjs.

// --- Arg parsing (mirrors scripts/memory-search.mjs's parser) -----------

function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['--project', '--since', '--limit', '--out']);
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { out.values[a] = argv[++i]; continue; }
    out.flags.add(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const statsOnly = args.flags.has('--stats');
const includeSubagents = args.flags.has('--include-subagents');
const projectFilter = args.values['--project'] || null;
const limit = args.values['--limit'] ? Math.max(1, Number(args.values['--limit']) || Infinity) : Infinity;
const outArg = args.values['--out'] || null;

let sinceMs = -Infinity;
if (args.values['--since']) {
  const parsed = Date.parse(args.values['--since']);
  if (Number.isNaN(parsed)) {
    console.error(`transcript-harvest: --since "${args.values['--since']}" is not a parseable date (use an ISO date like 2026-08-01)`);
    process.exit(2);
  }
  sinceMs = parsed;
}

// --- Discover candidate files --------------------------------------------

// Main-session files sit directly in a project directory; subagent
// transcripts live one level deeper, in <project>/<sessionId>/subagents/*.jsonl
// (the same <sessionId> that names the main .jsonl file's own basename).
// Workflow agents (subagents/workflows/<wf>/) are not scanned.
function discoverTranscripts(root, { withSubagents }) {
  const project = projectFilter
    ? (name) => name.toLowerCase().includes(projectFilter.toLowerCase())
    : null;
  const { files } = discoverShared(root, { main: true, subagents: withSubagents, project, meta: false });
  return files.map((f) => ({ project: f.project, kind: f.kind, path: f.path, mtimeMs: f.mtimeMs }));
}

// --- Compact-summary detection --------------------------------------------
//
// A `type:"system"` compact_boundary record is followed by the synthetic
// summary `type:"user"` record; lib/transcripts.mjs's CompactionTracker does
// the pairing (isCompactSummary:true is authoritative, the opening wording is
// a fallback, and a user record straight after a boundary counts too).

const SUMMARY_CAP_CHARS = 4000; // a sane cap for a REVIEWABLE digest, not a full archive

function capText(text) {
  const s = String(text || '');
  if (s.length <= SUMMARY_CAP_CHARS) return { text: s, truncated: false, originalChars: s.length };
  return { text: `${s.slice(0, SUMMARY_CAP_CHARS)}…`, truncated: true, originalChars: s.length };
}

// --- Scan one file, streaming line-by-line --------------------------------
//
// Never load a whole file into memory — the largest transcript on this
// operator's machine is ~67MB, and the corpus has files that size across
// multiple projects. readline over a stream keeps this at one line at a time
// regardless of file size. Unparseable lines are skipped silently (a
// mid-write truncated last line, a corrupt record) — this is a best-effort
// harvest, not a strict parser.
async function scanFile(file, stats, onSummary) {
  const tracker = new CompactionTracker();
  const fileStats = {};
  try {
    for await (const rec of readRecords(file.path, { stats: fileStats })) {
      const ev = tracker.feed(rec);
      if (!ev || !ev.summary) continue;
      const ts = Date.parse(ev.summary.timestamp || '');
      if (!Number.isNaN(ts) && ts < sinceMs) continue;
      onSummary(ev.summary, ev.boundary, file);
      if (stats.summaries.length >= limit) return;
    }
  } finally {
    stats.bytesRead += fileStats.bytes || 0;
  }
}

// --- Run the harvest --------------------------------------------------

const root = transcriptsRoot();
const allFiles = discoverTranscripts(root, { withSubagents: includeSubagents });

// Pre-filter by file mtime when --since is given (a file that was not
// touched since the cutoff cannot contain anything newer than it), then scan
// most-recently-modified first so --limit yields the most RECENT summaries
// rather than whatever directory order the filesystem happens to return.
const candidates = allFiles
  .filter((f) => sinceMs === -Infinity || f.mtimeMs >= sinceMs || f.mtimeMs === 0)
  .sort((a, z) => z.mtimeMs - a.mtimeMs);

const stats = {
  filesScanned: 0,
  totalCandidates: candidates.length,
  bytesRead: 0,
  summaries: [],
  startedAt: Date.now(),
};

let lastProgressAt = Date.now();
function maybeReportProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 1500) return;
  lastProgressAt = now;
  const mb = (stats.bytesRead / (1024 * 1024)).toFixed(1);
  const secs = ((now - stats.startedAt) / 1000).toFixed(1);
  process.stderr.write(
    `transcript-harvest: scanned ${stats.filesScanned}/${stats.totalCandidates} files, `
    + `${stats.summaries.length} summaries, ${mb} MB read (${secs}s)\n`,
  );
}

function recordSummary(rec, boundary, file) {
  const capped = capText(flattenContent(rec.message.content));
  const meta = boundary?.compactMetadata || {};
  stats.summaries.push({
    project: file.project,
    kind: file.kind,
    sessionId: rec.sessionId || null,
    cwd: rec.cwd || null,
    gitBranch: rec.gitBranch || null,
    timestamp: rec.timestamp || null,
    trigger: meta.trigger || null,
    preTokens: meta.preTokens ?? null,
    postTokens: meta.postTokens ?? null,
    droppedTokens: meta.cumulativeDroppedTokens ?? null,
    text: capped.text,
    truncated: capped.truncated,
    originalChars: capped.originalChars,
  });
}

for (const file of candidates) {
  if (stats.summaries.length >= limit) break;
  await scanFile(file, stats, recordSummary);
  stats.filesScanned++;
  maybeReportProgress();
}
maybeReportProgress(true);

const elapsedMs = Date.now() - stats.startedAt;

// --- --stats: report and exit, write nothing --------------------------

if (statsOnly) {
  console.log('transcript-harvest --stats');
  console.log(`  root              : ${root}`);
  console.log(`  scope             : ${projectFilter ? `project~="${projectFilter}"` : 'all projects'}${includeSubagents ? ' (including subagents)' : ' (main sessions only)'}`);
  console.log(`  since             : ${args.values['--since'] || '(none)'}`);
  console.log(`  transcripts found : ${stats.totalCandidates}`);
  console.log(`  transcripts read  : ${stats.filesScanned}`);
  console.log(`  bytes read        : ${stats.bytesRead} (${(stats.bytesRead / (1024 * 1024)).toFixed(1)} MB)`);
  console.log(`  summaries found   : ${stats.summaries.length}${stats.summaries.length >= limit && limit !== Infinity ? ' (stopped: --limit reached)' : ''}`);
  console.log(`  elapsed           : ${(elapsedMs / 1000).toFixed(2)}s`);
  process.exit(0);
}

// --- Write the digest ---------------------------------------------------

if (stats.summaries.length === 0) {
  console.log(`transcript-harvest: no compaction summaries found (scanned ${stats.filesScanned} transcript(s), ${(elapsedMs / 1000).toFixed(2)}s). Nothing written.`);
  process.exit(0);
}

const outDir = join(dataDir(), 'transcript-harvest');
try { mkdirSync(outDir, { recursive: true }); } catch { /* best effort */ }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultMdPath = join(outDir, `harvest-${stamp}.md`);
const mdPath = outArg ? resolve(outArg) : defaultMdPath;
const jsonPath = outArg ? mdPath.replace(/\.md$/i, '.json') : join(outDir, `harvest-${stamp}.json`);

// Guardrail, not an enforcement: --out is a power-user escape hatch, but the
// one hard rule from the brief is "never into the repo". Best-effort warning
// only — this script has no reliable way to know where "the repo" is when
// invoked standalone, so it checks the one thing it does know: its own
// grandparent (plugins/agent-companion/..) is never a valid --out target.
const repoGuessRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
if (outArg && resolve(mdPath).toLowerCase().startsWith(repoGuessRoot.toLowerCase())) {
  console.error(`transcript-harvest: WARNING — --out resolves inside what looks like the plugin's own repo (${repoGuessRoot}). This digest can contain harvested transcript prose; writing it into a repo risks committing it. Strongly prefer the default location (${defaultMdPath}).`);
}

const scopeLine = `${projectFilter ? `project~="${projectFilter}"` : 'all projects'}`
  + `${includeSubagents ? ', including subagents' : ', main sessions only'}`
  + `${args.values['--since'] ? `, since ${args.values['--since']}` : ''}`;

const header = [
  '# Transcript harvest digest',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Scope: ${scopeLine}`,
  `Transcripts scanned: ${stats.filesScanned} of ${stats.totalCandidates} candidates`,
  `Summaries found: ${stats.summaries.length}${stats.summaries.length >= limit && limit !== Infinity ? ' (--limit reached; more may exist)' : ''}`,
  `Bytes read: ${stats.bytesRead} (${(stats.bytesRead / (1024 * 1024)).toFixed(1)} MB)`,
  `Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`,
  '',
  '**This digest was written by transcript-harvest.mjs. It is a review aid, not a',
  'memory file, and this script never writes to a memory/ directory.** Every',
  'entry below is a MODEL-WRITTEN RECOLLECTION captured at compaction time —',
  'not a primary source. Treat each one as a LEAD TO VERIFY against the real',
  'files, commits, or conversation, never as a fact to store directly. If',
  'something here is worth keeping, verify it first, then propose it through',
  'the normal memory-writing path (see skills/memory-search/SKILL.md and the',
  "operator's own routing rules for what becomes a memory file versus a skill",
  'entry) — do not copy text from this digest straight into a memory file.',
  '',
  '---',
].join('\n');

const entries = stats.summaries.map((s, i) => {
  const tokenNote = s.preTokens != null
    ? ` (tokens: pre=${s.preTokens} post=${s.postTokens} dropped=${s.droppedTokens ?? '?'})`
    : '';
  const lines = [
    `## ${i + 1}. ${s.project} — ${s.sessionId || '(unknown session)'}`,
    '',
    `- project dir: \`${s.project}\``,
    `- session: \`${s.sessionId || '(unknown)'}\``,
    `- cwd: ${s.cwd || '(unknown)'}`,
    `- git branch: ${s.gitBranch || '(none)'}`,
    `- compacted at: ${s.timestamp || '(unknown)'}`,
    `- trigger: ${s.trigger || '(unknown)'}${tokenNote}`,
    '',
    s.text,
  ];
  if (s.truncated) lines.push('', `_[truncated — showing ${SUMMARY_CAP_CHARS} of ${s.originalChars} chars]_`);
  lines.push('', '---');
  return lines.join('\n');
});

writeFileSync(mdPath, [header, ...entries].join('\n\n'), 'utf8');
writeFileSync(jsonPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: scopeLine,
  filesScanned: stats.filesScanned,
  totalCandidates: stats.totalCandidates,
  bytesRead: stats.bytesRead,
  elapsedMs,
  note: 'Review aid only — model-written recollections, not primary sources. Never written as a memory file.',
  summaries: stats.summaries,
}, null, 2), 'utf8');

console.log(`transcript-harvest: wrote ${stats.summaries.length} summar${stats.summaries.length === 1 ? 'y' : 'ies'} from ${stats.filesScanned} transcript(s) (${(elapsedMs / 1000).toFixed(2)}s)`);
console.log(`  digest: ${mdPath}`);
console.log(`  json  : ${jsonPath}`);
console.log('Next: read the digest, verify anything worth keeping, then propose it through the normal memory-writing path (do not copy it in directly).');
