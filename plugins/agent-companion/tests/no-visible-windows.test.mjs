// Static guard against the Windows flashing-console-window bug class.
//
// Background: on Windows, whichever process actually ALLOCATES a console
// (git.exe, node.exe, a shell resolving a .cmd/.bat shim) pops a real,
// focus-stealing window unless windowsHide rides the SAME child_process call
// that creates it -- a flag on an outer/ancestor spawn does not propagate.
// See scripts/lib/proc.mjs's module banner and
// ~/.claude/skills/team-orchestration/SKILL.md ("A dev server must open NO
// window") for the full mechanism and how it was found (best-sudoku,
// 2026-09-20).
//
// This test walks every *.mjs file under hooks/ and scripts/ (skipping their
// own tests/ and node_modules/) and fails if any bare
// spawn/spawnSync/exec/execSync/execFile/execFileSync call does not carry
// windowsHide somewhere in its own argument list. It is a static text/brace
// scan, not a type checker -- good enough to catch "someone added a new
// child_process call and forgot the flag," which is the failure mode this
// guards against, without needing a JS parser dependency.
//
// Deliberately does NOT flag:
//  - the underscore-aliased calls inside scripts/lib/proc.mjs itself
//    (`_execSync(...)`, `_execFileSync(...)`, `_spawnSync(...)`) -- those are
//    the one sanctioned place raw node:child_process is invoked, and they
//    hardcode windowsHide in their own call. The regex only matches BARE
//    names immediately preceded by a non-identifier, non-dot character, so
//    `_execSync(` and `execSyncHidden(` both fail to match.
//  - `something.exec(...)` (e.g. RegExp#exec, seen in hooks/self-update.mjs
//    and scripts/memory-vault.mjs) -- excluded by the same "not preceded by
//    `.`" rule, since node:child_process's functions are always called bare
//    (imported by name), never as a method, in this codebase.
//  - matches inside //-comments and /* */-comments -- blanked to
//    same-length whitespace (newlines preserved, so line numbers stay
//    accurate) before the call regex runs. Deliberately NOT attempting to
//    strip string/template-literal text the same way: an earlier version of
//    this test did, and a markdown-fence regex literal elsewhere in this
//    very plugin (``` inside a RegExp, e.g. `/^```/`) desynced a hand-rolled
//    backtick scanner and silently blanked out hundreds of lines of REAL
//    code, including an actual spawnSync(...) call -- turning this guard
//    into a no-op false negative, which is a far worse failure than the
//    false positive it was trying to avoid. So string/template contents are
//    left in place, and prose false positives (e.g. "N spawn(s) in 24h" in
//    a findings message) are filtered out instead by the looksLikeRealCall()
//    heuristic below: every real call site in this codebase either takes no
//    arguments, or its argument list contains a quote character or a comma;
//    "(s)" (bare single-letter, no quote, no comma) does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

const CHECKED_DIRS = ['hooks', 'scripts'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'tests', '__tests__']);

function walkMjs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkMjs(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(join(dir, entry.name));
  }
  return out;
}

// Blank //-line and /* block */ comments to same-length whitespace,
// preserving every newline so line numbers computed against the result
// still match the original file. Deliberately does NOT touch string,
// template, or regex literals -- see the module banner above for why a
// fuller scanner is actively dangerous here.
function stripComments(src) {
  const out = Array.from(src);
  const n = out.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blank(start, i);
    } else if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      blank(start, i);
    } else {
      i++;
    }
  }
  return out.join('');
}

// Bare function names only, not preceded by an identifier char, $, or `.`
// -- excludes both the proc.mjs underscore aliases/Hidden wrappers and any
// obj.exec(-style method call (RegExp#exec, etc).
const CALL_RE = /(?<![\w$.])(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(/g;

// From the index of an opening `(`, return the substring up to its matching
// closing `)`, tracking (), [], {} depth together.
function extractCallArgs(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx); // unbalanced (shouldn't happen in valid JS) -- fail open to "no windowsHide found"
}

// Every real child_process call site in this codebase either takes zero
// arguments or has an argument list containing a quote character or a comma
// (a command name, then options). A bare single-letter/short-identifier
// argument list with neither is the signature of a prose false positive
// like "N spawn(s) in 24h" surviving comment-stripping, not a real call.
function looksLikeRealCall(argsText) {
  const inner = argsText.slice(1, -1);
  return inner.trim() === '' || /['"`,]/.test(inner);
}

test('every child_process call in hooks/ and scripts/ carries windowsHide', () => {
  const violations = [];

  for (const dirName of CHECKED_DIRS) {
    const dir = join(pluginRoot, dirName);
    for (const file of walkMjs(dir)) {
      const original = readFileSync(file, 'utf8');
      const src = stripComments(original);
      let m;
      CALL_RE.lastIndex = 0;
      while ((m = CALL_RE.exec(src))) {
        const openParenIdx = m.index + m[0].length - 1;
        const argsText = extractCallArgs(src, openParenIdx);
        if (!looksLikeRealCall(argsText)) continue;
        if (!argsText.includes('windowsHide')) {
          const line = src.slice(0, m.index).split('\n').length;
          violations.push(`${file.replace(pluginRoot, '.')}:${line}: \`${m[1]}(\` has no windowsHide in its arguments`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `child_process call(s) missing windowsHide (Windows flashing-console-window risk):\n${violations.join('\n')}`,
  );
});