// Auth-error handling for the live benchmark path (docs/BENCHMARK.md
// "Preconditions"). Found 2026-09-23: every live run under a redirected
// HOME failed OAuth auth silently -- is_error:true, terminal_reason:
// "api_error", cost_usd:0, answer text "Not logged in · Please run
// /login" -- and nothing told the operator this was an auth failure rather
// than the model failing every task. This file tests the fix's pieces at
// the unit level, same philosophy as tests/bench-sandbox-isolation.test.mjs:
// no test here spawns a real `claude` process (or fakes one) -- isAuthError(),
// checkIsolateHomePreflight(), formatRunLine(), authErrorAbortMessage(), and
// rebuildSummary()'s exclusion math are all pure/file-local logic, exercised
// directly or via a hand-written results.jsonl fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAuthError, checkIsolateHomePreflight, formatRunLine, authErrorAbortMessage, rebuildSummary,
} from '../bench/runner.mjs';
import { runScript } from './helpers.mjs';

// --- isAuthError(): classification -----------------------------------------

test('isAuthError: the exact shape reproduced live (is_error, terminal_reason api_error, cost $0, "Not logged in" text)', () => {
  const json = { is_error: true, terminal_reason: 'api_error', total_cost_usd: 0, num_turns: 1, result: 'Not logged in · Please run /login' };
  assert.equal(isAuthError({ json, answerText: json.result, stdout: JSON.stringify(json), err: null }), true);
});

test('isAuthError: text match alone is sufficient, even with no parsed json at all', () => {
  assert.equal(isAuthError({ json: null, answerText: '', stdout: 'Not logged in. Please run /login to continue.', err: null }), true);
  assert.equal(isAuthError({ json: null, answerText: '', stdout: 'error: 401 Unauthorized', err: null }), true);
  assert.equal(isAuthError({ json: null, answerText: '', stdout: '', err: 'authentication_error: invalid x-api-key' }), true);
});

test('isAuthError: text match is case-insensitive', () => {
  assert.equal(isAuthError({ json: null, answerText: 'NOT LOGGED IN', stdout: '', err: null }), true);
  assert.equal(isAuthError({ json: null, answerText: 'Invalid API Key provided', stdout: '', err: null }), true);
});

test('isAuthError: api_error + $0/null cost is classified as auth_error even without matching text', () => {
  assert.equal(isAuthError({ json: { is_error: true, terminal_reason: 'api_error', total_cost_usd: 0 }, answerText: '', stdout: '', err: null }), true);
  assert.equal(isAuthError({ json: { is_error: true, subtype: 'api_error', total_cost_usd: null }, answerText: '', stdout: '', err: null }), true);
});

test('isAuthError: NOT an auth error -- a genuine task failure or budget exhaustion with real cost/no error', () => {
  assert.equal(isAuthError({ json: { is_error: false, total_cost_usd: 0.02, result: 'The answer is 4.' }, answerText: 'The answer is 4.', stdout: '', err: null }), false);
  assert.equal(isAuthError({ json: { is_error: true, terminal_reason: 'budget_exhausted', total_cost_usd: 0.31 }, answerText: '', stdout: '', err: null }), false);
  assert.equal(isAuthError({ json: { is_error: true, terminal_reason: 'error_max_turns', total_cost_usd: 0.15 }, answerText: '', stdout: '', err: null }), false);
});

test('isAuthError: an api_error WITH real cost incurred is not auto-classified as auth_error', () => {
  assert.equal(isAuthError({ json: { is_error: true, terminal_reason: 'api_error', total_cost_usd: 0.05 }, answerText: '', stdout: '', err: null }), false);
});

// --- checkIsolateHomePreflight(): refuse --isolate-home with no API key ----

