// memory-vault.mjs — see docs/adr/0001-memory-corpus-backup-vault.md for the
// design this exercises. Every test here uses a FAKE corpus under a fixture
// temp dir (AGENT_COMPANION_MEMORY_ROOT), never the real ~/.claude/projects —
// makeFixture()'s assertNotRealHome() guard throws if that is ever violated.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, runScript } from './helpers.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';

function vaultPathFor(stateDir) {
  return join(stateDir, 'memory-vault');
}

// Builds a fake corpus at <dir>/corpus with the given
// { [project]: { [fileRelPath]: content } } layout, plus one sibling
// transcript file per project (proving the transcript-exclusion invariant is
// exercised by every test, not just the dedicated one).
function makeCorpus(dir, layout) {
  const root = join(dir, 'corpus');
  for (const [project, files] of Object.entries(layout)) {
    const memDir = join(root, project, 'memory');
    mkdirSync(memDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = join(memDir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    writeFileSync(
      join(root, project, `${project}-session.jsonl`),
      JSON.stringify({ type: 'transcript', marker: 'TRANSCRIPT_MUST_NEVER_BE_VAULTED' }) + '\n',
    );
  }
  return root;
}

function baseEnv(fx, corpusRoot, { vaultOn = true } = {}) {
  return {
    AGENT_COMPANION_MEMORY_ROOT: corpusRoot,
    CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: vaultOn ? 'true' : 'false',
  };
}

function git(vault, args) {
  return execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8' });
}

function walkFiles(dir, out = [], base = dir) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, base);
    else out.push(full);
  }
  return out;
}

// --- disabled by default ----------------------------------------------

