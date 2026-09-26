// SPAWNING RULE 3 (operator-approved 2026-09-23): the model a spawn actually
// ran on — read from its subagent transcript, `"model"` on the last
// `type:"assistant"` record — must match what its definition's alias
// resolves to on the build that session ran. Rules 1 and 2 (missing
// model/effort, calling-session build floor) live at spawn time in
// hooks/spawn-guard.mjs; this one cannot, because the SPAWNED agent's own
// transcript does not exist yet when the spawn is approved. It runs here
// instead, from the audit, against recent history.
//
// Correlation problem: no field anywhere links a spawns.jsonl telemetry row
// (written at PreToolUse, before the new agent exists) to the transcript file
// the harness later writes for it — no agentId is known at spawn time. So
// this matches by NEAREST TIMESTAMP within the same caller session: a
// subagent transcript's own first record is written moments after the
// spawns.jsonl row's `at` (verified against real transcripts while building
// this — every sample was within seconds). A spawn row with no subagent
// transcript inside MATCH_TOLERANCE_MS is left unmatched and never guessed —
// the same "detect, don't pretend" posture every check in this plugin takes.
//
// Bounded on purpose: an unbounded transcript walk over every project this
// machine has touched took over two minutes in practice. Both the file walk
// (mtime floor) and the wall clock (maxMs) are capped, same shape as
// scripts/lib/coverage.mjs's telemetry-coverage check.

import {
  existsSync, openSync, fstatSync, readSync, closeSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  telemetryDir, classifyModel, classifyReferenceModel, modelTiers,
  parseSemver, semverBelow, tailRecords,
} from '../../hooks/lib/context.mjs';
import { discoverTranscripts, transcriptsRoot as sharedTranscriptsRoot } from './transcripts.mjs';

const DEFAULT_HOURS = 48;
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_MAX_MS = 20000;
const MATCH_TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes: generous enough for premium-cap queueing
const HEAD_READ_BYTES = 16 * 1024;

