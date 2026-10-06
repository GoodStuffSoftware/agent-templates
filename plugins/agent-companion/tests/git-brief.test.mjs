// scripts/git-brief.mjs (the one-line git state + `landed`) and hooks/git-brief.mjs
// (the SessionStart / SubagentStart injection, the git_brief switch, telemetry).
// Every repository is a throwaway under a fixture temp dir; "origin" is a bare
// repository on the local disk, so no test touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import { gitBrief, landed, runFetch, STAMP_FILE, FETCH_FRESH_MS, SQUASH_NOTE } from '../scripts/git-brief.mjs';

const IDENT = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...cleanGitEnv(), ...IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

function commit(repo, file, msg = `edit ${file}`) {
  writeFileSync(join(repo, file), `${msg}\n${Math.random()}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

// A bare origin plus a clone ("work") on main with two commits pushed.
function makeRepos(root) {
  const origin = join(root, 'origin.git');
  mkdirSync(origin, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-B', 'main');
  commit(work, 'a.txt', 'seed one');
  commit(work, 'b.txt', 'seed two');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  return { origin, work };
}

function withRepos(fn) {
  const fx = makeFixture();
  try { return fn({ ...makeRepos(fx.dir), fx }); } finally { fx.cleanup(); }
}

// The default caps (1.5 s fetch, 1 s per local call) are sized for agent
// start-up, not for a test run where the whole suite is spawning git at once.
// Raised here for in-process calls, and passed to every child the same way.
process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS = '60000';
process.env.AC_GIT_BRIEF_LOCAL_TIMEOUT_MS = '60000';

const noFetch = { fetch: false };

test('brief: one line, every field, on a clean branch that matches origin', () => withRepos(({ work }) => {
  const r = gitBrief({ cwd: work, ...noFetch });
  assert.ok(r.line, 'a line');
  assert.equal(r.line.includes('\n'), false, 'one line');
  const parts = r.line.split(' | ');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'main');
  assert.equal(parts[1], 'ahead 0 behind 0 origin/main');
  assert.equal(parts[2], 'uncommitted 0');
  assert.match(parts[3], /^worktree .*work$/);
  assert.match(parts[4], /^last [0-9a-f]{7,} seed two$/);
  assert.equal(parts[5], 'unpushed 0');
}));

test('brief: uncommitted count (modified + untracked), unpushed and ahead counts, long subject truncated', () => withRepos(({ work }) => {
  git(work, 'checkout', '-q', '-b', 'feat/x');
  commit(work, 'c.txt', `a very long subject ${'x'.repeat(120)}`);
  commit(work, 'd.txt', 'second local commit');
  writeFileSync(join(work, 'a.txt'), 'changed\n');
  writeFileSync(join(work, 'new1.txt'), 'n\n');
  writeFileSync(join(work, 'new2.txt'), 'n\n');
  const parts = gitBrief({ cwd: work, ...noFetch }).line.split(' | ');
  assert.equal(parts[0], 'feat/x');
  assert.equal(parts[1], 'ahead 2 behind 0 origin/main');
  assert.equal(parts[2], 'uncommitted 3');
  assert.match(parts[4], /^last [0-9a-f]+ second local commit$/);
  assert.equal(parts[5], 'unpushed 2 (no upstream)');
  commit(work, 'e.txt', `a very long subject ${'x'.repeat(120)}`);
  const last = gitBrief({ cwd: work, ...noFetch }).line.split(' | ')[4];
  assert.ok(last.length <= 'last 1234567 '.length + 60 + 2, `subject capped: ${last.length}`);
  assert.ok(last.endsWith('...'));
}));

test('brief: a branch with an upstream counts unpushed against it', () => withRepos(({ work }) => {
  commit(work, 'c.txt', 'not pushed');
  const parts = gitBrief({ cwd: work, ...noFetch }).line.split(' | ');
  assert.equal(parts[1], 'ahead 1 behind 0 origin/main');
  assert.equal(parts[5], 'unpushed 1');
}));

test('brief: detached HEAD is named by sha; a repo with no origin says so; a repo with no commits does not throw', () => withRepos(({ work, fx }) => {
  const sha = git(work, 'rev-parse', '--short', 'HEAD');
  git(work, 'checkout', '-q', '--detach');
  assert.equal(gitBrief({ cwd: work, ...noFetch }).line.split(' | ')[0], `detached@${sha}`);

  const lone = join(fx.dir, 'lone');
  mkdirSync(lone);
  git(lone, 'init', '-q', '-b', 'main');
  const empty = gitBrief({ cwd: lone, ...noFetch }).line;
  assert.match(empty, /^main \| no origin \| uncommitted 0 \| worktree .*lone \| last no commits \| unpushed 0$/);
  commit(lone, 'x.txt', 'only');
  assert.match(gitBrief({ cwd: lone, ...noFetch }).line, /^main \| no origin \| .*\| unpushed 1 \(no upstream\)$/);
}));

test('brief: a linked worktree reports its own path and branch', () => withRepos(({ work, fx }) => {
  const wt = join(fx.dir, 'wt');
  git(work, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
  const parts = gitBrief({ cwd: wt, ...noFetch }).line.split(' | ');
  assert.equal(parts[0], 'feat/wt');
  assert.match(parts[3], /^worktree .*wt$/);
}));

test('brief: outside a repository, or with a bad cwd, there is no line and no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-nogit-'));
  try {
    assert.equal(gitBrief({ cwd: dir, ...noFetch }).line, null);
    assert.equal(gitBrief({ cwd: join(dir, 'does-not-exist') }).line, null);
    assert.equal(landed('main', { cwd: dir }).line, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fetch: runs once, is skipped inside the freshness window, forced on request, and sees a new origin commit', () => withRepos(({ origin, work, fx }) => {
  const other = join(fx.dir, 'other');
  git(fx.dir, 'clone', '-q', origin, other);
  commit(other, 'z.txt', 'from elsewhere');
  git(other, 'push', '-q', 'origin', 'main');

  const stale = gitBrief({ cwd: work, ...noFetch });
  assert.match(stale.line, /ahead 0 behind 0 origin\/main/);
  assert.equal(stale.fetched, false);

  const first = gitBrief({ cwd: work });
  assert.equal(first.fetched, true);
  assert.match(first.line, /behind 1 origin\/main/);
  const stamp = join(work, '.git', STAMP_FILE);
  assert.ok(existsSync(stamp), 'stamp written in the shared git dir');
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).ok, true);

  assert.equal(gitBrief({ cwd: work }).fetched, false, 'fresh: skipped');
  assert.equal(gitBrief({ cwd: work, force: true }).fetched, true, '--fresh forces');
  // The window is a constant, and a stamp older than it fetches again.
  assert.equal(gitBrief({ cwd: work, now: Date.now() + FETCH_FRESH_MS + 1000 }).fetched, true);
}));

test('fetch: a linked worktree shares the stamp, so a second agent does not fetch again', () => withRepos(({ work, fx }) => {
  const wt = join(fx.dir, 'wt2');
  git(work, 'worktree', 'add', '-q', '-b', 'feat/wt2', wt);
  assert.equal(gitBrief({ cwd: work }).fetched, true);
  assert.equal(gitBrief({ cwd: wt }).fetched, false);
}));

test('fetch: an unreachable origin still prints the line, and is not retried inside the backoff', () => withRepos(({ work, fx }) => {
  git(work, 'remote', 'set-url', 'origin', join(fx.dir, 'gone.git'));
  const a = gitBrief({ cwd: work });
  assert.equal(a.fetched, true, 'attempted');
  assert.ok(a.line, 'line still printed from local refs');
  assert.match(a.line, /ahead 0 behind 0 origin\/main/);
  assert.equal(gitBrief({ cwd: work }).fetched, false, 'failure backoff');
}));

test('fetch: one that outlives the cap is killed, the line still prints, and the failure is stamped', () => withRepos(({ work }) => {
  const saved = process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS;
  process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS = '1';
  try {
    const r = gitBrief({ cwd: work });
    assert.equal(r.fetched, true);
    assert.match(r.line, /^main \| ahead 0 behind 0 origin\/main/);
    assert.equal(JSON.parse(readFileSync(join(work, '.git', STAMP_FILE), 'utf8')).ok, false);
  } finally { process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS = saved; }
}));

test('landed: ON for an ancestor of origin/main, by sha, branch and origin/<branch>', () => withRepos(({ work }) => {
  const sha = git(work, 'rev-parse', 'HEAD');
  const short = sha.slice(0, 7);
  assert.equal(landed(sha, { cwd: work, ...noFetch }).line, `ON main (${short})`);
  assert.equal(landed('main', { cwd: work, ...noFetch }).line, `ON main (${short})`);
  assert.equal(landed('origin/main', { cwd: work, ...noFetch }).line, `ON main (${short})`);
  assert.equal(landed(short, { cwd: work, ...noFetch }).line, `ON main (${short})`);
}));

test('landed: NOT on, with how far ahead; an unknown ref says so', () => withRepos(({ work }) => {
  git(work, 'checkout', '-q', '-b', 'feat/y');
  commit(work, 'c.txt', 'one');
  commit(work, 'd.txt', 'two');
  assert.equal(landed('feat/y', { cwd: work, ...noFetch }).line, `NOT on main (ahead 2; local origin/main only; ${SQUASH_NOTE})`);
  assert.equal(landed('HEAD~1', { cwd: work, ...noFetch }).line, `NOT on main (ahead 1; local origin/main only; ${SQUASH_NOTE})`);
}));

test('landed: a cherry-pick (same patch, new sha) reads as ON (cherry-picked); it needs the fetch to see origin/main', () => withRepos(({ origin, work, fx }) => {
  git(work, 'checkout', '-q', '-b', 'feat/r');
  const tip = commit(work, 'feature.txt', 'feature work');
  git(work, 'push', '-q', 'origin', 'feat/r');
  const other = join(fx.dir, 'other');
  git(fx.dir, 'clone', '-q', origin, other);
  git(other, 'fetch', '-q', 'origin');
  // A different parent, or a same-second cherry-pick could reproduce the commit's sha exactly.
  commit(other, 'unrelated.txt', 'unrelated main work');
  git(other, 'cherry-pick', tip.slice(0, 7));
  git(other, 'push', '-q', 'origin', 'main');
  // Without a fetch the local origin/main has not moved.
  assert.match(landed('feat/r', { cwd: work, ...noFetch }).line, /^NOT on main/);
  assert.equal(landed('feat/r', { cwd: work }).line, 'ON main (cherry-picked)');
}));

// Lands `shas` on origin's main from a second clone, the way a cherry-pick or a
// rebase merge would: same patches, new parents, so new shas.
function landOnMain({ origin, fx }, shas, { unrelatedFirst = true } = {}) {
  const other = join(fx.dir, `other-${Math.random().toString(36).slice(2, 8)}`);
  git(fx.dir, 'clone', '-q', origin, other);
  if (unrelatedFirst) commit(other, `unrelated-${Math.random().toString(36).slice(2, 8)}.txt`, 'unrelated main work');
  for (const s of shas) git(other, 'cherry-pick', s.slice(0, 7));
  git(other, 'push', '-q', 'origin', 'main');
}

test('landed: every commit of a multi-commit branch cherry-picked or rebased onto main reads ON (cherry-picked), and does not say NOT', () => withRepos((ctx) => {
  const { work } = ctx;
  git(work, 'checkout', '-q', '-b', 'feat/m');
  const a = commit(work, 'f1.txt', 'feature one');
  const b = commit(work, 'f2.txt', 'feature two');
  const c = commit(work, 'f3.txt', 'feature three');
  git(work, 'push', '-q', 'origin', 'feat/m');
  landOnMain(ctx, [a, b, c]);
  const line = landed('feat/m', { cwd: work }).line;
  assert.equal(line, 'ON main (cherry-picked)');
  assert.ok(!/NOT|squash/.test(line));
  // By sha and by origin/<branch> too.
  assert.equal(landed(c, { cwd: work, fetch: false }).line, 'ON main (cherry-picked)');
  assert.equal(landed('origin/feat/m', { cwd: work, fetch: false }).line, 'ON main (cherry-picked)');
}));

test('landed: only some commits cherry-picked is NOT, counting just the ones main lacks, with the squash note', () => withRepos((ctx) => {
  const { work } = ctx;
  git(work, 'checkout', '-q', '-b', 'feat/p');
  const a = commit(work, 'g1.txt', 'part one');
  commit(work, 'g2.txt', 'part two');
  commit(work, 'g3.txt', 'part three');
  git(work, 'push', '-q', 'origin', 'feat/p');
  landOnMain(ctx, [a]);
  assert.equal(landed('feat/p', { cwd: work }).line, `NOT on main (ahead 2; ${SQUASH_NOTE})`);
}));

test('landed: a squash merge is NOT, and the line says a squash merge would not show; the note appears only with NOT', () => withRepos((ctx) => {
  const { work, origin, fx } = ctx;
  git(work, 'checkout', '-q', '-b', 'feat/s');
  commit(work, 'h1.txt', 'sq one');
  commit(work, 'h2.txt', 'sq two');
  git(work, 'push', '-q', 'origin', 'feat/s');
  const other = join(fx.dir, 'other-squash');
  git(fx.dir, 'clone', '-q', origin, other);
  git(other, 'fetch', '-q', 'origin', 'feat/s');
  git(other, 'merge', '--squash', 'origin/feat/s');
  git(other, 'commit', '-q', '-m', 'squash of feat/s');
  git(other, 'push', '-q', 'origin', 'main');
  const line = landed('feat/s', { cwd: work }).line;
  assert.equal(line, `NOT on main (ahead 2; ${SQUASH_NOTE})`);
  assert.equal(landed('main', { cwd: work, fetch: false }).line.includes('squash'), false, 'an ON answer carries no note');
  assert.equal(landed('nope', { cwd: work, fetch: false }).line.includes('squash'), false, 'an unknown ref carries no note');
}));

test('landed: a missing default branch (no origin) prints nothing', () => {
  const fx = makeFixture();
  try {
    const lone = join(fx.dir, 'lone');
    mkdirSync(lone);
    git(lone, 'init', '-q', '-b', 'main');
    commit(lone, 'x.txt', 'only');
    assert.equal(landed('HEAD', { cwd: lone }).line, null);
  } finally { fx.cleanup(); }
});

// --- review fixes: landed always fetches fresh; a timed-out fetch leaves no orphan ---

test('landed: always fetches fresh, even inside the 5-minute window, so a merge made after the last fetch reads ON', () => withRepos(({ origin, work, fx }) => {
  git(work, 'checkout', '-q', '-b', 'feat/late');
  const tip = commit(work, 'late.txt', 'late feature');
  git(work, 'push', '-q', 'origin', 'feat/late');
  // A start-up fetch stamps "fresh" (and refreshes origin/main) BEFORE the merge happens.
  assert.equal(gitBrief({ cwd: work }).fetched, true);
  assert.equal(gitBrief({ cwd: work }).fetched, false, 'the stamp is fresh');
  const other = join(fx.dir, 'other-late');
  git(fx.dir, 'clone', '-q', origin, other);
  git(other, 'fetch', '-q', 'origin', 'feat/late');
  git(other, 'merge', '-q', '--ff-only', tip);
  git(other, 'push', '-q', 'origin', 'main');
  // The question is explicit, so it must not trust the stamp.
  const r = landed('feat/late', { cwd: work });
  assert.equal(r.line, `ON main (${tip.slice(0, 7)})`);
  assert.equal(r.fetched, true, 'landed fetched although the stamp was fresh');
}));

test('landed: a NOT answer that rests on a skipped or failed fetch says the ref may be stale', () => withRepos(({ work, fx }) => {
  git(work, 'checkout', '-q', '-b', 'feat/z');
  commit(work, 'z1.txt', 'z one');
  const skipped = landed('feat/z', { cwd: work, fetch: false }).line;
  assert.match(skipped, /^NOT on main \(ahead 1; /);
  assert.match(skipped, /local origin\/main only/);
  git(work, 'remote', 'set-url', 'origin', join(fx.dir, 'gone.git'));
  const failed = landed('feat/z', { cwd: work });
  assert.match(failed.line, /fetch failed; origin\/main may be stale/);
  assert.equal(failed.fetch_outcome, 'fail');
}));

test('landed: an unknown or deleted ref is UNKNOWN, not NOT on', () => withRepos(({ work }) => {
  assert.equal(landed('--upload-pack=x', { cwd: work, ...noFetch }).line, 'UNKNOWN (no such ref --upload-pack=x)');
  assert.equal(landed('nope', { cwd: work, ...noFetch }).answer, 'UNKNOWN');
}));

// A server that accepts and never answers, the way a stalled proxy or a dead
// Git host does. The test thread blocks inside spawnSync while git runs, so the
// kernel accepts the connection and Node sees it afterwards: what matters is
// whether the client end is closed once the call returns.
//
// The socket is drained (resume) on purpose. git sends its HTTP request and then
// waits; a killed process's kernel ends the connection one of two ways. Windows
// (taskkill /F) resets it, which surfaces as ECONNRESET and closes the socket
// whether or not it was read. Linux (SIGKILL) closes it gracefully with a FIN,
// and Node only reports that end of stream once everything before it has been
// read: an undrained socket holding the request bytes never emits 'end', so
// never 'close', and a correctly killed tree would read as an orphan. Draining
// changes nothing for a survivor: a live git-remote-http sends neither FIN nor
// RST, so its socket still never closes.
async function hangServer() {
  const sockets = [];
  const srv = createServer((s) => {
    const rec = { s, closed: false, events: [] };
    sockets.push(rec);
    s.resume();
    s.on('end', () => rec.events.push('end'));
    s.on('error', (e) => rec.events.push(`error ${e.code}`));
    s.on('close', () => { rec.closed = true; rec.events.push('close'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, sockets, close: () => { for (const x of sockets) x.s.destroy(); srv.close(); } };
}

test('fetch timeout: the whole git process tree is killed, so no git-remote-http survives holding the connection', async () => {
  const hs = await hangServer();
  const fx = makeFixture();
  const saved = { t: process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS, l: process.env.GIT_HTTP_LOW_SPEED_LIMIT, s: process.env.GIT_HTTP_LOW_SPEED_TIME };
  try {
    const { work } = makeRepos(fx.dir);
    git(work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${hs.port}/r.git`);
    // Disarm git's own low-speed abort so only the tree kill can end the child.
    process.env.GIT_HTTP_LOW_SPEED_LIMIT = '1';
    process.env.GIT_HTTP_LOW_SPEED_TIME = '120';
    process.env.AC_GIT_BRIEF_FETCH_TIMEOUT_MS = '700';
    const r = gitBrief({ cwd: work });
    assert.equal(r.fetched, true);
    assert.equal(r.fetch_outcome, 'timeout');
    assert.ok(r.line, 'the line still prints');
    // The guarantee under test is that the FETCH is bounded by the cap (plus the
    // runner backstop), not by git's own 120 s low-speed abort. So bound the fetch
    // step, which gitBrief times itself around exactly that call. Timing the whole
    // gitBrief() call also counts its ~6 local git spawns (repo-facts, symbolic-ref,
    // remote, status, rev-list, log), each of which pays process start-up on a
    // CPU-starved machine, and those are not what the cap bounds (the suite raises
    // the local cap to 60 s). That made this check flake at ~1 in 6 under load.
    const fetchMs = r.steps_ms.fetch;
    assert.equal(typeof fetchMs, 'number', 'gitBrief reports the fetch step time');
    assert.ok(fetchMs < 6000, `fetch step returned in ${fetchMs} ms (steps: ${JSON.stringify(r.steps_ms)})`);
    // Wait for the close events themselves (bounded), not a fixed sleep.
    for (const until = Date.now() + 5000; Date.now() < until;) {
      if (hs.sockets.length >= 1 && hs.sockets.every((x) => x.closed)) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(hs.sockets.length >= 1, 'git did connect to the hang server');
    assert.ok(hs.sockets.every((x) => x.closed),
      `every connection was closed: no orphaned git-remote-http (socket events: ${JSON.stringify(hs.sockets.map((x) => x.events))})`);
  } finally {
    for (const [k, v] of [['AC_GIT_BRIEF_FETCH_TIMEOUT_MS', saved.t], ['GIT_HTTP_LOW_SPEED_LIMIT', saved.l], ['GIT_HTTP_LOW_SPEED_TIME', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    hs.close(); fx.cleanup();
  }
});

// On a loaded machine the runner can take longer than the cap plus slack (node
// start-up, then taskkill), so the spawnSync backstop kills the runner before
// the runner has killed git. Forced here by a backstop shorter than the cap.
test('fetch backstop: when the runner itself is killed, git\'s tree is still killed, so no git-remote-http survives', async () => {
  const hs = await hangServer();
  const fx = makeFixture();
  const saved = { l: process.env.GIT_HTTP_LOW_SPEED_LIMIT, s: process.env.GIT_HTTP_LOW_SPEED_TIME };
  try {
    const { work } = makeRepos(fx.dir);
    git(work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${hs.port}/r.git`);
    process.env.GIT_HTTP_LOW_SPEED_LIMIT = '1';
    process.env.GIT_HTTP_LOW_SPEED_TIME = '120';
    const outcome = runFetch(work, ['fetch', '--quiet', 'origin', 'main'], 60000, { backstopMs: 5000 });
    assert.equal(outcome, 'timeout');
    for (const until = Date.now() + 5000; Date.now() < until;) {
      if (hs.sockets.length >= 1 && hs.sockets.every((x) => x.closed)) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(hs.sockets.length >= 1, 'git did connect to the hang server');
    assert.ok(hs.sockets.every((x) => x.closed),
      `every connection was closed: no orphaned git-remote-http (socket events: ${JSON.stringify(hs.sockets.map((x) => x.events))})`);
  } finally {
    for (const [k, v] of [['GIT_HTTP_LOW_SPEED_LIMIT', saved.l], ['GIT_HTTP_LOW_SPEED_TIME', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    hs.close(); fx.cleanup();
  }
});

// --- the CLI ----------------------------------------------------------------

test('cli: prints the line, exits 0, and logs a run row; outside a repository it prints nothing and still exits 0', () => withRepos(({ work, fx }) => {
  const env = { AGENT_COMPANION_STATE_DIR: fx.stateDir };
  const r = runScript('scripts/git-brief.mjs', ['--no-fetch', '--cwd', work], { env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /^main \| ahead 0 behind 0 origin\/main \| uncommitted 0 \|/);

  const l = runScript('scripts/git-brief.mjs', ['landed', 'HEAD', '--no-fetch', '--cwd', work], { env });
  assert.match(l.stdout.trim(), /^ON main \([0-9a-f]{7}\)$/);

  const none = mkdtempSync(join(tmpdir(), 'ac-nogit-'));
  try {
    const n = runScript('scripts/git-brief.mjs', ['--cwd', none], { env });
    assert.equal(n.status, 0);
    assert.equal(n.stdout, '');
  } finally { rmSync(none, { recursive: true, force: true }); }

  const rows = readJsonl(join(fx.stateDir, 'telemetry', 'git-brief.jsonl'));
  assert.deepEqual(rows.map((x) => x.event), ['run', 'landed', 'run']);
  assert.equal(rows[0].chars, r.stdout.length);
  assert.equal(rows[0].fetched, false);
  assert.equal(typeof rows[0].duration_ms, 'number');
  assert.equal(rows[2].chars, 0);
  assert.ok(rows.every((x) => typeof x.at === 'string' && x.v));
  // Outcome separates "nothing to say" from "could not say"; the fetch outcome and per-step ms are logged.
  assert.deepEqual(rows.map((x) => x.outcome), ['ok', 'ok', 'not-repo']);
  assert.equal(rows[0].fetch_outcome, 'skipped');
  assert.equal(typeof rows[0].steps_ms, 'object');
  assert.ok(rows[0].steps_ms.status >= 0);
  assert.equal(rows[1].answer, 'ON');
  assert.match(rows[1].target_hash, /^[0-9a-f]{8}$/);
  assert.equal(rows[1].rechecked_after_NOT, false);
  assert.equal(rows[1].target_hash.includes('HEAD'), false, 'the target is hashed, not logged');
}));

// --- the hook ---------------------------------------------------------------

const HOOK = 'hooks/git-brief.mjs';

test('hook: SessionStart and SubagentStart each inject one additionalContext line with the refresh command, and log it', () => withRepos(({ work, fx }) => {
  const env = { AGENT_COMPANION_STATE_DIR: fx.stateDir };
  const s = runHook(HOOK, { session_id: 'sess-1', cwd: work, source: 'startup' }, { env, args: ['--event', 'session-start'] });
  assert.equal(s.status, 0);
  assert.equal(s.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = s.json.hookSpecificOutput.additionalContext;
  assert.equal(text.includes('\n'), false, 'one line');
  assert.match(text, /^Git: main \| ahead 0 behind 0 origin\/main \| uncommitted 0 \|/);
  assert.match(text, /scripts\/git-brief\.mjs" \[landed <sha\|branch>\]$/);
  assert.match(text, /instead of git status\/fetch/);

  const a = runHook(HOOK, { session_id: 'sess-1', agent_id: 'ag-1', agent_type: 'agent-companion:ac-sonnet-high', cwd: work },
    { env, args: ['--event', 'subagent-start'] });
  assert.equal(a.json.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(a.json.hookSpecificOutput.additionalContext, /^Git: main \|/);

  const rows = readJsonl(join(fx.stateDir, 'telemetry', 'git-brief.jsonl'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'inject-session');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].chars, text.length);
  assert.equal(rows[0].fetched, true, 'the first start fetched');
  assert.equal(rows[1].event, 'inject-subagent');
  assert.equal(rows[1].agent_type, 'agent-companion:ac-sonnet-high');
  assert.equal(rows[1].fetched, false, 'the second start was inside the window');
  assert.equal(typeof rows[1].duration_ms, 'number');
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].fetch_outcome, 'ok');
  assert.equal(rows[0].fetch_age_ms, null, 'no earlier stamp');
  assert.equal(rows[1].fetch_outcome, 'fresh-skip');
  assert.equal(typeof rows[1].fetch_age_ms, 'number');
  assert.equal(typeof rows[0].start_ms, 'number', 'hook start latency');
  assert.ok(rows[0].steps_ms.fetch >= 0 && rows[0].steps_ms.status >= 0, 'time per git step');
}));

test('hook: git_brief off (env CLAUDE_PLUGIN_OPTION_GIT_BRIEF=0) prints nothing, runs no git, writes no row', () => withRepos(({ work, fx }) => {
  const env = { AGENT_COMPANION_STATE_DIR: fx.stateDir, CLAUDE_PLUGIN_OPTION_GIT_BRIEF: '0' };
  for (const ev of ['session-start', 'subagent-start']) {
    const r = runHook(HOOK, { session_id: 'sess-2', cwd: work }, { env, args: ['--event', ev] });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(join(fx.stateDir, 'telemetry', 'git-brief.jsonl')), false);
  const stampDir = join(work, '.git', STAMP_FILE);
  assert.equal(existsSync(stampDir), false, 'no fetch was attempted');
}));

test('hook: outside a repository, with an unknown event, or with a garbled payload, it prints nothing and exits 0', () => {
  const fx = makeFixture();
  const none = mkdtempSync(join(tmpdir(), 'ac-nogit-'));
  try {
    const env = { AGENT_COMPANION_STATE_DIR: fx.stateDir };
    const a = runHook(HOOK, { session_id: 's3', cwd: none }, { env, args: ['--event', 'session-start'] });
    assert.equal(a.status, 0);
    assert.equal(a.stdout, '');
    const b = runHook(HOOK, { session_id: 's3', cwd: none }, { env, args: ['--event', 'bogus'] });
    assert.equal(b.status, 0);
    assert.equal(b.stdout, '');
    const c = runHook(HOOK, undefined, { env, args: ['--event', 'session-start'], cwd: none });
    assert.equal(c.status, 0);
    assert.equal(c.stdout, '');
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'git-brief.jsonl'));
    assert.equal(rows[0].chars, 0, 'a run that said nothing is still logged, with chars 0');
    assert.equal(rows[0].outcome, 'not-repo', 'and says why');
  } finally { rmSync(none, { recursive: true, force: true }); fx.cleanup(); }
});

test('hooks.json registers the hook on SessionStart and SubagentStart; plugin.json declares git_brief on by default', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  const uses = (ev, arg) => hooks[ev].some((g) => g.hooks.some((h) => (h.args || []).join(' ').includes(`git-brief.mjs --event ${arg}`)));
  assert.ok(uses('SessionStart', 'session-start'));
  assert.ok(uses('SubagentStart', 'subagent-start'));
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(plugin.userConfig.git_brief.type, 'boolean');
  assert.equal(plugin.userConfig.git_brief.default, true);
});
