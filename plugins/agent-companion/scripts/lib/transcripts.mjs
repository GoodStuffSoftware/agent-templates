// transcripts — the ONE reader for Claude Code session and subagent
// transcripts (JSONL). Every script in this plugin that walks or parses
// transcripts goes through here: cache-ttl, transcript-harvest, the
// telemetry-coverage check, the model-mismatch check, and the
// transcript-report CLI. It is read-only and local: no network, no writes,
// no model calls.
//
// --- Layout (verified against real local transcripts) ----------------------
//
//   <root>/<project>/<sessionId>.jsonl                               main session
//   <root>/<project>/<sessionId>/subagents/agent-<id>.jsonl          subagent
//   <root>/<project>/<sessionId>/subagents/agent-<id>.meta.json      sidecar: agentType, name, model, ...
//   <root>/<project>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl   workflow agent
//   <root>/<project>/<sessionId>/subagents/workflows/<wf>/journal.jsonl      workflow journal (not a transcript)
//
// <root> is ~/.claude/projects unless AGENT_COMPANION_TRANSCRIPTS_ROOT (or an
// explicit argument) says otherwise.
//
// --- Records -----------------------------------------------------------------
//
// One JSON object per line. The ones this module reads:
//   type:"assistant"  message.{id, model, usage, content}, requestId, timestamp,
//                     uuid, sessionId, agentId (subagents), isSidechain
//   type:"user"       timestamp, uuid, isMeta, isCompactSummary, message.content
//                     (a tool_result block marks a tool round-trip)
//   type:"system"     subtype:"compact_boundary" + compactMetadata.{trigger,
//                     preTokens, postTokens, durationMs, ...}
// Every other type (attachment, queue-operation, custom-title, ...) is
// skipped. A line that is not valid JSON (a truncated last line mid-write, a
// corrupt record) is skipped and counted, never thrown.
//
// --- Dedup rules (explicit, and each one tested) -------------------------------
//
// One API request is written as SEVERAL assistant lines (one per content
// block while streaming), all carrying the same requestId and a usage object.
// Measured on real transcripts, the lines of one request agree on input and
// cache fields and output_tokens only grows, so:
//
//   D1  A request is keyed by requestId, falling back to message.id. Its
//       usage is the FIELD-WISE MAX over all its lines — never a sum.
//   D2  Grouping is FILE-WIDE, not just over adjacent lines. Two requests
//       running at once in one transcript (measured: only in subagent files,
//       the two runs fewer than 100 lines apart) interleave their lines, so
//       request A's lines resume after request B's. An adjacent-only
//       grouping would count A's second run as another request. The request
//       keeps the position and start of its FIRST run; a later run feeds the
//       usage max (D1), its tool_use names and its end time, and is counted
//       in stats.reloggedLines.
//   D3  A line whose uuid already appeared in the same file is an exact
//       re-log and is skipped entirely (stats.duplicateUuidLines). This is
//       what real main-session transcripts do when they write earlier
//       assistant lines again much later in the file; an adjacent-only
//       grouping (what cache-ttl.mjs did before this module) counted each of
//       those as an extra request with a negative gap.
//   D4  ACROSS files: a resumed or forked session's new JSONL carries copies
//       of earlier requests (same requestId, same timestamp). On the machine
//       this was built on, about 11% of all requestIds appear in more than
//       one file, subagent forks up to a hundred-plus times. Copies are NOT
//       always identical: about a quarter of multi-file ids differ, almost
//       always in output_tokens (one copy was written before the stream
//       finished). So the ids are resolved over the whole corpus
//       (resolveCrossFile(); scanCorpus() does it by default):
//         - ONE logical request per id, owned by the ORIGINAL file: the file
//           whose earliest record is earliest (ties: older mtime, then path).
//           Never path order alone — a copy's file can sort first.
//         - Its usage is the field-wise max over every copy (D1 again).
//         - Its timestamps and position are the original file's.
//         - Every other copy comes back duplicate:true, carrying the same
//           merged usage. Duplicates stay in the per-file list so the gap
//           chain inside that file is unbroken, but every total must skip
//           them.
//       Compactions copied into another file are resolved the same way, by
//       the boundary (or summary) record's uuid. readTranscript() still takes
//       a shared `seen` Set for a caller that reads files one at a time; that
//       claims in call order and does not max-merge.
//   D5  model "<synthetic>" lines (harness-written error placeholders) are
//       never requests.
//
// --- Derived views ---------------------------------------------------------
//
//   contextTokens  input + cacheRead + cacheWrite: the prompt the model saw
//                  on that request.
//   gaps           start-to-start time between consecutive requests in ONE
//                  file (never across files). A request's start is the
//                  timestamp of the user record that led to it (the prompt or
//                  tool result that was sent). A user record leads to ONE
//                  request only; a request with no user record of its own
//                  starts at its own first assistant line. Start-to-start is
//                  what a cache TTL is measured against: the previous request
//                  read or wrote the cache when it was sent. Each gap says
//                  what connected the two requests (`via`), which cache TTL
//                  applied (`ttl`), whether the cache held (`outcome`) and,
//                  for a rewrite, why (`cause`); see gapsOf().
//   compactions    one per compact_boundary (or a compact-summary user record
//                  with no boundary before it), with the pre/post token counts
//                  the harness recorded and the first request after it.
//                  postTokens is the size of the SUMMARY only. The working
//                  size after a compaction (summary + system prompt + tools +
//                  re-attached files) is firstRequestAfter.contextTokens,
//                  measured at 1.4x to 7.8x postTokens. Advice about the
//                  auto-compact window must use firstRequestAfter.contextTokens.
//   spawn baseline the first request of a subagent transcript, when it is a
//                  real cold start (not a copied-history duplicate).

