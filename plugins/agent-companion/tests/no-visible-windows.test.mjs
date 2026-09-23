// Static test: every process-spawning call in bench/ must pass
// `windowsHide: true`. A benchmark batch spawns dozens of `claude`
// processes (plus git/node helper calls) in a row -- on Windows, a spawn
// with no windowsHide option pops a visible console window per process,
// which is disruptive at that volume and was an open gap in the original
// bench/effort-grid harness (its own model-benchmark skill draft flagged
// this as something to VERIFY, not something already fixed — see
// docs/BENCHMARK.md "No visible windows"). This test makes it a checked
// invariant instead of a thing to remember to verify by hand.
//
// Deliberately a plain source-text grep, not an AST parse: the invariant is
// "this exact option, spelled this exact way, appears somewhere in the same
// call" and a regex over the call's own text is simpler and more direct
// than parsing for the same answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const FILES = [
  'bench/runner.mjs',
  'bench/tasks/common.mjs',
  'bench/task-packs/lib.mjs',
  'bench/task-packs/examples/leak-check-gitignore-fix/hidden-test.mjs',
];

// Matches an execFile(...)/execFileSync(...)/spawn(...) call's full argument
// list, non-greedy up to the matching close-paren of a SIMPLE (no nested
// parens inside a string literal containing ")") call -- true for every
// call site in this codebase, verified by inspection.
const CALL_RE = /\b(?:execFile|execFileSync|spawn)\s*\(([\s\S]*?)\)\s*;/g;

for (const rel of FILES) {
  test(`${rel}: every execFile/execFileSync/spawn call sets windowsHide: true`, () => {
    const text = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    const calls = [...text.matchAll(CALL_RE)];
    assert.ok(calls.length > 0, `expected at least one execFile/execFileSync/spawn call in ${rel} — update FILES/CALL_RE if the call shape changed`);
    for (const m of calls) {
      assert.match(m[0], /windowsHide\s*:\s*true/, `call without windowsHide:true in ${rel}:\n  ${m[0].replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  });
}
