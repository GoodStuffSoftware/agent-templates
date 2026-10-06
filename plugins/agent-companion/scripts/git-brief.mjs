#!/usr/bin/env node
// git-brief.mjs — one line of git state, so an agent does not spend a dozen
// `git status` / `git fetch` / `git rev-list` calls (and a turn each) finding
// out where it is.
//
//   node git-brief.mjs                  one line: branch | ahead/behind origin's
//                                       default branch | uncommitted N |
//                                       worktree | last commit | unpushed N
//   node git-brief.mjs landed <sha|branch>
//                                       one line: ON <default> (sha) |
//                                       ON <default> (cherry-picked) |
//                                       NOT on <default> (ahead N; a squash
//                                       merge wouldn't show) |
//                                       UNKNOWN (no such ref ...)
//   --no-fetch                          read local refs only
//   --fresh                             fetch even if the last fetch was recent
//                                       (`landed` always does: it is a question)
//   --cwd <dir>                         repo to look at (default: cwd)
//
// Cross-machine branch state is the coordination server's `branch_status` MCP tool; this
// script only reads the repository it runs in (plus one fetch of origin).
//
// FETCH POLICY. Before reading, the one-line brief fetches origin's default
// branch (and only that), unless a fetch ran in this repository within
// FETCH_FRESH_MS (5 minutes; a worktree shares its repository's stamp, so ten
// agents starting together cause one fetch, not ten). `landed` is an explicit
// question, so it ALWAYS fetches (a 5-minute-old origin/main answers "NOT on
// main" for a branch merged a minute ago); a NOT that rests on a skipped or
// failed fetch says so. The fetch never prompts (GIT_TERMINAL_PROMPT=0,
// GCM_INTERACTIVE=never, ssh BatchMode), gives up on a stalled transfer
// (GIT_HTTP_LOW_SPEED_*) and is killed after FETCH_TIMEOUT_MS (1.5 s): the
// whole process TREE, because git forks git-remote-http and killing git alone
// leaves it holding the connection (on Windows for good). A failed or
// timed-out fetch is not retried for FAIL_BACKOFF_MS (1 minute) by the brief,
// so an offline machine pays the timeout once, not at every agent start. The
// whole run has one deadline (FETCH_TIMEOUT_MS + LOCAL_TIMEOUT_MS, 2.5 s): the
// fetch is the only step that can wait, and each local git call is capped at
// LOCAL_TIMEOUT_MS and at what is left of the deadline.
//
// FAIL OPEN. Outside a git repository, in a bare repository, or on any error,
// nothing is printed and the exit status is 0.
//
// Telemetry: every CLI run appends a row to telemetry/git-brief.jsonl
// (hooks/lib/context.mjs appendLog; the hook, hooks/git-brief.mjs, writes its
// own `inject-*` rows), with the outcome, the fetch outcome and age, and the
// time per git step (briefTelemetry). See docs/TELEMETRY.md.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FETCH_FRESH_MS = 5 * 60 * 1000;
export const FAIL_BACKOFF_MS = 60 * 1000;
export const FETCH_TIMEOUT_MS = 1500;
export const LOCAL_TIMEOUT_MS = 1000;

// Both caps can be raised with AC_GIT_BRIEF_FETCH_TIMEOUT_MS and
// AC_GIT_BRIEF_LOCAL_TIMEOUT_MS (read at call time) for a slow machine or a
// loaded test run; the defaults are what keep agent start-up under about 2 s.
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const fetchTimeout = () => envMs('AC_GIT_BRIEF_FETCH_TIMEOUT_MS', FETCH_TIMEOUT_MS);
const localTimeout = () => envMs('AC_GIT_BRIEF_LOCAL_TIMEOUT_MS', LOCAL_TIMEOUT_MS);
// One deadline per run (default fetch cap + one local cap = 2.5 s). The fetch is
// the only step that can use the fetch cap; everything else shares the rest.
const deadlineMs = () => envMs('AC_GIT_BRIEF_DEADLINE_MS', fetchTimeout() + localTimeout());
export const SUBJECT_MAX = 60;
export const SQUASH_NOTE = "a squash merge wouldn't show";
export const STAMP_FILE = 'ac-git-brief-fetch.json';

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  // Never let ssh wait on a passphrase or host-key question. An operator's own
  // GIT_SSH_COMMAND / GIT_SSH is theirs and is left alone.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=2';
  return env;
}