import {
  readdirSync, statSync, createReadStream, readFileSync, openSync, readSync, closeSync, fstatSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { claudeDir } from '../../hooks/lib/context.mjs';

export const SYNTHETIC_MODEL = '<synthetic>';
export const NO_META_AGENT_TYPE = '(no meta)';
export const FIVE_MIN_MS = 5 * 60 * 1000;
export const SIXTY_MIN_MS = 60 * 60 * 1000;

// Lowercased opening of the harness-written compaction summary — a fallback
// signal only, for a record that lost its isCompactSummary flag.
const SUMMARY_PREFIX = 'this session is being continued from a previous conversation that ran out of context';

export function transcriptsRoot(explicit) {
  return explicit || process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT || join(claudeDir(), 'projects');
}

// --- Path description (both separator styles) -----------------------------
//
// Splits on either separator so a Windows path read on POSIX (or the other
// way round, e.g. a path taken from a synced telemetry row) still yields the
// right kind and ids.
export function describePath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  const base = name.replace(/\.jsonl$/i, '');
  const subIdx = parts.lastIndexOf('subagents');
  if (subIdx >= 1) {
    const sessionId = parts[subIdx - 1];
    const project = subIdx >= 2 ? parts[subIdx - 2] : null;
    const isWorkflow = parts[subIdx + 1] === 'workflows' && parts.length === subIdx + 4;
    const workflowId = isWorkflow ? parts[subIdx + 2] : null;
    const isAgent = /^agent-/.test(base);
    // Any JSONL directly in subagents/ is a subagent transcript; under
    // subagents/workflows/<wf>/ only agent-* is (journal.jsonl is not).
    const isSub = isWorkflow ? isAgent : parts.length === subIdx + 2;
    return {
      kind: isSub ? 'subagent' : 'other',
      project,
      sessionId,
      agentId: isSub ? (isAgent ? base.slice('agent-'.length) : base) : null,
      workflowId,
    };
  }
  return { kind: 'main', project: parts[parts.length - 2] || null, sessionId: base, agentId: null, workflowId: null };
}

function readMeta(jsonlPath) {
  try { return JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/i, '.meta.json'), 'utf8')) || {}; } catch { return {}; }
}

