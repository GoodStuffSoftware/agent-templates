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
// './recurrence.mjs'` from detect.mjs runs nothing on its own.
//
// Zero dependencies: Node builtins only.
//
// Usage:
//   node recurrence.mjs                                # full scan, human table
//   node recurrence.mjs --since 2026-09-01              # incremental
//   node recurrence.mjs --min-sessions 5 --top 10
//   node recurrence.mjs --json                          # full ranked array + scan metadata
//   node recurrence.mjs --out ./scan.json                # override the write location

import {
  readdirSync, statSync, createReadStream, mkdirSync, writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dataDir, claudeDir } from '../hooks/lib/context.mjs';

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
// Covers exactly the label-wrapper prefixes PATTERNS above can each latch
// onto independently (Error:/error TS####: from pattern 1, the errno codes
// from pattern 2, fatal: from pattern 4) — a bounded, named list, not a
// blanket "strip anything before a colon" rule that would also eat the
// error CLASS off SyntaxError:/TypeError:/etc. and wrongly merge genuinely
// different failures.
const NOISE_PREFIX_RE = /^(?:error\s*(?:ts\d+)?|enoent|eacces|eperm|econnrefused|etimedout|eaddrinuse|eexist|fatal)\s*:\s*/i;

function stripNoisePrefixes(s) {
  let out = String(s).trim();
  // A message can stack more than one label ("Error: ENOENT: …") — strip
  // until nothing more matches. The equality check guarantees termination;
  // the iteration cap is defensive belt-and-braces, not load-bearing.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(NOISE_PREFIX_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

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

// --- CLI -----------------------------------------------------------------
// Everything below this line is a side effect (argv, stdout, file writes,
// process.exit) and must never run just because something imported this
// module — see the module banner and
// lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md.
// Same idiom scripts/memory-vault.mjs already uses for the same reason
// (it, too, is imported directly — by checks.mjs — as well as run as a CLI).
function normalizePath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
const isMain = process.argv[1] && normalizePath(process.argv[1]) === normalizePath(fileURLToPath(import.meta.url));

if (isMain) {
  await runCli();
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

  let sinceMs = -Infinity;
  if (values['--since']) {
    const parsed = Date.parse(values['--since']);
    if (Number.isNaN(parsed)) {
      console.error(`recurrence: --since "${values['--since']}" is not a parseable date (use an ISO date like 2026-08-01)`);
      process.exit(2);
    }
    sinceMs = parsed;
  }
  const minSessions = values['--min-sessions'] ? Math.max(1, Number(values['--min-sessions']) || 3) : 3;
  const top = values['--top'] ? Math.max(1, Number(values['--top']) || 30) : 30;
  const asJson = flags.has('--json');
  const outArg = values['--out'] || null;

  const result = await scanRecurrence({ sinceMs, minSessions });

  // FIX 4: default write location is the plugin's disposable data
  // directory, exactly mirroring transcript-harvest.mjs's own digest
  // location and naming (see that script, and this file's module banner,
  // for why: this artifact holds real paths, repo names, and URLs that
  // must never land in a public library's repo).
  const outDir = join(dataDir(), 'recurrence-scan');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* best effort */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultPath = join(outDir, `scan-${stamp}.json`);
  const outPath = outArg ? resolve(outArg) : defaultPath;

  // Same best-effort guard transcript-harvest.mjs uses: --out is a
  // power-user escape hatch, and this script has no reliable way to know
  // where "the repo" is when invoked standalone, so it checks the one
  // thing it does know — its own grandparent (plugins/agent-companion/..)
  // is never a valid --out target.
  const repoGuessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (outArg && resolve(outPath).toLowerCase().startsWith(repoGuessRoot.toLowerCase())) {
    console.error(`recurrence: WARNING — --out resolves inside what looks like the plugin's own repo (${repoGuessRoot}). This scan can contain absolute paths, real repository names, and remote URLs pulled from the operator's own transcripts. Writing it into a repo risks committing it (node scripts/leak-check.mjs would fail). Strongly prefer the default location (${defaultPath}).`);
  }

  const payload = { meta: result.meta, ranked: result.ranked };
  try {
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    // Confirmation always goes to stderr, never stdout: --json's stdout
    // must be nothing but the JSON payload, or a caller piping it into
    // JSON.parse (detect.mjs does not — it imports scanRecurrence()
    // directly — but a human scripting against the CLI might) breaks.
    console.error(`recurrence: wrote ${result.ranked.length} row(s) to ${outPath}`);
  } catch (e) {
    console.error(`recurrence: could not write ${outPath}: ${e.message}`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  const m = result.meta;
  console.log(`recurrence: scanned ${m.filesScanned.toLocaleString()}/${m.filesFound.toLocaleString()} transcript(s) (${m.scope}${m.since ? ` since ${m.since}` : ''}), ${(m.bytesRead / 1e9).toFixed(2)} GB, ${(m.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`distinct signatures: ${m.distinctSignatures.toLocaleString()} | recurring in ${minSessions}+ sessions: ${m.recurringCount.toLocaleString()}\n`);
  console.log('sess  proj  hits  first..last            signature');
  for (const r of result.ranked.slice(0, top)) {
    console.log(
      String(r.sessions).padStart(4),
      String(r.projects).padStart(5),
      String(r.hits).padStart(5),
      ` ${r.first}..${r.last}`,
      ' ' + r.sample.slice(0, 96),
    );
  }
}
