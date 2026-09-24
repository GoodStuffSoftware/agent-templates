// scripts/benchmark.mjs's pre-run estimate + confirmation gate, exercised as
// a subprocess exactly the way tests/bench-dry-run.test.mjs does. No model
// is ever called: a gated live run must refuse (or the ceiling stop must
// fire) BEFORE any "START ..." line is printed, and --dry-run never spawns
// anything at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runScript } from './helpers.mjs';

function bench(args, env = {}) {
  return runScript('scripts/benchmark.mjs', args, { env });
}

test('--dry-run prints a PRE-RUN ESTIMATE with the mapped seed family label, makes no model call', () => {
  const { cleanup } = makeFixture();
  try {
    const res = bench(['--dry-run', '--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PRE-RUN ESTIMATE/);
    assert.match(res.stdout, /family=easy-synthetic/, 'the bare "easy" task family is mapped to the seed\'s "easy-synthetic" label');
    assert.match(res.stdout, /current weekly usage: unknown/);
    assert.doesNotMatch(res.stdout, /START /);
  } finally {
    cleanup();
  }
});

test('a live run with a Fable cell refuses to start without --confirm (exit 2, no model call)', () => {
  const { cleanup } = makeFixture();
  try {
    const res = bench(['--cells', 'fable51-high', '--tasks', 'real-secret-scan', '--reps', '1'], {
      CLAUDE_BIN: 'C:\\nonexistent\\claude-should-never-be-called.exe',
    });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /CONFIRMATION REQUIRED/);
    assert.match(res.stdout + res.stderr, /Fable cell/);
    assert.doesNotMatch(res.stdout, /START /, 'refused before launching anything');
  } finally {
    cleanup();
  }
});

test('a live run above --confirm-above-points refuses without --confirm, and the estimate names the threshold', () => {
  const { cleanup } = makeFixture();
  try {
    const res = bench([
      '--cells', 'sonnet-medium', '--tasks', 'real-effort-note', '--reps', '1',
      '--confirm-above-points', '0',
    ], { CLAUDE_BIN: 'C:\\nonexistent\\claude-should-never-be-called.exe' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /confirmation threshold/);
  } finally {
    cleanup();
  }
});

test('--weekly-ceiling-pct already reached stops BEFORE the first cell, with --confirm past the initial gate (exit 0, no model call)', () => {
  const { cleanup } = makeFixture();
  try {
    const res = bench([
      '--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1',
      '--weekly-usage-pct', '95', '--weekly-ceiling-pct', '90', '--confirm',
    ], { CLAUDE_BIN: 'C:\\nonexistent\\claude-should-never-be-called.exe' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /CEILING REACHED/);
    assert.match(res.stdout, /Partial results:/);
    assert.doesNotMatch(res.stdout, /START /, 'stopped before starting the cell -- no model call attempted');
  } finally {
    cleanup();
  }
});

test('--weekly-usage-pct/--weekly-ceiling-pct absent: the estimate reads "unknown", never a guessed %', () => {
  const { cleanup } = makeFixture();
  try {
    const res = bench(['--dry-run', '--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1']);
    assert.match(res.stdout, /current weekly usage: unknown  ->  projected after this run: unknown/);
  } finally {
    cleanup();
  }
});
