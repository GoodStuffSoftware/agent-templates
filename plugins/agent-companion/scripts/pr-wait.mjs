#!/usr/bin/env node
// pr-wait.mjs — wait for a PR's checks (or a GitHub Actions run) to finish
// INSIDE this script, and return one compact final state.
//
// Why: agents poll CI with `gh pr checks`, `gh run watch`, `gh pr view` and
// sleep loops; every poll is a tool call whose result is re-read from the
// prompt cache for the rest of the session. A wait that happens in a process
// costs no tokens. One call, one answer.
//
// Usage:
//   node pr-wait.mjs <pr-number|branch|url> [--repo owner/repo] [--timeout 20m]
//   node pr-wait.mjs --run <run-id|branch>   [--repo owner/repo] [--timeout 20m]
//
// --timeout takes 90 / 90s / 20m / 1h (a bare number is seconds). Default 20m.
//
// Exit codes: 0 checks passed, or the PR merged; 1 a check failed, or the PR
// closed unmerged, or the run did not succeed; 2 timeout; 3 usage or gh error.
//
// Output: one start line, then NOTHING until the end (safe under
// run_in_background), then one final line and at most 9 detail lines (failed
// check names with their log URLs; on timeout, the checks still pending).
//
//   PR 31 OPEN FAIL | checks 3 passed, 1 failed, 4 total | 4m12s
//   FAIL build https://github.com/o/r/actions/runs/1/job/2
//
// Never prompts. gh is polled with backoff (5s growing to 30s). A transient gh
// failure is retried; a not-found / not-logged-in failure is not.
//
// Bound to the commit, not the branch. Right after a push GitHub can still
// report the PREVIOUS commit's checks for a few seconds, so:
//   - PR mode reads the PR's current head commit (headRefOid) and counts only
//     the check runs and commit statuses of THAT commit; a head commit whose
//     checks have not registered yet is waited on, never answered from an
//     older commit. The head is re-read on every poll, so a later push is
//     followed.
//   - `--run <branch>` takes the newest run whose head SHA equals the branch's
//     current remote tip, and keeps waiting (within the timeout) while there is
//     none yet, instead of returning the run before the push. Once a run is
//     chosen it is followed to its end. A run id is used as given.
//
// Test seams (not for normal use): PR_WAIT_GH_SCRIPT runs a node script in
// place of gh; PR_WAIT_POLL_MS / PR_WAIT_POLL_MAX_MS set the backoff;
// PR_WAIT_NO_CHECKS_GRACE_MS sets the no-checks grace.
//
// Telemetry: one row per run to telemetry/pr-wait.jsonl (docs/TELEMETRY.md).

import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendLog } from '../hooks/lib/context.mjs';

const MAX_DETAIL_LINES = 9; // plus the final line = the 10 lines the contract allows
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const TRANSIENT_RETRIES = 3;

const POLL_START_MS = envNum('PR_WAIT_POLL_MS', 5000);
const POLL_MAX_MS = envNum('PR_WAIT_POLL_MAX_MS', 30000);
// A PR with no checks at all is indistinguishable, at first, from one whose
// checks have not registered yet. Wait this long before calling it "no checks".
const NO_CHECKS_GRACE_MS = envNum('PR_WAIT_NO_CHECKS_GRACE_MS', 90000);

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? n : dflt;
}

const startedAt = Date.now();
let polls = 0;
let mode = 'pr';
let finished = false;

// ---------------------------------------------------------------- output / exit

// Synchronous write: process.exit() right after an async pipe write can drop
// the tail of the output on Windows, and the final line is the whole point.
function out(text) {
  try { writeSync(1, text); } catch { process.stdout.write(text); }
}

