// Import of legacy pre-durable-state data into the new state root.
//
// Idempotent, incremental, locked, and non-destructive. Every source file is
// read-only to this module — nothing here ever deletes or truncates a legacy
// file, so an old session still running an old plugin copy can keep appending
// to it and a later sync just picks up the increment.
//
// syncLegacy({ now } = {}) -> { imported: { streamName: countWrittenThisRun }, skipped: reason|null }
//
// Called from hooks/scout-surface.mjs (SessionStart, before it reads
// anything), scripts/detect.mjs and scripts/audit.mjs (at the start of each),
// and the scripts/state-sync.mjs CLI. MUST fail open: any exception is caught
// and reported as `skipped`, never thrown — a SessionStart hook must never
// block or throw because history recovery had a bad day.

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync,
  statSync, copyFileSync, unlinkSync, openSync, fstatSync, readSync, closeSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  dataDirs, stateRoot, stateDir, telemetryDir, stateFile, readJson, writeJson, isFixtureSession,
} from './context.mjs';

const STREAMS = ['spawns.jsonl', 'denials.jsonl', 'subagent-starts.jsonl', 'unknown-agent-types.jsonl'];
const UPLOAD_FILES = ['spawns.jsonl', 'subagent-starts.jsonl', 'unknown-agent-types.jsonl', 'denials.jsonl'];
const STATE_FILES_TO_BACKUP = ['baseline.json', 'scout-latest.json', 'version-notice-state.json', 'model-tiers.json', 'upload-state.json'];
const LOCK_STALE_MS = 60000;

function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

function isCanarySid(sid) {
  return /^canary/i.test(String(sid || ''));
}

// --- lock --------------------------------------------------------------

function tryCreateLock(lockFile, payload) {
  try {
    writeFileSync(lockFile, JSON.stringify(payload), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function acquireLock() {
  const lockFile = join(stateDir(), 'sync.lock');
  const payload = { pid: process.pid, at: Date.now() };
  if (tryCreateLock(lockFile, payload)) return lockFile;

  // Prefer the `at` recorded inside the lock's own JSON content; if that
  // content is corrupt or unreadable, fall back to the lock FILE's mtime for
  // the staleness test. Without this fallback a corrupt lock (unparseable
  // JSON — a torn write, disk corruption, whatever) reads as "always held":
  // JSON.parse failing left `age` permanently at -1 with nothing to ever
  // break the deadlock, so a sync stopped permanently instead of just once.
  let lockAt = null;
  try {
    const info = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (info && typeof info.at === 'number') lockAt = info.at;
  } catch { /* corrupt or unreadable content: fall through to mtime below */ }
  if (lockAt == null) {
    try { lockAt = statSync(lockFile).mtimeMs; } catch { /* lock file gone entirely: treat as takeable below */ }
  }

  // lockAt still null means the lock file itself is gone (raced away by
  // whoever held it) — nothing to be stale about, so it is immediately
  // takeable rather than permanently blocking.
  const age = lockAt == null ? Infinity : Date.now() - lockAt;
  if (age <= LOCK_STALE_MS) return null; // genuinely held, and not stale

  // Stale (or gone): take it over.
  try { unlinkSync(lockFile); } catch { /* another process may already have released it, or it never existed */ }
  return tryCreateLock(lockFile, payload) ? lockFile : null;
}

// --- bounded incremental file scan --------------------------------------

function readHead(fd, size) {
  const len = Math.min(4096, size);
  if (len === 0) return sha1('');
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, 0);
  return sha1(buf);
}

function readRange(fd, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, start);
  return buf;
}

// Reads only the NEW complete lines of `filePath` since the stored cursor,
// updates `cursors[filePath]` in place, and returns those lines (may be []).
// Restarts from 0 when the file shrank below the stored offset or its head
// hash changed (recreated — e.g. by a reinstall). Never reads the whole file
// when there is nothing new: a couple of small bounded reads (head + the
// delta range) at most.
function scanFileIncrement(filePath, cursors) {
  let fd;
  try { fd = openSync(filePath, 'r'); } catch { return []; } // missing: nothing to import
  try {
    const size = fstatSync(fd).size;
    const head = readHead(fd, size);
    const prev = cursors[filePath] || { offset: 0, size: 0, head: '' };
    let offset = prev.offset;
    if (size < offset || (prev.head && head !== prev.head)) offset = 0;
    if (size === offset) {
      cursors[filePath] = { offset, size, head };
      return [];
    }
    const buf = readRange(fd, offset, size);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) {
      // No complete line landed yet; leave the offset where it was.
      cursors[filePath] = { offset, size, head };
      return [];
    }
    const complete = text.slice(0, lastNl);
    const newOffset = offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
    cursors[filePath] = { offset: newOffset, size, head };
    return complete.split('\n').filter((l) => l.trim() !== '');
  } finally {
    closeSync(fd);
  }
}

// --- source discovery ----------------------------------------------------