// The state of the run in progress (the public functions are synchronous, so
// there is exactly one): the deadline, the time spent per git subcommand, and
// whether a LOCAL git call timed out (an answer built on one is not trusted).
let RUN = null;
function startRun() {
  RUN = { deadline: Date.now() + deadlineMs(), steps: {}, localTimedOut: false, timedOut: false };
  return RUN;
}
const addStep = (name, ms) => { if (RUN) RUN.steps[name] = (RUN.steps[name] || 0) + ms; };

function git(cwd, args, timeout = localTimeout()) {
  let cap = timeout;
  if (RUN) {
    const left = RUN.deadline - Date.now();
    if (left <= 0) { RUN.localTimedOut = true; RUN.timedOut = true; return { ok: false, out: '', timedOut: true }; }
    cap = Math.min(cap, left);
  }
  const t0 = Date.now();
  const r = spawnSync('git', args, {
    cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true, timeout: cap, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  });
  addStep(args[0], Date.now() - t0);
  if (r.error || r.status === null) {
    const timedOut = r.error?.code === 'ETIMEDOUT';
    if (timedOut && RUN) { RUN.localTimedOut = true; RUN.timedOut = true; }
    return { ok: false, out: '', timedOut };
  }
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r?\n$/, ''), status: r.status };
}

// The fetch runs under a small node runner that spawns git ASYNCHRONOUSLY, so on
// timeout it can kill the whole tree: spawnSync's own timeout kills only the
// direct child, and git has already forked git-remote-http, which would stay
// alive holding the connection (on Windows indefinitely). taskkill /T /F on
// Windows; the child is its own process group elsewhere, so kill(-pid).
// Exit 124 = timed out here. The runner prints git's pid first, so that when
// the backstop below kills the runner itself (a loaded machine can take longer
// than the cap plus slack just to start node and run taskkill), the caller can
// still kill git's tree instead of leaving it orphaned. git is detached on
// Windows too: a non-detached child sits in node's kill-on-close job, so killing
// the runner took git and its first child down with it while git-remote-http
// broke away and survived, parentless, where taskkill /T could no longer reach
// it. Detached, git outlives the runner and its tree stays walkable.
const FETCH_RUNNER = `
const { spawn, spawnSync } = require('node:child_process');
const ms = Number(process.argv[1]);
const args = process.argv.slice(2);
const win = process.platform === 'win32';
const c = spawn('git', args, { stdio: 'ignore', windowsHide: true, detached: true });
if (c.pid) process.stdout.write(c.pid + '\\n');
const killTree = () => {
  try {
    if (win) spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-c.pid, 'SIGKILL');
  } catch {}
};
const t = setTimeout(() => { killTree(); process.exit(124); }, ms);
c.on('error', () => process.exit(125));
c.on('exit', (code) => { clearTimeout(t); process.exit(code === null ? 1 : code); });
`;

function fetchEnv() {
  const env = gitEnv();
  // A transfer that has stalled gives up by itself: the second line of defence
  // behind the tree kill. An operator's own values are theirs and are left alone.
  if (!env.GIT_HTTP_LOW_SPEED_LIMIT) env.GIT_HTTP_LOW_SPEED_LIMIT = '1000';
  if (!env.GIT_HTTP_LOW_SPEED_TIME) env.GIT_HTTP_LOW_SPEED_TIME = '2';
  return env;
}

// On Windows the orphan kill runs in a detached helper so it never holds the
// hook (whose own timeout is 5 s): the helper first confirms the pid is still a
// git process, because by the time the backstop fires every handle to git may be
// closed (the runner's own taskkill already ran, or git exited and the slow
// runner had not yet), so Windows may have reused the pid for an unrelated
// process. The check narrows that window; it cannot close it entirely.
const ORPHAN_KILLER = `
const { spawnSync } = require('node:child_process');
const pid = process.argv[1];
const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
const m = /^"([^"]*)","(\\d+)"/m.exec(r.stdout || '');
if (m && m[2] === pid && /^git/i.test(m[1])) {
  spawnSync('taskkill', ['/T', '/F', '/PID', pid], { windowsHide: true, stdio: 'ignore' });
}
`;

