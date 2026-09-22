#!/usr/bin/env node
// gotcha-retrieval.mjs — PostToolUseFailure hook: a literal, high-precision
// match between a tool failure's error text and a `symptoms:` key authored
// on an existing lesson or memory file, fired the instant the failure
// happens. See docs/adr/0002-stack-scoped-gotcha-retrieval.md — this is the
// Phase 3 (match + inject) and Phase 4 (capture-on-miss) halves of that
// decision; they share one hook because a miss is the mirror image of a
// hit and both need the same normalized text and the same corpus read.
//
// Design rule this file answers to (hooks/lib/context.mjs's own banner,
// repeated here because this hook did not exist when that banner was
// written): A HOOK MUST NEVER BREAK A SESSION. Every code path below is
// wrapped so a throw anywhere becomes passthrough() — a missed gotcha,
// never a wedged tool call.
//
// Zero dependencies. Node builtins only.

import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStdin, opt, dataDir, passthrough, isFixtureSession,
} from './lib/context.mjs';
import { normalizeErrorText } from './lib/text-normalize.mjs';
import {
  loadOrBuildIndex, loadOrBuildRepoIndex, memoryRoot, findRepoRoot,
  DEFAULT_REPO_GLOBS, DEFAULT_REPO_MAX_FILE_BYTES, DEFAULT_REPO_MAX_TOTAL_BYTES,
} from './lib/memory-index.mjs';

export const MARKER = '[agent-companion: gotcha]';
const MAX_CONTEXT_CHARS = 600;
// A candidate symptoms: key normalizing to fewer characters than this is too
// short to trust as a distinctive fingerprint (see the ADR's Decision part
// 3 — a calibrated version of this guard is future work; this is the floor
// below which a key cannot possibly be anything BUT generic, e.g. "error").
const MIN_KEY_CHARS = 6;

function fileStem(fileRel) {
  const base = String(fileRel).split('/').pop() || String(fileRel);
  return base.replace(/\.[^.]+$/, '');
}

// Collect one candidate per FILE, not per chunk. memory-index.mjs's
// chunkFile() splits a file into one chunk per heading, and every chunk
// from the same file carries that file's SAME frontmatter (fmSymptoms
// included) — so walking chunks directly would offer the same file's
// symptoms list once per heading it happens to have. Deduping by
// scope+project+file collapses that back to one candidate per file, which
// is the actual unit `symptoms:` is authored at.
function candidateEntries(chunks) {
  const byFile = new Map();
  for (const c of chunks || []) {
    const symptoms = Array.isArray(c.fmSymptoms) ? c.fmSymptoms : [];
    if (!symptoms.length) continue;
    const key = `${c.scope}:${c.project}:${c.file}`;
    if (byFile.has(key)) continue;
    byFile.set(key, {
      scope: c.scope,
      file: c.file,
      title: c.fmName || fileStem(c.file),
      body: c.fmDescription || c.fmFirstLine || '',
      sessions: Number.isFinite(c.fmSessions) ? c.fmSessions : 0,
      symptoms,
    });
  }
  return [...byFile.values()];
}

// Literal substring match, nothing scored. `haystack` is the already
// normalized, already lower-cased live error text; each candidate key is
// normalized (mojibake repair + prefix strip + whitespace collapse) the
// SAME way before comparing, so a key authored from a clean paste still
// matches a live error sourced from a damaged transcript, or vice versa
// (ADR Decision part 3).
//
// At most one gotcha per failure: when several entries' keys all hit,
// prefer the entry with the higher recorded `sessions:` (how many distinct
// real sessions recurrence.mjs measured this failure in — see
// hooks/lib/memory-index.mjs's parseFrontmatter and
// docs/adr/0002-stack-scoped-gotcha-retrieval.md); when that is tied
// (including the common case of neither entry carrying the field, i.e. both
// 0) fall back to the longer matched key, since a longer literal match is
// the more specific — and therefore more likely correct — fingerprint.
// Ties broken deterministically last, by file path, so the result never
// depends on filesystem walk order.
function findMatch(entries, normalizedError) {
  const haystack = normalizedError.toLowerCase();
  if (!haystack) return null;
  let best = null;
  for (const entry of entries) {
    for (const rawKey of entry.symptoms) {
      const key = normalizeErrorText(String(rawKey || '')).toLowerCase();
      if (key.length < MIN_KEY_CHARS) continue;
      if (!haystack.includes(key)) continue;
      const candidate = {
        entry, matchedKey: rawKey, keyLen: key.length,
      };
      if (
        !best
        || entry.sessions > best.entry.sessions
        || (entry.sessions === best.entry.sessions && candidate.keyLen > best.keyLen)
        || (entry.sessions === best.entry.sessions && candidate.keyLen === best.keyLen
          && entry.file < best.entry.file)
      ) {
        best = candidate;
      }
      break; // one hit is enough to qualify this entry — move to the next one
    }
  }
  return best;
}

