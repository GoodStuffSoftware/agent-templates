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
import { makeFixture, runScript, GIT_CHAIN_TIMEOUT_MS, assertNotRealHome } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import { CHECKS } from '../scripts/checks.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';

// Every memory-vault.mjs run in this file goes through here: a git-chain hang
// guard (see GIT_CHAIN_TIMEOUT_MS in helpers.mjs for the measurements), and a
// killed child fails as a timeout, not as a wrong sync result.
function runVault(args, opts = {}) {
  const res = runScript(SCRIPT, args, { timeout: GIT_CHAIN_TIMEOUT_MS, ...opts });
  assert.ok(!res.timedOut,
    `memory-vault.mjs ${args.join(' ')} was killed after ${opts.timeout ?? GIT_CHAIN_TIMEOUT_MS} ms without finishing `
    + '(the sync hung, or the machine is badly overloaded) — this is not a sync result');
  return res;
}
const DRIFT = CHECKS.find((c) => c.id === 'memory-vault-drift');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, ...opts, env: cleanGitEnv(opts.env || process.env),
  });
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
    const r = runVault(['init', '--json'], { env });
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
    runVault(['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);
    const headBefore = git(vault, ['rev-parse', 'HEAD']).trim();

    const second = runVault(['init', '--json'], { env });
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
    runVault(['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);

    const mine = '# mine\n*.md text eol=lf\n';
    writeFileSync(join(vault, '.gitattributes'), mine);
    git(vault, ['add', '--', '.gitattributes']);
    git(vault, ['commit', '-q', '-m', 'operator edit']);

    const again = runVault(['init'], { env });
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
    runVault(['sync', '--json'], { env });
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
    const r = runVault(['init'], { env });
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
    runVault(['sync', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);

    git(vault, ['rm', '-q', '--cached', '--', '.gitattributes']);
    rmSync(join(vault, '.gitattributes'));
    git(vault, ['commit', '-q', '-m', 'drop gitattributes']);
    git(vault, ['config', 'core.autocrlf', 'true']);

    const r = runVault(['init'], { env });
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
    execFileSync('git', ['--work-tree', out, '-C', repo, 'checkout-index', '-a', '-f'], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
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

    execFileSync('git', ['--work-tree', out, '-C', repo, 'checkout-index', '-a', '-f'], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });

    for (const [name, original] of Object.entries(cases)) {
      const blob = execFileSync('git', ['-C', repo, 'show', `HEAD:${name}`], { encoding: 'buffer', windowsHide: true, env: cleanGitEnv() });
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

    runVault(['init', '--json'], { env });
    const vault = vaultPathFor(fx.stateDir);
    git(vault, ['config', 'core.autocrlf', 'true']); // the hazard, left ON
    const r = runVault(['sync', '--json'], { env });
    assert.equal(r.json?.committed, true, `sync should commit: ${r.stderr}`);

    const rel = 'projects/proj-a/memory/MEMORY.md';
    const blob = execFileSync('git', ['-C', vault, 'show', `HEAD:${rel}`], { encoding: 'buffer', windowsHide: true, env: cleanGitEnv() });
    execFileSync('git', ['--work-tree', out, '-C', vault, 'checkout-index', '-a', '-f'], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
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

// --- 0.29.2: the operator's line-ending settings still apply ---------------
// Vault git calls read no global or system config any more. Git for Windows
// sets core.autocrlf=true in its SYSTEM config, and an operator may set it
// globally, so the vault now looks that value up once and passes it with -c.
// These fixtures put core.autocrlf=true where an operator's machine has it,
// in config outside the vault ($HOME/.gitconfig here), never in the vault's
// own config, and check that an existing vault stores exactly the bytes
// 0.29.1 stored.
function operatorAutocrlfEnv(dir, text = '[core]\n\tautocrlf = true\n') {
  const home = join(dir, 'operator-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), text);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'no-xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: undefined };
  for (const k of Object.keys(process.env)) {
    if (/^(git_config_global|xdg_config_home)$/i.test(k) && !(k in env)) env[k] = undefined;
  }
  return env;
}

const LINE_ENDING_FILES = {
  'lf.md': '# lf\n\n- one\n- two\n',
  'crlf.md': '# crlf\r\n\r\n- one\r\n- two\r\n',
  'mixed.md': '# mixed\n- one\r\n- two\n',
};

function blobOf(vault, rel) {
  return git(vault, ['rev-parse', `HEAD:${rel}`]).trim();
}

test('an existing byte-exact vault round-trips LF, CRLF and mixed files byte for byte with the operator\'s autocrlf=true', () => {
  const fx = makeFixture();
  const out = mkdtempSync(join(tmpdir(), 'ac-vault-restore-'));
  try {
    const opEnv = operatorAutocrlfEnv(fx.dir);
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', ...opEnv };
    assert.equal(runScript(SCRIPT, ['sync', '--json'], { env }).status, 0);
    // The existing vault: now sync the line-ending fixtures into it.
    for (const [name, body] of Object.entries(LINE_ENDING_FILES)) writeFileSync(join(corpus, 'proj-a', 'memory', name), body);
    const r = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(r.json?.committed, true, r.stderr);
    const vault = vaultPathFor(fx.stateDir);
    // Restore through a checkout that honours the same operator config.
    const opGitEnv = { ...cleanGitEnv(), ...opEnv };
    for (const k of Object.keys(opGitEnv)) if (opGitEnv[k] === undefined) delete opGitEnv[k];
    execFileSync('git', ['--work-tree', out, '-C', vault, 'checkout-index', '-a', '-f'], { windowsHide: true, env: opGitEnv });
    for (const [name, body] of Object.entries(LINE_ENDING_FILES)) {
      const rel = `projects/proj-a/memory/${name}`;
      const original = Buffer.from(body, 'utf8');
      const blob = execFileSync('git', ['-C', vault, 'show', `HEAD:${rel}`], { encoding: 'buffer', windowsHide: true, env: cleanGitEnv() });
      assert.equal(sha256(blob), sha256(original), `${name}: committed blob`);
      assert.equal(sha256(readFileSync(join(out, ...rel.split('/')))), sha256(original), `${name}: fresh checkout`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 3 });
    fx.cleanup();
  }
});

test('an existing vault WITHOUT `* -text` stores the same bytes as 0.29.1 did under the operator\'s autocrlf=true', () => {
  const fx = makeFixture();
  try {
    const opEnv = operatorAutocrlfEnv(fx.dir);
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', ...opEnv };
    assert.equal(runScript(SCRIPT, ['sync', '--json'], { env }).status, 0);
    const vault = vaultPathFor(fx.stateDir);
    // An operator's own .gitattributes that leaves text conversion on: the
    // vault reports it and never replaces it (see 'differs').
    writeFileSync(join(vault, '.gitattributes'), '*.bin binary\n');
    git(vault, ['add', '--', '.gitattributes']);
    git(vault, ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'operator attributes']);
    for (const [name, body] of Object.entries(LINE_ENDING_FILES)) writeFileSync(join(corpus, 'proj-a', 'memory', name), body);
    const r = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(r.json?.committed, true, r.stderr);
    // The oracle is plain git with the operator's config, as 0.29.1 ran it:
    // `hash-object --path` applies exactly the conversion `add` would.
    const opGitEnv = { ...cleanGitEnv(), ...opEnv };
    for (const k of Object.keys(opGitEnv)) if (opGitEnv[k] === undefined) delete opGitEnv[k];
    const plainEnv = { ...opGitEnv, HOME: join(fx.dir, 'nowhere') };
    let converted = 0;
    for (const name of Object.keys(LINE_ENDING_FILES)) {
      const rel = `projects/proj-a/memory/${name}`;
      const src = join(corpus, 'proj-a', 'memory', name);
      const expected = git(vault, ['hash-object', `--path=${rel}`, src], { env: opGitEnv }).trim();
      assert.equal(blobOf(vault, rel), expected, `${name}: the vault stored different bytes than 0.29.1 would have`);
      // CONTROL: without the operator's autocrlf the CRLF files would be stored differently.
      if (git(vault, ['hash-object', `--path=${rel}`, src], { env: plainEnv }).trim() !== expected) converted += 1;
    }
    assert.ok(converted >= 1, 'the fixture must include a file autocrlf actually converts, or this proves nothing');
  } finally {
    fx.cleanup();
  }
});

test('if the operator\'s config cannot be read, a vault without `* -text` refuses to commit; a byte-exact vault carries on', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index\n' } });
    const base = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    assert.equal(runScript(SCRIPT, ['sync', '--json'], { env: base }).status, 0);
    const vault = vaultPathFor(fx.stateDir);
    // A config file git cannot parse makes the one lookup fail.
    const broken = operatorAutocrlfEnv(fx.dir, '[core\n\tautocrlf = true\n');
    const env = { ...base, ...broken };

    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), 'index v2\n');
    const ok = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(ok.status, 0, `a byte-exact vault does not need the operator's line-ending settings:\n${ok.stderr}`);
    assert.equal(ok.json?.committed, true, ok.stdout);

    writeFileSync(join(vault, '.gitattributes'), '*.bin binary\n');
    git(vault, ['add', '--', '.gitattributes']);
    git(vault, ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'operator attributes']);
    const head = git(vault, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), 'index v3\r\n');
    const refused = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /refusing to write — could not read your git configuration's line-ending settings/);
    assert.equal(git(vault, ['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
  } finally {
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
    runVault(['sync', '--json'], { env });
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
