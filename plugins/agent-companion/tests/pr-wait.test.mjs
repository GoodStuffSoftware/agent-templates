// scripts/pr-wait.mjs: wait for a PR's checks or a workflow run inside the
// script and print one final state. gh is stubbed: PR_WAIT_GH_SCRIPT points the
// script at a node file that plays back a scenario, so no network, no auth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeFixture, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { defaultRules, matchRules, PR_WAIT_HINT_TEXT, PR_WAIT_HINT_WORDING } from '../hooks/lib/rules.mjs';

const rulesPath = join(PLUGIN_ROOT, 'hooks', 'lib', 'rules.mjs');
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
let key = args[0] === 'pr' ? 'pr' : args[1] === 'list' ? 'list' : 'run';
let ndjson = false;
if (args[0] === 'api') {
  const m = /commits\\/([^/?]+)\\/(check-runs|status)/.exec(args[1] || '');
  if (m) { key = (m[2] === 'status' ? 'st:' : 'cr:') + m[1]; ndjson = true; }
  else if (/\\/branches\\//.test(args[1] || '')) key = 'branch';
}
const scenario = JSON.parse(readFileSync(dir + '/scenario.json', 'utf8'));
const cf = dir + '/counter.json';
const counter = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8')) : {};
const i = counter[key] || 0;
counter[key] = i + 1;
writeFileSync(cf, JSON.stringify(counter));
const list = key.startsWith('cr:') ? (scenario.checkRuns || {})[key.slice(3)] || []
  : key.startsWith('st:') ? (scenario.statuses || {})[key.slice(3)] || [{ out: [] }]
  : scenario[key] || [];
const step = list[Math.min(i, list.length - 1)];
if (!step) { process.stderr.write('stub: no scenario for ' + key + '\\n'); process.exit(1); }
if (step.err) { process.stderr.write(step.err + '\\n'); process.exit(step.code || 1); }
process.stdout.write(ndjson ? step.out.map((x) => JSON.stringify(x)).join('\\n') : JSON.stringify(step.out));
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
    PR_WAIT_SETTLE_MS: '60',
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

// API-shaped check run / status, as `gh api .../commits/<sha>/check-runs` returns them.
const cr = (name, status, conclusion, url) => ({ name, status: String(status).toLowerCase(), conclusion: String(conclusion || '').toLowerCase() || null, html_url: url || `https://ci.example/${name}` });
const st = (context, state, url) => ({ context, state, target_url: url });
const pr = (state, sha, extra = {}) => ({ out: { number: 31, state, mergedAt: null, mergeStateStatus: 'CLEAN', headRefOid: sha, url: 'https://github.com/o/r/pull/31', ...extra } });
const checks = (...runs) => ({ out: runs });
// One head commit all along: pr view step i pairs with check-run step i.
const onSha = (sha, prSteps, runSteps, extra = {}) => ({ pr: prSteps, checkRuns: { [sha]: runSteps }, ...extra });
const isApi = (c) => c.startsWith('api ');

test('checks pending, then all green: waits inside the script, exit 0, one start line, one final line', () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [
    checks(cr('build', 'in_progress'), cr('test', 'queued')),
    checks(cr('build', 'completed', 'success'), cr('test', 'in_progress')),
    checks(cr('build', 'completed', 'success'), cr('test', 'completed', 'success')),
  ]));
  try {
    const r = t.run('31', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.lines.length, 2, `start line plus one final line only:\n${r.stdout}`);
    assert.match(r.start, /^pr-wait: waiting on PR 31 \(o\/r\)/);
    assert.match(r.final, /^PR 31 OPEN PASS @sha-1 \| checks 2 passed, 0 failed, 2 total \| merge CLEAN \| \d+s$/);
    assert.equal(t.calls().length, 12, 'four polls of pr view + check-runs + status: pending, pending, green, green again (settled)');
    assert.ok(t.calls().filter((c) => c.startsWith('pr view')).every((c) => c.startsWith('pr view 31 --repo o/r --json ')), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('a failed check: exit 1, names and log URLs after the final line, never more than 10 lines', () => {
  const runs = [cr('build', 'completed', 'success')];
  for (let i = 1; i <= 14; i += 1) runs.push(cr(`job-${i}`, 'completed', 'failure', `https://ci.example/log/${i}`));
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks(...runs)]));
  try {
    const r = t.run('feature-branch');
    assert.equal(r.code, 1);
    assert.match(r.final, /^PR 31 OPEN FAIL @sha-1 \| checks 1 passed, 14 failed, 15 total \| \d+s$/);
    assert.ok(r.lines.length - 1 <= 10, `final line plus details must be at most 10 lines, got ${r.lines.length - 1}`);
    assert.equal(t.calls().length, 3, 'a failure is reported at once, with no settle wait');
    assert.match(r.detail[0], /^FAIL job-1 https:\/\/ci\.example\/log\/1$/);
    assert.match(r.detail[r.detail.length - 1], /^FAIL \.\.\. and \d+ more$/);
  } finally { t.fx.cleanup(); }
});

