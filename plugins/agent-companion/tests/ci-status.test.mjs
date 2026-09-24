// ci-status.mjs — the main_ci_red signal's own gh reader.
//
// Every gh call is injected (`exec`); no test here touches the network or a
// real `gh` binary, per the same convention as repo-discovery.test.mjs's
// discoverViaGh tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRepoCiStatus, streakFromRuns, githubOwnerRepoFromUrl, repoCacheKey } from '../scripts/lib/ci-status.mjs';
import { normalizeGitUrl } from '../scripts/lib/publication-sweep.mjs';

// A scripted `exec` that answers by matching on the gh subcommand: the first
// arg after 'api' (default_branch lookup, workflows listing, or a run list).
function scriptedExec({ branch = 'main', workflows = [], runsByWorkflow = {} } = {}) {
  return (cmd, args) => {
    assert.equal(cmd, 'gh');
    const jqIdx = args.indexOf('--jq');
    const jq = args[jqIdx + 1];
    const target = args.find((a) => typeof a === 'string' && a.startsWith('repos/'));
    if (jq === '.default_branch') return branch;
    if (target.includes('/actions/workflows/') === false && target.endsWith('/actions/workflows')) {
      return workflows.map((w) => JSON.stringify({ id: w.id, name: w.name })).join('\n');
    }
    const m = /\/actions\/workflows\/(\d+)\/runs/.exec(target);
    const wfId = m ? Number(m[1]) : null;
    const runs = runsByWorkflow[wfId] || [];
    return runs.map((r) => JSON.stringify(r)).join('\n');
  };
}

test('streakFromRuns: latest green -> null (nothing to report)', () => {
  const runs = [
    { conclusion: 'success', created_at: '2026-09-24T10:00:00Z', html_url: 'https://github.com/o/r/actions/runs/3' },
    { conclusion: 'failure', created_at: '2026-09-24T09:00:00Z', html_url: 'https://github.com/o/r/actions/runs/2' },
  ];
  assert.equal(streakFromRuns(runs), null);
});

test('streakFromRuns: latest red, streak start is the oldest CONSECUTIVE red run', () => {
  const runs = [
    { conclusion: 'failure', created_at: '2026-09-24T12:00:00Z', html_url: '.../runs/5' },
    { conclusion: 'timed_out', created_at: '2026-09-24T11:00:00Z', html_url: '.../runs/4' },
    { conclusion: 'cancelled', created_at: '2026-09-24T10:00:00Z', html_url: '.../runs/3' },
    { conclusion: 'success', created_at: '2026-09-24T09:00:00Z', html_url: '.../runs/2' }, // streak stops here
    { conclusion: 'failure', created_at: '2026-09-24T08:00:00Z', html_url: '.../runs/1' }, // older, unrelated red — must NOT be counted
  ];
  const streak = streakFromRuns(runs);
  assert.ok(streak);
  assert.equal(streak.redSince, '2026-09-24T10:00:00Z'); // the oldest run IN the current red streak
  assert.equal(streak.latestUrl, '.../runs/5');
  assert.equal(streak.failingRunCount, 3);
  assert.equal(streak.boundedByPage, false);
});

test('streakFromRuns: empty or missing runs -> null', () => {
  assert.equal(streakFromRuns([]), null);
  assert.equal(streakFromRuns(undefined), null);
});

test('checkRepoCiStatus: green default branch -> ok:true, red:false, no red workflows listed', async () => {
  const exec = scriptedExec({
    branch: 'main',
    workflows: [{ id: 1, name: 'ci' }],
    runsByWorkflow: { 1: [{ conclusion: 'success', created_at: '2026-09-24T10:00:00Z', html_url: 'u1' }] },
  });
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, true);
  assert.equal(res.red, false);
  assert.deepEqual(res.workflows, []);
});

