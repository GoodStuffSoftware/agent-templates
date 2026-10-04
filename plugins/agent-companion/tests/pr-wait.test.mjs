// scripts/pr-wait.mjs: wait for a PR's checks or a workflow run inside the
// script and print one final state. gh is stubbed: PR_WAIT_GH_SCRIPT points the
// script at a node file that plays back a scenario, so no network, no auth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { defaultRules, matchRules, PR_WAIT_HINT_TEXT } from '../hooks/lib/rules.mjs';
import { classifyCheck } from '../scripts/pr-wait.mjs';

const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'pr-wait.mjs');

// The stub gh. Subcommand "pr view" plays scenario.pr, "run view" scenario.run,
// "run list" scenario.list. Each entry is { out } (JSON on stdout) or
// { err, code } (a failure). The last entry repeats once the list runs out.
// Every call is appended to calls.log so a test can see exactly what was asked.
const STUB = `
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const [dir] = [process.env.PR_WAIT_STUB_DIR];
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', args.join(' ') + '\\n');
const key = args[0] === 'pr' ? 'pr' : args[1] === 'list' ? 'list' : 'run';
const scenario = JSON.parse(readFileSync(dir + '/scenario.json', 'utf8'));
const cf = dir + '/counter.json';
const counter = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8')) : {};
const i = counter[key] || 0;
counter[key] = i + 1;
writeFileSync(cf, JSON.stringify(counter));
const list = scenario[key] || [];
const step = list[Math.min(i, list.length - 1)];
if (!step) { process.stderr.write('stub: no scenario for ' + key + '\\n'); process.exit(1); }
if (step.err) { process.stderr.write(step.err + '\\n'); process.exit(step.code || 1); }
process.stdout.write(JSON.stringify(step.out));
`;

function setup(scenario, extraEnv = {}) {
  const fx = makeFixture();
  writeFileSync(join(fx.dir, 'gh-stub.mjs'), STUB);
  writeFileSync(join(fx.dir, 'scenario.json'), JSON.stringify(scenario));
  const env = {
    ...process.env,
    PR_WAIT_GH_SCRIPT: join(fx.dir, 'gh-stub.mjs'),
    PR_WAIT_STUB_DIR: fx.dir,
    PR_WAIT_POLL_MS: '20',
    PR_WAIT_POLL_MAX_MS: '40',
    PR_WAIT_NO_CHECKS_GRACE_MS: '150',
    CLAUDE_SESSION_ID: 'sess-prwait',
    ...extraEnv,
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines, start: lines[0], final: lines[1], detail: lines.slice(2) };
  };
  const calls = () => (existsSync(join(fx.dir, 'calls.log')) ? readFileSync(join(fx.dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  const rows = () => readJsonl(join(fx.stateDir, 'telemetry', 'pr-wait.jsonl'));
  return { fx, run, calls, rows };
}

const cr = (name, status, conclusion, url) => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: url || `https://ci.example/${name}` });
const pr = (state, checks, extra = {}) => ({ out: { number: 31, state, mergedAt: null, mergeStateStatus: 'CLEAN', statusCheckRollup: checks, url: 'https://github.com/o/r/pull/31', ...extra } });