// --- Discovery -------------------------------------------------------------
//
// Walk order is readdir order, project by project: a project's main files and
// then each session directory's subagents — the same order cache-ttl.mjs used,
// so a file/byte cap truncates the same files it did. Caps count every file
// returned, whatever its kind. A root that does not exist returns no files,
// never throws.
//
// Options:
//   sinceMs     skip files not modified since (they cannot hold newer records)
//   maxFiles, maxBytes   caps; hitting either sets truncated and stops adding
//   main, subagents      include those kinds (default both)
//   workflows   include workflow agents under subagents/workflows/<wf>/ (default false)
//   other       include every other *.jsonl found anywhere under the root,
//               e.g. workflow journals (default false) — for callers that
//               scan for a string in any JSONL, not for transcripts
//   project     function(projectDirName) -> boolean filter
//   meta        read subagent .meta.json sidecars (default true)
//   anyDepth    walk every directory under root depth-first and classify
//               each JSONL by where it sits (parent "subagents" -> subagent,
//               directly in a project dir -> main, else other). For callers
//               whose root may be a single project directory rather than the
//               projects root; the two checks that walked this way before
//               (coverage, model-mismatch) keep doing so.
export function discoverTranscripts(root, {
  sinceMs = -Infinity, maxFiles = Infinity, maxBytes = Infinity,
  main = true, subagents = true, workflows = false, other = false,
  project = null, meta = true, anyDepth = false,
} = {}) {
  const files = [];
  let truncated = false;
  let totalBytes = 0;

  const consider = (path, info) => {
    let st;
    try { st = statSync(path); } catch { return; }
    if (st.mtimeMs < sinceMs) return;
    if (files.length >= maxFiles || totalBytes + st.size > maxBytes) { truncated = true; return; }
    totalBytes += st.size;
    const entry = { path, size: st.size, mtimeMs: st.mtimeMs, ...info };
    if (info.kind === 'subagent') {
      const m = meta ? readMeta(path) : {};
      entry.meta = m;
      entry.agentType = m.agentType || NO_META_AGENT_TYPE;
      entry.agentName = m.name || null;
      entry.declaredModel = m.model || null;
    }
    files.push(entry);
  };

  let top;
  try { top = readdirSync(root, { withFileTypes: true }); } catch { return { files, truncated, exists: false }; }

  if (anyDepth) {
    // Depth-agnostic walk (depth-first, the order the coverage and
    // model-mismatch checks always walked in): every *.jsonl anywhere under
    // root, classified by where it sits rather than by how deep — so a root
    // that is itself one project directory still finds its subagents.
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = dir === root ? top : readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const d = describePath(full.slice(root.length));
        const isMainPos = dir !== root && resolve(dir, '..') === resolve(root);
        let kind = d.kind === 'subagent' ? 'subagent' : (isMainPos ? 'main' : 'other');
        if (d.kind === 'subagent' && d.workflowId && !workflows) kind = 'other';
        if ((kind === 'main' && !main) || (kind === 'subagent' && !subagents) || (kind === 'other' && !other)) continue;
        if (project) {
          const projName = full.slice(root.length).split(/[\\/]+/).filter(Boolean)[0];
          if (!projName || !project(projName)) continue;
        }
        consider(full, {
          kind,
          project: d.project,
          sessionId: kind === 'main' ? e.name.slice(0, -'.jsonl'.length) : d.sessionId,
          agentId: kind === 'subagent' ? d.agentId : null,
          workflowId: d.workflowId,
        });
      }
    }
    return { files, truncated, exists: true };
  }

  // Everything under a directory that is not already a known transcript
  // position, for `other`.
  const walkOther = (dir, projName) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walkOther(full, projName); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl')) consider(full, { kind: 'other', project: projName, sessionId: null, agentId: null, workflowId: null });
    }
  };

  for (const t of top) {
    if (t.isFile() && t.name.endsWith('.jsonl')) {
      if (other) consider(join(root, t.name), { kind: 'other', project: null, sessionId: null, agentId: null, workflowId: null });
      continue;
    }
    if (!t.isDirectory()) continue;
    if (project && !project(t.name)) continue;
    const projDir = join(root, t.name);
    let entries;
    try { entries = readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (main) consider(join(projDir, e.name), { kind: 'main', project: t.name, sessionId: e.name.slice(0, -'.jsonl'.length), agentId: null, workflowId: null });
        continue;
      }
      if (!e.isDirectory()) continue;
      const sessionDir = join(projDir, e.name);
      let sEntries;
      try { sEntries = readdirSync(sessionDir, { withFileTypes: true }); } catch { continue; }
      for (const se of sEntries) {
        const sFull = join(sessionDir, se.name);
        if (se.isDirectory() && se.name === 'subagents') {
          let subEntries;
          try { subEntries = readdirSync(sFull, { withFileTypes: true }); } catch { continue; }
          for (const s of subEntries) {
            const full = join(sFull, s.name);
            if (s.isFile() && s.name.endsWith('.jsonl')) {
              if (subagents) consider(full, { kind: 'subagent', project: t.name, sessionId: e.name, agentId: describePath(full).agentId, workflowId: null });
              continue;
            }
            if (!s.isDirectory()) continue;
            if (s.name === 'workflows') {
              let wfs;
              try { wfs = readdirSync(full, { withFileTypes: true }); } catch { continue; }
              for (const wf of wfs) {
                const wfDir = join(full, wf.name);
                if (!wf.isDirectory()) {
                  if (other && wf.isFile() && wf.name.endsWith('.jsonl')) consider(wfDir, { kind: 'other', project: t.name, sessionId: e.name, agentId: null, workflowId: null });
                  continue;
                }
                let wEntries;
                try { wEntries = readdirSync(wfDir, { withFileTypes: true }); } catch { continue; }
                for (const w of wEntries) {
                  const wFull = join(wfDir, w.name);
                  if (w.isFile() && w.name.endsWith('.jsonl')) {
                    if (w.name.startsWith('agent-') && workflows) {
                      consider(wFull, { kind: 'subagent', project: t.name, sessionId: e.name, agentId: w.name.slice('agent-'.length, -'.jsonl'.length), workflowId: wf.name });
                    } else if (other && !w.name.startsWith('agent-')) {
                      consider(wFull, { kind: 'other', project: t.name, sessionId: e.name, agentId: null, workflowId: wf.name });
                    }
                  } else if (other && w.isDirectory()) {
                    walkOther(wFull, t.name);
                  }
                }
              }
            } else if (other) {
              walkOther(full, t.name);
            }
          }
        } else if (other && se.isDirectory()) {
          walkOther(sFull, t.name);
        } else if (other && se.isFile() && se.name.endsWith('.jsonl')) {
          consider(sFull, { kind: 'other', project: t.name, sessionId: e.name, agentId: null, workflowId: null });
        }
      }
    }
  }
  return { files, truncated, exists: true };
}