test('checkRepoCiStatus: one red workflow among several -> red:true, only the red one reported, with its streak start', async () => {
  const exec = scriptedExec({
    branch: 'main',
    workflows: [{ id: 1, name: 'tests' }, { id: 2, name: 'lint' }],
    runsByWorkflow: {
      1: [
        { conclusion: 'failure', created_at: '2026-09-24T12:00:00Z', html_url: 'https://github.com/me/proj/actions/runs/9' },
        { conclusion: 'failure', created_at: '2026-09-24T11:00:00Z', html_url: 'https://github.com/me/proj/actions/runs/8' },
        { conclusion: 'success', created_at: '2026-09-24T10:00:00Z', html_url: 'https://github.com/me/proj/actions/runs/7' },
      ],
      2: [{ conclusion: 'success', created_at: '2026-09-24T10:00:00Z', html_url: 'u-lint' }],
    },
  });
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, true);
  assert.equal(res.red, true);
  assert.equal(res.workflows.length, 1);
  assert.equal(res.workflows[0].name, 'tests');
  assert.equal(res.workflows[0].redSince, '2026-09-24T11:00:00Z');
  assert.equal(res.workflows[0].failingRunCount, 2);
});

test('checkRepoCiStatus: no active workflows -> ok:true, red:false (nothing to check)', async () => {
  const exec = scriptedExec({ branch: 'main', workflows: [] });
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'empty', exec });
  assert.equal(res.ok, true);
  assert.equal(res.red, false);
  assert.deepEqual(res.workflows, []);
});

test('checkRepoCiStatus: gh missing (ENOENT) -> ok:false, reason names it, never throws', async () => {
  const exec = () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; };
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not installed/);
});

test('checkRepoCiStatus: gh unauthenticated -> ok:false, reason surfaces the auth failure, never throws', async () => {
  const exec = () => { const e = new Error('command failed'); e.stderr = 'gh: To use GitHub CLI, please authenticate: run gh auth login'; throw e; };
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not authenticated/);
});

test('checkRepoCiStatus: workflows list fails (e.g. offline) after default-branch succeeded -> ok:false, never throws', async () => {
  let call = 0;
  const exec = (cmd, args) => {
    call += 1;
    if (call === 1) return 'main'; // default_branch lookup succeeds
    const e = new Error('command failed'); e.stderr = 'gh: connection timed out'; throw e;
  };
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /gh api failed/);
});

test('checkRepoCiStatus: one workflow erroring does not blank out a genuinely red sibling', async () => {
  const exec = (cmd, args) => {
    const jqIdx = args.indexOf('--jq');
    const jq = args[jqIdx + 1];
    const target = args.find((a) => typeof a === 'string' && a.startsWith('repos/'));
    if (jq === '.default_branch') return 'main';
    if (target.endsWith('/actions/workflows')) {
      return [{ id: 1, name: 'flaky-api' }, { id: 2, name: 'tests' }].map((w) => JSON.stringify(w)).join('\n');
    }
    if (target.includes('/1/runs')) { const e = new Error('boom'); e.stderr = 'gh: 502'; throw e; }
    if (target.includes('/2/runs')) return JSON.stringify({ conclusion: 'failure', created_at: '2026-09-24T09:00:00Z', html_url: 'u' });
    throw new Error(`unexpected target ${target}`);
  };
  const res = await checkRepoCiStatus({ owner: 'me', repo: 'proj', exec });
  assert.equal(res.ok, true);
  assert.equal(res.red, true);
  assert.deepEqual(res.workflows.map((w) => w.name), ['tests']);
});

test('githubOwnerRepoFromUrl: parses a github origin, null for a non-GitHub remote', () => {
  assert.deepEqual(githubOwnerRepoFromUrl('git@github.com:Me/Proj.git', normalizeGitUrl), { owner: 'me', repo: 'proj' });
  assert.equal(githubOwnerRepoFromUrl('git@gitlab.com:me/proj.git', normalizeGitUrl), null);
  assert.equal(githubOwnerRepoFromUrl('', normalizeGitUrl), null);
});

test('repoCacheKey: stable, case-insensitive', () => {
  assert.equal(repoCacheKey('Me', 'Proj'), 'me/proj');
  assert.equal(repoCacheKey('me', 'proj'), repoCacheKey('ME', 'PROJ'));
});
