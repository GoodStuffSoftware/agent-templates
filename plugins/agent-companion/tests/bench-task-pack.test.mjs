// Task-pack mechanics: manifest loading (base64 ref decoding), the leak
// guard (parent-only, per FORMAT.md), the .git-absence check, and
// buildTaskFromPack()'s runner.mjs-shaped task object — exercised entirely
// against the committed example pack (bench/task-packs/examples/
// leak-check-gitignore-fix) and THIS repo's own git history. No model call
// anywhere in this file: the pack's own "model" is a plain hidden-test
// script that shells out to node/git, never to claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, PLUGIN_ROOT, runScript } from './helpers.mjs';
import { loadPack, buildTaskFromPack, verifyPack, encodeRef } from '../bench/task-packs/lib.mjs';

const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const EXAMPLE_PACK_DIR = join(PLUGIN_ROOT, 'bench', 'task-packs', 'examples', 'leak-check-gitignore-fix');

test('encodeRef()/loadPack() round-trip: manifest stores base64, loadPack() decodes back to the original ref text', () => {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  const raw = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'manifest.json'), 'utf8'));
  // Decode independently from loadPack() itself, so this is a real
  // round-trip check rather than restating loadPack()'s own output. Never
  // a hardcoded plaintext ref: a real git SHA is exactly the shape this
  // repo's own leak-check.mjs bans (git-sha-like) -- see lib.mjs's note.
  assert.equal(pack.parentRef, Buffer.from(raw.parentRefB64, 'base64').toString('utf8'));
  assert.equal(pack.fixRef, Buffer.from(raw.fixRefB64, 'base64').toString('utf8'));
  assert.ok(pack.parentRef.endsWith('^'), 'parentRef should be fixRef with a trailing ^ (the commit before it)');
  assert.equal(pack.parentRef.slice(0, -1), pack.fixRef);
  assert.equal(encodeRef('abc'), Buffer.from('abc').toString('base64'));
});

test('manifest.json never stores a plaintext git ref — parentRefB64/fixRefB64 are not the shape leak-check.mjs\'s SHA_RE bans', () => {
  const raw = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'manifest.json'), 'utf8'));
  const SHA_RE = /^[0-9a-f]{7,40}$/i;
  assert.doesNotMatch(raw.parentRefB64, SHA_RE);
  assert.doesNotMatch(raw.fixRefB64, SHA_RE);
});

test('the example pack verifies: fails at parentRef, passes at fixRef, leak guard clean', async () => {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  const result = await verifyPack(pack, REPO_ROOT);
  assert.equal(result.parentPass, false, `parentRef must FAIL the hidden test: ${JSON.stringify(result.detail)}`);
  assert.equal(result.fixPass, true, `fixRef must PASS the hidden test: ${JSON.stringify(result.detail)}`);
  assert.equal(result.leakOk, true, `leak guard must be clean: ${JSON.stringify(result.detail)}`);
  assert.equal(result.ok, true);
});

test('a pack whose parentRef extraction leaks a forbidden phrase fails leak-ok, independent of fail/pass verdicts', async () => {
  // Build a throwaway pack pointing at the SAME repo/refs as the real
  // example, but with a leakPhrase guaranteed to appear in the parent
  // extraction (a word the file's own header comment always carries).
  const { dir, cleanup } = makeFixture();
  try {
    const packDir = join(dir, 'leaky-pack');
    mkdirSync(packDir, { recursive: true });
    const realManifest = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'manifest.json'), 'utf8'));
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
      ...realManifest,
      // "Zero dependencies" appears in leak-check.mjs's own header comment
      // at BOTH parentRef and fixRef -- guaranteed to trip the guard.
      leakPhrases: ['Zero dependencies'],
    }));
    copyFileSync(join(EXAMPLE_PACK_DIR, 'report.md'), join(packDir, 'report.md'));
    copyFileSync(join(EXAMPLE_PACK_DIR, 'hidden-test.mjs'), join(packDir, 'hidden-test.mjs'));

    const pack = loadPack(packDir);
    const result = await verifyPack(pack, REPO_ROOT);
    assert.equal(result.leakOk, false, 'expected the leak guard to fire on a phrase present in the parent extraction');
    assert.equal(result.ok, false);
    assert.ok(result.detail.some((d) => d.includes('parent') && d.includes('leaked')), JSON.stringify(result.detail));
  } finally {
    cleanup();
  }
});