test('checkIsolateHomePreflight: throws when isolateHome is true and ANTHROPIC_API_KEY is unset', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => checkIsolateHomePreflight(true), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('checkIsolateHomePreflight: does not throw when isolateHome is true and ANTHROPIC_API_KEY is set', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fixture-key-not-real';
  try {
    assert.doesNotThrow(() => checkIsolateHomePreflight(true));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('checkIsolateHomePreflight: never throws when isolateHome is false, key or no key', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.doesNotThrow(() => checkIsolateHomePreflight(false));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('scripts/benchmark.mjs --isolate-home with no ANTHROPIC_API_KEY is a usage error (exit 2), before any dry-run/plan output', () => {
  const res = runScript('scripts/benchmark.mjs', ['--isolate-home', '--dry-run', '--cells', 'haiku', '--tasks', 'lookup', '--reps', '1'], {
    env: { ANTHROPIC_API_KEY: '' },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--isolate-home requires ANTHROPIC_API_KEY/);
  assert.doesNotMatch(res.stdout, /DRY RUN/);
});

test('scripts/benchmark.mjs --isolate-home WITH ANTHROPIC_API_KEY set proceeds past the preflight check (dry-run still makes no model call)', () => {
  const res = runScript('scripts/benchmark.mjs', ['--isolate-home', '--dry-run', '--cells', 'haiku', '--tasks', 'lookup', '--reps', '1'], {
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-fixture-key-not-real' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /--isolate-home: HOME\/USERPROFILE will be redirected/);
});

// --- formatRunLine(): the console line distinguishes auth_error from a ------
// --- plain pass=false, and surfaces is_error/terminal_reason too -----------

test('formatRunLine: a clean pass shows status=ok', () => {
  const line = formatRunLine({ pass: true, cost_usd: 0.01, num_turns: 3, is_error: false, auth_error: false }, 1234);
  assert.match(line, /status=ok/);
  assert.match(line, /pass=true/);
});

test('formatRunLine: an auth_error is status=auth_error, distinct from a plain task failure', () => {
  const line = formatRunLine({ pass: false, cost_usd: 0, num_turns: 1, is_error: true, terminal_reason: 'api_error', auth_error: true }, 500);
  assert.match(line, /status=auth_error/);
  assert.doesNotMatch(line, /status=error/);
});

test('formatRunLine: a genuine (non-auth) error surfaces its terminal_reason, not a bare pass=false', () => {
  const line = formatRunLine({ pass: false, cost_usd: 0.4, num_turns: 9, is_error: true, terminal_reason: 'budget_exhausted', auth_error: false }, 900);
  assert.match(line, /status=error\(budget_exhausted\)/);
});

// --- authErrorAbortMessage(): identifies the run and gives actionable guidance

test('authErrorAbortMessage: names the cell/task/rep and gives OAuth guidance when not isolating home', () => {
  const msg = authErrorAbortMessage({ cell: 'haiku', task: 'lookup', rep: 1, isolate_home: false });
  assert.match(msg, /haiku \/ lookup \/ rep1/);
  assert.match(msg, /OAuth session/);
  assert.match(msg, /AUTH ERROR/);
});

test('authErrorAbortMessage: gives ANTHROPIC_API_KEY guidance when isolate_home was set', () => {
  const msg = authErrorAbortMessage({ cell: 'sonnet-low', task: 'verify', rep: 2, isolate_home: true });
  assert.match(msg, /ANTHROPIC_API_KEY/);
});

// --- rebuildSummary(): auth_error rows are excluded from pass-rate/median --
// --- math, but counted and called out --------------------------------------

test('rebuildSummary excludes auth_error rows from pass_rate and every other stat, and flags the count in summary.md', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-summary-'));
  try {
    const rows = [
      // Two auth_error rows: BOTH pass:false, cost $0 -- if these leaked into
      // the math they would drag pass_rate to 0% and medians to 0.
      { cell: 'haiku', task: 'lookup', rep: 1, pass: false, is_error: true, auth_error: true, cost_usd: 0, output_tokens: 0, num_turns: 1 },
      { cell: 'haiku', task: 'lookup', rep: 2, pass: false, is_error: true, auth_error: true, cost_usd: 0, output_tokens: 0, num_turns: 1 },
      // One real, passing run.
      { cell: 'haiku', task: 'lookup', rep: 3, pass: true, is_error: false, auth_error: false, cost_usd: 0.02, output_tokens: 120, num_turns: 3, claim_honest: true, scope_ok: true },
    ];
    writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary.length, 1);
    assert.equal(summary[0].n, 1, 'the 2 auth_error rows must not count toward n');
    assert.equal(summary[0].pass_rate, 1, 'pass_rate must be computed only from the one real, passing run');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /AUTH ERROR: 2 run\(s\) failed authentication/);
    assert.match(md, /EXCLUDED from every stat below/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary with NO auth_error rows prints no AUTH ERROR note at all', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-summary-'));
  try {
    const rows = [
      { cell: 'haiku', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false, cost_usd: 0.02, output_tokens: 120, num_turns: 3 },
    ];
    writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rebuildSummary(outDir);
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /AUTH ERROR/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
