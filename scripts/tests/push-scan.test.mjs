// Tests for scripts/push-scan.mjs (the pushed-commit leak scan) and its wiring
// into the pre-push gate (ci-local.mjs prePushGate).
//
// Every "private name" here is SYNTHETIC, generated at run time — never read
// from the real denylist file. The denylist the scan sees is a throwaway one
// under a temp AGENT_COMPANION_STATE_DIR.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  compileDenyEntry, parseDenylist, matchDenylist, denylistPath, parseAddedLines,
  runPushScan, listPushedCommits,
} from '../push-scan.mjs';
import { buildScanContext } from '../leak-check.mjs';
import { prePushGate } from '../ci-local.mjs';
import { cleanGitEnv } from '../../plugins/agent-companion/scripts/lib/git-env.mjs';

const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

// A fresh, letters-only synthetic name (no digits: never SHA-like).
function synth(prefix = 'q') {
  return prefix + Array.from(randomBytes(10), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
}

const ZERO = '0'.repeat(40);

function makeRepo(identity = {}) {
  const repo = tmp('push-scan-repo-');
  const env = cleanGitEnv(process.env, {
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...identity,
  });
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
      cwd: repo, env, encoding: 'utf8', windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const commit = (files, message = 'change') => {
    for (const [name, body] of Object.entries(files)) {
      const p = join(repo, name);
      if (body === null) unlinkSync(p);
      else {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, body);
      }
    }
    git('add', '-A');
    const msgFile = join(tmp('push-scan-msg-'), 'msg.txt');
    writeFileSync(msgFile, message);
    git('commit', '-q', '-F', msgFile);
    return git('rev-parse', 'HEAD');
  };
  return { repo, git, commit, env };
}

function stateDirWith(lines) {
  const dir = tmp('push-scan-state-');
  if (lines !== null) {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'private-names.txt'), `${lines.join('\n')}\n`);
  }
  return dir;
}

// Scan with a captured console, the throwaway denylist, and leak-check's
// static + path classes (derived names off: a fixture must not depend on
// this machine's project directories).
function scan(repo, { stateDir, pushes, commits }) {
  const out = [];
  const env = { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir };
  const leakCtx = buildScanContext({ root: repo, noDerived: true, quiet: true, user: 'fixtureuser' }, {});
  const res = runPushScan({
    repo, pushes, commits, env, leakCtx, log: (m) => out.push(m), err: (m) => out.push(m),
  });
  return { ...res, output: out.join('\n') };
}

// ---------------------------------------------------------------------------
// Match semantics
// ---------------------------------------------------------------------------

test('denylist literal: case-insensitive whole word — "ann" never hits "annotation"', () => {
  const re = compileDenyEntry('ann');
  const hit = (s) => { re.lastIndex = 0; return re.test(s); };
  for (const yes of ['ann', 'Ann', 'ANN', "Ann's notes", 'ann-notes', 'ann_x', '(ann)', 'path/ann/x', 'x.ann']) {
    assert.ok(hit(yes), `expected a hit on ${JSON.stringify(yes)}`);
  }
  for (const no of ['annotation', 'Annotation', 'joann', 'banner', 'ann2', 'plann']) {
    assert.ok(!hit(no), `expected NO hit on ${JSON.stringify(no)}`);
  }
});

test('denylist: a synthetic multi-part name matches as a literal, not a regex', () => {
  const name = `${synth()}.${synth()}`;
  const re = compileDenyEntry(name);
  assert.ok(re.test(`see ${name.toUpperCase()} here`));
  re.lastIndex = 0;
  assert.ok(!re.test(name.replace('.', 'x')), 'the dot is literal');
});

test('denylist: "re:" entries are case-insensitive regexes; comments and blanks are ignored; a bad regex is reported by line only', () => {
  const a = synth();
  const parsed = parseDenylist(['# comment', '', `re:${a}-[a-z]`, 're:(unclosed', `  ${synth()}  `].join('\n'));
  assert.deepEqual(parsed.invalid, [4]);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((e) => e.lineNo), [3, 5]);
  assert.deepEqual(matchDenylist(`x\n${a.toUpperCase()}-q`, parsed.entries), [{ entryLine: 3, line: 2 }]);
});