test('a PR that merges returns 0 at once, even with checks not finished', () => {
  const t = setup(onSha('sha-1', [pr('MERGED', 'sha-1', { mergedAt: '2026-10-04T00:00:00Z' })], [checks(cr('build', 'in_progress'))]));
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.match(r.final, /^PR 31 MERGED @sha-1 \|/);
    assert.equal(t.calls().length, 3);
  } finally { t.fx.cleanup(); }
});

test('a PR closed unmerged returns 1', () => {
  const t = setup(onSha('sha-1', [pr('CLOSED', 'sha-1')], [checks(cr('build', 'in_progress'))]));
  try {
    const r = t.run('31');
    assert.equal(r.code, 1);
    assert.match(r.final, /^PR 31 CLOSED unmerged @sha-1 \|/);
  } finally { t.fx.cleanup(); }
});

test('timeout: exit 2, the checks still pending are named', () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks(cr('build', 'completed', 'success'), cr('slow', 'in_progress', '', 'https://ci.example/slow'))]));
  try {
    const r = t.run('31', '--timeout', '1s');
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.final, /^PR 31 OPEN TIMEOUT @sha-1 after 1s \| checks 1 passed, 0 failed, 2 total, 1 pending \|/);
    assert.deepEqual(r.detail, ['PENDING slow https://ci.example/slow']);
    assert.ok(t.calls().filter((c) => c.startsWith('pr view')).length >= 2, 'it polled repeatedly while waiting');
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
  const t = setup({
    pr: [{ err: 'HTTP 502: Bad Gateway', code: 1 }, pr('OPEN', 'sha-1')],
    checkRuns: { 'sha-1': [checks(cr('build', 'completed', 'success'))] },
  });
  try {
    const r = t.run('31');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(t.calls().filter((c) => c.startsWith('pr view')).length, 3, 'the failed call, then a green poll and its settle poll');
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
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks()]));
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
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks()]));
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.match(r.final, /^PR 31 OPEN NO-CHECKS @sha-1 \| no checks reported after .*no CI observed \(exit 0 = nothing failed\)/);
    assert.ok(t.calls().filter((c) => c.startsWith('pr view')).length >= 2, 'it waited out the grace, not just one look');
  } finally { t.fx.cleanup(); }
});

test('status contexts count too: a pending one holds the wait, an error fails it', () => {
  const t = setup({
    pr: [pr('OPEN', 'sha-1')],
    checkRuns: { 'sha-1': [checks(cr('build', 'completed', 'success'))] },
    statuses: { 'sha-1': [checks(st('ci/legacy', 'pending', 'https://old.example/1')), checks(st('ci/legacy', 'error', 'https://old.example/1'))] },
  });
  try {
    const r = t.run('31');
    assert.equal(r.code, 1);
    assert.match(r.final, /checks 1 passed, 1 failed, 2 total/);
    assert.equal(r.detail[0], 'FAIL ci/legacy https://old.example/1');
    assert.equal(t.calls().filter((c) => c.startsWith('pr view')).length, 2);
  } finally { t.fx.cleanup(); }
});