// --- Line reader ---------------------------------------------------------------
//
// Streams a file line by line (never loads it whole — real transcripts reach
// tens of MB) and yields parsed records. `prefilter(line)` runs on the raw
// line first; a line it rejects is never parsed, which is what keeps a
// needle-in-haystack scan (the coverage check) fast. `stats` (optional) is
// filled in as it goes: lines, bytes, unparseable, and truncatedTail (the
// last line is not valid JSON and the file does not end in a newline — a
// write in progress).
export async function* readRecords(path, { prefilter = null, stats = null } = {}) {
  const s = stats || {};
  s.lines = s.lines || 0;
  s.bytes = s.bytes || 0;
  s.unparseable = s.unparseable || 0;
  let rl;
  try {
    rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  } catch {
    return;
  }
  let lastBad = false;
  let first = true;
  try {
    for await (let line of rl) {
      // A UTF-8 byte-order mark would make the first record unparseable.
      if (first) { first = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
      if (!line) continue;
      s.lines += 1;
      s.bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (prefilter && !prefilter(line)) { lastBad = false; continue; }
      let rec;
      try { rec = JSON.parse(line); } catch { s.unparseable += 1; lastBad = true; continue; }
      lastBad = false;
      if (rec && typeof rec === 'object') yield rec;
    }
  } catch {
    // unreadable mid-stream (file vanished, permission): what was read stands
  }
  if (lastBad) s.truncatedTail = !endsWithNewline(path);
}

function endsWithNewline(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (!size) return true;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// --- Record predicates (shared by every caller) ---------------------------------

export function isCompactBoundary(rec) {
  return !!rec && rec.type === 'system' && rec.subtype === 'compact_boundary';
}

export function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : ''))).join('\n');
  }
  return '';
}

// isCompactSummary:true is the authoritative signal; the text prefix is a
// fallback for a record that kept the wording but lost the flag. (The third
// signal — a user record straight after a compact_boundary — needs the
// previous line, so CompactionTracker applies it.)
export function isCompactSummary(rec) {
  if (!rec || rec.type !== 'user' || !rec.message) return false;
  if (rec.isCompactSummary === true) return true;
  return flattenContent(rec.message.content).slice(0, 200).toLowerCase().includes(SUMMARY_PREFIX);
}

// Pairs a compact_boundary with the summary user record that follows it.
// feed(rec) returns a finished event { boundary, summary } when rec is a
// summary (boundary is null when no boundary came before it), or null
// otherwise. A user record after a boundary counts as the summary even
// without the flag or the wording. Only conversation records (user,
// assistant, system) break the pairing: newer transcripts write attachment
// records between the boundary and the summary (measured: 2-3 of them, in
// about a third of recent compactions), and an adjacency-only rule split
// each of those into a boundary with no summary plus a summary with no
// trigger or token counts. flush() returns a boundary no summary followed.
const PAIRING_TYPES = new Set(['user', 'assistant', 'system']);

export class CompactionTracker {
  constructor() { this.pending = null; }

  feed(rec) {
    if (isCompactBoundary(rec)) {
      const orphan = this.pending;
      this.pending = rec;
      return orphan ? { boundary: orphan, summary: null } : null;
    }
    if (this.pending && !PAIRING_TYPES.has(rec && rec.type)) return null;
    if (rec && rec.type === 'user' && (this.pending || isCompactSummary(rec))) {
      const ev = { boundary: this.pending, summary: rec };
      this.pending = null;
      return ev;
    }
    if (this.pending) {
      const orphan = this.pending;
      this.pending = null;
      return { boundary: orphan, summary: null };
    }
    return null;
  }

  flush() {
    const orphan = this.pending;
    this.pending = null;
    return orphan ? { boundary: orphan, summary: null } : null;
  }
}

function compactionFromEvent(ev, index) {
  const meta = ev.boundary?.compactMetadata || {};
  const ts = Date.parse((ev.boundary || ev.summary)?.timestamp);
  return {
    index,
    ts: Number.isFinite(ts) ? ts : null,
    trigger: meta.trigger ?? null,
    preTokens: meta.preTokens ?? null,
    postTokens: meta.postTokens ?? null,
    durationMs: meta.durationMs ?? null,
    hasBoundary: !!ev.boundary,
    hasSummary: !!ev.summary,
    duplicate: false,
    requestsBefore: 0,
    requestsAfter: 0,
    // { contextTokens, cacheRead, cacheWrite, model } of the first request
    // after it that is not a copy. contextTokens is the post-compaction
    // working size (see the module header); postTokens is the summary alone.
    firstRequestAfter: null,
    key: ev.boundary?.uuid || ev.summary?.uuid || null, // cross-file identity (D4)
  };
}

// --- Usage ----------------------------------------------------------------

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

// One line's usage in this module's shape. cache_creation_input_tokens is
// the total; when only the split is present the total is its sum.
export function usageOf(u) {
  const x = u || {};
  const w5 = x.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = x.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const flat = x.cache_creation_input_tokens;
  return {
    input: x.input_tokens || 0,
    output: x.output_tokens || 0,
    cacheRead: x.cache_read_input_tokens || 0,
    cacheWrite: typeof flat === 'number' ? flat : w5 + w1,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  };
}

function maxInto(into, u) {
  for (const k of Object.keys(into)) into[k] = Math.max(into[k], u[k] || 0);
}

