// Byte-exactness. The vault copies memory files in verbatim and has to hand
// them back verbatim. git does not do that by default: with core.autocrlf an
// LF-native store commits as LF and CHECKS OUT as CRLF. Nothing errors and
// nothing warns — the rewrite is only visible at restore time, which is the
// one moment the vault is the last remaining copy of the corpus.
//
// Every repo here is a throwaway under a fixture temp dir, and each one sets
// core.autocrlf=true LOCALLY, so the tests exercise the conversion that would
// otherwise do the corrupting. A test that passed only because autocrlf
// happened to be off would prove nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeFixture, runScript, assertNotRealHome } from './helpers.mjs';
import { CHECKS } from '../scripts/checks.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';
const DRIFT = CHECKS.find((c) => c.id === 'memory-vault-drift');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', ...opts });
}

function makeCorpus(dir, layout) {
  const root = join(dir, 'corpus');
  for (const [project, files] of Object.entries(layout)) {
    const memDir = join(root, project, 'memory');
    mkdirSync(memDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(memDir, rel), content);
  }
  return root;
}

function vaultPathFor(stateDir) {
  return join(stateDir, 'memory-vault');
}

// --- init writes the file ------------------------------------------------

test('init writes a .gitattributes that disables normalisation, and commits it', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    const r = runScript(SCRIPT, ['init', '--json'], { env });
    assert.equal(r.status, 0, `init exited ${r.status}: ${r.stderr}`);
    assert.equal(r.json?.gitattributes, 'created');

    const vault = vaultPathFor(fx.stateDir);
    const file = join(vault, '.gitattributes');
    assert.ok(existsSync(file), 'init must write .gitattributes');
    const text = readFileSync(file, 'utf8');
    const rules = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rules, ['* -text'], 'the rule must disable text conversion for everything');

    // ...and it is IN the initial commit, not left dirty beside it.
    assert.equal(git(vault, ['status', '--porcelain']).trim(), '');
    assert.ok(git(vault, ['ls-files', '--', '.gitattributes']).trim(), '.gitattributes must be tracked');
  } finally {
    fx.cleanup();
  }
});

test('init is still idempotent: a second run neither rewrites nor re-commits .gitattributes', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runScript(SCRIPT, ['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);
    const headBefore = git(vault, ['rev-parse', 'HEAD']).trim();

    const second = runScript(SCRIPT, ['init', '--json'], { env });
    assert.equal(second.json?.created, false);
    assert.equal(second.json?.gitattributes, 'present');
    assert.equal(git(vault, ['rev-parse', 'HEAD']).trim(), headBefore, 'no new commit');
    assert.equal(git(vault, ['status', '--porcelain']).trim(), '');
  } finally {
    fx.cleanup();
  }
});

test('init never clobbers a .gitattributes the operator wrote differently — it reports it', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runScript(SCRIPT, ['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);

    const mine = '# mine\n*.md text eol=lf\n';
    writeFileSync(join(vault, '.gitattributes'), mine);
    git(vault, ['add', '--', '.gitattributes']);
    git(vault, ['commit', '-q', '-m', 'operator edit']);

    const again = runScript(SCRIPT, ['init'], { env });
    assert.equal(again.status, 0);
    assert.equal(readFileSync(join(vault, '.gitattributes'), 'utf8'), mine, 'left exactly as written');
    assert.match(again.stdout, /does NOT disable line-ending conversion/);
    assert.match(again.stdout, /Left exactly as you wrote it/);
  } finally {
    fx.cleanup();
  }
});

test('backfill into an older vault refuses when it would renormalise tracked content', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runScript(SCRIPT, ['sync', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);

    // Recreate the pre-fix situation: no .gitattributes, autocrlf on, and a
    // tracked file whose working-tree bytes are CRLF while its blob is LF.
    // That is content git would silently rewrite the moment conversion is
    // switched off — a rewrite of the backup, not a backup.
    git(vault, ['rm', '-q', '--cached', '--', '.gitattributes']);
    rmSync(join(vault, '.gitattributes'));
    git(vault, ['commit', '-q', '-m', 'drop gitattributes']);
    git(vault, ['config', 'core.autocrlf', 'true']);
    const tracked = join(vault, 'projects', 'proj-a', 'memory', 'MEMORY.md');
    writeFileSync(tracked, 'index\r\n');
    // The trap this gate exists for: the blob is LF, the working tree is
    // CRLF, and `git diff` shows NOTHING because autocrlf converts the file
    // back before comparing. Only a raw byte comparison sees the divergence.
    assert.equal(git(vault, ['diff']).trim(), '', 'autocrlf hides the divergence from a normal diff');

    const headBefore = git(vault, ['rev-parse', 'HEAD']).trim();
    const r = runScript(SCRIPT, ['init'], { env });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /could not add \.gitattributes/);
    assert.match(r.stdout, /renormalisation/);
    assert.ok(!existsSync(join(vault, '.gitattributes')), 'no .gitattributes is left behind');
    assert.equal(git(vault, ['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
    assert.equal(readFileSync(tracked, 'utf8'), 'index\r\n', 'tracked content left exactly as found');
  } finally {
    fx.cleanup();
  }
});

test('backfill into a clean older vault adds .gitattributes as its own single-file commit', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'lf-native\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runScript(SCRIPT, ['sync', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);

    git(vault, ['rm', '-q', '--cached', '--', '.gitattributes']);
    rmSync(join(vault, '.gitattributes'));
    git(vault, ['commit', '-q', '-m', 'drop gitattributes']);
    git(vault, ['config', 'core.autocrlf', 'true']);

    const r = runScript(SCRIPT, ['init'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /added \.gitattributes/);
    const files = git(vault, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean);
    assert.deepEqual(files, ['.gitattributes'], 'the commit touches exactly one file');
    assert.equal(git(vault, ['status', '--porcelain']).trim(), '');
  } finally {
    fx.cleanup();
  }
});

