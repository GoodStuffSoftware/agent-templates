// scripts/benchmark.mjs --dry-run: plan correctness, and that it NEVER
// spawns claude (no model call, no CLAUDE_BIN resolution needed — see
// bench/runner.mjs's lazy getClaudeBin()). Also covers --list, task-family
// expansion, and that the default results path resolves OUTSIDE this repo
// (the plugin data dir, never a path under PLUGIN_ROOT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, isAbsolute } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

function dryRun(args, env = {}) {
  return runScript('scripts/benchmark.mjs', ['--dry-run', ...args], { env });
}

test('--dry-run makes no model call: exits 0 with no claude/CLAUDE_BIN dependency', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // CLAUDE_BIN deliberately points at something that does not exist --
    // if --dry-run ever tried to resolve or spawn it, this would fail loudly
    // instead of silently succeeding.
    const res = dryRun(['--cells', 'haiku', '--tasks', 'lookup', '--reps', '1'], {
      CLAUDE_BIN: 'C:\\nonexistent\\claude-should-never-be-called.exe',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /DRY RUN/);
    assert.doesNotMatch(res.stdout, /nonexistent/);
    void dir;
  } finally {
    cleanup();
  }
});

test('--dry-run plan correctness: cell x task x rep counts match the request', () => {
  const res = dryRun(['--cells', 'haiku,sonnet-medium', '--tasks', 'easy', '--reps', '2']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cells:\s+2\s+\(haiku, sonnet-medium\)/);
  assert.match(res.stdout, /tasks:\s+6\s+/); // the "easy" family has 6 tasks
  assert.match(res.stdout, /reps:\s+2/);
  assert.match(res.stdout, /total runs:\s+24/); // 2 cells * 6 tasks * 2 reps
  // Every planned run line is present exactly once.
  const plannedLines = res.stdout.split('\n').filter((l) => l.includes('->  claude'));
  assert.equal(plannedLines.length, 24);
});

test('--dry-run shows the exact claude args per run, including effort and the model id (not a bare alias)', () => {
  const res = dryRun(['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--model claude-sonnet-5\b/);
  assert.match(res.stdout, /--effort medium\b/);
  assert.match(res.stdout, /--setting-sources ""/);
  assert.match(res.stdout, /--dangerously-skip-permissions/);
  assert.match(res.stdout, /--strict-mcp-config/);
});

test('--dry-run applies the global --max-budget-usd ceiling to the shown args (tighter of the two)', () => {
  const res = dryRun(['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--max-budget-usd', '0.01']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--max-budget-usd 0\.01\b/);
});

test('--tasks family expansion: easy/hard/real are disjoint and union to "all"', () => {
  const easy = dryRun(['--cells', 'haiku', '--tasks', 'easy', '--reps', '1']);
  const hard = dryRun(['--cells', 'haiku', '--tasks', 'hard', '--reps', '1']);
  const real = dryRun(['--cells', 'haiku', '--tasks', 'real', '--reps', '1']);
  const all = dryRun(['--cells', 'haiku', '--tasks', 'all', '--reps', '1']);
  const countOf = (res) => Number(res.stdout.match(/tasks:\s+(\d+)\s+/)[1]);
  const easyN = countOf(easy);
  const hardN = countOf(hard);
  const realN = countOf(real);
  const allN = countOf(all);
  assert.equal(easyN + hardN + realN, allN, `${easyN}+${hardN}+${realN} should equal ${allN}`);
});

test('an unknown task/family is a usage error (exit 2), not a silent no-op', () => {
  const res = dryRun(['--cells', 'haiku', '--tasks', 'not-a-real-task', '--reps', '1']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown task or family/);
});

test('an unknown cell is a usage error (exit 2)', () => {
  const res = dryRun(['--cells', 'not-a-real-cell', '--tasks', 'lookup', '--reps', '1']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown cell/);
});

test('--list prints cells, families, and every task id, and makes no model call', () => {
  const res = runScript('scripts/benchmark.mjs', ['--list']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /haiku/);
  assert.match(res.stdout, /easy\s+lookup/);
  assert.match(res.stdout, /real-capacity/);
});

test('the default results directory resolves OUTSIDE this repo (the plugin data dir), never under PLUGIN_ROOT', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = dryRun(['--cells', 'haiku', '--tasks', 'lookup', '--reps', '1'], {
      CLAUDE_PLUGIN_DATA: dir + '\\data',
    });
    assert.equal(res.status, 0, res.stderr);
    const m = res.stdout.match(/out dir:\s+(.+)/);
    assert.ok(m, 'expected an "out dir:" line');
    const outDir = m[1].trim();
    assert.ok(isAbsolute(outDir), `out dir should be absolute, got ${outDir}`);
    const rel = relative(PLUGIN_ROOT, outDir);
    assert.ok(rel.startsWith('..'), `out dir ${outDir} must be outside the repo (relative(PLUGIN_ROOT, outDir) = ${rel})`);
    assert.match(outDir, /benchmarks[\\/]pilot-\d{4}-\d{2}-\d{2}/);
  } finally {
    cleanup();
  }
});

test('--phase changes the default out-dir\'s phase label', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = dryRun(['--cells', 'haiku', '--tasks', 'lookup', '--reps', '1', '--phase', 'real'], {
      CLAUDE_PLUGIN_DATA: dir + '\\data',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /benchmarks[\\/]real-\d{4}-\d{2}-\d{2}/);
  } finally {
    cleanup();
  }
});

test('--out-dir overrides the default and is honored verbatim (resolved absolute)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const target = dir + '\\my-custom-results';
    const res = dryRun(['--cells', 'haiku', '--tasks', 'lookup', '--reps', '1', '--out-dir', target]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`out dir:\\s+${target.replace(/[\\]/g, '\\\\')}`));
  } finally {
    cleanup();
  }
});
