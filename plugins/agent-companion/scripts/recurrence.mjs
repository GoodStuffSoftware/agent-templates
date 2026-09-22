#!/usr/bin/env node
// recurrence.mjs — which failures have we hit in the MOST DISTINCT SESSIONS?
//
// Not a gotcha miner. It counts recurrence, which is the one signal that
// says "we have solved this before and had to solve it again". A thing
// struggled with five times left five traces in five sessions; a one-off
// left one. See docs/adr/0002-stack-scoped-gotcha-retrieval.md — this is
// the capture-on-miss half of that decision, brought forward because the
// recurrence data already exists in the transcripts.
//
// Deterministic, streaming, no model involved. Grew out of a prototype that
// ran the full corpus (5,203 transcripts / 9.23 GB) in ~90s; this version
// keeps that shape and fixes two real bugs the prototype run surfaced:
//
// FIX 1 — signed text is now restricted to tool_result content (message
// content blocks whose type is "tool_result", plus the top-level
// toolUseResult field Claude Code also writes). The prototype matched
// PATTERNS against every message's text, which means the OPERATOR'S OWN
// PROSE — standing rules, agent instructions, a line like "if the reviewer
// failed to catch it, update that agent's .md immediately" — matched
// "failed to" and got counted as a 70-session "recurring failure". That is
// not a failure recurring; it is boilerplate repeated in every brief that
// quotes it. A real failure is something a TOOL reported, so only tool
// output is eligible to be signed.
//
// FIX 2 — signatures strip a leading noise-prefix (Error:, ENOENT:, fatal:,
// error TS####:, and the other errno codes already in PATTERNS below)
// before normalising. Several PATTERNS entries can each match a different
// starting point inside ONE failure string — "Error: ENOENT: no such
// file…" matches the Error: pattern (from "Error:"), the errno pattern
// (from "ENOENT:"), and the "No such file" pattern (from "no such
// file…") — so one real failure produced THREE rows differing only in
// which label happened to prefix the captured span. The prefixes carry no
// information once the more specific text after them survives, so they are
// stripped, repeatedly (a message can stack more than one), before signing.
// Deliberately narrow: this does NOT strip SyntaxError:/TypeError:/etc. —
// which error CLASS occurred is part of what makes two failures the same
// or different, not noise to discard.
//
// FIX 3 — --since <ISO> skips any transcript whose mtime predates it, so
// the daily scout can scan incrementally instead of re-reading 9.2GB every
// morning. A full scan (no --since) is the fallback, used for the very
// first run and for a human asking "what's recurring, all time?".
//
// FIX 4 — this file's CLI writes its artifact under the plugin's disposable
// DATA directory (dataDir(), same root scripts/transcript-harvest.mjs uses
// for its own digest — see that script for the precedent), never the repo.
// A scan result contains absolute user paths, real repository names, and
// remote URLs pulled straight out of the operator's own transcripts;
// writing that into a public library's repo would fail
// scripts/leak-check.mjs and ship a real person's file layout to everyone
// who clones the library. dataDir() is already documented as exactly the
// right place for a disposable, regenerable artifact like this one.
//
// FIX 5 — full scan is an --init-ONLY operation now (2026-09-22 refinement).
// Fix 3 above originally made an absent cursor fall back to a full scan
// silently — right for a human's first-ever run, wrong for the DAILY scout,
// which would otherwise repeat that ~90s unattended walk every morning it
// has no cursor (e.g. after a state reset). The CLI's default/incremental
// path and detect.mjs's in-process check now both REQUIRE a cursor
// (state written by `--init`) and refuse — printing a one-line hint,
// scanning nothing — rather than guess. `--init` is the one deliberate
// full scan: it also classifies every row (guard / harness / environment /
// unknown — see scripts/lib/recurrence-classify.mjs) and seeds a
// persistent known-set from what is genuinely already understood (this
// machine's own guard denials, Claude Code's own tool-layer errors, and
// whatever the memory corpus already documents) so the real backlog —
// undocumented `environment`-class rows — is what survives, not buried
// under everything the first scan happens to find. An explicit `--since`
// still bypasses the cursor requirement, same as always: a human asking a
// direct question is not the unattended case this fix targets.
//
// FIX 6 — `--backfill` never spends a token on its own. The scan (and
// classification, and known-set seeding) is deterministic and free; only a
// MODEL reading candidate excerpts to draft symptom keys costs the
// operator's subscription allowance, and this script has no model access
// of its own (zero dependencies) to do that even if it wanted to. So
// `--backfill` alone only ever prints an estimate — candidate count,
// approximate excerpt volume, a pointer to
// plugins/agent-companion/docs/USAGE-ACCOUNTING.md for how allowance is
// actually weighted — and stops. `--backfill --yes` writes the reviewed
// candidate set to disk for a SEPARATE, subsequent agent-driven pass to
// read and draft from; it still never calls a model itself. Reads
// `--init`'s own persisted output (`init-latest.json`) rather than
// scanning again, so it can never become a second unattended full-scan
// path — see FIX 5.
//
// scanRecurrence() below is exported and used TWO ways: this file's own CLI
// (writes an artifact, prints a table or --json), and scripts/detect.mjs's
// "recurring_failures" scout check, which imports it directly and calls it
// IN-PROCESS — no subprocess, no argv-quoting, no JSON round-trip through a
// pipe — the same shape scripts/lib/coverage.mjs's telemetryCoverage()
// already established for detect.mjs's other transcript-scanning check.
// Because this file is importable, it follows
// lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md:
// everything CLI-shaped (argv parsing, stdout, process.exit, file writes)
// sits behind an is-main-module guard at the bottom, so `import
// './recurrence.mjs'` from detect.mjs runs nothing on its own. The same is
// true of `--backfill`'s model-spend gate specifically: it lives ENTIRELY
// inside runCli()/runBackfill() below the guard, is never exported, and
// detect.mjs's import of this file names only { scanRecurrence } — there is
// no path from the scout into it.
//
// Zero dependencies: Node builtins only.
//
// Usage:
//   node recurrence.mjs --init                          # the one full scan: classify + seed known-set + write cursor
//   node recurrence.mjs                                  # incremental; refuses if --init has never run
//   node recurrence.mjs --since 2026-09-01                # explicit human override, cursor or not
//   node recurrence.mjs --min-sessions 5 --top 10
//   node recurrence.mjs --json                            # full ranked array + scan metadata
//   node recurrence.mjs --out ./scan.json                  # override the write location
//   node recurrence.mjs --backfill                         # estimate only, writes nothing
//   node recurrence.mjs --backfill --yes                    # write the reviewed candidate set