// --- the round trip ------------------------------------------------------

// Proves the corruption is real before proving the fix works. Without this
// half, a green round-trip test could just mean autocrlf was never on.
test('CONTROL: without .gitattributes, autocrlf=true breaks the LF round trip', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ac-crlf-control-'));
  const out = mkdtempSync(join(tmpdir(), 'ac-crlf-control-out-'));
  assertNotRealHome(repo, 'control repo');
  try {
    git(repo, ['init', '-q', '-b', 'main', '.']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'core.autocrlf', 'true']);

    const original = Buffer.from('# store\n- one\n- two\n', 'utf8');
    writeFileSync(join(repo, 'MEMORY.md'), original);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'add']);

    // A fresh checkout is what a restore actually is.
    execFileSync('git', ['--work-tree', out, '-C', repo, 'checkout-index', '-a', '-f'], { windowsHide: true, encoding: 'utf8' });
    const restored = readFileSync(join(out, 'MEMORY.md'));
    assert.notEqual(sha256(restored), sha256(original),
      'if this passes, autocrlf was not actually active and the round-trip test below proves nothing');
    assert.ok(restored.includes(0x0d), 'the restored file came back with CR bytes');
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an LF file round-trips byte-identically through commit and checkout with `* -text`', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ac-crlf-fixed-'));
  const out = mkdtempSync(join(tmpdir(), 'ac-crlf-fixed-out-'));
  assertNotRealHome(repo, 'round-trip repo');
  try {
    git(repo, ['init', '-q', '-b', 'main', '.']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'core.autocrlf', 'true']); // the hazard, left ON
    writeFileSync(join(repo, '.gitattributes'), '* -text\n');

    // LF-native, CRLF-native, and mixed — all three must survive untouched.
    const cases = {
      'lf.md': Buffer.from('# store\n- one\n- two\n', 'utf8'),
      'crlf.md': Buffer.from('# store\r\n- one\r\n', 'utf8'),
      'mixed.md': Buffer.from('a\nb\r\nc\n\r\n', 'utf8'),
    };
    for (const [name, buf] of Object.entries(cases)) writeFileSync(join(repo, name), buf);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'add']);

    execFileSync('git', ['--work-tree', out, '-C', repo, 'checkout-index', '-a', '-f'], { windowsHide: true, encoding: 'utf8' });

    for (const [name, original] of Object.entries(cases)) {
      const blob = execFileSync('git', ['-C', repo, 'show', `HEAD:${name}`], { windowsHide: true, encoding: 'buffer' });
      const restored = readFileSync(join(out, name));
      const working = readFileSync(join(repo, name));
      assert.equal(sha256(blob), sha256(original), `${name}: committed blob differs from the original bytes`);
      assert.equal(sha256(restored), sha256(original), `${name}: fresh checkout differs from the original bytes`);
      assert.equal(sha256(working), sha256(original), `${name}: working tree differs from the original bytes`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an LF memory file round-trips byte-identically through a real vault sync under autocrlf=true', () => {
  const fx = makeFixture();
  const out = mkdtempSync(join(tmpdir(), 'ac-vault-restore-'));
  try {
    const body = '# index\n\n- a line\n- another\n';
    const original = Buffer.from(body, 'utf8');
    assert.ok(!original.includes(0x0d), 'the fixture source must be LF-native for this to mean anything');
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': body } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };

    runScript(SCRIPT, ['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);
    git(vault, ['config', 'core.autocrlf', 'true']); // the hazard, left ON
    const r = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(r.json?.committed, true, `sync should commit: ${r.stderr}`);

    const rel = 'projects/proj-a/memory/MEMORY.md';
    const blob = execFileSync('git', ['-C', vault, 'show', `HEAD:${rel}`], { windowsHide: true, encoding: 'buffer' });
    execFileSync('git', ['--work-tree', out, '-C', vault, 'checkout-index', '-a', '-f'], { windowsHide: true, encoding: 'utf8' });
    const restored = readFileSync(join(out, ...rel.split('/')));
    const working = readFileSync(join(vault, ...rel.split('/')));

    assert.equal(sha256(blob), sha256(original), 'committed blob');
    assert.equal(sha256(restored), sha256(original), 'fresh checkout');
    assert.equal(sha256(working), sha256(original), 'vault working tree');
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 3 });
    fx.cleanup();
  }
});

// --- the audit notices ---------------------------------------------------

test('memory-vault-drift warns about a vault that is not byte-exact', () => {
  const fx = makeFixture();
  const saved = process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT;
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runScript(SCRIPT, ['sync', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = 'true';

    assert.equal(DRIFT.run({}).status, 'ok', 'a byte-exact vault is quiet');

    git(vault, ['rm', '-q', '--cached', '--', '.gitattributes']);
    rmSync(join(vault, '.gitattributes'));
    git(vault, ['commit', '-q', '-m', 'drop gitattributes']);

    const r = DRIFT.run({});
    assert.equal(r.status, 'warn', `expected warn: ${JSON.stringify(r.findings)}`);
    assert.match(r.findings.join(' | '), /no \.gitattributes disabling line-ending conversion/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT;
    else process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = saved;
    fx.cleanup();
  }
});