function legacySources() {
  const dirs = new Set(dataDirs()); // already rooted at pluginDataRoot()
  const envDir = process.env.CLAUDE_PLUGIN_DATA;
  if (envDir) dirs.add(envDir);
  return [...dirs];
}

function backupLegacyDirs(sources, stamp) {
  const backupRoot = join(stateRoot(), 'migration', `backup-${stamp}`);
  let any = false;
  for (const dir of sources) {
    const name = basename(dir);
    for (const f of [...STREAMS, ...STATE_FILES_TO_BACKUP]) {
      const src = join(dir, f);
      if (!existsSync(src)) continue;
      try {
        const destDir = join(backupRoot, name);
        mkdirSync(destDir, { recursive: true });
        copyFileSync(src, join(destDir, f));
        any = true;
      } catch { /* unreadable/unwritable: skip, never block the import on a backup failure */ }
    }
  }
  return any ? backupRoot : null;
}

// --- per-stream parse (merge across sources, sort by `at`) ---------------

function parseStream(streamName, sources, cursors) {
  const candidates = [];
  let order = 0;
  for (const dir of sources) {
    const filePath = join(dir, streamName);
    for (const raw of scanFileIncrement(filePath, cursors)) {
      candidates.push({ raw, order: order++ });
    }
  }
  const parsed = [];
  for (const c of candidates) {
    let row;
    try { row = JSON.parse(c.raw); } catch { continue; } // torn/malformed line: skip
    parsed.push({ raw: c.raw, row, order: c.order });
  }
  // Rows without `at` go last, in source order. Ties broken by encounter order.
  parsed.sort((a, b) => {
    const ta = a.row && a.row.at ? Date.parse(a.row.at) : NaN;
    const tb = b.row && b.row.at ? Date.parse(b.row.at) : NaN;
    const va = Number.isNaN(ta) ? null : ta;
    const vb = Number.isNaN(tb) ? null : tb;
    if (va == null && vb == null) return a.order - b.order;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb || a.order - b.order;
  });
  return parsed;
}

// --- apply: line-hash dedup for spawns/denials/subagent-starts -----------

function applyLineDedupStream(streamName, parsed, counts) {
  const destPath = join(telemetryDir(), streamName);
  const fixturesPath = join(telemetryDir(), 'fixtures.jsonl');

  const seen = new Set();
  if (parsed.length) {
    let existingText = '';
    try { existingText = readFileSync(destPath, 'utf8'); } catch { /* none yet */ }
    for (const l of existingText.split('\n')) {
      const t = l.trim();
      if (t) seen.add(sha1(t));
    }
  }

  let written = 0;
  let dupes = 0;
  let fixtures = 0;
  const toWrite = [];
  const toFixtures = [];
  for (const { raw, row } of parsed) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const sid = row.session_id;
    if (isCanarySid(sid)) continue; // canary rows are never imported anywhere
    if (isFixtureSession(sid)) {
      toFixtures.push(JSON.stringify({ ...row, stream: streamName }));
      fixtures++;
      continue;
    }
    const key = sha1(trimmed);
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    toWrite.push(trimmed);
    written++;
  }
  if (toWrite.length) appendFileSync(destPath, `${toWrite.join('\n')}\n`);
  if (toFixtures.length) appendFileSync(fixturesPath, `${toFixtures.join('\n')}\n`);
  counts[streamName] = { read: parsed.length, written, dupes, fixtures };
}

// --- apply: agent_type dedup (keep earliest) for unknown-agent-types -----