// First record in a transcript that carries both `timestamp` and `version` —
// read from the START (unlike tailRecords, which reads from the end), since
// what is wanted here is "when did this subagent session begin", not its
// latest state. Bounded to HEAD_READ_BYTES: the harness writes both fields on
// effectively the first line, so this never needs to read far.
function headTimestampAndVersion(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return null;
    const len = Math.min(size, HEAD_READ_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.pop(); // last line may be mid-record: drop it
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      const ts = Date.parse(rec.timestamp);
      if (!Number.isNaN(ts) && typeof rec.version === 'string') {
        return { ts, version: rec.version };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// The last `type:"assistant"` record's resolved model id — reused from the
// same tail-read shape lastAssistantMeta() uses for the CALLER's transcript
// in hooks/spawn-guard.mjs, applied here to the SPAWNED agent's own.
function lastAssistantModel(path) {
  const records = tailRecords(path, { filter: (line) => line.includes('"type":"assistant"') });
  if (!records.length) return null;
  const last = records[records.length - 1];
  return (last && last.message && typeof last.message.model === 'string') ? last.message.model : null;
}

// Collect `<session>/subagents/agent-*.jsonl` files under root with mtime at
// or after sinceMs, honouring file/byte caps. Returns { bySession, truncated }
// where bySession maps sessionId (the directory name one level above
// `subagents/`) -> [{ file, mtimeMs }].
//
// Discovery is lib/transcripts.mjs's: ordinary subagent transcripts only.
// Workflow agents (subagents/workflows/<wf>/) are left out — a workflow agent
// is not started by an Agent spawn, so it has no spawns.jsonl row to match.
function collectSubagentFiles(root, sinceMs, maxFiles, maxBytes) {
  const bySession = new Map();
  const { files, truncated } = discoverTranscripts(root, {
    sinceMs, maxFiles, maxBytes, main: false, subagents: true, workflows: false, meta: false, anyDepth: true,
  });
  for (const f of files) {
    if (!bySession.has(f.sessionId)) bySession.set(f.sessionId, []);
    bySession.get(f.sessionId).push({ file: f.path, mtimeMs: f.mtimeMs });
  }
  return { bySession, truncated };
}

function readSpawnRows(sinceMs, nowMs) {
  const f = join(telemetryDir(), 'spawns.jsonl');
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    const ts = Date.parse(row.at);
    if (Number.isNaN(ts) || ts < sinceMs || ts > nowMs) continue;
    out.push({ ...row, atMs: ts });
  }
  return out;
}

// A superseded (non-routable) reference entry whose match ALSO overlaps the
// current routable tier for the same alias — e.g. `claude-opus-5` (the
// "opus-5" reference) vs the current "opus" tier, which also matches it via
// its broader `match: "opus"` regex. That overlap is exactly what makes a
// stale resolution invisible to classifyModel() alone: both generations
// classify as alias "opus". classifyReferenceModel() uses the narrower,
// generation-specific regex to tell them apart.
function supersededGenerationFor(actualModelId, requestedAlias) {
  const ref = classifyReferenceModel(actualModelId);
  if (!ref || ref.routable !== false) return null;
  const cfg = modelTiers();
  const tierSpec = (cfg.tiers || {})[requestedAlias];
  if (!tierSpec) return null;
  try {
    if (new RegExp(tierSpec.match || requestedAlias, 'i').test(actualModelId)) return ref;
  } catch { /* bad regex in an override: skip */ }
  return null;
}

// scanModelMismatches({ hours, now, transcriptsRoot, maxFiles, maxBytes, maxMs })
//   -> { checked, matched, unmatched, mismatches: [...], truncated }
export async function scanModelMismatches({
  hours = DEFAULT_HOURS,
  now = new Date(),
  transcriptsRoot,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxMs = DEFAULT_MAX_MS,
} = {}) {
  const start = Date.now();
  const nowMs = now.getTime();
  const sinceMs = nowMs - hours * 3600000;
  const root = sharedTranscriptsRoot(transcriptsRoot);

  const spawnRows = readSpawnRows(sinceMs, nowMs);
  if (!existsSync(root) || !spawnRows.length) {
    return { checked: 0, matched: 0, unmatched: spawnRows.length, mismatches: [], truncated: false };
  }

  const { bySession, truncated: collectTruncated } = collectSubagentFiles(root, sinceMs - MATCH_TOLERANCE_MS, maxFiles, maxBytes);
  let truncated = collectTruncated;

  // session_id -> spawn rows, sorted by `at` ascending.
  const rowsBySession = new Map();
  for (const row of spawnRows) {
    const sid = row.session_id;
    if (!sid) continue;
    if (!rowsBySession.has(sid)) rowsBySession.set(sid, []);
    rowsBySession.get(sid).push(row);
  }
  for (const rows of rowsBySession.values()) rows.sort((a, b) => a.atMs - b.atMs);

  const floor = (() => {
    try { return modelTiers().aliasResolution?.minClaudeCodeVersion; } catch { return null; }
  })();
  const floorParsed = parseSemver(floor);

  const mismatches = [];
  let matched = 0;
  let checked = 0;

  for (const [sid, rows] of rowsBySession) {
    if (maxMs != null && Date.now() - start > maxMs) { truncated = true; break; }
    const candidates = (bySession.get(sid) || []).slice();
    // Head-read each candidate ONCE, up front, so pair-building below is pure
    // comparison — no repeated file I/O.
    const withHead = candidates
      .map((c) => ({ ...c, head: headTimestampAndVersion(c.file) }))
      .filter((c) => c.head);

    // Matching each ROW to its own individually-nearest candidate, in row
    // order, is what this used to do — and on real data it produces SWAPS:
    // a batch of near-simultaneous spawns in one session (measured: three
    // subagent transcripts starting within 46 seconds of each other) let an
    // earlier row's "good enough" match consume a candidate that was the
    // near-exact (15ms) match for a LATER row, which then fell back to an
    // unrelated transcript six minutes on and reported a false alias
    // mismatch. Sorting every (row, candidate) pair by time delta FIRST and
    // assigning greedily from closest to farthest is the standard fix for
    // this shape of bipartite matching — the near-exact pair above wins
    // before either of its members can be claimed by a weaker match.
    const pairs = [];
    for (const row of rows) {
      const requested = (row.model && row.model !== '(inherited)') ? row.model : row.model_definition;
      if (!requested) continue;
      const requestedClass = classifyModel(requested);
      if (!requestedClass.known) continue; // an unrecognised id: nothing to compare against
      for (const c of withHead) {
        if (c.head.ts < row.atMs || c.head.ts > row.atMs + MATCH_TOLERANCE_MS) continue;
        pairs.push({ row, requested, requestedClass, candidate: c, delta: c.head.ts - row.atMs });
      }
    }
    pairs.sort((a, b) => a.delta - b.delta);

    const usedRows = new Set();
    const usedCandidates = new Set();
    for (const pair of pairs) {
      if (usedRows.has(pair.row) || usedCandidates.has(pair.candidate.file)) continue;
      usedRows.add(pair.row);
      usedCandidates.add(pair.candidate.file);
      checked += 1;

      const { row, requested, requestedClass, candidate: best } = pair;
      const actualModelId = lastAssistantModel(best.file);
      if (!actualModelId) continue;
      matched += 1;

      const actualClass = classifyModel(actualModelId);
      const buildVersion = best.head.version;
      const belowFloor = !!(floorParsed && semverBelow(parseSemver(buildVersion) || [0, 0, 0], floorParsed));

      // 1. Gross mismatch: resolved to a DIFFERENT alias entirely than what
      //    was requested/defined — e.g. sonnet requested, opus ran.
      if (actualClass.alias && actualClass.alias !== requestedClass.alias) {
        mismatches.push({
          kind: 'alias_mismatch',
          session_id: sid,
          requested,
          requestedAlias: requestedClass.alias,
          actual: actualModelId,
          actualAlias: actualClass.alias,
          buildVersion,
          file: best.file,
          at: row.at,
        });
        continue; // don't also report a stale-generation finding on top
      }

      // 2. Stale generation: same alias, but the id that actually ran is a
      //    superseded, non-routable reference entry (the opus-5-vs-5.5 shape
      //    the config's aliasResolution note documents).
      const superseded = supersededGenerationFor(actualModelId, requestedClass.alias);
      if (superseded) {
        mismatches.push({
          kind: 'stale_generation',
          session_id: sid,
          requested,
          requestedAlias: requestedClass.alias,
          actual: actualModelId,
          supersededBy: superseded.displayName || superseded.key,
          buildVersion,
          belowFloor,
          file: best.file,
          at: row.at,
        });
      }
    }
    if (maxMs != null && Date.now() - start > maxMs) { truncated = true; break; }
  }

  return {
    checked,
    matched,
    unmatched: spawnRows.length - matched,
    mismatches,
    truncated,
  };
}