test('classifyCheck: skipped and neutral pass, cancelled and timed out fail, queued waits', () => {
  assert.equal(classifyCheck(cr('a', 'completed', 'skipped')).verdict, 'pass');
  assert.equal(classifyCheck(cr('a', 'completed', 'neutral')).verdict, 'pass');
  assert.equal(classifyCheck(cr('a', 'completed', 'cancelled')).verdict, 'fail');
  assert.equal(classifyCheck(cr('a', 'completed', 'timed_out')).verdict, 'fail');
  assert.equal(classifyCheck(cr('a', 'queued')).verdict, 'pending');
  assert.equal(classifyCheck({ context: 'x', state: 'expected' }).verdict, 'pending');
  assert.equal(classifyCheck(st('x', 'success', 'u')).url, 'u');
});

// ---- the settle rule: a PASS needs the check set to hold still across two polls

test('a check that registers after the first one finished is not missed: the PASS waits for the set to settle', () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [
    checks(cr('build', 'completed', 'success')),
    checks(cr('build', 'completed', 'success'), cr('deploy-preview', 'in_progress')),
    checks(cr('build', 'completed', 'success'), cr('deploy-preview', 'completed', 'success')),
  ]));
  try {
    const r = t.run('31', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^PR 31 OPEN PASS @sha-1 \| checks 2 passed, 0 failed, 2 total/, 'the late check is in the verdict');
    assert.ok(t.calls().filter((c) => c.startsWith('pr view')).length >= 4, 'first green, late check, second green, settled');
  } finally { t.fx.cleanup(); }
});

test('a late check that FAILS after the first green still fails the wait', () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [
    checks(cr('build', 'completed', 'success')),
    checks(cr('build', 'completed', 'success'), cr('e2e', 'completed', 'failure', 'https://ci.example/e2e')),
  ]));
  try {
    const r = t.run('31');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.detail[0], 'FAIL e2e https://ci.example/e2e');
  } finally { t.fx.cleanup(); }
});

test('a green set that never changes passes after exactly two polls (the second one the settle check)', () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks(cr('build', 'completed', 'success'))]));
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.equal(t.calls().filter((c) => c.startsWith('pr view')).length, 2);
    const row = t.rows().find((x) => x.event === 'end');
    assert.equal(row.cycles, 2);
    assert.equal(row.settle_waits, 1);
  } finally { t.fx.cleanup(); }
});

test('gh outside a git repository is a permanent error: exit 3 on the first call', () => {
  const t = setup({ pr: [{ err: 'fatal: not a git repository (or any of the parent directories): .git', code: 128 }] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 3);
    assert.equal(t.calls().length, 1, 'not retried');
    assert.equal(t.rows().find((x) => x.event === 'end').error_class, 'permanent');
  } finally { t.fx.cleanup(); }
});

// ---- stale checks: bound to the PR's current head commit

test('PR mode reads only the head commit: a previous commit green does not answer for a new head with no checks yet', () => {
  const t = setup({
    pr: [pr('OPEN', 'new-sha')],
    checkRuns: {
      'old-sha': [checks(cr('build', 'completed', 'success'))],
      'new-sha': [checks(), checks(cr('build', 'queued')), checks(cr('build', 'in_progress')), checks(cr('build', 'completed', 'success'))],
    },
  });
  try {
    const r = t.run('31', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^PR 31 OPEN PASS @new-sha \| checks 1 passed, 0 failed, 1 total/);
    assert.ok(t.calls().filter((c) => c.startsWith('pr view')).length >= 4, 'it kept waiting through the empty and queued polls');
    assert.ok(t.calls().some((c) => c.includes('commits/new-sha/check-runs')));
    assert.ok(!t.calls().some((c) => c.includes('old-sha')), 'the previous commit is never asked about');
  } finally { t.fx.cleanup(); }
});