test('denylistPath: <stateRoot>/config/private-names.txt, honouring AGENT_COMPANION_STATE_DIR and CLAUDE_CONFIG_DIR', () => {
  assert.equal(denylistPath({ AGENT_COMPANION_STATE_DIR: join('S', 'root') }), join('S', 'root', 'config', 'private-names.txt'));
  assert.equal(denylistPath({ CLAUDE_CONFIG_DIR: join('C', 'cfg') }), join('C', 'cfg', 'agent-companion', 'config', 'private-names.txt'));
});

test('parseAddedLines: a content line starting "++" is content, not a file header; line numbers are the new file\'s', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    'index 1..2 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -0,0 +3,2 @@',
    '+first',
    '+++ looks like a header',
    '@@ -9 +10 @@',
    '-old',
    '+new',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [
    { file: 'f.txt', line: 3, text: 'first' },
    { file: 'f.txt', line: 4, text: '++ looks like a header' },
    { file: 'f.txt', line: 10, text: 'new' },
  ]);
});

// ---------------------------------------------------------------------------
// Real commits
// ---------------------------------------------------------------------------

test('a denylisted name in a diff is reported by SHA and file:line, and the name is never printed', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'docs/notes.md': `line one\nwritten by ${name} today\n` });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.equal(r.hits.length, 1);
  assert.match(r.output, new RegExp(`${sha.slice(0, 12)} {2}docs/notes\\.md:2 {2}\\[private-names: denylist line 1\\]`));
  assert.ok(!r.output.toLowerCase().includes(name), 'the matched name must never be printed');
});

test('a name in the commit message and in a touched path hits; the path itself is withheld from output', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ [`fixtures/${name}.json`]: '{"a": 1}\n' }, `add the ${name} fixture\n\nmore text\n`);
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /commit message:1 {2}\[private-names/);
  assert.match(r.output, /touched path #1 {2}\[private-names/);
  assert.ok(!r.output.toLowerCase().includes(name));
});

test('a diff hit inside a file whose path matched is printed as "touched path #N:line", never by its path', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ [`${name}/readme.txt`]: `about ${name}\n` });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.match(r.output, /touched path #1:1 {2}\[private-names/);
  assert.ok(!r.output.toLowerCase().includes(name));
});

test('a name added in one commit and deleted in the next is still caught (history, not the tree)', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const base = commit({ 'a.txt': 'clean\n' });
  const bad = commit({ 'a.txt': `clean\n${name}\n` });
  const fix = commit({ 'a.txt': 'clean\n' });
  const r = scan(repo, { stateDir: stateDirWith([name]), pushes: [{ localSha: fix, remoteSha: base, remoteRef: 'refs/heads/feature' }] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.commits, [bad, fix]);
  assert.deepEqual([...new Set(r.hits.map((h) => h.sha))], [bad]);
});

test('placeholder home paths and the docs\' example paths do not hit', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({
    'docs/paths.md': [
      'C:\\Users\\{{USER}}\\.claude\\agent-companion',
      '{{HOME}}/.claude/agent-companion/config/private-names.txt',
      '~/.claude/agent-companion/config/private-names.txt',
      '/home/you/dev/project',
      '/Users/<you>/Library',
      'C:\\Users\\you\\dev\\my-project',
      '%USERPROFILE%\\dev\\my-project',
      '~/dev/acme-app',
      '',
    ].join('\n'),
  }, 'docs: example paths\n');
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.hits, []);
});