import {
  readdirSync, statSync, createReadStream, mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  dataDir, claudeDir, stateFile, readJson, writeJson,
} from '../hooks/lib/context.mjs';
import { stripNoisePrefixes } from '../hooks/lib/text-normalize.mjs';
import {
  harvestGuardMarkers, classifyRows, sortForDisplay, defaultGuardMarkerDirs,
} from './lib/recurrence-classify.mjs';
import {
  loadOrBuildIndex, search, memoryRoot, findRepoRoot, loadOrBuildRepoIndex,
  DEFAULT_REPO_GLOBS, DEFAULT_REPO_MAX_FILE_BYTES, DEFAULT_REPO_MAX_TOTAL_BYTES,
} from '../hooks/lib/memory-index.mjs';

// Same override transcript-harvest.mjs reads, for the same reason: tests
// (and detect.mjs, when it wants to) need a scratch corpus, never the
// operator's real ~/.claude/projects.
function transcriptsRoot() {
  return process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT || join(claudeDir(), 'projects');
}

// --- FIX 1: where a failure is allowed to come from -------------------
//
// A tool_result content block's own `content` is either a plain string
// (Bash/PowerShell-shaped results) or an array of sub-blocks carrying
// `.text` (MCP-shaped results). The top-level `toolUseResult` field Claude
// Code also writes on the same record is either a plain string, or an
// object — in practice `{ stdout, stderr, ... }` for a shell tool — so only
// those two known string-bearing shapes are read; an unrecognised object
// shape (e.g. a Read tool's file payload) contributes nothing rather than
// being stringified wholesale, which would pull structured noise (and
// potentially megabytes of file content) into the pattern match below.
function toolResultTexts(rec) {
  const texts = [];
  const content = rec?.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      if (typeof block.content === 'string') {
        texts.push(block.content);
      } else if (Array.isArray(block.content)) {
        for (const sub of block.content) {
          if (typeof sub?.text === 'string') texts.push(sub.text);
        }
      }
    }
  }
  const tur = rec?.toolUseResult;
  if (typeof tur === 'string') {
    texts.push(tur);
  } else if (tur && typeof tur === 'object') {
    if (typeof tur.stdout === 'string') texts.push(tur.stdout);
    if (typeof tur.stderr === 'string') texts.push(tur.stderr);
    if (Array.isArray(tur.content)) {
      for (const sub of tur.content) {
        if (typeof sub?.text === 'string') texts.push(sub.text);
      }
    }
  }
  return texts;
}

