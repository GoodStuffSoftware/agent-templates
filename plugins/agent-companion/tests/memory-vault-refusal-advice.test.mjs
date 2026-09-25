// A memory-vault refusal must never talk anyone into destroying history.
//
// A refusal is followed by whoever reads it, whether a person or an agent. The
// round-2 review found a chain that ended badly. A genuine vault whose owner
// had changed its local user.email was refused as "not a vault this plugin
// created" and told to move the stray marker out. The next run refused the same
// directory as a repository without a marker, with the advice "delete that
// directory and retry". That deleted the whole backup history.
//
// So these tests do not only check the first message. They WALK the advice:
// each step does what the refusal says, reruns, and checks again. The walk
// continues until the vault works. At every step, a message about a directory
// that holds commits must contain no deletion verb at all. At the end, every
// directory that was moved aside must still hold every commit it started with.
//
// Every repository here is a throwaway under the fixture temp dir. GIT_* is
// only ever set on a child process.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, chmodSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'memory-vault.mjs');
const VAULT_EMAIL = 'memory-vault@agent-companion.local';
const MARKER = JSON.stringify({ kind: 'agent-companion-memory-vault', schema: 1, createdAt: 'x' });

// Any of these in a refusal about a directory holding commits is a failure.
const DELETION = /\b(delete|deleting|deleted|remove|removing|rm|rmdir|erase|erasing|wipe|wiping|discard|discarding|purge|trash)\b/i;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

function commitCount(dir) {
  if (!existsSync(join(dir, '.git'))) return 0;
  try { return Number(git(['-C', dir, 'rev-list', '--all', '--count'])); } catch { return 0; }
}

function runVault(fx, cmd, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, '--json'], {
    cwd: fx.dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: {
      ...process.env,
      AGENT_COMPANION_MEMORY_ROOT: fx.corpus,
      CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      ...extraEnv,
    },
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function fixture() {
  const fx = makeFixture();
  const mem = join(fx.dir, 'corpus', 'proj-a', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), '# index\n');
  fx.corpus = join(fx.dir, 'corpus');
  fx.vault = join(fx.stateDir, 'memory-vault');
  return fx;
}

function ownerRepo(dir, { email = 'owner@example.invalid', name = 'owner', commits = 2 } = {}) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir]);
  git(['-C', dir, 'config', 'user.name', name]);
  git(['-C', dir, 'config', 'user.email', email]);
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, `work${i}.txt`), `owner work ${i}\n`);
    git(['-C', dir, 'add', '-A']);
    git(['-C', dir, 'commit', '-q', '-m', `owner work ${i}`]);
  }
}

// Follow the refusal advice, step by step, until the vault works.
function walkAdvice(fx, { maxSteps = 5 } = {}) {
  const trail = [];
  const setAside = []; // [path, commitsAtMove]
  for (let step = 0; step < maxSteps; step++) {
    const res = runVault(fx, 'sync');
    if (res.status === 0) {
      assert.equal(res.json?.committed, true, `sync ran but did not commit: ${res.stdout}`);
      return { trail, setAside, final: res };
    }
    const msg = res.stderr;
    const commits = commitCount(fx.vault);
    const files = existsSync(fx.vault)
      ? readdirSync(fx.vault).filter((n) => n !== '.git' && n !== '.memory-vault.json') : [];
    trail.push({ commits, msg });
    if (commits > 0 || files.length > 0) {
      assert.doesNotMatch(msg, DELETION,
        `step ${step}: a refusal about a directory holding ${commits} commit(s) and ${files.length} file(s) `
        + `advises deletion:\n${msg}`);
    }
    if (/move that one file out of the repository/.test(msg)) {
      renameSync(join(fx.vault, '.memory-vault.json'), join(fx.dir, `stray-marker-${step}.json`));
    } else if (/move (?:the directory|it) aside by renaming it \(for example to (.+?)\.moved-aside\)/.test(msg)) {
      const target = `${fx.vault}.moved-aside`;
      assert.ok(msg.includes(target), `the suggested new name should be ${target}:\n${msg}`);
      renameSync(fx.vault, target);
      setAside.push([target, commits]);
    } else if (/loses nothing/.test(msg)) {
      assert.equal(commits, 0, 'deletion may only be suggested for a directory with no commits');
      rmSync(fx.vault, { recursive: true, force: true });
    } else {
      assert.fail(`step ${step}: the refusal gives no advice this walk can follow:\n${msg}`);
    }
  }
  assert.fail(`the advice did not converge on a working vault in ${maxSteps} steps:\n${trail.map((t) => t.msg).join('\n---\n')}`);
  return null;
}

