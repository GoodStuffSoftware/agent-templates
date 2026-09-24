// ci-status.mjs — is a repo's default-branch CI red, and since when?
//
// Suggestion-only, read-only: this module never re-runs, cancels, or fixes a
// workflow. It answers one question — "did the default branch's LATEST
// COMPLETED run of each active workflow conclude failure/cancelled/timed_out,
// and if so, since which run did that streak start?" — using `gh api` only.
//
// Same degrade convention as scripts/lib/repo-discovery.mjs's discoverViaGh():
// every gh call is injectable (`exec`), and gh missing/unauthenticated/offline
// all report { ok: false, reason } rather than throwing. A caller that gets
// ok:false must stay SILENT (per the calibration-scout's own rule: a quiet
// day says nothing) — it is not itself a signal.
//
// Bounded on purpose: one page of up to CI_STATUS_RUNS_PER_PAGE completed
// runs per workflow. A streak longer than that page reports the OLDEST run
// IN THE PAGE as "red since" (a lower bound on the true start), rather than
// paginating further — this is a suggestion surfaced once a day, not an
// incident timeline, and unbounded pagination is exactly the kind of gh rate
// budget this feature must not spend.

import { execFileSync } from 'node:child_process';

const RED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);
export const CI_STATUS_RUNS_PER_PAGE = 30;

function defaultExec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function ghDegrade(err) {
  const msg = (err && (err.stderr || err.message)) || String(err);
  const first = String(msg).split('\n')[0];
  const missing = err && (err.code === 'ENOENT' || /command not found|not recognized/i.test(first));
  const unauth = /authenticat/i.test(first) || /gh auth login/i.test(first);
  return {
    ok: false,
    reason: missing ? 'gh is not installed' : unauth ? 'gh is not authenticated' : `gh api failed: ${first}`,
  };
}

// owner/repo -> the repo's default branch, or an ok:false degrade.
function fetchDefaultBranch(owner, repo, exec, timeout) {
  try {
    const out = exec('gh', ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch'], { timeout, windowsHide: true });
    const branch = String(out || '').trim();
    return branch ? { ok: true, branch } : { ok: false, reason: 'gh api returned no default_branch' };
  } catch (err) {
    return ghDegrade(err);
  }
}

// owner/repo -> [{id, name}] for every ACTIVE workflow, or an ok:false degrade.
function fetchActiveWorkflows(owner, repo, exec, timeout) {
  try {
    const out = exec('gh', [
      'api', '--paginate', `repos/${owner}/${repo}/actions/workflows`,
      '--jq', '.workflows[] | select(.state=="active") | {id, name}',
    ], { timeout, windowsHide: true });
    const workflows = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.id != null && row.name) workflows.push({ id: row.id, name: row.name });
      } catch { /* torn line: skip */ }
    }
    return { ok: true, workflows };
  } catch (err) {
    return ghDegrade(err);
  }
}

// One workflow's last CI_STATUS_RUNS_PER_PAGE COMPLETED runs on `branch`,
// newest first (the GitHub API's own order) — or an ok:false degrade.
function fetchCompletedRuns(owner, repo, workflowId, branch, exec, timeout) {
  try {
    const q = `repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`
      + `?branch=${encodeURIComponent(branch)}&status=completed&per_page=${CI_STATUS_RUNS_PER_PAGE}`;
    const out = exec('gh', [
      'api', q, '--jq', '.workflow_runs[] | {conclusion, created_at, html_url}',
    ], { timeout, windowsHide: true });
    const runs = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.conclusion) runs.push(row);
      } catch { /* torn line: skip */ }
    }
    return { ok: true, runs };
  } catch (err) {
    return ghDegrade(err);
  }
}

// Given one workflow's completed runs (newest first), is the CURRENT streak
// red, and if so since when / which URLs. Returns null when the latest run
// is green (nothing to report) or there are no completed runs at all.
export function streakFromRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  if (!RED_CONCLUSIONS.has(runs[0].conclusion)) return null; // latest is green: not red
  let streakEnd = runs.length; // exclusive — index of the first non-red run, or the page end
  for (let i = 1; i < runs.length; i += 1) {
    if (!RED_CONCLUSIONS.has(runs[i].conclusion)) { streakEnd = i; break; }
  }
  const streak = runs.slice(0, streakEnd);
  return {
    redSince: streak[streak.length - 1].created_at,
    latestUrl: streak[0].html_url,
    failingRunCount: streak.length,
    boundedByPage: streakEnd === runs.length && runs.length === CI_STATUS_RUNS_PER_PAGE,
  };
}

// checkRepoCiStatus({ owner, repo, exec, timeout }) ->
//   { ok: true, red: boolean, workflows: [{ name, redSince, latestUrl, failingRunCount, boundedByPage }] }
//   { ok: false, reason }
// NEVER throws. `red` is true iff at least one active workflow's latest
// completed run on the default branch is in a red streak.
export async function checkRepoCiStatus({ owner, repo, exec = defaultExec, timeout = 20000 } = {}) {
  if (!owner || !repo) return { ok: false, reason: 'no owner/repo given' };
  const branchRes = fetchDefaultBranch(owner, repo, exec, timeout);
  if (!branchRes.ok) return branchRes;
  const wfRes = fetchActiveWorkflows(owner, repo, exec, timeout);
  if (!wfRes.ok) return wfRes;
  if (wfRes.workflows.length === 0) return { ok: true, red: false, workflows: [] };

  const redWorkflows = [];
  for (const wf of wfRes.workflows) {
    const runsRes = fetchCompletedRuns(owner, repo, wf.id, branchRes.branch, exec, timeout);
    if (!runsRes.ok) continue; // one workflow failing to answer must not blank out the others
    const streak = streakFromRuns(runsRes.runs);
    if (streak) redWorkflows.push({ name: wf.name, ...streak });
  }
  return { ok: true, red: redWorkflows.length > 0, workflows: redWorkflows, defaultBranch: branchRes.branch };
}

// owner/repo from a git origin URL, or null for a non-GitHub remote. Same
// shape as repo-discovery.mjs's githubOwnerRepo(), duplicated locally rather
// than imported so this module has exactly one dependency direction (it is
// imported BY detect.mjs, same layer as repo-discovery.mjs, not underneath
// it) — see normalizeGitUrl in publication-sweep.mjs for the format this reads.
export function githubOwnerRepoFromUrl(url, normalizeGitUrl) {
  const norm = normalizeGitUrl(url || '');
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(norm);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// A stable cache key for a repo, independent of URL scheme/case.
export function repoCacheKey(owner, repo) {
  return `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
}
