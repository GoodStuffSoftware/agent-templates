// recurrence-classify.mjs — sort a recurrence.mjs ranked row into one of
// guard / harness / environment / unknown, and harvest the guard markers
// that classification needs.
//
// Why this exists as its own module, separate from recurrence.mjs's scan:
// scanRecurrence() finds "text a TOOL reported, repeated across sessions" —
// it does not and should not know WHY that text recurs. Measured on the real
// corpus, most of what recurs is not a gotcha at all: this operator's own
// guard hooks correctly refusing something, or Claude Code's own tool layer
// complaining about agent behaviour (read-before-write, a stale old_string).
// Only a genuine external-world failure is worth spending tokens to write up
// as a symptom key (docs/adr/0002-stack-scoped-gotcha-retrieval.md) — this
// module is the filter that keeps the other two from burying it.
//
// Two different honesty postures on purpose:
//   - GUARD markers are harvested from source, never hardcoded — a guard's
//     wording lives in files this repo (or this operator's machine) owns,
//     and a hardcoded copy rots the first time someone edits a deny() call.
//   - HARNESS/ENVIRONMENT patterns ARE hardcoded — they describe Claude
//     Code's own tool-layer wording and the shape of a real OS/network/git
//     failure, neither of which is introspectable from any file this plugin
//     can read. Small and named, not a blanket guess.
//
// This is a heuristic, said out loud rather than hidden behind confident
// labels: `unknown` exists so a row this module cannot place fails toward a
// human's review, not toward silent exclusion from the backlog.
//
// Zero dependencies. Node builtins only.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../../hooks/lib/context.mjs';

// Default directories to harvest guard markers from: this plugin's own
// shipped hooks (portable — ships with the plugin, identical on every
// machine) and this operator's personal ~/.claude/hooks (machine-specific
// custom guards; may not exist at all — harvestGuardMarkers() fails open
// per-directory, see below). Resolved relative to THIS file's own location
// so callers (recurrence.mjs's CLI, detect.mjs's in-process check) never
// have to duplicate the path math or agree on a cwd.
export function defaultGuardMarkerDirs() {
  const pluginHooksDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
  return [pluginHooksDir, join(claudeDir(), 'hooks')];
}

// --- Guard-marker harvesting ------------------------------------------------

// A marker shorter than this is too generic to trust as "this text came from
// OUR guard" — e.g. an ack-topic string like 'junction' is exactly the kind
// of short, plausible-elsewhere token this floor exists to exclude. Chosen
// to sit just under the shortest genuinely distinctive prefix actually
// shipped today ("Delegation guard: that is ", 27 chars) while still well
// above any incidental short literal a hook file might contain.
const MIN_MARKER_LEN = 15;

// recurrence.mjs's own `sample` field (what a row is classified against) is
// truncated to 130 chars of the WHOLE matched text, prefix included (e.g.
// "Error: " or "error TS1234: " — see recurrence.mjs's PATTERNS and its
// `sample: m[0]...slice(0, 130)`). A marker longer than that can never be
// found as a substring of a row it genuinely came from — confirmed on a
// real corpus, where the ~185-char `--no-verify` guard message was present
// verbatim in a recurring row's raw transcript text but invisible to an
// unbounded marker, because the row's own `sample` had already been cut off
// mid-message before the marker's matching portion. Capped well under the
// ~120 usable chars (130 minus the longest realistic prefix) so a marker
// this long is truncated to its OWN start rather than silently unmatchable
// — the start of a hand-written denial message is already highly specific
// (see MIN_MARKER_LEN's own reasoning), so truncating the tail costs
// distinctiveness, not correctness.
const MAX_MARKER_LEN = 100;

function discoverMjsFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.mjs')) out.push(p);
    }
  }
  return out;
}