function assertNothingLost(setAside) {
  for (const [dir, commits] of setAside) {
    assert.ok(existsSync(dir), `${basename(dir)} was set aside and must still exist`);
    assert.equal(commitCount(dir), commits, `${basename(dir)} lost history`);
  }
}

const SCENARIOS = [
  ['a real repository with a planted marker', (fx) => {
    ownerRepo(fx.vault);
    writeFileSync(join(fx.vault, '.memory-vault.json'), MARKER);
  }],
  ['a real repository that copied the vault identity and a marker, but not its history', (fx) => {
    ownerRepo(fx.vault, { email: VAULT_EMAIL, name: 'agent-companion memory-vault' });
    writeFileSync(join(fx.vault, '.memory-vault.json'), MARKER);
  }],
  ['a genuine vault whose marker went missing', (fx) => {
    const first = runVault(fx, 'sync');
    assert.equal(first.status, 0, first.stderr);
    renameSync(join(fx.vault, '.memory-vault.json'), join(fx.dir, 'lost-marker.json'));
  }],
  ['a repository with commits and no marker', (fx) => {
    ownerRepo(fx.vault);
  }],
  ['a repository with files but no commits and no marker', (fx) => {
    ownerRepo(fx.vault, { commits: 0 });
    writeFileSync(join(fx.vault, 'draft.txt'), 'uncommitted work\n');
  }],
  ['a non-empty directory that is not a repository', (fx) => {
    mkdirSync(fx.vault, { recursive: true });
    writeFileSync(join(fx.vault, 'notes.txt'), 'someone else\'s files\n');
  }],
];

for (const [label, setup] of SCENARIOS) {
  test(`G1: walking the refusal advice for ${label} never deletes history and ends in a working vault`, () => {
    const fx = fixture();
    try {
      setup(fx);
      const { trail, setAside } = walkAdvice(fx);
      assert.ok(trail.length > 0, 'this shape must be refused at least once');
      assertNothingLost(setAside);
      assert.equal(git(['-C', fx.vault, 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index');
    } finally {
      fx.cleanup();
    }
  });
}

// Positive control: the walk's deletion detector does fire, and deletion IS
// advised, where it cannot lose anything.
test('G1: an empty repository with no commits and no files is the one case where deletion is advised', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.vault, { recursive: true });
    git(['init', '-q', '-b', 'main', fx.vault]);
    const res = runVault(fx, 'init');
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, DELETION);
    assert.match(res.stderr, /holds no commits and no files .* loses nothing/);
    const { trail } = walkAdvice(fx);
    assert.equal(trail.length, 1);
  } finally {
    fx.cleanup();
  }
});

// The shape the review found. The vault is recognised by its history, and a
// changed identity only earns a note.
//
// Vault calls read no global config (0.29.2), so the identity a commit falls
// back to when the owner unset the vault's local user.email is looked up
// separately, from the operator's own git config, and passed with -c. These
// fixtures give the operator an identity the usual way ($HOME/.gitconfig)
// or none at all, with system config, XDG_CONFIG_HOME and EMAIL out of the
// way unless a case sets them. `undefined` removes a variable from the child.
function operatorEnv(fx, { identity = null, email } = {}) {
  const home = join(fx.dir, 'operator-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'),
    identity ? `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n` : '');
  const env = {
    HOME: home, XDG_CONFIG_HOME: join(home, 'no-xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: undefined, EMAIL: email,
  };
  // Windows env names are case-insensitive: clear any other spelling too.
  for (const k of Object.keys(process.env)) {
    if (/^(email|git_config_global|xdg_config_home)$/i.test(k) && !(k in env)) env[k] = undefined;
  }
  return env;
}

const OPERATOR = { name: 'Operator Person', email: 'operator@example.invalid' };
const setEmail = (v) => git(['-C', v, 'config', '--file', join(v, '.git', 'config'), 'user.email', 'owner@example.invalid']);
const unsetEmail = (v) => git(['-C', v, 'config', '--file', join(v, '.git', 'config'), '--unset', 'user.email']);