test('checks pending, then all green: waits inside the script, exit 0, one start line, one final line', () => {
  const t = setup({ pr: [
    pr('OPEN', [cr('build', 'IN_PROGRESS', ''), cr('test', 'QUEUED', '')]),
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS'), cr('test', 'IN_PROGRESS', '')]),
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS'), cr('test', 'COMPLETED', 'SUCCESS')]),
  ] });
  try {
    const r = t.run('31', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.lines.length, 2, `start line plus one final line only:\n${r.stdout}`);
    assert.match(r.start, /^pr-wait: waiting on PR 31 \(o\/r\)/);
    assert.match(r.final, /^PR 31 OPEN PASS \| checks 2 passed, 0 failed, 2 total \| merge CLEAN \| \d+s$/);
    assert.equal(t.calls().length, 3);
    assert.ok(t.calls().every((c) => c.startsWith('pr view 31 --repo o/r --json ')), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('a failed check: exit 1, names and log URLs after the final line, never more than 10 lines', () => {
  const checks = [cr('build', 'COMPLETED', 'SUCCESS')];
  for (let i = 1; i <= 14; i += 1) checks.push(cr(`job-${i}`, 'COMPLETED', 'FAILURE', `https://ci.example/log/${i}`));
  const t = setup({ pr: [pr('OPEN', checks)] });
  try {
    const r = t.run('feature-branch');
    assert.equal(r.code, 1);
    assert.match(r.final, /^PR 31 OPEN FAIL \| checks 1 passed, 14 failed, 15 total \| \d+s$/);
    assert.ok(r.lines.length - 1 <= 10, `final line plus details must be at most 10 lines, got ${r.lines.length - 1}`);
    assert.match(r.detail[0], /^FAIL job-1 https:\/\/ci\.example\/log\/1$/);
    assert.match(r.detail[r.detail.length - 1], /^FAIL \.\.\. and \d+ more$/);
  } finally { t.fx.cleanup(); }
});

test('a PR that merges returns 0 at once, even with checks not finished', () => {
  const t = setup({ pr: [pr('MERGED', [cr('build', 'IN_PROGRESS', '')], { mergedAt: '2026-10-04T00:00:00Z' })] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.match(r.final, /^PR 31 MERGED \|/);
    assert.equal(t.calls().length, 1);
  } finally { t.fx.cleanup(); }
});

test('a PR closed unmerged returns 1', () => {
  const t = setup({ pr: [pr('CLOSED', [cr('build', 'IN_PROGRESS', '')])] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 1);
    assert.match(r.final, /^PR 31 CLOSED unmerged \|/);
  } finally { t.fx.cleanup(); }
});

test('timeout: exit 2, the checks still pending are named', () => {
  const t = setup({ pr: [pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS'), cr('slow', 'IN_PROGRESS', '', 'https://ci.example/slow')])] });
  try {
    const r = t.run('31', '--timeout', '1s');
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.final, /^PR 31 OPEN TIMEOUT after 1s \| checks 1 passed, 0 failed, 2 total, 1 pending \|/);
    assert.deepEqual(r.detail, ['PENDING slow https://ci.example/slow']);
    assert.ok(t.calls().length >= 3, 'it polled repeatedly while waiting');
  } finally { t.fx.cleanup(); }
});

test('a gh failure that will not heal (no such PR) exits 3 on the first call', () => {
  const t = setup({ pr: [{ err: 'GraphQL: Could not resolve to a PullRequest with the number of 999.', code: 1 }] });
  try {
    const r = t.run('999');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /gh failed: GraphQL: Could not resolve/);
    assert.equal(t.calls().length, 1);
    assert.equal(r.final, undefined, 'nothing but the start line on stdout');
  } finally { t.fx.cleanup(); }
});

test('a transient gh failure is retried and the run recovers', () => {
  const t = setup({ pr: [
    { err: 'HTTP 502: Bad Gateway', code: 1 },
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS')]),
  ] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(t.calls().length, 2);
  } finally { t.fx.cleanup(); }
});

test('gh failing every time gives up with exit 3 after a few tries', () => {
  const t = setup({ pr: [{ err: 'HTTP 502: Bad Gateway', code: 1 }] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 3);
    assert.equal(t.calls().length, 3);
  } finally { t.fx.cleanup(); }
});

test('usage errors exit 3 and never reach gh', () => {
  const t = setup({ pr: [pr('OPEN', [])] });
  try {
    for (const args of [[], ['31', '--timeout', 'soon'], ['31', '--bogus'], ['1', '2'], ['31', '--repo']]) {
      const r = t.run(...args);
      assert.equal(r.code, 3, `${args.join(' ')} -> ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /pr-wait:/);
    }
    assert.equal(t.calls().length, 0);
  } finally { t.fx.cleanup(); }
});

test('--help exits 0 and prints usage', () => {
  const t = setup({});
  try {
    const r = t.run('--help');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: pr-wait/);
  } finally { t.fx.cleanup(); }
});

test('a PR with no checks reports NO-CHECKS (exit 0) once the grace passes', () => {
  const t = setup({ pr: [pr('OPEN', [])] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.match(r.final, /^PR 31 OPEN NO-CHECKS \|/);
    assert.ok(t.calls().length >= 2, 'it waited out the grace, not just one look');
  } finally { t.fx.cleanup(); }
});

test('status contexts count too: a pending one holds the wait, an error fails it', () => {
  const t = setup({ pr: [
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 'https://old.example/1' }]),
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://old.example/1' }]),
  ] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 1);
    assert.match(r.final, /checks 1 passed, 1 failed, 2 total/);
    assert.equal(r.detail[0], 'FAIL ci/legacy https://old.example/1');
    assert.equal(t.calls().length, 2);
  } finally { t.fx.cleanup(); }
});

test('classifyCheck: skipped and neutral pass, cancelled and timed out fail, queued waits', () => {
  assert.equal(classifyCheck(cr('a', 'COMPLETED', 'SKIPPED')).verdict, 'pass');
  assert.equal(classifyCheck(cr('a', 'COMPLETED', 'NEUTRAL')).verdict, 'pass');
  assert.equal(classifyCheck(cr('a', 'COMPLETED', 'CANCELLED')).verdict, 'fail');
  assert.equal(classifyCheck(cr('a', 'COMPLETED', 'TIMED_OUT')).verdict, 'fail');
  assert.equal(classifyCheck(cr('a', 'QUEUED', '')).verdict, 'pending');
  assert.equal(classifyCheck({ context: 'x', state: 'EXPECTED' }).verdict, 'pending');
});

// ---- run mode

const job = (name, status, conclusion) => ({ name, status, conclusion, url: `https://github.com/o/r/actions/runs/7/job/${name}` });
const run = (status, conclusion, jobs) => ({ out: { databaseId: 7, status, conclusion, workflowName: 'CI', url: 'https://github.com/o/r/actions/runs/7', jobs } });

test('--run <id>: waits for the run, exit 0 on success', () => {
  const t = setup({ run: [
    run('in_progress', '', [job('build', 'completed', 'success'), job('test', 'in_progress', '')]),
    run('completed', 'success', [job('build', 'completed', 'success'), job('test', 'completed', 'success')]),
  ] });
  try {
    const r = t.run('--run', '7', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^RUN 7 \(CI\) PASS \| jobs 2 passed, 0 failed, 2 total \| \d+s$/);
    assert.ok(t.calls().every((c) => c.startsWith('run view 7 --repo o/r --json ')), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('--run <branch>: resolves the newest run on the branch first, exit 1 on failure with the failed job', () => {
  const t = setup({
    list: [{ out: [] }, { out: [{ databaseId: 7, status: 'queued' }] }],
    run: [run('completed', 'failure', [job('build', 'completed', 'success'), job('test', 'completed', 'failure')])],
  });
  try {
    const r = t.run('--run', 'my-branch');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.final, /^RUN 7 \(CI\) FAIL \(failure\) \| jobs 1 passed, 1 failed, 2 total/);
    assert.equal(r.detail[0], 'FAIL test https://github.com/o/r/actions/runs/7/job/test');
    assert.ok(t.calls()[0].startsWith('run list --branch my-branch --limit 1'), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('--run: a cancelled run with no failed job still names itself', () => {
  const t = setup({ run: [run('completed', 'cancelled', [job('build', 'completed', 'cancelled')])] });
  try {
    const r = t.run('--run', '7');
    assert.equal(r.code, 1);
    assert.ok(r.detail.length >= 1);
  } finally { t.fx.cleanup(); }
});

test('--run: times out with exit 2 when the run never finishes', () => {
  const t = setup({ run: [run('in_progress', '', [job('test', 'in_progress', '')])] });
  try {
    const r = t.run('--run', '7', '--timeout', '1s');
    assert.equal(r.code, 2);
    assert.match(r.final, /^RUN 7 \(CI\) TIMEOUT after 1s/);
    assert.match(r.detail[0], /^PENDING test /);
  } finally { t.fx.cleanup(); }
});

// ---- telemetry

test('telemetry: one row per run with mode, polls, duration, outcome and exit code', () => {
  const t = setup({ pr: [
    pr('OPEN', [cr('build', 'IN_PROGRESS', '')]),
    pr('OPEN', [cr('build', 'COMPLETED', 'SUCCESS')]),
  ], run: [run('completed', 'failure', [job('t', 'completed', 'failure')])] });
  try {
    assert.equal(t.run('31').code, 0);
    assert.equal(t.run('--run', '7').code, 1);
    assert.equal(t.run('31', '--timeout', 'soon').code, 3);
    const rows = t.rows();
    assert.equal(rows.length, 3);
    const [a, b, c] = rows;
    assert.deepEqual([a.mode, a.polls, a.outcome, a.exit_code, a.session_id], ['pr', 2, 'passed', 0, 'sess-prwait']);
    assert.deepEqual([b.mode, b.polls, b.outcome, b.exit_code], ['run', 1, 'failed', 1]);
    assert.deepEqual([c.outcome, c.exit_code], ['usage', 3]);
    for (const r of rows) {
      assert.ok(Number.isFinite(r.duration_ms) && r.duration_ms >= 0);
      assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
      assert.equal(r.v, 2);
    }
  } finally { t.fx.cleanup(); }
});

test('telemetry: no session id exported means no session_id field', () => {
  const t = setup({ pr: [pr('MERGED', [], { mergedAt: 'x' })] }, { CLAUDE_SESSION_ID: '' });
  try {
    assert.equal(t.run('31').code, 0);
    assert.ok(!('session_id' in t.rows()[0]));
  } finally { t.fx.cleanup(); }
});

test('telemetry: still written with the pr_wait hint option off (it only hides the line)', () => {
  const t = setup({ pr: [pr('MERGED', [], { mergedAt: 'x' })] }, { CLAUDE_PLUGIN_OPTION_PR_WAIT: '0' });
  try {
    assert.equal(t.run('31').code, 0);
    assert.equal(t.rows().length, 1);
  } finally { t.fx.cleanup(); }
});

// ---- discoverability line and the pr_wait toggle

test('the hint line is one line of 150 characters or fewer and names the script and the release tools', () => {
  assert.ok(PR_WAIT_HINT_TEXT.length <= 150, `${PR_WAIT_HINT_TEXT.length} chars`);
  assert.ok(!PR_WAIT_HINT_TEXT.includes('\n'));
  assert.match(PR_WAIT_HINT_TEXT, /scripts\/pr-wait\.mjs/);
  assert.match(PR_WAIT_HINT_TEXT, /verify_release/);
  assert.match(PR_WAIT_HINT_TEXT, /merge_to_main/);
});

test('pr-wait-hint is a built-in lead-audience session-start rule, on by default, switched off by CLAUDE_PLUGIN_OPTION_PR_WAIT=0', () => {
  const fx = makeFixture();
  const saved = process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT;
  try {
    delete process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT;
    const def = defaultRules().find((r) => r.id === 'pr-wait-hint');
    assert.ok(def && def.enabled && def.scope === 'session-start' && def.gate === 'pr_wait');
    assert.ok(matchRules({ scope: 'session-start', sessionId: 's1' }).some((r) => r.id === 'pr-wait-hint'), 'on by default');
    process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT = '0';
    assert.ok(!matchRules({ scope: 'session-start', sessionId: 's1' }).some((r) => r.id === 'pr-wait-hint'), 'env override hides it');
    process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT = 'false';
    assert.ok(!matchRules({ scope: 'session-start', sessionId: 's1' }).some((r) => r.id === 'pr-wait-hint'));
    process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT = '1';
    assert.ok(matchRules({ scope: 'session-start', sessionId: 's1' }).some((r) => r.id === 'pr-wait-hint'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT; else process.env.CLAUDE_PLUGIN_OPTION_PR_WAIT = saved;
    fx.cleanup();
  }
});

test('plugin.json declares pr_wait as a boolean defaulting to on', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.pr_wait;
  assert.equal(cfg.type, 'boolean');
  assert.equal(cfg.default, true);
});