test('extraction never produces a .git directory, and the leak guard treats one as a failure if it ever did', async () => {
  // Direct unit check on the .git-absence assertion inside verifyPack(),
  // independent of the leak-phrase path above.
  const pack = loadPack(EXAMPLE_PACK_DIR);
  const result = await verifyPack(pack, REPO_ROOT);
  assert.ok(!result.detail.some((d) => d.includes('.git directory')), JSON.stringify(result.detail));
});

test('buildTaskFromPack(): setup() extracts parentRef only, never fixRef, into the sandbox', () => {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  const task = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
  const sandboxDir = mkdtempSync(join(tmpdir(), 'pack-task-setup-'));
  try {
    const meta = task.setup(sandboxDir);
    assert.ok(existsSync(join(sandboxDir, 'scripts', 'leak-check.mjs')));
    const content = readFileSync(join(sandboxDir, 'scripts', 'leak-check.mjs'), 'utf8');
    // The FIX version added `execFileSync` to its imports and a
    // `listCommittableFiles` function; the PARENT version (what setup()
    // must extract) has neither.
    assert.doesNotMatch(content, /listCommittableFiles/, 'setup() must extract parentRef (pre-fix), not fixRef');
    assert.equal(meta.pack.id, 'leak-check-gitignore-fix');
    assert.ok(!existsSync(join(sandboxDir, '.git')));
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('buildTaskFromPack(): prompt() is the report text plus the sandbox/CLAIM footer, and score() is async and awaitable', async () => {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  const task = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
  const sandboxDir = mkdtempSync(join(tmpdir(), 'pack-task-score-'));
  try {
    const meta = task.setup(sandboxDir);
    const prompt = task.prompt(meta);
    assert.match(prompt, /leak-check\.mjs/);
    assert.match(prompt, /CLAIM:/);

    // Score against the UNFIXED sandbox (the model made no changes) — must
    // fail, since the parent version's own bug is still present.
    const scored = await task.score(sandboxDir, 'CLAIM: nothing changed', meta);
    assert.equal(scored.pass, false);
    assert.ok(scored.detail?.hiddenTest, 'expected a hiddenTest detail string');
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('buildTaskFromPack() throws a clear error with no --pack-repo', () => {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  assert.throws(() => buildTaskFromPack(pack, {}), /needs --pack-repo/);
});

test('scripts/benchmark.mjs: --task-pack requires --pack-repo', () => {
  const res = runScript('scripts/benchmark.mjs', ['--dry-run', '--cells', 'haiku', '--tasks', 'leak-check-gitignore-fix', '--task-pack', EXAMPLE_PACK_DIR]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--pack-repo/);
});

test('scripts/benchmark.mjs: a task-pack id colliding with a built-in task id is a usage error', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const packDir = join(dir, 'colliding-pack');
    mkdirSync(packDir, { recursive: true });
    const realManifest = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'manifest.json'), 'utf8'));
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({ ...realManifest, id: 'lookup' }));
    copyFileSync(join(EXAMPLE_PACK_DIR, 'report.md'), join(packDir, 'report.md'));
    copyFileSync(join(EXAMPLE_PACK_DIR, 'hidden-test.mjs'), join(packDir, 'hidden-test.mjs'));

    const res = runScript('scripts/benchmark.mjs', ['--dry-run', '--cells', 'haiku', '--tasks', 'lookup', '--task-pack', packDir, '--pack-repo', REPO_ROOT]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /collides with an existing task id/);
  } finally {
    cleanup();
  }
});