export function contextTokensOf(usage) {
  return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

export function addUsage(into, u) {
  for (const k of Object.keys(into)) into[k] += u[k] || 0;
  return into;
}

// --- One transcript ----------------------------------------------------------
//
// readTranscript(path, opts) -> { file, requests, compactions, stats }
//
// opts:
//   kind, agentType, agentName, sessionId ... (file facts; describePath(path)
//                 fills whatever is not given)
//   seen          a Set shared across files for cross-file dedup (D4)
//   keepSummaries keep the raw summary record on each compaction (summaryRecord)
//
// Each request:
//   id, messageId, model, ts (first assistant line), startTs, endTs (last
//   assistant line of its first run), sessionId, agentId, isSidechain, kind,
//   agentType, agentName, usage, contextTokens, lines, toolUseNames[],
//   lastBlockType, connectingUser { ts, hasToolResult, isMeta, isCompaction,
//   origin, isMessage } | null, compactionsBefore, duplicate, index
//
// connectingUser is the user record that led to this request, or null when
// none came between it and the request before (then startTs is its own first
// line). origin is the record's origin.kind when it has one (coordinator,
// peer, task-notification, ...) or 'teammate-message' for the older
// plain-text <teammate-message> shape. isMessage is true for a message another
// agent sent with SendMessage: origin coordinator or peer (written with
// isMeta:true), or a <teammate-message> record.
//
// file.firstTs is the earliest record timestamp in the file: the key
// resolveCrossFile() uses to find the original of a copied request.
export async function readTranscript(path, opts = {}) {
  const desc = describePath(path);
  const file = {
    path,
    kind: opts.kind || desc.kind,
    project: opts.project ?? desc.project,
    sessionId: opts.sessionId ?? desc.sessionId,
    agentId: opts.agentId ?? desc.agentId,
    workflowId: opts.workflowId ?? desc.workflowId,
    agentType: opts.agentType ?? null,
    agentName: opts.agentName ?? null,
    firstTs: null,
  };
  const seen = opts.seen || null;
  const stats = {
    lines: 0, bytes: 0, unparseable: 0, truncatedTail: false,
    duplicateUuidLines: 0, reloggedLines: 0, crossFileDuplicates: 0, syntheticLines: 0, noKeyLines: 0,
  };

  const requests = [];
  const byId = new Map();
  const compactions = [];
  const tracker = new CompactionTracker();
  const uuids = new Set();
  let current = null; // request whose first run of lines is still open
  let lastUserRec = null; // the user record the next new request starts from (consumed by it)

  const onCompaction = (ev) => {
    const c = compactionFromEvent(ev, compactions.length);
    // D4 for compactions: a copied history carries the same boundary record.
    if (seen && c.key) {
      const k = `compaction:${c.key}`;
      if (seen.has(k)) { c.duplicate = true; stats.crossFileDuplicates += 1; } else seen.add(k);
    }
    if (opts.keepSummaries) {
      c.summaryRecord = ev.summary || null;
      c.boundaryRecord = ev.boundary || null;
    }
    compactions.push(c);
  };

  for await (const rec of readRecords(path, { stats })) {
    if (rec.uuid) {
      if (uuids.has(rec.uuid)) { stats.duplicateUuidLines += 1; continue; }
      uuids.add(rec.uuid);
    }
    const recTs = Date.parse(rec.timestamp);
    if (Number.isFinite(recTs) && (file.firstTs == null || recTs < file.firstTs)) file.firstTs = recTs;

    const ev = tracker.feed(rec);
    if (ev) onCompaction(ev);

    if (rec.type === 'user') {
      const content = rec.message?.content;
      const teammate = /^\s*<teammate-message/.test(flattenContent(content).slice(0, 200));
      const origin = (rec.origin && typeof rec.origin.kind === 'string' ? rec.origin.kind : null)
        || (teammate ? 'teammate-message' : null);
      lastUserRec = {
        ts: recTs,
        hasToolResult: Array.isArray(content) && content.some((b) => b && b.type === 'tool_result'),
        isMeta: rec.isMeta === true,
        isCompaction: !!(ev && ev.summary === rec),
        origin,
        isMessage: origin === 'coordinator' || origin === 'peer' || origin === 'teammate-message',
      };
      continue;
    }
    if (rec.type !== 'assistant') continue;

    const msg = rec.message || {};
    if (msg.model === SYNTHETIC_MODEL) { stats.syntheticLines += 1; continue; }
    const key = rec.requestId || msg.id;
    if (!key) { stats.noKeyLines += 1; continue; }
    const u = usageOf(msg.usage);

    if (current && current.id === key) {
      maxInto(current.usage, u);
      current.lines += 1;
      if (Number.isFinite(recTs) && recTs > current.endTs) current.endTs = recTs;
      absorbContent(current, msg.content);
      continue;
    }
    const earlier = byId.get(key);
    if (earlier) {
      // D2: a later run of a request whose first run already closed (two
      // requests interleaving). Usage, content and end time all count.
      maxInto(earlier.usage, u);
      earlier.lines += 1;
      // A run that is later in time continues the request (its last block
      // is the request's last block); an earlier-timestamped copy only adds
      // tool_use names.
      const continues = Number.isFinite(recTs) && recTs >= earlier.endTs;
      if (continues) earlier.endTs = recTs;
      absorbContent(earlier, msg.content, { updateLast: continues });
      stats.reloggedLines += 1;
      current = null;
      continue;
    }

    const firstTs = recTs;
    const connecting = lastUserRec;
    lastUserRec = null; // F4: a user record leads to one request only
    const req = {
      id: key,
      messageId: msg.id || null,
      model: msg.model || null,
      ts: firstTs,
      startTs: connecting && Number.isFinite(connecting.ts) ? connecting.ts : firstTs,
      endTs: firstTs,
      sessionId: rec.sessionId || file.sessionId || null,
      agentId: rec.agentId || file.agentId || null,
      isSidechain: rec.isSidechain === true,
      kind: file.kind,
      agentType: file.agentType,
      agentName: file.agentName,
      usage: u,
      contextTokens: 0,
      lines: 1,
      toolUseNames: new Set(),
      lastBlockType: null,
      connectingUser: connecting,
      compactionsBefore: compactions.length,
      duplicate: false,
      index: requests.length,
    };
    if (seen) {
      if (seen.has(key)) { req.duplicate = true; stats.crossFileDuplicates += 1; } else seen.add(key);
    }
    absorbContent(req, msg.content);
    byId.set(key, req);
    requests.push(req);
    current = req;
  }
  const orphan = tracker.flush();
  if (orphan) onCompaction(orphan);

  for (const r of requests) r.toolUseNames = [...r.toolUseNames];
  const result = { file, requests, compactions, stats };
  finalizeTranscript(result);
  return result;
}

// Everything derived from usage and the duplicate flags: contextTokens, and
// each compaction's requestsBefore / requestsAfter / firstRequestAfter.
// Runs at the end of readTranscript() and again after resolveCrossFile()
// changes flags or usage.
export function finalizeTranscript(result) {
  const { requests, compactions } = result;
  for (const r of requests) r.contextTokens = contextTokensOf(r.usage);
  const own = requests.filter((r) => !r.duplicate);
  for (let i = 0; i < compactions.length; i++) {
    const c = compactions[i];
    // Own requests written before it, and between it and the next one.
    c.requestsBefore = own.filter((q) => q.compactionsBefore <= i).length;
    c.requestsAfter = own.filter((q) => q.compactionsBefore === i + 1).length;
    const r = own.find((q) => q.compactionsBefore === i + 1);
    c.firstRequestAfter = r
      ? { contextTokens: r.contextTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, model: r.model }
      : null;
  }
  return result;
}

function absorbContent(req, content, { updateLast = true } = {}) {
  if (!Array.isArray(content)) return;
  for (const b of content) if (b && b.type === 'tool_use' && b.name) req.toolUseNames.add(b.name);
  if (updateLast && content.length) req.lastBlockType = content[content.length - 1]?.type || req.lastBlockType;
}

// --- Cross-file resolution (D4) ------------------------------------------------
//
// resolveCrossFile(items) where each item is { result, mtimeMs } (result from
// readTranscript() called WITHOUT `seen`). Mutates the results in place:
// marks copies duplicate:true, max-merges usage into one logical request per
// id, re-derives contextTokens and compaction fields, and sets each file's
// stats.crossFileDuplicates. Returns counters:
//   ids                 requestIds found in more than one file
//   idsMaxDiffers       of those, ids whose merged usage differs from the copy
//                       the old rule kept (the first file in path order)
//   ownerNotPathFirst   ids whose original file is not the first in path order
//   compactionKeys      compactions found in more than one file
export function resolveCrossFile(items) {
  const byPath = (a, b) => (a.result.file.path < b.result.file.path ? -1 : a.result.file.path > b.result.file.path ? 1 : 0);
  const originalOrder = [...items].sort((a, b) => {
    const fa = a.result.file.firstTs ?? Infinity;
    const fb = b.result.file.firstTs ?? Infinity;
    if (fa !== fb) return fa - fb;
    const ma = a.mtimeMs ?? Infinity;
    const mb = b.mtimeMs ?? Infinity;
    if (ma !== mb) return ma - mb;
    return byPath(a, b);
  });
  const pathRank = new Map([...items].sort(byPath).map((it, i) => [it.result, i]));

  // id -> copies, in original order (the first one owns the id)
  const copies = new Map();
  const cCopies = new Map();
  for (const it of originalOrder) {
    it.result.stats.crossFileDuplicates = 0;
    for (const r of it.result.requests) {
      const list = copies.get(r.id);
      if (list) list.push({ r, res: it.result }); else copies.set(r.id, [{ r, res: it.result }]);
    }
    for (const c of it.result.compactions) {
      if (!c.key) continue;
      const list = cCopies.get(c.key);
      if (list) list.push({ c, res: it.result }); else cCopies.set(c.key, [{ c, res: it.result }]);
    }
  }

  const out = { ids: 0, idsMaxDiffers: 0, ownerNotPathFirst: 0, compactionKeys: 0 };
  const touched = new Set();
  for (const list of copies.values()) {
    if (list.length < 2) continue;
    out.ids += 1;
    const merged = emptyUsage();
    for (const { r } of list) maxInto(merged, r.usage);
    let pathFirst = list[0];
    for (const x of list) if (pathRank.get(x.res) < pathRank.get(pathFirst.res)) pathFirst = x;
    if (Object.keys(merged).some((k) => merged[k] !== pathFirst.r.usage[k])) out.idsMaxDiffers += 1;
    if (pathFirst !== list[0]) out.ownerNotPathFirst += 1;
    list.forEach(({ r, res }, i) => {
      r.usage = { ...merged };
      r.duplicate = i > 0;
      if (i > 0) res.stats.crossFileDuplicates += 1;
      touched.add(res);
    });
  }
  for (const list of cCopies.values()) {
    if (list.length < 2) continue;
    out.compactionKeys += 1;
    list.forEach(({ c, res }, i) => {
      c.duplicate = i > 0;
      if (i > 0) res.stats.crossFileDuplicates += 1;
      touched.add(res);
    });
  }
  for (const res of touched) finalizeTranscript(res);
  return out;
}

// --- Gaps, resumes, spawn baseline ------------------------------------------------

export function bandFor(gapMs) {
  if (gapMs < FIVE_MIN_MS) return 'lt5';
  if (gapMs <= SIXTY_MIN_MS) return '5to60';
  return 'gt60';
}

export const TTL_MS = { '5m': FIVE_MIN_MS, '1h': SIXTY_MIN_MS };

// What connected a request to the one before it, from its connectingUser:
//   'compaction'  the compaction summary
//   'toolResult'  a tool result (a tool round-trip, however slow the tool)
//   'message'     a message another agent sent with SendMessage
//   'meta'        any other harness-written record (task notifications,
//                 reminders, hook output)
//   'prompt'      a prompt typed by the person
//   'none'        no user record came between the two requests
export function viaOf(connectingUser) {
  const u = connectingUser;
  if (!u) return 'none';
  if (u.isCompaction) return 'compaction';
  if (u.hasToolResult) return 'toolResult';
  if (u.isMessage) return 'message';
  if (u.isMeta) return 'meta';
  return 'prompt';
}

// The TTL bucket a request's writes went to: the larger of the 1h/5m split,
// or null when it wrote nothing split by bucket.
function writeTtlOf(usage) {
  const w1 = usage.cacheWrite1h || 0;
  const w5 = usage.cacheWrite5m || 0;
  if (!w1 && !w5) return null;
  return w1 >= w5 ? '1h' : '5m';
}

// One entry per request after the first in a file. A duplicate request (D4)
// gets no entry of its own — its copy in the owning file has it — but it
// still serves as the previous request for the next one, so the gap at the
// point where a forked or resumed file starts its own work is kept.
//
//   gapMs          start-to-start, see the module header
//   via            what connected the two requests, see viaOf()
//   origin         the connecting record's origin (coordinator, peer,
//                  task-notification, teammate-message, ...) or null
//   kind           the file's kind (main | subagent)
//   ttl, ttlMs     the cache TTL that applied: the bucket the most recent
//                  request that wrote a split cache entry wrote into, or when
//                  none has, the default for the kind (main 1h, subagent 5m).
//                  ttlSource says which ('write' | 'default').
//   prevContext    what the previous request's cache could hold
//   rereadTokens   this request's context (what had to be read or rewritten)
//   cacheRead, cacheWrite   how it actually came back
//   outcome        'hit' when cacheRead covers at least half of prevContext
//                  (a full read followed by a large append is still a hit),
//                  else 'rewrite'. With no previous context, read >= write.
//   cause          null for a hit. For a rewrite: 'compaction' (a compaction
//                  came between), 'idle-expiry' (the gap is longer than the
//                  TTL: the cache expired), or 'prefix-change' (inside the TTL:
//                  something changed the prompt prefix, typically an isMeta
//                  record). Only 'idle-expiry' is caused by idle time.
//   afterCompaction   a compaction came between the two requests
export function gapsOf(requests) {
  const out = [];
  let lastTtl = null;
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const prevTtl = lastTtl;
    const wt = writeTtlOf(r.usage);
    if (wt) lastTtl = wt;
    if (i === 0 || r.duplicate) continue;
    const p = requests[i - 1];
    if (!Number.isFinite(r.startTs) || !Number.isFinite(p.startTs)) continue;
    const gapMs = r.startTs - p.startTs;
    const via = viaOf(r.connectingUser);
    const ttl = prevTtl || (r.kind === 'main' ? '1h' : '5m');
    const ttlMs = TTL_MS[ttl];
    const prevContext = p.contextTokens;
    const hit = prevContext > 0
      ? r.usage.cacheRead >= 0.5 * prevContext
      : r.usage.cacheRead >= r.usage.cacheWrite;
    const afterCompaction = r.compactionsBefore > p.compactionsBefore;
    let cause = null;
    if (!hit) {
      if (afterCompaction || via === 'compaction') cause = 'compaction';
      else if (gapMs > ttlMs) cause = 'idle-expiry';
      else cause = 'prefix-change';
    }
    out.push({
      index: r.index,
      gapMs,
      band: bandFor(gapMs),
      model: r.model,
      kind: r.kind,
      via,
      origin: r.connectingUser?.origin ?? null,
      ttl,
      ttlMs,
      ttlSource: prevTtl ? 'write' : 'default',
      prevContext,
      rereadTokens: r.contextTokens,
      cacheRead: r.usage.cacheRead,
      cacheWrite: r.usage.cacheWrite,
      outcome: hit ? 'hit' : 'rewrite',
      cause,
      afterCompaction,
      connectingUser: r.connectingUser,
    });
  }
  return out;
}

