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
//                                       NOT on <default> (ahead N)
//   --no-fetch                          read local refs only
//   --fresh                             fetch even if the last fetch was recent
//   --cwd <dir>                         repo to look at (default: cwd)
//
// Cross-machine branch state is the coordination server's `branch_status` MCP tool; this
// script only reads the repository it runs in (plus one fetch of origin).
//
// FETCH POLICY. Before reading, the script fetches origin's default branch
// (and only that), unless a fetch ran in this repository within
// FETCH_FRESH_MS (5 minutes; a worktree shares its repository's stamp, so ten
// agents starting together cause one fetch, not ten). The fetch never
// prompts (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, ssh BatchMode) and is
// killed after FETCH_TIMEOUT_MS (1.5 s). A failed or timed-out fetch is not
// retried for FAIL_BACKOFF_MS (1 minute), so an offline machine pays the
// timeout once, not at every agent start. The whole run is held under about
// 2 s: the fetch is the only step that can wait, and each local git call is
// capped at LOCAL_TIMEOUT_MS.
//
// FAIL OPEN. Outside a git repository, in a bare repository, or on any error,
// nothing is printed and the exit status is 0.
//
// Telemetry: every CLI run appends a row to telemetry/git-brief.jsonl
// (hooks/lib/context.mjs appendLog; the hook, hooks/git-brief.mjs, writes its
// own `inject-*` rows). See docs/TELEMETRY.md.

import { spawnSync } from 'node:child_process';
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
export const SUBJECT_MAX = 60;
export const STAMP_FILE = 'ac-git-brief-fetch.json';

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  // Never let ssh wait on a passphrase or host-key question. An operator's own
  // GIT_SSH_COMMAND / GIT_SSH is theirs and is left alone.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=2';
  return env;
}

function git(cwd, args, timeout = localTimeout()) {
  const r = spawnSync('git', args, {
    cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error || r.status === null) return { ok: false, out: '', timedOut: r.error?.code === 'ETIMEDOUT' };
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r?\n$/, ''), status: r.status };
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

// Fetch origin's default branch unless one ran recently. Returns whether a
// fetch was attempted. The stamp is written BEFORE the attempt (so agents
// starting at the same moment skip rather than all fetch) and again after,
// with the outcome. A stamp from a run that never finished (killed) counts as
// a failure for FAIL_BACKOFF_MS.
export function maybeFetch(cwd, branch, commonDir, { force = false, now = Date.now(), timeoutMs = fetchTimeout() } = {}) {
  if (!branch || !commonDir) return false;
  if (!git(cwd, ['remote', 'get-url', 'origin']).ok) return false;
  const file = join(commonDir, STAMP_FILE);
  const st = readStamp(file);
  if (!force && st) {
    const age = now - st.at;
    const window = st.ok === true ? FETCH_FRESH_MS : FAIL_BACKOFF_MS;
    if (age >= 0 && age < window) return false;
  }
  const write = (ok) => { try { writeFileSync(file, JSON.stringify({ at: now, ok })); } catch { /* read-only repo: fetch anyway, just unstamped */ } };
  write(null);
  const r = git(cwd, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', branch], timeoutMs);
  write(r.ok);
  return true;
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

// The one-line brief, or null (not a repo / nothing readable). Never throws.
export function gitBrief({ cwd = process.cwd(), fetch = true, force = false, now = Date.now() } = {}) {
  const t0 = Date.now();
  try {
    const f = repoFacts(cwd);
    if (!f) return { line: null, fetched: false, ms: Date.now() - t0 };
    const dflt = defaultBranch(cwd);
    const fetched = fetch ? maybeFetch(cwd, dflt, f.commonDir, { force, now }) : false;

    const s = git(cwd, ['status', '--porcelain=v2', '--branch']);
    if (!s.ok) return { line: null, fetched, ms: Date.now() - t0 };
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
    return { line, fetched, ms: Date.now() - t0, defaultBranch: dflt };
  } catch {
    return { line: null, fetched: false, ms: Date.now() - t0 };
  }
}

// `landed <sha|branch>`. ON: the commit is an ancestor of origin's default
// branch, or every one of its commits has a patch-equivalent there (a rebase
// merge). Squash merges are not detected: they read as NOT on.
export function landed(target, { cwd = process.cwd(), fetch = true, force = false, now = Date.now() } = {}) {
  const t0 = Date.now();
  try {
    const f = repoFacts(cwd);
    if (!f || !target) return { line: null, fetched: false, ms: Date.now() - t0 };
    const dflt = defaultBranch(cwd);
    if (!dflt) return { line: null, fetched: false, ms: Date.now() - t0 };
    const fetched = fetch ? maybeFetch(cwd, dflt, f.commonDir, { force, now }) : false;
    const base = `refs/remotes/origin/${dflt}`;
    const tip = git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    if (!tip.ok) return { line: null, fetched, ms: Date.now() - t0 };

    let sha = null;
    for (const cand of [target, `refs/remotes/origin/${target}`]) {
      if (cand.startsWith('-')) continue;
      const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
      if (r.ok && /^[0-9a-f]{7,64}$/.test(r.out)) { sha = r.out; break; }
    }
    const done = (line) => ({ line, fetched, ms: Date.now() - t0, defaultBranch: dflt });
    if (!sha) return done(`NOT on ${dflt} (unknown ref ${trunc(target, 60)})`);
    const short = sha.slice(0, 7);
    if (git(cwd, ['merge-base', '--is-ancestor', sha, base]).status === 0) return done(`ON ${dflt} (${short})`);
    const n = git(cwd, ['rev-list', '--count', `${base}..${sha}`]);
    const ahead = n.ok && /^\d+$/.test(n.out) ? Number(n.out) : null;
    const ch = git(cwd, ['cherry', base, sha]);
    if (ch.ok && ch.out && ch.out.split('\n').every((l) => l.startsWith('-'))) return done(`ON ${dflt} (${short}, rebased)`);
    return done(ahead === null ? `NOT on ${dflt}` : `NOT on ${dflt} (ahead ${ahead})`);
  } catch {
    return { line: null, fetched: false, ms: Date.now() - t0 };
  }
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
    });
  } catch { /* fail open */ }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(() => process.exit(0), () => process.exit(0));
}
