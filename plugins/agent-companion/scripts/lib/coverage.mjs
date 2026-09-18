// "Enforcement silent" coverage check.
//
// spawns.jsonl is the guard's OWN account of what it saw. It can go quiet for
// reasons that have nothing to do with activity — a renamed hook matcher, an
// exception before the append, a config flag flipped off — and a quiet log
// reads exactly like a quiet day. Transcripts are independent ground truth:
// every real `Agent` tool_use call is written there by the harness itself,
// outside this plugin's control. Comparing the two catches the guard going
// silent while spawns keep happening.

import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { telemetryDir, claudeDir } from '../../hooks/lib/context.mjs';
import { syncLegacy } from '../../hooks/lib/state-sync.mjs';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function utcDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Recursively collect candidate *.jsonl files (including */subagents/) whose
// mtime is at or after `sinceMs`, honouring the file/byte caps. Returns
// { files, truncated }.
function collectTranscriptFiles(root, sinceMs, maxFiles, maxBytes) {
  const files = [];
  let totalBytes = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      if (files.length >= maxFiles || totalBytes + st.size > maxBytes) { truncated = true; continue; }
      files.push(full);
      totalBytes += st.size;
    }
  }
  return { files, truncated };
}

// Stream one transcript file line by line, counting Agent tool_use blocks.
// `seenIds` dedups by tool_use.id ACROSS all files (a line can be re-logged).
// `dayCounts` accumulates per-UTC-day counts for `type:"tool_use"` +
// `name:"Agent"` blocks whose record timestamp falls in [windowStartMs, now].
async function scanTranscriptFile(file, seenIds, dayCounts, windowStartMs, nowMs) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"tool_use"') || !line.includes('"name":"Agent"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : null;
    if (!content) continue;
    const ts = Date.parse(rec.timestamp);
    if (Number.isNaN(ts) || ts < windowStartMs || ts > nowMs) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || block.name !== 'Agent') continue;
      const id = block.id || `${file}:${rec.timestamp}:${dayCounts.size}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const day = utcDay(ts);
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    }
  }
}

// telemetryCoverage({ days, now, transcriptsRoot, maxFiles, maxBytes, maxMs })
//   -> { days: [{ day, transcriptSpawns, telemetryRows, status, partialDay? }],
//        silentDays, partialDays, windowDays, truncated }
export async function telemetryCoverage({
  days = 7,
  now = new Date(),
  transcriptsRoot,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxMs = null,
  partialRatio = 0.5,
} = {}) {
  const start = Date.now();
  const nowMs = now.getTime();
  const windowStartMs = nowMs - days * 86400000;
  const root = transcriptsRoot || process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT || join(claudeDir(), 'projects');

  const dayCounts = new Map();
  let truncated = false;
  if (existsSync(root)) {
    const { files, truncated: capTruncated } = collectTranscriptFiles(root, windowStartMs, maxFiles, maxBytes);
    truncated = capTruncated;
    const seenIds = new Set();
    for (const f of files) {
      if (maxMs != null && Date.now() - start > maxMs) { truncated = true; break; }
      try { await scanTranscriptFile(f, seenIds, dayCounts, windowStartMs, nowMs); } catch { /* unreadable: skip */ }
    }
  }

  // Telemetry: production spawns.jsonl only, by UTC day of `at`. Recover any
  // pending legacy import first so a fresh install does not read as silent.
  try { syncLegacy(); } catch { /* fail open */ }
  const telemetryDayCounts = new Map();
  try {
    const { readFileSync } = await import('node:fs');
    const f = join(telemetryDir(), 'spawns.jsonl');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let row;
        try { row = JSON.parse(t); } catch { continue; }
        const ts = Date.parse(row && row.at);
        if (Number.isNaN(ts) || ts < windowStartMs || ts > nowMs) continue;
        const day = utcDay(ts);
        telemetryDayCounts.set(day, (telemetryDayCounts.get(day) || 0) + 1);
      }
    }
  } catch { /* fail open: report zero telemetry rather than throw */ }

  const todayStr = utcDay(nowMs);
  const out = [];
  let silentDays = 0;
  let partialDays = 0;
  // Exactly `days` buckets: today plus the (days - 1) days before it, so
  // `windowDays` and `days.length` agree and "the last N days" means N.
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = nowMs - i * 86400000;
    const day = utcDay(dayMs);
    const transcriptSpawns = dayCounts.get(day) || 0;
    const telemetryRows = telemetryDayCounts.get(day) || 0;
    const isToday = day === todayStr;

    let status;
    if (transcriptSpawns === 0 && telemetryRows === 0) status = 'idle';
    else if (transcriptSpawns > 0 && telemetryRows === 0) status = isToday ? 'partial' : 'silent';
    else if (telemetryRows < partialRatio * transcriptSpawns) status = 'partial';
    else status = 'ok';

    if (status === 'silent') silentDays++;
    else if (status === 'partial') partialDays++;

    const entry = { day, transcriptSpawns, telemetryRows, status };
    if (isToday) entry.partialDay = true;
    out.push(entry);
  }

  return { days: out, silentDays, partialDays, windowDays: days, truncated };
}