function agentTypeMarkerName(t) {
  const safe = String(t).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${sha1(t).slice(0, 8)}.seen`;
}

function applyUnknownAgentTypes(parsed, counts) {
  const streamName = 'unknown-agent-types.jsonl';
  const destPath = join(telemetryDir(), streamName);
  const fixturesPath = join(telemetryDir(), 'fixtures.jsonl');
  const typesDir = join(stateDir(), 'agent-types');
  try { mkdirSync(typesDir, { recursive: true }); } catch { /* fail open */ }

  const seenTypes = new Set();
  if (parsed.length) {
    try {
      for (const l of readFileSync(destPath, 'utf8').split('\n')) {
        const t = l.trim();
        if (!t) continue;
        try { const r = JSON.parse(t); if (r && r.agent_type) seenTypes.add(r.agent_type); } catch { /* skip */ }
      }
    } catch { /* none yet */ }
  }

  let dupes = 0;
  let fixtures = 0;
  const earliestByType = new Map();
  const toFixtures = [];
  for (const { raw, row } of parsed) {
    const trimmed = raw.trim();
    if (!trimmed || !row || !row.agent_type) continue;
    const sid = row.session_id;
    if (isCanarySid(sid)) continue;
    if (isFixtureSession(sid)) {
      toFixtures.push(JSON.stringify({ ...row, stream: streamName }));
      fixtures++;
      continue;
    }
    const t = row.agent_type;
    if (seenTypes.has(t) || earliestByType.has(t)) { dupes++; continue; }
    earliestByType.set(t, row); // parsed is pre-sorted by `at`: first seen == earliest
  }

  let written = 0;
  const toWrite = [];
  for (const [t, row] of earliestByType) {
    toWrite.push(JSON.stringify(row));
    try { writeFileSync(join(typesDir, agentTypeMarkerName(t)), '', { flag: 'wx' }); } catch { /* already marked, or unwritable: fail open */ }
    written++;
  }
  if (toWrite.length) appendFileSync(destPath, `${toWrite.join('\n')}\n`);
  if (toFixtures.length) appendFileSync(fixturesPath, `${toFixtures.join('\n')}\n`);
  counts[streamName] = { read: parsed.length, written, dupes, fixtures };
}

// --- first-import state-file merge ----------------------------------------

function countLines(f) {
  try { return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
}

function importStateFiles(sources) {
  // baseline.json / scout-latest.json: the source with the greatest checkedAt.
  for (const name of ['baseline.json', 'scout-latest.json']) {
    let best = null;
    let bestAt = -Infinity;
    for (const dir of sources) {
      const f = join(dir, name);
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const at = Date.parse(j && j.checkedAt);
        if (!Number.isNaN(at) && at > bestAt) { bestAt = at; best = j; }
      } catch { /* skip unreadable */ }
    }
    if (best) writeJson(stateFile(name), best);
  }

  // version-notice-state.json: merge per-session keys, newest `.at` wins.
  {
    const merged = {};
    for (const dir of sources) {
      const f = join(dir, 'version-notice-state.json');
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        for (const [sid, rec] of Object.entries(j || {})) {
          const prevAt = merged[sid] && merged[sid].at || -Infinity;
          const recAt = (rec && rec.at) || -Infinity;
          if (!merged[sid] || recAt > prevAt) merged[sid] = rec;
        }
      } catch { /* skip */ }
    }
    if (Object.keys(merged).length) writeJson(stateFile('version-notice-state.json'), merged);
  }

  // model-tiers.json (operator override): most-recently-modified source, and
  // ONLY when the destination does not already have one.
  {
    const destFile = stateFile('model-tiers.json');
    if (!existsSync(destFile)) {
      let best = null;
      let bestMtime = -Infinity;
      for (const dir of sources) {
        const f = join(dir, 'model-tiers.json');
        if (!existsSync(f)) continue;
        try {
          const mt = statSync(f).mtimeMs;
          if (mt > bestMtime) { bestMtime = mt; best = f; }
        } catch { /* skip */ }
      }
      if (best) { try { copyFileSync(best, destFile); } catch { /* fail open */ } }
    }
  }

  // upload-state.json: base fields from the most-recently-modified source (if
  // any exists); offsets are then reset to the POST-MERGE line counts, so
  // imported history counts as already sent and an opt-in upload never
  // re-sends it.
  {
    let bestFile = null;
    let bestMtime = -Infinity;
    for (const dir of sources) {
      const f = join(dir, 'upload-state.json');
      if (!existsSync(f)) continue;
      try {
        const mt = statSync(f).mtimeMs;
        if (mt > bestMtime) { bestMtime = mt; bestFile = f; }
      } catch { /* skip */ }
    }
    if (bestFile) {
      let base = {};
      try { base = JSON.parse(readFileSync(bestFile, 'utf8')); } catch { /* start empty */ }
      const offsets = {};
      for (const s of UPLOAD_FILES) offsets[s] = countLines(join(telemetryDir(), s));
      writeJson(stateFile('upload-state.json'), { ...base, offsets });
    }
  }
  // premium-window.json and delegation-streak.json are deliberately NOT
  // imported — they are short-lived rolling windows and start fresh.
}

// --- top level -------------------------------------------------------------

function doSync(now) {
  const migratedFile = stateFile('migrated.json');
  const isFirst = !existsSync(migratedFile);
  const sources = legacySources();
  const cursors = readJson(stateFile('import-cursors.json'), {});

  let backupPath = null;
  if (isFirst) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backupPath = backupLegacyDirs(sources, stamp);
  }

  const counts = {};
  for (const streamName of STREAMS) {
    const parsed = parseStream(streamName, sources, cursors);
    if (streamName === 'unknown-agent-types.jsonl') applyUnknownAgentTypes(parsed, counts);
    else applyLineDedupStream(streamName, parsed, counts);
  }
  writeJson(stateFile('import-cursors.json'), cursors);

  const imported = {};
  for (const s of STREAMS) imported[s] = (counts[s] && counts[s].written) || 0;

  if (isFirst) {
    importStateFiles(sources);
    writeJson(migratedFile, {
      at: now.toISOString(),
      fromDirs: sources,
      rows: counts,
      backup: backupPath,
    });
  }

  return { imported, skipped: null };
}

export function syncLegacy({ now = new Date() } = {}) {
  let lockFile = null;
  try {
    lockFile = acquireLock();
    if (!lockFile) return { imported: {}, skipped: 'locked' };
    return doSync(now);
  } catch (e) {
    return { imported: {}, skipped: `error: ${e && e.message}` };
  } finally {
    if (lockFile) { try { unlinkSync(lockFile); } catch { /* ignore */ } }
  }
}