test('sync is a no-op when memory_vault is off (default) and creates no vault', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const res = runScript(SCRIPT, ['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus }, // memory_vault option NOT set
    });
    assert.equal(res.status, 0, `sync exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.skipped, 'disabled');
    assert.ok(!existsSync(vaultPathFor(fx.stateDir)), 'no vault directory should be created while disabled');
  } finally {
    fx.cleanup();
  }
});

// --- init: idempotent, refuses to clobber -------------------------------

test('init is idempotent — a second call is a no-op that leaves the repo alone', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const env = baseEnv(fx, corpus);

    const first = runScript(SCRIPT, ['init', '--json'], { env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.created, true);

    const vault = vaultPathFor(fx.stateDir);
    const shaBefore = git(vault, ['rev-parse', 'HEAD']).trim();

    const second = runScript(SCRIPT, ['init', '--json'], { env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.created, false, 'second init should report created:false');

    const shaAfter = git(vault, ['rev-parse', 'HEAD']).trim();
    assert.equal(shaAfter, shaBefore, 'idempotent init must not add a commit');
  } finally {
    fx.cleanup();
  }
});

test('init refuses to clobber a non-empty directory that is not already a memory vault', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const vault = vaultPathFor(fx.stateDir);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, 'unrelated-file.txt'), 'pre-existing content that must survive');

    const res = runScript(SCRIPT, ['init', '--json'], { env: baseEnv(fx, corpus) });
    assert.notEqual(res.status, 0, 'init must fail rather than clobber');
    assert.match(res.stderr, /refusing to initialize/);
    assert.ok(existsSync(join(vault, 'unrelated-file.txt')), 'pre-existing content must be untouched');
    assert.ok(!existsSync(join(vault, '.git')), 'no git repo should have been created over foreign content');
  } finally {
    fx.cleanup();
  }
});

// --- sync: add / modify / delete, commit messages, no-op on no changes ---

test('sync commits adds, then modifies and deletes on the next run, and a third no-change sync commits nothing', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, {
      'proj-a': { 'MEMORY.md': 'index v1', 'fact1.md': 'fact one' },
      'proj-b': { 'MEMORY.md': 'index b' },
    });
    const env = baseEnv(fx, corpus);
    const vault = vaultPathFor(fx.stateDir);

    const s1 = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(s1.status, 0, s1.stderr);
    assert.equal(s1.json.committed, true);
    assert.equal(s1.json.added, 3);
    assert.deepEqual(s1.json.projectsTouched, ['proj-a', 'proj-b']);
    const sha1 = git(vault, ['rev-parse', 'HEAD']).trim();

    // No changes: second sync must commit nothing.
    const s2 = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(s2.status, 0, s2.stderr);
    assert.equal(s2.json.committed, false);
    const sha2 = git(vault, ['rev-parse', 'HEAD']).trim();
    assert.equal(sha2, sha1, 'a no-change sync must not create an empty commit');

    // Modify one file, delete another.
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), 'index v2');
    unlinkSync(join(corpus, 'proj-a', 'memory', 'fact1.md'));

    const s3 = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(s3.status, 0, s3.stderr);
    assert.equal(s3.json.committed, true);
    assert.equal(s3.json.modified, 1);
    assert.equal(s3.json.removed, 1);
    const sha3 = git(vault, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(sha3, sha1);

    // Commit message states counts and touched projects (subject line +
    // "Projects touched:" body line — %B is the full message, not just %s).
    const fullMessage = git(vault, ['log', '-1', '--format=%B']).trim();
    assert.match(fullMessage, /\+0 added, 1 modified, 1 deleted/);
    assert.match(fullMessage, /Projects touched: proj-a/);
  } finally {
    fx.cleanup();
  }
});

// --- deletions recorded in history --------------------------------------

test('a deleted memory file is recoverable from vault history after the deletion commit', () => {
  const fx = makeFixture();
  try {
    // proj-b's file is untouched and stays present throughout — the point of
    // this test is the deletion path, not the (separately tested) guard that
    // aborts when the WHOLE corpus enumerates to zero files.
    const corpus = makeCorpus(fx.dir, {
      'proj-a': { 'fact1.md': 'irreplaceable content' },
      'proj-b': { 'MEMORY.md': 'index b' },
    });
    const env = baseEnv(fx, corpus);
    const vault = vaultPathFor(fx.stateDir);

    runScript(SCRIPT, ['sync', '--json'], { env });
    unlinkSync(join(corpus, 'proj-a', 'memory', 'fact1.md'));
    const del = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(del.json.removed, 1);

    // Gone from HEAD...
    assert.throws(() => git(vault, ['show', 'HEAD:projects/proj-a/memory/fact1.md']));
    // ...but recoverable from the commit before the deletion.
    const recovered = git(vault, ['show', 'HEAD^:projects/proj-a/memory/fact1.md']);
    assert.equal(recovered, 'irreplaceable content');
  } finally {
    fx.cleanup();
  }
});

// --- transcripts never captured (proof, not just design) -----------------

test('a session transcript sitting beside memory/ is never copied into the vault, in the tree or in history', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, {
      'proj-a': { 'MEMORY.md': 'index', 'fact1.md': 'fact one' },
    });
    const env = baseEnv(fx, corpus);
    const vault = vaultPathFor(fx.stateDir);

    runScript(SCRIPT, ['sync', '--json'], { env });
    // Change something and sync again so there are 2 real content commits,
    // maximizing the chance a leak would have shown up somewhere in history.
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), 'index v2');
    runScript(SCRIPT, ['sync', '--json'], { env });

    const allTrackedFiles = walkFiles(join(vault, 'projects'));
    assert.ok(!allTrackedFiles.some((f) => f.endsWith('.jsonl')), 'no .jsonl file should ever be tracked in the vault');

    const fullHistory = git(vault, ['log', '-p']);
    assert.ok(!fullHistory.includes('.jsonl'), 'no .jsonl filename should ever appear in vault git history');
    assert.ok(!fullHistory.includes('TRANSCRIPT_MUST_NEVER_BE_VAULTED'), 'transcript content must never appear in vault git history');
  } finally {
    fx.cleanup();
  }
});

// --- secrets gate ---------------------------------------------------------

test('a file that looks like it carries a live credential is excluded from the commit and never enters history', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, {
      'proj-a': {
        'MEMORY.md': 'index',
        'leaky.md': 'token: "AKIAABCDEFGHIJKLMNOP"',
      },
    });
    const env = baseEnv(fx, corpus);
    const vault = vaultPathFor(fx.stateDir);

    const res = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.flagged, 1);
    assert.equal(res.json.flaggedFiles[0].file, 'proj-a/leaky.md');
    assert.ok(res.json.flaggedFiles[0].labels.includes('aws-access-key-id'));

    assert.ok(!existsSync(join(vault, 'projects', 'proj-a', 'memory', 'leaky.md')), 'flagged file must not be written into the vault working tree');
    const fullHistory = git(vault, ['log', '-p']);
    assert.ok(!fullHistory.includes('AKIAABCDEFGHIJKLMNOP'), 'the secret value must never enter vault git history');
  } finally {
    fx.cleanup();
  }
});

// --- empty-enumeration safety guard ---------------------------------------

test('sync aborts without deleting anything when the corpus enumerates to zero files but the vault already has content', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const env = baseEnv(fx, corpus);
    const vault = vaultPathFor(fx.stateDir);

    const first = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(first.json.committed, true);
    const shaBefore = git(vault, ['rev-parse', 'HEAD']).trim();
    const filesBefore = walkFiles(join(vault, 'projects'));
    assert.ok(filesBefore.length > 0);

    // Point at a corpus root that does not exist — discoverFiles() fails open
    // to [], which is exactly the dangerous case this guard exists for.
    const brokenEnv = { ...env, AGENT_COMPANION_MEMORY_ROOT: join(fx.dir, 'does-not-exist') };
    const res = runScript(SCRIPT, ['sync', '--json'], { env: brokenEnv });
    assert.notEqual(res.status, 0, 'an aborted sync must exit non-zero');
    assert.equal(res.json.aborted, true);
    assert.equal(res.json.reason, 'empty-enumeration-guard');

    const shaAfter = git(vault, ['rev-parse', 'HEAD']).trim();
    assert.equal(shaAfter, shaBefore, 'no commit should be made on an aborted sync');
    const filesAfter = walkFiles(join(vault, 'projects'));
    assert.deepEqual(filesAfter.sort(), filesBefore.sort(), 'vault content must be untouched by an aborted sync');
  } finally {
    fx.cleanup();
  }
});

// --- the live corpus is never written to ----------------------------------

test('the live corpus is never written to by init or sync (mtime proof)', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, {
      'proj-a': { 'MEMORY.md': 'index', 'fact1.md': 'fact one' },
      'proj-b': { 'MEMORY.md': 'index b' },
    });
    const env = baseEnv(fx, corpus);

    const corpusFiles = walkFiles(corpus);
    assert.ok(corpusFiles.length >= 5, 'fixture should include memory files and the sibling transcripts');
    const before = new Map(corpusFiles.map((f) => [f, statSync(f).mtimeMs]));
    const contentBefore = new Map(corpusFiles.map((f) => [f, readFileSync(f, 'utf8')]));

    runScript(SCRIPT, ['init', '--json'], { env });
    runScript(SCRIPT, ['sync', '--json'], { env });
    runScript(SCRIPT, ['status', '--json'], { env });

    const after = walkFiles(corpus);
    assert.deepEqual(after.sort(), corpusFiles.sort(), 'no corpus file should be added or removed');
    for (const f of corpusFiles) {
      assert.equal(statSync(f).mtimeMs, before.get(f), `mtime of ${f} must be unchanged`);
      assert.equal(readFileSync(f, 'utf8'), contentBefore.get(f), `content of ${f} must be unchanged`);
    }
  } finally {
    fx.cleanup();
  }
});

// --- status ----------------------------------------------------------------

test('status reports uninitialized, then reflects a real sync', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const env = baseEnv(fx, corpus);

    const before = runScript(SCRIPT, ['status', '--json'], { env });
    assert.equal(before.json.initialized, false);
    assert.equal(before.json.enabled, true);

    runScript(SCRIPT, ['sync', '--json'], { env });
    const after = runScript(SCRIPT, ['status', '--json'], { env });
    assert.equal(after.json.initialized, true);
    assert.equal(after.json.dirty, false);
    assert.equal(after.json.fileCount, 1);
    assert.ok(after.json.lastCommit?.sha);
  } finally {
    fx.cleanup();
  }
});
