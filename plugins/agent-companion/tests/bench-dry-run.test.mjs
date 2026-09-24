// scripts/benchmark.mjs --dry-run: plan correctness, and that it NEVER
// spawns claude (no model call, no CLAUDE_BIN resolution needed — see
// bench/runner.mjs's lazy getClaudeBin()). Also covers --list, task-family
// expansion, and that the default results path resolves OUTSIDE this repo
// (the plugin data dir, never a path under PLUGIN_ROOT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, isAbsolute, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
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

test('--dry-run scales the shown --max-budget-usd by the cell\'s model price relative to Sonnet 5 (fable51-high: lookup\'s 0.6 * 5x = 3)', () => {
  const res = dryRun(['--cells', 'fable51-high', '--tasks', 'lookup', '--reps', '1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--model claude-fable-5-1\b/);
  assert.match(res.stdout, /--max-budget-usd 3\b/);
});

test('--dry-run scales the global --max-budget-usd ceiling too, before taking the tighter of the two (fable51-high, ceiling 1 -> scaled to 5, still looser than the task\'s scaled 3)', () => {
  const res = dryRun(['--cells', 'fable51-high', '--tasks', 'lookup', '--reps', '1', '--max-budget-usd', '1']);
  assert.equal(res.status, 0, res.stderr);
  // task default (0.6) scaled 5x = 3, ceiling (1) scaled 5x = 5 -- tighter is 3.
  assert.match(res.stdout, /--max-budget-usd 3\b/);
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

// --- FS9 (2026-09-24 round-2 family-split review, HIGH): scripts/benchmark.mjs --
// --- (the gated entry point) had no --evidence-family flag at all -----------------

test('FS9: --evidence-family overrides a task with no declared evidenceFamily, reflected in the pre-run estimate', () => {
  // "lookup" is a built-in easy task -- no evidenceFamily of its own, so it
  // normally estimates as family "easy-synthetic".
  const baseline = dryRun(['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1']);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /family=easy-synthetic\b/);

  const overridden = dryRun(['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--evidence-family', 'architecture']);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /family=architecture\b/);
  assert.doesNotMatch(overridden.stdout, /family=easy-synthetic\b/);
});

test('FS9: an unrecognized --evidence-family value is a usage error (exit 2), refused before any plan is printed', () => {
  const res = dryRun(['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--evidence-family', 'not-a-real-label']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /not a recognized fine label/);
  assert.doesNotMatch(res.stdout, /DRY RUN/);
});

test('FS9: AGENT_COMPANION_BENCH_EVIDENCE_FAMILY env var is used when --evidence-family is omitted, and an explicit flag wins over it', () => {
  const viaEnv = dryRun(
    ['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1'],
    { AGENT_COMPANION_BENCH_EVIDENCE_FAMILY: 'mined' },
  );
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.match(viaEnv.stdout, /family=mined\b/);

  const flagWins = dryRun(
    ['--cells', 'sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--evidence-family', 'architecture'],
    { AGENT_COMPANION_BENCH_EVIDENCE_FAMILY: 'mined' },
  );
  assert.equal(flagWins.status, 0, flagWins.stderr);
  assert.match(flagWins.stdout, /family=architecture\b/);
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

// --dry-run --resume must honor the resume marker and show only what's
// left, not the full original plan re-printed as if nothing had run yet
// (LOW finding: the dry-run branch used to exit BEFORE resume filtering ran
// at all, so `--dry-run --resume` was misleading mid-batch).
test('--dry-run --resume shows only the remaining cells, not the full original grid', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const outDir = join(dir, 'resume-test');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '.batch-state.json'), JSON.stringify({ completedCells: ['haiku'] }));

    const res = runScript('scripts/benchmark.mjs', [
      '--dry-run', '--resume', '--cells', 'haiku,sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--out-dir', outDir,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Resuming: 1\/2 cell\(s\) remaining \(sonnet-medium\)/);
    // haiku is marked complete -- must not appear in the planned-run lines.
    assert.doesNotMatch(res.stdout, /haiku \/ lookup/);
    assert.match(res.stdout, /sonnet-medium \/ lookup \/ rep1/);
  } finally {
    cleanup();
  }
});

test('--dry-run --resume with every requested cell already complete prints "Nothing to resume" and shows no plan', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const outDir = join(dir, 'resume-test-done');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '.batch-state.json'), JSON.stringify({ completedCells: ['haiku', 'sonnet-medium'] }));

    const res = runScript('scripts/benchmark.mjs', [
      '--dry-run', '--resume', '--cells', 'haiku,sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--out-dir', outDir,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Nothing to resume/);
    assert.doesNotMatch(res.stdout, /->  claude/);
  } finally {
    cleanup();
  }
});

test('--dry-run WITHOUT --resume is unaffected by an existing .batch-state.json (shows the full grid)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const outDir = join(dir, 'resume-test-ignored');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '.batch-state.json'), JSON.stringify({ completedCells: ['haiku'] }));

    const res = runScript('scripts/benchmark.mjs', [
      '--dry-run', '--cells', 'haiku,sonnet-medium', '--tasks', 'lookup', '--reps', '1', '--out-dir', outDir,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /Resuming:/);
    assert.match(res.stdout, /haiku \/ lookup \/ rep1/);
    assert.match(res.stdout, /sonnet-medium \/ lookup \/ rep1/);
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