// Error-shaped lines worth signing. Deliberately narrow: each names a real
// failure surface rather than any sentence containing the word "error".
const PATTERNS = [
  /\b(?:Error|error)\s*(?:TS\d+)?\s*:\s*[^\n]{12,180}/,
  /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EADDRINUSE|EEXIST)\b[^\n]{0,140}/,
  /\bexit(?:ed with)? code\s+[1-9]\d*[^\n]{0,120}/i,
  /\bfatal:\s*[^\n]{8,160}/,
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError)\b[^\n]{0,150}/,
  /\bnot recognized as (?:an internal or external command|the name of a)[^\n]{0,80}/i,
  /\bpermission denied[^\n]{0,120}/i,
  /\b(?:command not found|No such file or directory)[^\n]{0,120}/i,
  /\bfailed (?:with|to)\s[^\n]{8,150}/i,
  /\bcannot find (?:module|package|name)\b[^\n]{0,120}/i,
];

// --- FIX 2: collapse prefix variants of the SAME failure ----------------
//
// stripNoisePrefixes() (the label-wrapper strip — Error:/error TS####: from
// pattern 1, the errno codes from pattern 2, fatal: from pattern 4) now
// lives in hooks/lib/text-normalize.mjs, shared with
// hooks/gotcha-retrieval.mjs's own normalizer — see that ADR
// (docs/adr/0002-stack-scoped-gotcha-retrieval.md, Decision part 3) for why
// there must be exactly one implementation of this, not two that could
// silently drift apart. Imported above; nothing else in this section
// changed.

// Collapse the variable parts so the same failure in two repos is one row.
export function signature(s) {
  return stripNoisePrefixes(s)
    .replace(/[A-Za-z]:\\[^\s"'`]+|\/(?:[\w.-]+\/){2,}[\w.-]*/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
    .toLowerCase();
}

function discoverFiles(root) {
  const files = [];
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  })(root);
  return files;
}