test("PR mode: a head that never registers checks ends NO-CHECKS, not the old commit's green", () => {
  const t = setup({
    pr: [pr('OPEN', 'new-sha')],
    checkRuns: { 'old-sha': [checks(cr('build', 'completed', 'success'))], 'new-sha': [checks()] },
  });
  try {
    const r = t.run('31');
    assert.equal(r.code, 0);
    assert.match(r.final, /^PR 31 OPEN NO-CHECKS @new-sha \|/);
    assert.ok(!t.calls().some((c) => c.includes('old-sha')));
  } finally { t.fx.cleanup(); }
});

test("PR mode follows a push made while waiting: the new head decides, the old head's pending checks are dropped", () => {
  const t = setup({
    pr: [pr('OPEN', 'sha-1'), pr('OPEN', 'sha-2')],
    checkRuns: {
      'sha-1': [checks(cr('build', 'in_progress'))],
      'sha-2': [checks(cr('build', 'completed', 'success'))],
    },
  });
  try {
    const r = t.run('31', '--repo', 'o/r');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^PR 31 OPEN PASS @sha-2 \| checks 1 passed, 0 failed, 1 total/);
    assert.ok(t.calls().some((c) => c.includes('commits/sha-1/')) && t.calls().some((c) => c.includes('commits/sha-2/')));
  } finally { t.fx.cleanup(); }
});