// The advisor's "resumed after idle" gaps: the conversation was picked up
// again by a person's prompt or another agent's SendMessage (via 'prompt' or
// 'message'), after longer than the cache TTL that applied. A tool
// round-trip, however slow, is not a resume. Of these, the ones that cost a
// rewrite are cause === 'idle-expiry'; that is the count the resume guard
// uses. Task notifications (via 'meta', origin 'task-notification') also wake
// an idle agent; pass { includeTaskNotifications: true } to count them.
export function isResumeAfterIdle(g, { includeTaskNotifications = false } = {}) {
  const resumed = g.via === 'prompt' || g.via === 'message'
    || (includeTaskNotifications && g.via === 'meta' && g.origin === 'task-notification');
  return resumed && g.gapMs > g.ttlMs;
}

export function resumeAfterIdleGaps(gaps, opts) {
  return gaps.filter((g) => isResumeAfterIdle(g, opts));
}

// The cold write a subagent pays on spawn: its first request, when that
// request is its own (a forked file whose history starts with copies of
// another file's requests is not a cold start and returns null).
export function spawnBaselineOf(result) {
  if (result.file.kind !== 'subagent') return null;
  const first = result.requests[0];
  if (!first || first.duplicate) return null;
  return {
    agentType: result.file.agentType,
    agentName: result.file.agentName,
    model: first.model,
    ts: first.ts,
    contextTokens: first.contextTokens,
    input: first.usage.input,
    cacheRead: first.usage.cacheRead,
    cacheWrite: first.usage.cacheWrite,
    cacheWrite1h: first.usage.cacheWrite1h,
  };
}