// The scan, as a pure(ish) async function — no argv, no stdout, no process
// exit, no file writes. `root` and `sinceMs`/`minSessions` are all explicit
// parameters (never read from module-scope state) specifically so a test —
// or detect.mjs — can call this directly against a scratch corpus. See
// tests/recurrence.test.mjs.
export async function scanRecurrence({
  root = transcriptsRoot(),
  sinceMs = -Infinity,
  minSessions = 3,
} = {}) {
  const startedAt = Date.now();
  const allFiles = discoverFiles(root);

  // FIX 3: file-level --since filter. A transcript is append-only, so a
  // file whose mtime predates the cutoff cannot contain anything newer than
  // it — skip reading it at all rather than opening and immediately
  // discarding. (This is a FILE-level cutoff, not a per-line one: a file
  // touched since the cutoff is scanned in full, old lines included, same
  // as transcript-harvest.mjs's own --since. The accepted cost is a
  // signature that crosses minSessions only by combining several old,
  // untouched files with one new one will not be caught by an incremental
  // scan until something re-touches one of those old files — a full scan
  // is what finds that case, and Fix 3's own contract is "an incremental
  // scan is a fast, best-effort catch of what's newly active", not a
  // substitute for one.)
  const candidates = sinceMs === -Infinity
    ? allFiles
    : allFiles.filter((f) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(f).mtimeMs; } catch { return true; } // stat failed: scan it, don't guess
      return mtimeMs >= sinceMs;
    });

  const sigs = new Map(); // signature -> { sessions:Set, projects:Set, hits, first, last, sample }
  let bytesRead = 0;

  for (const f of candidates) {
    try { bytesRead += statSync(f).size; } catch { /* ignore */ }
    let rl;
    try { rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity }); } catch { continue; }
    for await (const L of rl) {
      if (L.length < 40) continue;
      // Cheap prefilter before the expensive JSON.parse + block walk.
      if (!/error|ENOENT|EACCES|fatal:|exit code|denied|not found|failed/i.test(L)) continue;
      let r; try { r = JSON.parse(L); } catch { continue; }
      const sid = r.sessionId; if (!sid) continue;
      const proj = (r.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '?';
      const when = (r.timestamp || '').slice(0, 10);

      const texts = toolResultTexts(r); // FIX 1: tool output only, never prose
      for (const t of texts) {
        if (t.length > 200000) continue;
        for (const re of PATTERNS) {
          const m = t.match(re);
          if (!m) continue;
          const sig = signature(m[0]); // FIX 2 happens inside signature()
          if (sig.length < 20) continue;
          let e = sigs.get(sig);
          if (!e) {
            e = {
              sessions: new Set(), projects: new Set(), hits: 0, first: when, last: when,
              sample: m[0].replace(/\s+/g, ' ').slice(0, 130),
            };
            sigs.set(sig, e);
          }
          e.sessions.add(sid); e.projects.add(proj); e.hits++;
          if (when && when < e.first) e.first = when;
          if (when && when > e.last) e.last = when;
        }
      }
    }
  }

  // The full ranked array — never capped by --top here. --top is a display
  // concern for the CLI's human table only; a caller diffing "what's newly
  // recurring" (detect.mjs) needs every row that cleared minSessions, not
  // just the biggest ones, or a newly-crossed signature that will never be
  // a top-30-by-session-count row would simply never be seen.
  const ranked = [...sigs.entries()]
    .map(([sig, e]) => ({
      sig, sessions: e.sessions.size, projects: e.projects.size, hits: e.hits,
      first: e.first, last: e.last, sample: e.sample,
    }))
    .filter((r) => r.sessions >= minSessions)
    .sort((a, b) => b.sessions - a.sessions);

  return {
    ranked,
    meta: {
      scannedAt: new Date().toISOString(),
      root,
      since: sinceMs === -Infinity ? null : new Date(sinceMs).toISOString(),
      scope: sinceMs === -Infinity ? 'full' : 'incremental',
      minSessions,
      filesFound: allFiles.length,
      filesScanned: candidates.length,
      filesSkippedByMtime: allFiles.length - candidates.length,
      bytesRead,
      distinctSignatures: sigs.size,
      recurringCount: ranked.length,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

// --- Known-set + cursor (Change 1/2 — see FIX 5 above) --------------------
//
// Shared, in that exact word, with scripts/detect.mjs's in-process scout
// check: both read/write these same three fields on the SAME file
// (stateFile('baseline.json')) through these two functions, so there is
// exactly one merge discipline for them even though two different entry
// points (this file's `--init`/default CLI, and detect.mjs's daily check)
// call in. baseline.json already documents "exactly ONE writer path" for
// itself (docs/TELEMETRY.md) — that was about collapsing several possible
// FILE LOCATIONS to one, not about limiting it to one caller, and a
// read-merge-write through these two functions preserves that discipline:
// neither caller ever touches a field it does not own.
//
// recurrenceKnown holds hashes only (hashSig below), never raw signature
// text or a file path — same privacy posture the pre-refinement
// recurrenceSeen field already had (see docs/TELEMETRY.md).
const RECURRENCE_KNOWN_CAP = 2000; // headroom over a real corpus's observed recurring-signature count
const RECURRENCE_STATE_KEYS = ['recurrenceLastScan', 'recurrenceKnown', 'recurrenceInit'];

export function hashSig(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

export function loadRecurrenceState() {
  const baseline = readJson(stateFile('baseline.json'), {});
  return {
    recurrenceLastScan: baseline.recurrenceLastScan || null,
    recurrenceKnown: Array.isArray(baseline.recurrenceKnown) ? baseline.recurrenceKnown : [],
    recurrenceInit: baseline.recurrenceInit || null,
  };
}

export function saveRecurrenceState(patch) {
  const file = stateFile('baseline.json');
  const baseline = readJson(file, {});
  const next = { ...baseline };
  for (const k of RECURRENCE_STATE_KEYS) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  writeJson(file, next);
}

export function capKnown(hashes) {
  return [...new Set(hashes)].slice(-RECURRENCE_KNOWN_CAP);
}

// --- CLI -----------------------------------------------------------------
// Everything below this line is a side effect (argv, stdout, file writes,
// process.exit) and must never run just because something imported this
// module — see the module banner and
// lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md.
// Same idiom scripts/memory-vault.mjs already uses for the same reason
// (it, too, is imported directly — by checks.mjs — as well as run as a CLI).
function normalizePath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
const isMain = process.argv[1] && normalizePath(process.argv[1]) === normalizePath(fileURLToPath(import.meta.url));

// Declared before the isMain call below, not after: `const` is block-scoped
// with a temporal dead zone, unlike the `function` declarations further
// down (fully hoisted, so their later position is fine) — runCli() can
// reference NO_CURSOR_HINT the instant it runs, and it runs on the very
// next line.
const NO_CURSOR_HINT = 'recurrence: no cursor yet — run `node recurrence.mjs --init` once (or use the setup skill) to establish the known-set and cursor. Refusing to run an unattended full scan (see FIX 5 in this file\'s module banner).';

if (isMain) {
  await runCli();
}

function writeScanArtifact(fileName, payload) {
  const outDir = join(dataDir(), 'recurrence-scan');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* best effort */ }
  const outPath = join(outDir, fileName);
  try {
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    return outPath;
  } catch (e) {
    console.error(`recurrence: could not write ${outPath}: ${e.message}`);
    return null;
  }
}

async function runCli() {
  const argv = process.argv.slice(2);
  const VALUE_FLAGS = new Set(['--since', '--min-sessions', '--top', '--out']);
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { values[a] = argv[++i]; continue; }
    flags.add(a);
  }

  if (flags.has('--backfill')) {
    await runBackfill({ proceedYes: flags.has('--yes') });
    return;
  }

  const isInit = flags.has('--init');
  const minSessions = values['--min-sessions'] ? Math.max(1, Number(values['--min-sessions']) || 3) : 3;
  const top = values['--top'] ? Math.max(1, Number(values['--top']) || 30) : 30;
  const asJson = flags.has('--json');
  const outArg = values['--out'] || null;

  const state = loadRecurrenceState();
  let sinceMs;
  if (isInit) {
    sinceMs = -Infinity; // the one deliberate full scan — see FIX 5
  } else if (values['--since']) {
    const parsed = Date.parse(values['--since']);
    if (Number.isNaN(parsed)) {
      console.error(`recurrence: --since "${values['--since']}" is not a parseable date (use an ISO date like 2026-08-01)`);
      process.exit(2);
    }
    sinceMs = parsed; // explicit human intent always bypasses the cursor requirement
  } else if (state.recurrenceLastScan) {
    sinceMs = Date.parse(state.recurrenceLastScan);
  } else {
    console.error(NO_CURSOR_HINT);
    if (asJson) process.stdout.write(JSON.stringify({ ranked: [], meta: { scope: 'no-cursor' } }));
    return;
  }

  const result = await scanRecurrence({ sinceMs, minSessions });

  // Classification is cheap (regex + a dozen small hook-source reads) and
  // safe to run unconditionally — unlike the memory-corpus "already
  // captured" check (init-only; see finishInit below), it never touches the
  // memory corpus, so there is no cost reason to gate it to --init.
  const { markers: guardMarkers } = harvestGuardMarkers(defaultGuardMarkerDirs());
  const { rows: classified, counts } = classifyRows(result.ranked, guardMarkers);

  if (isInit) {
    await finishInit({ result, classified, counts, known: new Set(state.recurrenceKnown || []) });
    return;
  }

  // --- default/incremental (and explicit --since) reporting --------------
  // FIX 4: default write location is the plugin's disposable data
  // directory, exactly mirroring transcript-harvest.mjs's own digest
  // location and naming (see that script, and this file's module banner,
  // for why: this artifact holds real paths, repo names, and URLs that
  // must never land in a public library's repo).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = outArg ? resolve(outArg) : join(dataDir(), 'recurrence-scan', `scan-${stamp}.json`);
  // Same best-effort guard transcript-harvest.mjs uses: --out is a
  // power-user escape hatch, and this script has no reliable way to know
  // where "the repo" is when invoked standalone, so it checks the one
  // thing it does know — its own grandparent (plugins/agent-companion/..)
  // is never a valid --out target.
  const repoGuessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (outArg && resolve(outPath).toLowerCase().startsWith(repoGuessRoot.toLowerCase())) {
    console.error(`recurrence: WARNING — --out resolves inside what looks like the plugin's own repo (${repoGuessRoot}). This scan can contain absolute paths, real repository names, and remote URLs pulled from the operator's own transcripts. Writing it into a repo risks committing it (node scripts/leak-check.mjs would fail). Strongly prefer the default location.`);
  }

  const payload = { meta: result.meta, ranked: classified };
  if (outArg) {
    try {
      writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
      console.error(`recurrence: wrote ${classified.length} row(s) to ${outPath}`);
    } catch (e) {
      console.error(`recurrence: could not write ${outPath}: ${e.message}`);
    }
  } else {
    const written = writeScanArtifact(`scan-${stamp}.json`, payload);
    // Confirmation always goes to stderr, never stdout: --json's stdout
    // must be nothing but the JSON payload, or a caller piping it into
    // JSON.parse (detect.mjs does not — it imports scanRecurrence()
    // directly — but a human scripting against the CLI might) breaks.
    if (written) console.error(`recurrence: wrote ${classified.length} row(s) to ${written}`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  const m = result.meta;
  console.log(`recurrence: scanned ${m.filesScanned.toLocaleString()}/${m.filesFound.toLocaleString()} transcript(s) (${m.scope}${m.since ? ` since ${m.since}` : ''}), ${(m.bytesRead / 1e9).toFixed(2)} GB, ${(m.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`distinct signatures: ${m.distinctSignatures.toLocaleString()} | recurring in ${minSessions}+ sessions: ${m.recurringCount.toLocaleString()}`);
  console.log(`class counts — environment: ${counts.environment} | unknown: ${counts.unknown} | harness: ${counts.harness} | guard: ${counts.guard}`);
  console.log('(showing NEW activity since the cursor above, not the full corpus — re-run with --init for the full picture)\n');
  console.log('cls  sess  proj  hits  first..last            signature');
  for (const r of sortForDisplay(classified).slice(0, top)) {
    console.log(
      r.class.slice(0, 3).padEnd(4),
      String(r.sessions).padStart(4),
      String(r.projects).padStart(5),
      String(r.hits).padStart(5),
      ` ${r.first}..${r.last}`,
      ' ' + r.sample.slice(0, 90),
    );
  }
}

// The one full-scan report: classify everything, seed the known-set from
// what is genuinely already understood (NOT from everything the scan
// found — that would bury the real backlog under noise, see Change 2 in
// the brief this implements), write the cursor, and leave a full-picture
// artifact (`init-latest.json`, fixed name, always the latest) for
// --backfill to read without ever scanning on its own.
async function finishInit({ result, classified, counts, known }) {
  const guardRows = classified.filter((r) => r.class === 'guard');
  const harnessRows = classified.filter((r) => r.class === 'harness');
  const candidates = classified.filter((r) => r.class === 'environment' || r.class === 'unknown');

  // Seed source 3: already documented in the memory corpus. Deliberately
  // --init-only — re-running BM25 search per candidate (search() retokenizes
  // its whole pool per call, see hooks/lib/memory-index.mjs) hundreds of
  // times on every DAILY incremental run would cost real CPU for no benefit
  // an occasional, human-invoked --init does not already provide just as
  // well. Reuses buildMemoryBrief()'s own calibrated minScore (25) rather
  // than deriving a new threshold — see hooks/lib/memory-brief.mjs's module
  // banner for the calibration finding that makes a fresh threshold here a
  // waste of effort: raw BM25 tracks query length almost as much as
  // relevance, and there is no better fixed number to find.
  const MEMORY_MIN_SCORE = 25;
  const memoryCapturedSigs = new Set();
  try {
    const dataDirPath = dataDir();
    const { index: userIndex } = loadOrBuildIndex({
      root: memoryRoot(), dataDirPath, forceRebuild: false, rebuildIfStale: true,
    });
    let repoChunks = [];
    try {
      const found = findRepoRoot(process.cwd());
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
    } catch { /* repo scope contributes nothing */ }
    const pool = [...(userIndex?.chunks || []), ...repoChunks];
    if (pool.length) {
      for (const row of candidates) {
        const hits = search(pool, row.sample, { limit: 3 });
        if (hits.length && hits[0].score >= MEMORY_MIN_SCORE) memoryCapturedSigs.add(row.sig);
      }
    }
  } catch { /* memory corpus unreadable: contributes nothing, --init still finishes */ }
  const memoryRows = candidates.filter((r) => memoryCapturedSigs.has(r.sig));

  const newlyKnown = [...guardRows, ...harnessRows, ...memoryRows].map((r) => hashSig(r.sig));
  const mergedKnown = capKnown([...known, ...newlyKnown]);

  const now = new Date().toISOString();
  const initSummary = {
    at: now,
    totalRows: classified.length,
    counts,
    seeded: {
      guard: guardRows.length, harness: harnessRows.length, memory: memoryRows.length, total: newlyKnown.length,
    },
  };
  saveRecurrenceState({ recurrenceLastScan: now, recurrenceKnown: mergedKnown, recurrenceInit: initSummary });
  const written = writeScanArtifact('init-latest.json', { meta: result.meta, rows: classified });

  const m = result.meta;
  console.log(`recurrence --init: full scan of ${m.filesScanned.toLocaleString()} transcript(s), ${(m.bytesRead / 1e9).toFixed(2)} GB, ${(m.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`rows per class — environment: ${counts.environment} | unknown: ${counts.unknown} | harness: ${counts.harness} | guard: ${counts.guard} (total ${classified.length})`);
  console.log(`seeded as known — guard: ${guardRows.length} | harness: ${harnessRows.length} | already-in-memory: ${memoryRows.length} | total newly known: ${newlyKnown.length} (known-set now ${mergedKnown.length})`);
  if (written) console.log(`full picture written to ${written} (read by --backfill; never re-scanned)`);
  console.log('classification is heuristic and WILL misfile some rows — that is what the "unknown" bucket is for (fails toward review, never toward silent exclusion).\n');

  const topEnv = classified.filter((r) => r.class === 'environment').sort((a, b) => b.sessions - a.sessions).slice(0, 10);
  console.log(`top ${topEnv.length} environment-class row(s) by distinct sessions:`);
  for (const r of topEnv) {
    const tag = memoryCapturedSigs.has(r.sig) ? '[already in memory]' : '[not yet documented]';
    console.log(`  ${String(r.sessions).padStart(3)} sessions  ${r.first}..${r.last}  ${tag}`);
    console.log(`      "${r.sample.slice(0, 110)}"`);
  }
}

// --backfill: estimate-then-gate, per Change 4. Reads --init's own
// init-latest.json rather than scanning — see FIX 6 above for why this
// function must never itself walk the transcript corpus. Everything here
// runs below the isMain guard and is never exported, so nothing in
// detect.mjs's scout path (which imports only { scanRecurrence } from this
// file) can reach it.
async function runBackfill({ proceedYes }) {
  const initPath = join(dataDir(), 'recurrence-scan', 'init-latest.json');
  let initData;
  try {
    initData = JSON.parse(readFileSync(initPath, 'utf8'));
  } catch {
    console.error(NO_CURSOR_HINT);
    console.error('recurrence --backfill: no init-latest.json found — --backfill reads --init\'s own output and never scans on its own.');
    return;
  }

  const state = loadRecurrenceState();
  const known = new Set(state.recurrenceKnown || []);
  // Only `environment` is a gotcha candidate (Change 3) — `unknown` rows are
  // not spent on until a human (or a re-run of --init after the memory
  // corpus grows) resolves the ambiguity.
  const candidates = (initData.rows || []).filter((r) => r.class === 'environment' && !known.has(hashSig(r.sig)));

  // Rough and clearly labeled as such — this number exists only to show the
  // shape (big vs small) before anyone commits to spending anything. See
  // plugins/agent-companion/docs/USAGE-ACCOUNTING.md for how allowance is
  // ACTUALLY accounted (weighted by model + effort, not raw token count) —
  // deliberately not restated here.
  const EXCERPTS_PER_CANDIDATE = 3;
  const ASSUMED_CHARS_PER_EXCERPT = 400;
  const estExcerpts = candidates.reduce((a, r) => a + Math.min(EXCERPTS_PER_CANDIDATE, Math.max(1, r.hits || 1)), 0);
  const estChars = estExcerpts * ASSUMED_CHARS_PER_EXCERPT;
  const estTokens = Math.round(estChars / 4);

  console.log(`recurrence --backfill: ${candidates.length} candidate(s) not yet known (environment-class, from the --init run at ${initData.meta?.scannedAt || 'an unknown time'}).`);
  console.log(`estimated excerpt volume: ~${estExcerpts} excerpt(s), ~${estChars.toLocaleString()} chars, ~${estTokens.toLocaleString()} tokens (rough — assumes up to ${EXCERPTS_PER_CANDIDATE} excerpts/candidate at ~${ASSUMED_CHARS_PER_EXCERPT} chars each).`);
  console.log('The scan above cost zero tokens. Drafting symptom keys from these excerpts is the ONLY step that spends the operator\'s subscription allowance, weighted by model and effort, not raw tokens — see plugins/agent-companion/docs/USAGE-ACCOUNTING.md.');

  if (!proceedYes) {
    console.log('\nDry run — nothing written. Re-run with `--backfill --yes` to write the reviewed candidate set for a subsequent drafting pass.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    preparedAt: new Date().toISOString(),
    sourceInitAt: initData.meta?.scannedAt || null,
    estimate: {
      candidates: candidates.length, excerpts: estExcerpts, chars: estChars, tokens: estTokens,
    },
    candidates,
  };
  const written = writeScanArtifact(`backfill-candidates-${stamp}.json`, payload);
  if (written) {
    console.log(`\nWrote ${candidates.length} candidate(s) to ${written}.`);
    console.log('This script does not draft anything itself (zero dependencies, no model access) — a separate, subsequent agent-driven pass reads this file to draft symptom keys.');
  }
}