function finish(code, outcome, lines) {
  if (finished) return;
  finished = true;
  if (lines && lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  try {
    const row = {
      at: new Date().toISOString(),
      mode,
      polls,
      duration_ms: Date.now() - startedAt,
      outcome,
      exit_code: code,
    };
    const sid = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
    if (sid) row.session_id = sid;
    appendLog('pr-wait.jsonl', row);
  } catch { /* telemetry is never allowed to change the answer */ }
  process.exit(code);
}

function usageError(msg) {
  process.stderr.write(`pr-wait: ${msg}\n`);
  finish(3, 'usage');
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(String(text).trim());
  if (!m) return null;
  const unit = (m[2] || 's').toLowerCase();
  const ms = Number(m[1]) * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
  return ms > 0 ? ms : null;
}

// ---------------------------------------------------------------- arguments

const HELP = `usage: pr-wait <pr-number|branch|url> [--repo owner/repo] [--timeout 20m]
       pr-wait --run <run-id|branch> [--repo owner/repo] [--timeout 20m]
exit: 0 passed or merged | 1 failed or closed unmerged | 2 timeout | 3 usage or gh error`;

function parseArgs(argv) {
  const out = { target: '', repo: '', timeoutMs: DEFAULT_TIMEOUT_MS, run: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--run') {
      out.run = true;
      // `--run <id>` takes the next bare word as its target; `--run` alone is
      // also fine when the target is given positionally.
      if (inline !== undefined) positional.push(inline);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) positional.push(argv[++i]);
    } else if (flag === '--repo') {
      const v = value();
      if (!v || v.startsWith('-')) return { error: '--repo needs owner/repo' };
      out.repo = v;
    } else if (flag === '--timeout') {
      const v = value();
      const ms = parseDuration(v);
      if (ms === null) return { error: `--timeout "${v ?? ''}" is not a duration (try 90s, 20m, 1h)` };
      out.timeoutMs = ms;
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else positional.push(a);
  }
  if (positional.length > 1) return { error: `expected one target, got ${positional.length}` };
  out.target = positional[0] || '';
  return out;
}

// ---------------------------------------------------------------- gh

// Failures that will not heal by waiting. Anything else is retried.
const PERMANENT = /could not resolve|no pull requests? found|not found|no workflow runs? found|gh auth login|not logged in|authentication|bad credentials|http 40[134]|invalid|unknown (?:flag|command)|accepts at most|required flag/i;

function ghCall(args, lines = false) {
  const script = process.env.PR_WAIT_GH_SCRIPT;
  const cmd = script ? process.execPath : 'gh';
  const full = script ? [script, ...args] : args;
  const r = spawnSync(cmd, full, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  if (r.error) {
    const missing = r.error.code === 'ENOENT';
    return { ok: false, permanent: missing, msg: missing ? 'gh is not installed or not on PATH' : String(r.error.message || r.error) };
  }
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || `gh exited ${r.status}`).trim().split('\n')[0].slice(0, 200);
    return { ok: false, permanent: PERMANENT.test(msg), msg };
  }
  try {
    // `lines`: newline-delimited JSON, what `gh api --paginate --jq '.x[]'` prints.
    const data = lines ? String(r.stdout).split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(r.stdout);
    return { ok: true, data };
  } catch {
    return { ok: false, permanent: false, msg: 'gh returned output that is not JSON' };
  }
}