for (const [label, change, envFor, expectedEmail] of [
  // The owner's own identity is never replaced, even with an operator identity available.
  ['changed', setEmail, (fx) => operatorEnv(fx, { identity: OPERATOR }), 'owner@example.invalid'],
  // Unset: the operator's configured identity, as 0.29.1 got it from global config.
  ['unset (operator identity in ~/.gitconfig)', unsetEmail, (fx) => operatorEnv(fx, { identity: OPERATOR }), OPERATOR.email],
  // Unset, no configured identity: git's own EMAIL fallback, as in 0.29.1.
  ['unset (EMAIL only)', unsetEmail, (fx) => operatorEnv(fx, { email: 'env@example.invalid' }), 'env@example.invalid'],
  // Unset, nothing anywhere: the vault's own identity rather than a failed commit.
  ['unset (no identity anywhere)', unsetEmail, (fx) => operatorEnv(fx), VAULT_EMAIL],
]) {
  test(`G1: a genuine vault whose owner ${label} its local user.email is accepted, with a note`, () => {
    const fx = fixture();
    try {
      const first = runVault(fx, 'sync');
      assert.equal(first.status, 0, first.stderr);
      const before = commitCount(fx.vault);
      change(fx.vault);
      const configBefore = git(['-C', fx.vault, 'config', '--file', join(fx.vault, '.git', 'config'), '--list']);
      writeFileSync(join(fx.corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
      const res = runVault(fx, 'sync', envFor(fx));
      assert.equal(res.status, 0, `a drifted identity must not refuse the vault:\n${res.stderr}`);
      assert.equal(res.json?.committed, true, res.stdout);
      assert.match(res.stderr, /note — .* is a vault this plugin created, but its local user\.email is/);
      assert.equal(res.stderr.match(/note —/g).length, 1, 'the note is said once per run');
      assert.equal(commitCount(fx.vault), before + 1);
      assert.equal(git(['-C', fx.vault, 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index v2');
      assert.equal(git(['-C', fx.vault, 'log', '-1', '--format=%ae|%ce']), `${expectedEmail}|${expectedEmail}`);
      assert.equal(git(['-C', fx.vault, 'log', '-1', '--format=%an']), 'agent-companion memory-vault',
        'the vault\'s own user.name is kept');
      assert.equal(git(['-C', fx.vault, 'config', '--file', join(fx.vault, '.git', 'config'), '--list']), configBefore,
        'nothing is written into the vault\'s config');
      assert.deepEqual(readdirSync(fx.stateDir).filter((n) => n.includes('moved-aside')), []);
    } finally {
      fx.cleanup();
    }
  });
}

// --- G2: a half-made vault is finished, never refused forever --------------
// createVault() writes the marker before the initialize commit. When that
// commit failed, for example because a global commit.gpgsign had no working
// signer, the result was a marker, the vault identity and zero commits. Every
// later run refused it as "not rooted in memory-vault: initialize".
//
// The signing config reaches git by every route a global config file has:
// GIT_CONFIG_GLOBAL, $HOME/.gitconfig and $XDG_CONFIG_HOME/git/config. It
// also names a clean filter for every path, which writes a sentinel if git
// runs it. The vault's -c commit.gpgsign=false keeps its commits unsigned
// even where the signing setting is read, and under the hermetic env it is
// never read at all. A clean filter has no -c answer, so the sentinel is
// what catches the hermetic env being removed. The 0.29.2 handoff's mutation
// table lists which removal turns which test red.
function signingConfig(fx) {
  const noGpg = join(fx.dir, 'no-such-gpg-program').replace(/\\/g, '/');
  const flag = join(fx.dir, 'SIGNING_SENTINEL');
  const filter = join(fx.dir, 'signing-filter');
  writeFileSync(filter, `#!/bin/sh\necho filter >> "${flag.replace(/\\/g, '/')}"\ncat\n`);
  chmodSync(filter, 0o755);
  const attributes = join(fx.dir, 'signing-attributes');
  writeFileSync(attributes, '* filter=signing-probe\n');
  const text = `[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = ${noGpg}\n`
    + `[core]\n\tattributesFile = ${attributes.replace(/\\/g, '/')}\n`
    + `[filter "signing-probe"]\n\tclean = ${filter.replace(/\\/g, '/')}\n`;
  const file = join(fx.dir, 'signing.gitconfig');
  writeFileSync(file, text);
  const home = join(fx.dir, 'signing-home');
  mkdirSync(join(home, 'git'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), text);
  writeFileSync(join(home, 'git', 'config'), text);
  return { flag, file, home };
}

for (const [label, route] of [
  ['GIT_CONFIG_GLOBAL', (s) => ({ GIT_CONFIG_GLOBAL: s.file })],
  ['HOME (~/.gitconfig)', (s) => ({ HOME: s.home })],
  ['XDG_CONFIG_HOME (git/config)', (s) => ({ XDG_CONFIG_HOME: s.home })],
]) {
  test(`G2: commit.gpgsign with no working signer, reached through ${label}, does not break init; vault commits are unsigned`, () => {
    const fx = fixture();
    try {
      const s = signingConfig(fx);
      const env = route(s);
      const init = runVault(fx, 'init', env);
      assert.equal(init.status, 0, `init must not depend on the operator's signer:\n${init.stderr}`);
      const sync = runVault(fx, 'sync', env);
      assert.equal(sync.status, 0, sync.stderr);
      assert.equal(sync.json?.committed, true, sync.stdout);
      assert.equal(git(['-C', fx.vault, 'log', '--format=%s', '--max-parents=0']), 'memory-vault: initialize');
      assert.equal(commitCount(fx.vault), 2);
      for (const sha of git(['-C', fx.vault, 'rev-list', 'HEAD']).split('\n')) {
        assert.doesNotMatch(git(['-C', fx.vault, 'cat-file', 'commit', sha]), /gpgsig/, `commit ${sha} is signed`);
      }
      assert.ok(!existsSync(s.flag), 'a clean filter from the operator\'s config ran on a vault write');
    } finally {
      fx.cleanup();
    }
  });
}

test('G2: a vault whose initialize commit never landed is finished on the next run', () => {
  const fx = fixture();
  try {
    // The exact leftovers of a failed initialize commit: our own .git with
    // the vault identity, the init files written and staged, no commit.
    mkdirSync(join(fx.vault, 'projects'), { recursive: true });
    git(['init', '-q', '-b', 'main', fx.vault]);
    git(['-C', fx.vault, 'config', '--file', join(fx.vault, '.git', 'config'), 'user.name', 'agent-companion memory-vault']);
    git(['-C', fx.vault, 'config', '--file', join(fx.vault, '.git', 'config'), 'user.email', VAULT_EMAIL]);
    writeFileSync(join(fx.vault, 'README.md'), '# agent-companion memory vault\n');
    writeFileSync(join(fx.vault, '.gitattributes'), '* -text\n');
    writeFileSync(join(fx.vault, '.memory-vault.json'), MARKER);
    git(['-C', fx.vault, 'add', '-A']);
    assert.equal(commitCount(fx.vault), 0);

    const res = runVault(fx, 'sync');
    assert.equal(res.status, 0, `a half-made vault must be finished, not refused:\n${res.stderr}`);
    assert.equal(res.json?.committed, true, res.stdout);
    assert.deepEqual(
      git(['-C', fx.vault, 'log', '--reverse', '--format=%s']).split('\n').map((s) => s.split(':')[0]),
      ['memory-vault', 'memory-vault sync'],
    );
    assert.equal(git(['-C', fx.vault, 'log', '--max-parents=0', '--format=%s']), 'memory-vault: initialize');
    assert.equal(git(['-C', fx.vault, 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index');
    // The next run treats it as an ordinary vault.
    writeFileSync(join(fx.corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const again = runVault(fx, 'sync');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json?.committed, true);
  } finally {
    fx.cleanup();
  }
});

test('G2: a zero-commit repository with a marker but not the vault identity is still refused', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.vault, { recursive: true });
    git(['init', '-q', '-b', 'main', fx.vault]);
    git(['-C', fx.vault, 'config', '--file', join(fx.vault, '.git', 'config'), 'user.email', 'owner@example.invalid']);
    writeFileSync(join(fx.vault, '.memory-vault.json'), MARKER);
    const res = runVault(fx, 'sync');
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /is not a vault this plugin created/);
    assert.equal(commitCount(fx.vault), 0);
    assert.deepEqual(readdirSync(fx.vault).sort(), ['.git', '.memory-vault.json']);
  } finally {
    fx.cleanup();
  }
});