test('a real-looking home path (synthetic user) is a leak-check hit, printed without the path', () => {
  const user = synth('u');
  const { repo, commit } = makeRepo();
  const sha = commit({ 'x.md': `see /home/${user}/stuff\n` });
  const r = scan(repo, { stateDir: stateDirWith([]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /x\.md:1 {2}\[leak-check: private-path:posix-home\]/);
  assert.ok(!r.output.includes(user));
});

test('author and committer identity are exempt: a denylisted author name alone is not a hit', () => {
  const name = synth();
  const { repo, commit } = makeRepo({
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.invalid`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.invalid`,
  });
  const sha = commit({ 'a.txt': 'clean\n' }, 'clean message\n');
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 0, r.output);
});

test('a SHA naming a commit in this repo is fine in a message (git revert); an unknown SHA-like run is a hit', () => {
  const { repo, commit } = makeRepo();
  const first = commit({ 'a.txt': 'one\n' });
  const revert = commit({ 'a.txt': 'two\n' }, `Revert "one"\n\nThis reverts commit ${first}.\n`);
  const foreign = randomBytes(20).toString('hex');
  const other = commit({ 'a.txt': 'three\n' }, `port of ${foreign}\n`);
  const r = scan(repo, { stateDir: stateDirWith([]), commits: [revert, other] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.hits.map((h) => [h.sha, h.where, h.label]), [[other, 'message', 'git-sha-like']]);
  assert.ok(!r.output.includes(foreign));
});

test('a missing denylist prints ONE warning line and the scan continues', () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const r = scan(repo, { stateDir: stateDirWith(null), commits: [sha] });
  assert.equal(r.status, 0);
  assert.equal(r.warnings.length, 1);
  assert.doesNotMatch(r.warnings[0], /\n/);
  assert.match(r.warnings[0], /no private-names denylist/);
  assert.match(r.output, /1 commit\(s\) scanned/);
});

test('an invalid re: entry blocks and names the denylist line, not its text', () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const bad = `re:(${synth()}`;
  const r = scan(repo, { stateDir: stateDirWith(['# header', bad]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /denylist line\(s\) 2 are not valid regexes/);
  assert.ok(!r.output.includes(bad.slice(4)));
});

test('listPushedCommits: a known remote sha limits the range to the new commits', () => {
  const { repo, commit } = makeRepo();
  const a = commit({ 'a.txt': '1\n' });
  const b = commit({ 'a.txt': '2\n' });
  const c = commit({ 'a.txt': '3\n' });
  const git = (args) => spawnSync('git', args, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: a }), [b, c]);
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: ZERO }), [a, b, c], 'a new ref: everything not on a remote-tracking ref');
  assert.deepEqual(listPushedCommits(git, { localSha: ZERO, remoteSha: a }), [], 'a delete publishes nothing');
});

// ---------------------------------------------------------------------------
// The pre-push gate: wip/** and backup/** are scanned too
// ---------------------------------------------------------------------------

function gateWith(repo, stateDir) {
  const suiteCalls = [];
  const scanned = [];
  const out = [];
  const opts = {
    scan: (refs) => {
      scanned.push(...refs.map((r) => r.remoteRef));
      return scan(repo, { stateDir, pushes: refs });
    },
    runSuites: (cls, sha) => { suiteCalls.push([cls, sha]); return [{ name: 's', status: 0, outcome: 'pass' }]; },
    log: (m) => out.push(m),
    err: (m) => out.push(m),
  };
  return { opts, suiteCalls, scanned, out };
}

test('pre-push gate: a hit on a wip/** ref blocks the push, and no suite runs', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': `${name}\n` });
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/wip/x', localSha: sha, remoteRef: 'refs/heads/wip/x', remoteSha: ZERO },
  ], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.scanned, ['refs/heads/wip/x']);
  assert.deepEqual(g.suiteCalls, []);
  assert.ok(!g.out.join('\n').toLowerCase().includes(name));
});

test('pre-push gate: wip/** and backup/** refs are scanned (suites still skipped); an ordinary branch gets both', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/wip/x', localSha: sha, remoteRef: 'refs/heads/wip/x', remoteSha: ZERO },
    { localRef: 'refs/heads/backup/y', localSha: sha, remoteRef: 'refs/heads/backup/y', remoteSha: ZERO },
    { localRef: 'refs/heads/feature', localSha: sha, remoteRef: 'refs/heads/feature', remoteSha: ZERO },
    { localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/old', remoteSha: sha },
  ], g.opts);
  assert.equal(status, 0);
  assert.deepEqual(g.scanned, ['refs/heads/wip/x', 'refs/heads/backup/y', 'refs/heads/feature']);
  assert.deepEqual(g.suiteCalls, [['normal', sha]]);
});

test('pre-push gate: a backup/** ref carrying a hit blocks too', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' }, `note about ${name}\n`);
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/backup/y', localSha: sha, remoteRef: 'refs/heads/backup/y', remoteSha: ZERO },
  ], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.suiteCalls, []);
});

test('pre-push gate: a scan that throws blocks (fails closed)', async () => {
  const out = [];
  const status = await prePushGate([
    { localRef: 'refs/heads/feature', localSha: 'a'.repeat(40), remoteRef: 'refs/heads/feature', remoteSha: ZERO },
  ], {
    scan: () => { throw new Error('boom'); }, runSuites: () => { throw new Error('must not run'); }, log: (m) => out.push(m), err: (m) => out.push(m),
  });
  assert.equal(status, 1);
  assert.match(out.join('\n'), /BLOCKED — the pushed-commit scan could not run: boom/);
});