// The backstop killed the runner, not git: kill the tree the runner reported.
// Elsewhere git leads a process group the runner created, so kill(-pid) reaches
// only that group (a reused pid would also have to lead a group; ESRCH is
// swallowed). Neither branch waits on the kill.
function killOrphanedTree(stdout) {
  const pid = Number.parseInt(String(stdout || '').trim().split(/\s+/)[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn(process.execPath, ['-e', ORPHAN_KILLER, String(pid)], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {}
}

// -> 'ok' | 'fail' | 'timeout'. backstopMs is for tests: the default (cap + 2 s)
// is what production uses.
export function runFetch(cwd, args, timeoutMs, { backstopMs } = {}) {
  const t0 = Date.now();
  let cap = timeoutMs;
  if (RUN) cap = Math.min(cap, Math.max(1, RUN.deadline - Date.now()));
  const r = spawnSync(process.execPath, ['-e', FETCH_RUNNER, String(cap), ...args], {
    cwd, env: fetchEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    // The runner enforces `cap` itself and kills the tree; this is only the
    // backstop for a runner that is itself stuck or slow.
    timeout: backstopMs ?? cap + 2000, killSignal: 'SIGKILL',
  });
  if (r.error?.code === 'ETIMEDOUT') killOrphanedTree(r.stdout);
  addStep('fetch', Date.now() - t0);
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'timeout' : 'fail';
  if (r.status === 124) return 'timeout';
  return r.status === 0 ? 'ok' : 'fail';
}

const slash = (p) => String(p || '').replace(/\\/g, '/');

// origin's default branch name: origin/HEAD when set, else main / master if
// that remote-tracking ref exists. null = unknown (no origin, or neither).
export function defaultBranch(cwd) {
  const s = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (s.ok && s.out.startsWith('origin/')) return s.out.slice('origin/'.length);
  for (const b of ['main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok) return b;
  }
  return null;
}

function readStamp(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j.at === 'number' ? j : null;
  } catch { return null; }
}

// Fetch origin's default branch unless one ran recently. Returns what
// happened: { attempted, outcome, age_ms } where outcome is 'ok', 'fail',
// 'timeout', 'fresh-skip' (a recent stamp), or 'no-remote' (nothing to fetch)
// and age_ms is how old the previous stamp was (null = none). The stamp is
// written BEFORE the attempt (so agents starting at the same moment skip rather
// than all fetch) and again after, with the outcome. A stamp from a run that
// never finished (killed) counts as a failure for FAIL_BACKOFF_MS.
export function maybeFetch(cwd, branch, commonDir, { force = false, now = Date.now(), timeoutMs = fetchTimeout() } = {}) {
  if (!branch || !commonDir) return { attempted: false, outcome: 'no-remote', age_ms: null };
  if (!git(cwd, ['remote', 'get-url', 'origin']).ok) return { attempted: false, outcome: 'no-remote', age_ms: null };
  const file = join(commonDir, STAMP_FILE);
  const st = readStamp(file);
  const age = st ? now - st.at : null;
  if (!force && st) {
    const window = st.ok === true ? FETCH_FRESH_MS : FAIL_BACKOFF_MS;
    if (age >= 0 && age < window) return { attempted: false, outcome: 'fresh-skip', age_ms: age, last_ok: st.ok === true };
  }
  const write = (ok) => { try { writeFileSync(file, JSON.stringify({ at: now, ok })); } catch { /* read-only repo: fetch anyway, just unstamped */ } };
  write(null);
  const outcome = runFetch(cwd, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', branch], timeoutMs);
  write(outcome === 'ok');
  return { attempted: true, outcome, age_ms: age };
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

// Parse `git status --porcelain=v2 --branch`.
function parseStatus(out) {
  const st = { head: null, oid: null, upstream: null, ahead: null, dirty: 0 };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) st.head = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) st.oid = line.slice(13).trim();
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) st.ahead = Number(m[1]);
    } else if (line && !line.startsWith('#')) st.dirty += 1;
  }
  return st;
}

function repoFacts(cwd) {
  const r = git(cwd, ['rev-parse', '--is-bare-repository', '--show-toplevel', '--git-common-dir']);
  if (!r.ok) return null;
  const [bare, top, common] = r.out.split('\n');
  if (bare === 'true' || !top) return null;
  return { top: slash(top), commonDir: resolve(cwd, common) };
}

const hash8 = (v) => createHash('sha256').update(String(v ?? '')).digest('hex').slice(0, 8);

// The fields every run reports, for the telemetry row (the CLI and the hook
// both log them). `fetch_outcome` is ok | fail | timeout | fresh-skip |
// no-remote | skipped (--no-fetch); `fetch_age_ms` is how old the previous
// fetch stamp was before this run (null = none); `steps_ms` is the time per git
// subcommand. `outcome` separates "nothing to say" from "could not say":
// ok | not-repo | no-default-branch | git-error | timeout | error.
export function briefTelemetry(res) {
  const out = {
    outcome: res.outcome ?? 'ok',
    fetch_outcome: res.fetch_outcome ?? 'skipped',
    fetch_age_ms: res.fetch_age_ms ?? null,
    steps_ms: res.steps_ms ?? {},
  };
  if (res.answer !== undefined) {
    out.answer = res.answer;
    out.target_hash = res.target_hash;
    out.stamp_age_ms = res.stamp_age_ms ?? null;
    out.rechecked_after_NOT = res.rechecked_after_NOT === true;
  }
  return out;
}