function buildContext(match) {
  const { entry, matchedKey } = match;
  const title = entry.title || matchedKey;
  const body = entry.body || '';
  let out = `${MARKER}\n${title}`;
  if (body) out += `\n${body}`;
  if (out.length > MAX_CONTEXT_CHARS) out = `${out.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
  return out;
}

// --- Capture-on-miss: dataDir() (the plugin's disposable data root), NEVER
// the repo — a signature is real failure text and can carry absolute paths
// and real repo/project names (same reasoning as recurrence.mjs's own FIX
// 4). This is the backfill driver: candidate gotchas ranked by how often
// they actually happen, mined for real by a later, separate pass.
function recordMiss(normalizedError, payload) {
  try {
    const dir = join(dataDir(), 'gotcha-capture');
    mkdirSync(dir, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      session_id: String(payload?.session_id ?? ''),
      tool_name: payload?.tool_name || null,
      signature: normalizedError.slice(0, 300),
    };
    appendFileSync(join(dir, 'misses.jsonl'), `${JSON.stringify(row)}\n`);
  } catch { /* fail open */ }
}

// --- Dedup: never inject the same entry twice for the same tool_use_id.
// A tiny, capped, persisted id list under the same disposable data
// directory — hooks are stateless per invocation, so "already injected"
// has to live on disk to mean anything across calls. Capped so a very long
// session can never grow this file without bound.
const SEEN_CAP = 200;
function alreadyInjected(toolUseId) {
  if (!toolUseId) return false; // nothing to key on: never block on this alone
  const dir = join(dataDir(), 'gotcha-capture');
  const file = join(dir, 'injected-ids.json');
  let ids = [];
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) ids = parsed;
    }
  } catch { /* treat as empty: fail open toward re-injecting, not toward crashing */ }
  if (ids.includes(toolUseId)) return true;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify([...ids, toolUseId].slice(-SEEN_CAP)));
  } catch { /* fail open: worst case a rare double-injection, never a crash */ }
  return false;
}

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: text },
  }));
  process.exit(0);
}

export function run(payload) {
  if (!opt('gotcha_retrieval', true)) return passthrough();

  const rawError = payload?.tool_error;
  if (typeof rawError !== 'string' || !rawError.trim()) return passthrough();

  const normalized = normalizeErrorText(rawError);
  if (!normalized) return passthrough();

  const dataDirPath = dataDir();
  const { index: userIndex } = loadOrBuildIndex({
    root: memoryRoot(), dataDirPath, forceRebuild: false, rebuildIfStale: true,
  });

  let repoChunks = [];
  try {
    const found = findRepoRoot(payload?.cwd || process.cwd());
    if (found) {
      const { index: repoIndex } = loadOrBuildRepoIndex({
        root: found.root,
        dataDirPath,
        globs: DEFAULT_REPO_GLOBS,
        maxFileBytes: DEFAULT_REPO_MAX_FILE_BYTES,
        maxTotalBytes: DEFAULT_REPO_MAX_TOTAL_BYTES,
        forceRebuild: false,
        rebuildIfStale: true,
      });
      repoChunks = repoIndex?.chunks || [];
    }
  } catch { /* repo scope contributes nothing: user scope still applies */ }

  const entries = candidateEntries([...(userIndex?.chunks || []), ...repoChunks]);
  const match = findMatch(entries, normalized);

  if (!match) {
    if (!isFixtureSession(payload?.session_id)) recordMiss(normalized, payload);
    return passthrough();
  }

  if (alreadyInjected(payload?.tool_use_id)) return passthrough();

  return emitContext(buildContext(match));
}

// Everything below this line is a side effect (reads real stdin, may call
// process.exit) and must never run just because something imported this
// module — see lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md
// and scripts/recurrence.mjs's own module banner, which follows the same
// idiom for the same reason. `run` is exported specifically so a future
// caller (a test, another script) can import and call it directly without
// ever touching stdin or triggering an exit — tests/gotcha-retrieval.test.mjs
// does not need to today (it runs this file as a real child process, the
// same shape the harness uses), but the guard has to hold regardless of
// whether anything currently exercises that path, not just for callers that
// happen to exist yet.
function normalizePath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
const isMain = process.argv[1] && normalizePath(process.argv[1]) === normalizePath(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    run(readStdin());
  } catch {
    passthrough();
  }
}