// --- Corpus scan ------------------------------------------------------------------
//
// Discovers and reads every transcript, calling onFile(result, fileEntry) for
// each, in path order.
//
// Cross-file dedup (D4) is ON by default (crossFileDedup: false turns it
// off). With it on, every file is read first and kept in memory, the copies
// are resolved across the whole set (resolveCrossFile()), and only then does
// onFile run: the max over copies needs every copy, and a copy can sit in a
// file read after the original. With it off, files stream through onFile one
// at a time.
//
// maxMs is a time budget for READING: once spent, the remaining files are
// skipped (truncated: true, filesSkipped counts them). Under a budget, files
// are read NEWEST first (by mtime), so a truncated scan covers recent
// activity across every project rather than the alphabetically first ones.
//
// Returns { root, exists, filesFound, filesRead, filesSkipped, truncated,
// wallMs, crossFile } where crossFile is resolveCrossFile()'s counters (null
// with dedup off).
export async function scanCorpus({
  root, sinceMs = -Infinity, maxFiles, maxBytes, maxMs = null,
  main = true, subagents = true, workflows = false, project = null,
  crossFileDedup = true, keepSummaries = false, onFile,
} = {}) {
  const started = Date.now();
  const dir = transcriptsRoot(root);
  const disc = discoverTranscripts(dir, {
    sinceMs, maxFiles, maxBytes, main, subagents, workflows, project,
  });
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const files = [...disc.files].sort(maxMs != null ? (a, b) => (b.mtimeMs - a.mtimeMs) || byPath(a, b) : byPath);
  let truncated = disc.truncated;
  let read = 0;
  let attempted = 0;
  const buffered = [];
  for (const f of files) {
    if (maxMs != null && Date.now() - started > maxMs) { truncated = true; break; }
    attempted += 1;
    let result;
    try {
      result = await readTranscript(f.path, {
        kind: f.kind, project: f.project, sessionId: f.sessionId, agentId: f.agentId, workflowId: f.workflowId,
        agentType: f.kind === 'subagent' ? f.agentType : null,
        agentName: f.kind === 'subagent' ? f.agentName : null,
        keepSummaries,
      });
    } catch { continue; }
    read += 1;
    if (crossFileDedup) buffered.push({ result, entry: f, mtimeMs: f.mtimeMs });
    else if (onFile) await onFile(result, f);
  }
  let crossFile = null;
  if (crossFileDedup) {
    crossFile = resolveCrossFile(buffered);
    buffered.sort((a, b) => byPath(a.entry, b.entry));
    for (let i = 0; i < buffered.length; i++) {
      const { result, entry } = buffered[i];
      buffered[i] = null; // let each file go once its consumer is done with it
      if (onFile) await onFile(result, entry);
    }
  }
  return {
    root: dir, exists: disc.exists, filesFound: disc.files.length, filesRead: read,
    filesSkipped: files.length - attempted, truncated, wallMs: Date.now() - started, crossFile,
  };
}

// --- Small stats helpers ---------------------------------------------------------

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