// One gh call with transient-failure retries (counted as polls: they are gh calls).
async function ghJson(args, backoff, lines = false) {
  let last;
  for (let attempt = 0; attempt < TRANSIENT_RETRIES; attempt += 1) {
    polls += 1;
    const r = ghCall(args, lines);
    if (r.ok) return r.data;
    last = r;
    if (r.permanent) break;
    await sleep(Math.min(backoff.current(), 5000));
  }
  process.stderr.write(`pr-wait: gh failed: ${last.msg}\n`);
  finish(3, 'gh-error');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeBackoff() {
  let next = POLL_START_MS;
  return {
    current: () => next,
    step() { const cur = next; next = Math.min(POLL_MAX_MS, Math.max(next + 1, Math.round(next * 1.5))); return cur; },
  };
}

// ---------------------------------------------------------------- classification

// Normalise a statusCheckRollup entry (CheckRun or StatusContext) to
// { name, url, verdict: 'pass' | 'fail' | 'pending' }.
export function classifyCheck(c) {
  const up = (v) => String(v ?? '').toUpperCase();
  if (c && (c.__typename === 'StatusContext' || (c.context !== undefined && c.status === undefined))) {
    const st = up(c.state);
    return {
      name: String(c.context || 'status'),
      url: c.targetUrl || c.target_url || '',
      verdict: st === 'SUCCESS' ? 'pass' : st === 'FAILURE' || st === 'ERROR' ? 'fail' : 'pending',
    };
  }
  const status = up(c?.status);
  const conclusion = up(c?.conclusion);
  let verdict = 'pending';
  if (status === 'COMPLETED') {
    verdict = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'pass' : 'fail';
  }
  return { name: String(c?.name || c?.workflowName || 'check'), url: c?.detailsUrl || c?.details_url || c?.html_url || c?.url || '', verdict };
}

function tally(items) {
  const t = { pass: 0, fail: 0, pending: 0, total: items.length, failed: [], waiting: [] };
  for (const it of items) {
    t[it.verdict] += 1;
    if (it.verdict === 'fail') t.failed.push(it);
    if (it.verdict === 'pending') t.waiting.push(it);
  }
  return t;
}

function detailLines(prefix, items, total) {
  const shown = items.slice(0, MAX_DETAIL_LINES);
  const lines = shown.map((it) => `${prefix} ${it.name}${it.url ? ` ${it.url}` : ''}`);
  if (items.length > shown.length) lines[lines.length - 1] = `${prefix} ... and ${items.length - shown.length + 1} more`;
  return lines;
}

function countsText(t) {
  return `checks ${t.pass} passed, ${t.fail} failed, ${t.total} total${t.pending ? `, ${t.pending} pending` : ''}`;
}

// ---------------------------------------------------------------- PR mode

const PR_FIELDS = 'number,state,mergedAt,mergeStateStatus,url,headRefOid';

// owner/repo for the API calls: --repo, else the one in the PR's own URL, else
// gh's placeholders (the repository gh finds from the current directory).
function repoOf(opts, prUrl) {
  if (opts.repo) return opts.repo;
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//.exec(String(prUrl || ''));
  return m ? m[1] : '{owner}/{repo}';
}

// The checks of ONE commit: its check runs (latest attempt of each name) and
// its legacy commit statuses. Never the PR's rollup, which can still describe
// the previous head for a few seconds after a push.
async function checksOfCommit(repo, sha, backoff) {
  const runs = await ghJson(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--jq', '.check_runs[]'], backoff, true);
  const statuses = await ghJson(['api', `repos/${repo}/commits/${sha}/status?per_page=100`, '--paginate', '--jq', '.statuses[]'], backoff, true);
  return [...runs, ...statuses].map(classifyCheck);
}

async function waitPr(opts) {
  const base = ['pr', 'view', opts.target, ...(opts.repo ? ['--repo', opts.repo] : []), '--json', PR_FIELDS];
  const backoff = makeBackoff();
  const deadline = startedAt + opts.timeoutMs;
  let noChecksSince = 0;
  let last = null;

  for (;;) {
    const pr = await ghJson(base, backoff);
    const num = pr.number ?? opts.target;
    const sha = String(pr.headRefOid || '');
    if (!sha) {
      process.stderr.write('pr-wait: gh returned no head commit (headRefOid) for the PR\n');
      finish(3, 'gh-error');
    }
    const items = await checksOfCommit(repoOf(opts, pr.url), sha, backoff);
    const t = tally(items);
    const state = String(pr.state || '').toUpperCase();
    const elapsed = () => fmtElapsed(Date.now() - startedAt);
    last = { num, t, state };

    if (state === 'MERGED' || pr.mergedAt) {
      finish(0, 'merged', [`PR ${num} MERGED | ${countsText(t)} | ${elapsed()}`, ...detailLines('FAIL', t.failed)]);
    }
    if (state === 'CLOSED') {
      finish(1, 'closed', [`PR ${num} CLOSED unmerged | ${countsText(t)} | ${elapsed()}`, ...detailLines('FAIL', t.failed)]);
    }

    if (t.total === 0) {
      if (!noChecksSince) noChecksSince = Date.now();
      if (Date.now() - noChecksSince >= NO_CHECKS_GRACE_MS) {
        finish(0, 'no-checks', [`PR ${num} ${state || 'OPEN'} NO-CHECKS | no checks reported after ${fmtElapsed(NO_CHECKS_GRACE_MS)} | ${elapsed()}`]);
      }
    } else {
      noChecksSince = 0;
      if (t.pending === 0) {
        const merge = pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN' ? ` | merge ${pr.mergeStateStatus}` : '';
        if (t.fail > 0) {
          finish(1, 'failed', [`PR ${num} ${state} FAIL | ${countsText(t)} | ${elapsed()}`, ...detailLines('FAIL', t.failed)]);
        }
        finish(0, 'passed', [`PR ${num} ${state} PASS | ${countsText(t)}${merge} | ${elapsed()}`]);
      }
    }

    const wait = backoff.step();
    if (Date.now() + wait > deadline) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(left); // one last look at the deadline, then give up
    } else {
      await sleep(wait);
    }
  }

  const { num, t, state } = last;
  finish(2, 'timeout', [
    `PR ${num} ${state || 'OPEN'} TIMEOUT after ${fmtElapsed(opts.timeoutMs)} | ${countsText(t)} | ${fmtElapsed(Date.now() - startedAt)}`,
    ...detailLines('FAIL', t.failed),
    ...detailLines('PENDING', t.waiting),
  ].slice(0, MAX_DETAIL_LINES + 1));
}

// ---------------------------------------------------------------- run mode

const RUN_FIELDS = 'databaseId,status,conclusion,jobs,url,workflowName';

async function waitRun(opts) {
  const backoff = makeBackoff();
  const deadline = startedAt + opts.timeoutMs;
  const scope = opts.repo ? ['--repo', opts.repo] : [];
  let runId = /^\d+$/.test(opts.target) ? opts.target : '';
  let tipSha = '';
  let last = null;

  for (;;) {
    if (!runId) {
      // The branch's CURRENT remote tip, then the newest run of that exact commit.
      const repo = opts.repo || '{owner}/{repo}';
      const ref = opts.target.split('/').map(encodeURIComponent).join('/');
      const branch = await ghJson(['api', `repos/${repo}/branches/${ref}`], backoff);
      tipSha = String(branch?.commit?.sha || '');
      if (tipSha) {
        const list = await ghJson(['run', 'list', '--branch', opts.target, '--limit', '30', '--json', 'databaseId,status,headSha,createdAt', ...scope], backoff);
        const mine = (Array.isArray(list) ? list : []).filter((r) => r?.databaseId && r.headSha === tipSha);
        mine.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || Number(b.databaseId) - Number(a.databaseId));
        if (mine[0]) runId = String(mine[0].databaseId);
      }
    }
    if (runId) {
      const run = await ghJson(['run', 'view', runId, ...scope, '--json', RUN_FIELDS], backoff);
      const jobs = (Array.isArray(run.jobs) ? run.jobs : []).map(classifyCheck);
      const t = tally(jobs);
      const status = String(run.status || '').toLowerCase();
      const conclusion = String(run.conclusion || '').toLowerCase();
      const label = `RUN ${runId}${run.workflowName ? ` (${run.workflowName})` : ''}`;
      const elapsed = () => fmtElapsed(Date.now() - startedAt);
      last = { label, t };
      if (status === 'completed') {
        const ok = ['success', 'neutral', 'skipped'].includes(conclusion);
        const head = `${label} ${ok ? 'PASS' : `FAIL (${conclusion || 'unknown'})`} | jobs ${t.pass} passed, ${t.fail} failed, ${t.total} total | ${elapsed()}`;
        // A run that failed with no failed job (cancelled, startup failure) names itself.
        const detail = detailLines('FAIL', t.failed);
        if (!ok && detail.length === 0 && run.url) detail.push(`FAIL ${run.workflowName || 'run'} ${run.url}`);
        finish(ok ? 0 : 1, ok ? 'passed' : 'failed', [head, ...detail]);
      }
    }

    const wait = backoff.step();
    if (Date.now() + wait > deadline) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(left); // one last look at the deadline, then give up
    } else {
      await sleep(wait);
    }
  }

  const tail = last
    ? [`${last.label} TIMEOUT after ${fmtElapsed(opts.timeoutMs)} | jobs ${last.t.pass} passed, ${last.t.fail} failed, ${last.t.total} total | ${fmtElapsed(Date.now() - startedAt)}`,
      ...detailLines('FAIL', last.t.failed), ...detailLines('PENDING', last.t.waiting)]
    : [`RUN ${opts.target} TIMEOUT after ${fmtElapsed(opts.timeoutMs)} | no run found for the branch's current tip${tipSha ? ` ${tipSha.slice(0, 7)}` : ''} | ${fmtElapsed(Date.now() - startedAt)}`];
  finish(2, 'timeout', tail.slice(0, MAX_DETAIL_LINES + 1));
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) usageError(`${opts.error}\n${HELP}`);
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    finish(0, 'help');
  }
  mode = opts.run ? 'run' : 'pr';
  if (!opts.target) usageError(`a PR number, branch or run id is required\n${HELP}`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => finish(130, 'interrupted'));
  }

  out(`pr-wait: waiting on ${opts.run ? 'run' : 'PR'} ${opts.target}${opts.repo ? ` (${opts.repo})` : ''}, timeout ${fmtElapsed(opts.timeoutMs)}\n`);
  if (opts.run) await waitRun(opts);
  else await waitPr(opts);
}

// Run only when executed directly, so a test can import classifyCheck.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`pr-wait: ${String(e?.message || e)}\n`);
    finish(3, 'gh-error');
  });
}