test("PR mode asks for the head commit and uses the PR's own repo for the API calls when --repo is absent", () => {
  const t = setup(onSha('sha-1', [pr('OPEN', 'sha-1')], [checks(cr('build', 'completed', 'success'))]));
  try {
    assert.equal(t.run('31').code, 0);
    assert.ok(t.calls()[0].includes('headRefOid'), t.calls()[0]);
    assert.ok(t.calls().filter(isApi).every((c) => c.startsWith('api repos/o/r/commits/sha-1/')), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('PR mode: a PR answer with no head commit is a gh error (exit 3), never guessed', () => {
  const t = setup({ pr: [pr('OPEN', '')] });
  try {
    const r = t.run('31');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /no head commit/);
  } finally { t.fx.cleanup(); }
});

// ---- run mode

const job = (name, status, conclusion) => ({ name, status, conclusion, url: `https://github.com/o/r/actions/runs/7/job/${name}` });
const run = (status, conclusion, jobs) => ({ out: { databaseId: 7, status, conclusion, workflowName: 'CI', url: 'https://github.com/o/r/actions/runs/7', jobs } });
const branchAt = (sha) => ({ out: { name: 'my-branch', commit: { sha } } });
const listed = (...rows) => ({ out: rows });
const lrun = (id, sha, createdAt = '2026-10-04T10:00:00Z') => ({ databaseId: id, status: 'queued', headSha: sha, createdAt });

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

test("--run <branch>: resolves the run of the branch's current tip first, exit 1 on failure with the failed job", () => {
  const t = setup({
    branch: [branchAt('tip-1')],
    list: [listed(), listed(lrun(7, 'tip-1'))],
    run: [run('completed', 'failure', [job('build', 'completed', 'success'), job('test', 'completed', 'failure')])],
  });
  try {
    const r = t.run('--run', 'my-branch');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.final, /^RUN 7 \(CI\) FAIL \(failure\) \| jobs 1 passed, 1 failed, 2 total/);
    assert.equal(r.detail[0], 'FAIL test https://github.com/o/r/actions/runs/7/job/test');
    assert.ok(t.calls()[0].startsWith('api repos/'), t.calls().join('\n'));
    assert.ok(t.calls()[0].includes('/branches/my-branch'), t.calls()[0]);
    assert.ok(t.calls().some((c) => c.startsWith('run list --branch my-branch')), t.calls().join('\n'));
  } finally { t.fx.cleanup(); }
});

test('--run <branch>: a run of the commit before the push is not returned; it waits for the run of the new tip', () => {
  const t = setup({
    branch: [branchAt('tip-2')],
    list: [
      listed(lrun(5, 'tip-1', '2026-10-04T09:00:00Z')),
      listed(lrun(5, 'tip-1', '2026-10-04T09:00:00Z')),
      listed(lrun(9, 'tip-2', '2026-10-04T10:00:00Z'), lrun(5, 'tip-1', '2026-10-04T09:00:00Z')),
    ],
    run: [run('completed', 'success', [job('build', 'completed', 'success')])],
  });
  try {
    const r = t.run('--run', 'my-branch');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^RUN 9 \(CI\) PASS/);
    assert.ok(!t.calls().some((c) => c.startsWith('run view 5')), 'the older run is never followed');
    assert.ok(t.calls().filter((c) => c.startsWith('run list')).length >= 3);
  } finally { t.fx.cleanup(); }
});

test("--run <branch>: with only an older run and no run for the tip, it times out (exit 2) rather than answer from the older one", () => {
  const t = setup({
    branch: [branchAt('tip-2')],
    list: [listed(lrun(5, 'tip-1'))],
    run: [run('completed', 'success', [job('build', 'completed', 'success')])],
  });
  try {
    const r = t.run('--run', 'my-branch', '--timeout', '1s');
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.final, /^RUN my-branch TIMEOUT after 1s \| no run found for the branch's current tip tip-2/);
    assert.ok(!t.calls().some((c) => c.startsWith('run view')));
  } finally { t.fx.cleanup(); }
});

test('--run <branch>: several runs of the same tip commit pick the newest', () => {
  const t = setup({
    branch: [branchAt('tip-2')],
    list: [listed(lrun(11, 'tip-2', '2026-10-04T10:00:00Z'), lrun(12, 'tip-2', '2026-10-04T10:05:00Z'), lrun(13, 'tip-1', '2026-10-04T10:09:00Z'))],
    run: [run('completed', 'success', [job('build', 'completed', 'success')])],
  });
  try {
    const r = t.run('--run', 'my-branch');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.final, /^RUN 12 /);
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
  const t = setup({
    pr: [pr('OPEN', 'sha-1')],
    checkRuns: { 'sha-1': [checks(cr('build', 'in_progress')), checks(cr('build', 'completed', 'success'))] },
    run: [run('completed', 'failure', [job('t', 'completed', 'failure')])],
  });
  try {
    assert.equal(t.run('31').code, 0);
    assert.equal(t.run('--run', '7').code, 1);
    assert.equal(t.run('31', '--timeout', 'soon').code, 3);
    const all = t.rows();
    const rows = all.filter((x) => x.event === 'end');
    assert.equal(rows.length, 3);
    // A start row precedes each run that got as far as polling; a usage error has none.
    assert.deepEqual(all.filter((x) => x.event === 'start').map((x) => x.mode), ['pr', 'run']);
    const [a, b, c] = rows;
    // One PR poll is three gh calls (pr view, check-runs, status): pending, green, green again = 9 calls over 3 cycles.
    assert.deepEqual([a.mode, a.polls, a.cycles, a.outcome, a.exit_code, a.session_id], ['pr', 9, 3, 'passed', 0, 'sess-prwait']);
    assert.deepEqual([b.mode, b.polls, b.outcome, b.exit_code], ['run', 1, 'failed', 1]);
    assert.deepEqual([c.outcome, c.exit_code], ['usage', 3]);
    for (const r of rows) {
      assert.ok(Number.isFinite(r.duration_ms) && r.duration_ms >= 0);
      assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
      assert.equal(r.v, 2);
    }
  } finally { t.fx.cleanup(); }
});

test('telemetry: the start row, the bound head sha, hashes of target and repo (never the names), and the error class', () => {
  const t = setup({
    pr: [pr('OPEN', 'abcdefabcd')],
    checkRuns: { abcdefabcd: [checks(cr('build', 'completed', 'success'))] },
  });
  try {
    assert.equal(t.run('feature/secret-branch', '--repo', 'o/r').code, 0);
    const all = t.rows();
    const start = all.find((x) => x.event === 'start');
    assert.equal(start.mode, 'pr');
    assert.match(start.target_hash, /^[0-9a-f]{8}$/);
    assert.match(start.repo_hash, /^[0-9a-f]{8}$/);
    assert.equal(typeof start.timeout_ms, 'number');
    const end = all.find((x) => x.event === 'end');
    assert.equal(end.head_sha, 'abcdefabcd');
    assert.equal(end.target_hash, start.target_hash);
    assert.equal(end.repo_hash, start.repo_hash);
    assert.ok(!JSON.stringify(all).includes('secret-branch'), 'the target is hashed, not logged');
    assert.ok(!('error_class' in end));
  } finally { t.fx.cleanup(); }
  const bad = setup({ pr: [{ err: 'HTTP 502: Bad Gateway', code: 1 }] });
  try {
    assert.equal(bad.run('31').code, 3);
    assert.equal(bad.rows().find((x) => x.event === 'end').error_class, 'transient');
  } finally { bad.fx.cleanup(); }
});

test('telemetry: no session id exported means no session_id field', () => {
  const t = setup({ pr: [pr('MERGED', 'sha-1', { mergedAt: 'x' })], checkRuns: { 'sha-1': [checks()] } }, { CLAUDE_SESSION_ID: '' });
  try {
    assert.equal(t.run('31').code, 0);
    assert.ok(!('session_id' in t.rows()[0]));
  } finally { t.fx.cleanup(); }
});

test('telemetry: still written with the pr_wait hint option off (it only hides the line)', () => {
  const t = setup({ pr: [pr('MERGED', 'sha-1', { mergedAt: 'x' })], checkRuns: { 'sha-1': [checks()] } }, { CLAUDE_PLUGIN_OPTION_PR_WAIT: '0' });
  try {
    assert.equal(t.run('31').code, 0);
    assert.equal(t.rows().length, 2, 'a start row and an end row');
  } finally { t.fx.cleanup(); }
});

// ---- discoverability line and the pr_wait toggle

test('the hint line is one line, names the REAL script path and run_in_background, and its wording is bounded', () => {
  assert.ok(!PR_WAIT_HINT_TEXT.includes('\n'));
  assert.ok(PR_WAIT_HINT_WORDING.length <= 125, `${PR_WAIT_HINT_WORDING.length} chars of wording, path excluded`);
  assert.ok(!/<plugin>/.test(PR_WAIT_HINT_TEXT), 'no placeholder an agent cannot expand');
  assert.match(PR_WAIT_HINT_TEXT, /run_in_background/);
  assert.match(PR_WAIT_HINT_TEXT, /2m/);
  const m = PR_WAIT_HINT_TEXT.match(/node "([^"]+)"/);
  assert.ok(m, 'the command is quoted (paths may hold spaces)');
  assert.ok(existsSync(m[1]), `the named script exists: ${m[1]}`);
  assert.ok(m[1].endsWith('/scripts/pr-wait.mjs'));
});

test('the hint path follows CLAUDE_PLUGIN_ROOT when it is set', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${pathToFileURL(rulesPath).href}').then((m) => process.stdout.write(m.PR_WAIT_HINT_TEXT))`],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PLUGIN_ROOT: 'C:\\x y\\plug\\' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('node "C:/x y/plug/scripts/pr-wait.mjs"'), r.stdout);
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