// Balanced-paren, quote-aware extraction of every `<name>(...)` call's raw
// argument source text from `src`. Depth is tracked only OUTSIDE a quote —
// once inside a '/"/` string, a paren character is just data (this is what
// lets a denial message safely contain inline code like `` `git push ...`) ``
// without closing the call early) — and a template literal's `${expr}`
// interior is likewise skipped rather than parsed, since every hook source
// this reads keeps such expressions paren-free (a bare identifier or a
// simple property/arithmetic access). Not a JS parser; good enough for the
// bounded, human-authored call shapes actually shipped in these files.
function extractCallArgs(src, name) {
  const marker = `${name}(`;
  const calls = [];
  let idx = 0;
  while (true) {
    const start = src.indexOf(marker, idx);
    if (start === -1) break;
    const before = start > 0 ? src[start - 1] : '';
    if (/[A-Za-z0-9_$]/.test(before)) { idx = start + marker.length; continue; } // e.g. "xdeny(" — not a real call
    let i = start + marker.length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    const argStart = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      }
      i++;
    }
    calls.push(src.slice(argStart, Math.max(argStart, i - 1)));
    idx = i;
  }
  return calls;
}

// Pull literal text out of a call's raw argument source: every quoted
// string (single/double/backtick), split on `${...}` interpolation so a
// template literal's placeholder never becomes part of a marker that could
// never match real transcript text (a marker containing the literal text
// "${growth}" would never match an actual number). Segments shorter than
// MIN_MARKER_LEN are dropped.
function literalSegments(argSrc) {
  const out = [];
  const strRe = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = strRe.exec(argSrc))) {
    const raw = m[0].slice(1, -1);
    const unescaped = raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\(.)/g, '$1');
    for (const seg of unescaped.split(/\$\{[^}]*\}/g)) {
      const trimmed = seg.replace(/\s+/g, ' ').trim();
      if (trimmed.length >= MIN_MARKER_LEN) out.push(trimmed.slice(0, MAX_MARKER_LEN));
    }
  }
  return out;
}

// Harvest every deny()-call literal segment from the .mjs files under each
// given directory (recursive). Fails open per-directory and per-file: a
// missing directory (e.g. no ~/.claude/hooks on a fresh machine) or an
// unreadable file just contributes nothing rather than throwing.
//
// Deliberately scoped to `deny(` calls, not "every string literal in the
// file" — several of these files also hold short, unrelated literals (ack
// topic names, a hardcoded worktree path) that would otherwise pollute the
// marker set with text that never appears in a real denial message.
export function harvestGuardMarkers(dirs) {
  const markers = new Set();
  let filesScanned = 0;
  let callsFound = 0;
  for (const dir of dirs || []) {
    if (!dir) continue;
    for (const f of discoverMjsFiles(dir)) {
      let src;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      filesScanned++;
      for (const argSrc of extractCallArgs(src, 'deny')) {
        callsFound++;
        for (const seg of literalSegments(argSrc)) markers.add(seg.toLowerCase());
      }
    }
  }
  return { markers: [...markers], filesScanned, callsFound };
}

// --- Harness (tool-layer) patterns ------------------------------------------
//
// Claude Code's own tool-result wording for an agent-behaviour mistake, not
// a fact about the world. Hardcoded and closed — unlike guard markers, there
// is no source file this plugin can read to re-derive these; they live in
// the harness binary. Kept small and specific on purpose: each entry names
// one real, recognisable tool error rather than a broad "sounds like a tool
// complaint" guess.
export const HARNESS_PATTERNS = [
  { label: 'read-before-write', re: /file has not been read yet/i },
  { label: 'edit-string-not-found', re: /string to replace not found in file/i },
  { label: 'max-tokens-exceeded', re: /exceeds maximum allowed tokens/i },
  { label: 'ripgrep-timeout', re: /\bripgrep\b[^\n]{0,40}\b(?:timed out|timeout)\b/i },
  // Found by running --init against a real 9.4GB/5,300-transcript corpus
  // (2026-09-22) and reading the top rows that landed in `unknown`: these
  // two were the #2 (71 sessions) and a top-25 (21 sessions) row overall,
  // both unmistakably Read/Edit tool-layer wrappers, not environment facts.
  { label: 'read-file-not-exist', re: /file does not exist\b[^\n]{0,60}your current working directory/i },
  { label: 'edit-stale-read', re: /file has been modified since read\b/i },
];