// What a run reports besides its line. `f` is maybeFetch's result, or null when
// no fetch was asked for.
function fetchFields(f) {
  return { fetched: f ? f.attempted : false, fetch_outcome: f ? f.outcome : 'skipped', fetch_age_ms: f ? f.age_ms : null };
}

// The one-line brief, or null (not a repo / nothing readable). Never throws.
export function gitBrief({ cwd = process.cwd(), fetch = true, force = false, now = Date.now() } = {}) {
  const t0 = Date.now();
  const run = startRun();
  const res = (extra) => ({ ms: Date.now() - t0, steps_ms: { ...run.steps }, fetched: false, fetch_outcome: 'skipped', fetch_age_ms: null, ...extra });
  try {
    const f = repoFacts(cwd);
    if (!f) return res({ line: null, outcome: run.timedOut ? 'timeout' : 'not-repo' });
    const dflt = defaultBranch(cwd);
    const fx = fetch ? maybeFetch(cwd, dflt, f.commonDir, { force, now }) : null;
    const ff = fetchFields(fx);

    const s = git(cwd, ['status', '--porcelain=v2', '--branch']);
    if (!s.ok) return res({ line: null, ...ff, outcome: s.timedOut || run.timedOut ? 'timeout' : 'git-error' });
    const st = parseStatus(s.out);
    const hasCommit = st.oid && st.oid !== '(initial)';
    const branch = st.head === '(detached)' ? `detached@${hasCommit ? st.oid.slice(0, 7) : '?'}` : (st.head || '?');

    let vs = 'no origin';
    if (dflt && hasCommit) {
      const c = git(cwd, ['rev-list', '--left-right', '--count', `refs/remotes/origin/${dflt}...HEAD`]);
      const m = c.ok && /^(\d+)\s+(\d+)$/.exec(c.out);
      if (m) vs = `ahead ${m[2]} behind ${m[1]} origin/${dflt}`;
    }

    let last = 'no commits';
    if (hasCommit) {
      const l = git(cwd, ['log', '-1', '--format=%h%x09%s']);
      if (l.ok && l.out) {
        const [sha, ...subj] = l.out.split('\t');
        last = `${sha} ${trunc(subj.join('\t'), SUBJECT_MAX)}`;
      }
    }

    let unpushed = '?';
    if (!hasCommit) unpushed = '0';
    else if (st.ahead !== null) unpushed = String(st.ahead);
    else {
      const u = git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      if (u.ok && /^\d+$/.test(u.out)) unpushed = `${u.out} (no upstream)`;
    }

    const line = [branch, vs, `uncommitted ${st.dirty}`, `worktree ${f.top}`, `last ${last}`, `unpushed ${unpushed}`].join(' | ');
    return res({ line, ...ff, outcome: 'ok', defaultBranch: dflt });
  } catch {
    return res({ line: null, outcome: 'error' });
  } finally { RUN = null; }
}