// --- Environment patterns ---------------------------------------------------
//
// Shapes that are, by construction, about the outside world (OS, filesystem,
// network, another process, git) rather than this operator's own guardrails
// or Claude Code's own tool layer. Deliberately narrower than
// recurrence.mjs's own PATTERNS (which exist to CAPTURE candidate failure
// text in the first place): a bare "Error: ..." or "exit code N" wrapper is
// too generic to tell a real environmental gotcha from a guard or harness
// message that happens to also start that way, so a row matching only the
// generic shape stays `unknown` rather than being guessed into
// `environment` — see the module banner.
export const ENVIRONMENT_PATTERNS = [
  // Base list from the brief's own examples, plus EISDIR/ENOTDIR/EMFILE/
  // ENOTEMPTY/EPIPE/ECONNRESET/ENETUNREACH/EHOSTUNREACH — the same kind of
  // standard POSIX/Node errno code as the originals, added after EISDIR
  // itself turned up as a real 35-session row (a genuinely-missing
  // node_modules file) on the 2026-09-22 real-corpus --init run.
  { label: 'errno', re: /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EADDRINUSE|EEXIST|EISDIR|ENOTDIR|EMFILE|ENOTEMPTY|EPIPE|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/ },
  { label: 'shell-not-recognized', re: /\bnot recognized as (?:an internal or external command|the name of a)/i },
  { label: 'command-not-found', re: /\bcommand not found\b/i },
  { label: 'no-such-file', re: /\bno such file or directory\b/i },
  { label: 'permission-denied', re: /\bpermission denied\b/i },
  { label: 'git-fatal', re: /\bfatal:\s*\S/i },
  { label: 'cannot-find-module', re: /\bcannot find (?:module|package|name)\b/i },
];

// --- Classification ----------------------------------------------------------

// Precedence: guard (exact-text, highest confidence) > harness (named,
// closed set) > environment (named, closed set) > unknown (fails toward
// review, never toward silent exclusion — see module banner).
export function classifyText(text, guardMarkers) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  for (const marker of guardMarkers || []) {
    if (marker && lower.includes(marker)) return 'guard';
  }
  for (const { re } of HARNESS_PATTERNS) if (re.test(s)) return 'harness';
  for (const { re } of ENVIRONMENT_PATTERNS) if (re.test(s)) return 'environment';
  return 'unknown';
}

// Classify a whole ranked[] array from scanRecurrence(). Pure: no I/O. Each
// row is classified on its `sample` text (the readable, un-redacted capture
// — see recurrence.mjs) falling back to `sig` if `sample` is absent, which
// only happens if a caller hand-builds a row (tests).
export function classifyRows(rows, guardMarkers) {
  const counts = { guard: 0, harness: 0, environment: 0, unknown: 0 };
  const out = (rows || []).map((r) => {
    const cls = classifyText(r.sample ?? r.sig, guardMarkers);
    counts[cls]++;
    return { ...r, class: cls };
  });
  return { rows: out, counts };
}

// Sort order for display: environment first (the only gotcha candidate —
// see module banner), then unknown (still worth a human's eye), then the
// two confirmed-noise classes. Stable secondary sort preserves the existing
// sessions-desc ranking within each class.
const CLASS_DISPLAY_ORDER = { environment: 0, unknown: 1, harness: 2, guard: 3 };
export function sortForDisplay(classifiedRows) {
  return [...classifiedRows].sort((a, b) => {
    const d = (CLASS_DISPLAY_ORDER[a.class] ?? 9) - (CLASS_DISPLAY_ORDER[b.class] ?? 9);
    if (d !== 0) return d;
    return b.sessions - a.sessions;
  });
}