// `landed <sha|branch>`. ON: the commit is an ancestor of origin's default
// branch, or every one of its commits has a patch-equivalent there, as
// `git cherry` finds it (a cherry-pick or a rebase merge): `(cherry-picked)`.
// Squash merges are not detected: they read as NOT on, with a note saying so.
// UNKNOWN: the ref does not resolve (typo, deleted branch), or a git call timed
// out before the answer could be trusted.
//
// It always fetches (unless fetch:false): this is an explicit question, and a
// fetch stamp up to five minutes old answers it wrongly for a branch merged in
// that window. A NOT that rests on a skipped or failed fetch says so, since
// only NOT can be wrong because of a stale ref.
export function landed(target, { cwd = process.cwd(), fetch = true, now = Date.now() } = {}) {
  const t0 = Date.now();
  const run = startRun();
  const base = { target_hash: hash8(target) };
  const res = (extra) => ({ ms: Date.now() - t0, steps_ms: { ...run.steps }, fetched: false, fetch_outcome: 'skipped', fetch_age_ms: null, ...extra });
  try {
    const f = repoFacts(cwd);
    if (!f) return res({ line: null, outcome: run.timedOut ? 'timeout' : 'not-repo', ...base });
    if (!target) return res({ line: null, outcome: 'no-target', ...base });
    const dflt = defaultBranch(cwd);
    if (!dflt) return res({ line: null, outcome: 'no-default-branch', ...base });
    const fx = fetch ? maybeFetch(cwd, dflt, f.commonDir, { force: true, now }) : null;
    const ff = fetchFields(fx);
    // Age of the last fetch that SUCCEEDED, as of the answer: 0 right after one.
    const stampAge = fx && fx.outcome === 'ok' ? 0 : null;
    const refBase = `refs/remotes/origin/${dflt}`;
    const tip = git(cwd, ['rev-parse', '--verify', '--quiet', `${refBase}^{commit}`]);
    if (!tip.ok) return res({ line: null, ...ff, outcome: run.timedOut ? 'timeout' : 'git-error', ...base });

    let sha = null;
    for (const cand of [target, `refs/remotes/origin/${target}`]) {
      if (cand.startsWith('-')) continue;
      const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
      if (r.ok && /^[0-9a-f]{7,64}$/.test(r.out)) { sha = r.out; break; }
    }
    const done = (line, answer) => res({
      line, answer, ...ff, ...base, outcome: 'ok', defaultBranch: dflt, stamp_age_ms: stampAge,
      // A NOT that was confirmed against a ref fetched in this very run.
      rechecked_after_NOT: answer === 'NOT' && fx !== null && fx.outcome === 'ok',
    });
    if (!sha) return done(run.localTimedOut ? 'UNKNOWN (git timed out)' : `UNKNOWN (no such ref ${trunc(target, 60)})`, 'UNKNOWN');
    const short = sha.slice(0, 7);
    const anc = git(cwd, ['merge-base', '--is-ancestor', sha, refBase]);
    if (anc.status === 0) return done(`ON ${dflt} (${short})`, 'ON');
    const n = git(cwd, ['rev-list', '--count', `${refBase}..${sha}`]);
    let ahead = n.ok && /^\d+$/.test(n.out) ? Number(n.out) : null;
    // Patch equivalence, as `git cherry` does it: a commit counts as landed
    // when the default branch has a commit with the same patch (a cherry-pick
    // or a rebase merge: new sha, same change). All equivalent: landed. Some
    // equivalent: only the rest are "ahead".
    const ch = git(cwd, ['cherry', refBase, sha]);
    if (ch.ok && ch.out) {
      const rows = ch.out.split('\n').filter(Boolean);
      const open = rows.filter((l) => l.startsWith('+')).length;
      if (open === 0 && rows.every((l) => l.startsWith('-'))) return done(`ON ${dflt} (cherry-picked)`, 'ON');
      if (rows.some((l) => l.startsWith('-'))) ahead = open;
    }
    // A git call that timed out cannot support a NOT.
    if (run.localTimedOut) return done('UNKNOWN (git timed out)', 'UNKNOWN');
    // Only NOT can be wrong because the ref is stale; ON never is.
    let stale = '';
    if (!fx || fx.outcome === 'no-remote') stale = `local origin/${dflt} only; `;
    else if (fx.outcome !== 'ok') stale = `fetch failed; origin/${dflt} may be stale; `;
    // A squash merge has no patch-equivalent commit, so it cannot be told
    // from unmerged work: say so, but only when the answer is NOT.
    return done(`NOT on ${dflt} (${ahead === null ? '' : `ahead ${ahead}; `}${stale}${SQUASH_NOTE})`, 'NOT');
  } catch {
    return res({ line: null, outcome: 'error', ...base });
  } finally { RUN = null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const cwd = val('--cwd') || process.cwd();
  const opts = { cwd, fetch: !argv.includes('--no-fetch'), force: argv.includes('--fresh') };
  const flagsWithValue = new Set(['--cwd']);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(argv[i - 1]));
  const sub = pos[0] === 'landed' ? 'landed' : null;
  const res = sub ? landed(pos[1], opts) : gitBrief(opts);
  if (res.line) process.stdout.write(`${res.line}\n`);
  try {
    // Imported late: a run that prints nothing still logs, but the import is
    // the heaviest part of start-up, so it must not precede the git work.
    const { appendLog } = await import('../hooks/lib/context.mjs');
    appendLog('git-brief.jsonl', {
      at: new Date().toISOString(),
      session_id: String(process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || ''),
      event: sub || 'run',
      chars: res.line ? res.line.length + 1 : 0,
      fetched: res.fetched,
      duration_ms: res.ms,
      ...briefTelemetry(res),
    });
  } catch { /* fail open */ }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(() => process.exit(0), () => process.exit(0));
}
