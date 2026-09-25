// A sync that does NO work must leave a trace, and memory-vault-drift must be
// able to report it. The failure this covers: sync() wrote the status cache
// only AFTER its memory_vault gate, so a sync that was turned away wrote
// nothing at all — "the option never reached the scheduled context" and
// "nobody has run a sync lately" produced byte-identical evidence, and the
// one check written to notice a vault that stopped backing up could report
// neither.
//
// Every fixture here uses a FAKE corpus and a FAKE state dir. Nothing in this
// file reads or writes the real ~/.claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runScript, GIT_CHAIN_TIMEOUT_MS } from './helpers.mjs';
import { CHECKS } from '../scripts/checks.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

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

function makeCorpus(dir, layout) {
  const root = join(dir, 'corpus');
  for (const [project, files] of Object.entries(layout)) {
    const memDir = join(root, project, 'memory');
    mkdirSync(memDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(memDir, rel), content);
  }
  return root;
}

function statusCachePath(fx) {
  return join(fx.stateDir, 'state', 'memory-vault-status.json');
}

function readCache(fx) {
  return JSON.parse(readFileSync(statusCachePath(fx), 'utf8'));
}

// The drift check runs IN THIS PROCESS, so point the resolvers at the fixture
// the same way makeFixture() already does and set the option by env var.
function runDrift({ vaultOn }) {
  const saved = process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT;
  process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = vaultOn ? 'true' : 'false';
  try {
    return DRIFT.run({});
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT;
    else process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = saved;
  }
}

test('a skipped sync writes a trace even though it creates no vault', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const res = runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    assert.equal(res.json?.skipped, 'disabled');
    assert.ok(!existsSync(join(fx.stateDir, 'memory-vault')), 'still creates no vault while disabled');

    const cache = readCache(fx);
    assert.equal(cache.v, 2);
    assert.equal(cache.lastAttemptOutcome, 'skipped');
    assert.equal(cache.lastAttemptReason, 'disabled');
    assert.equal(cache.consecutiveSkips, 1);
    assert.ok(cache.lastAttemptAt, 'the attempt is timestamped');
    assert.ok(!cache.lastSyncAt, 'a skip is not recorded as a successful sync');
  } finally {
    fx.cleanup();
  }
});

test('consecutive skips accumulate, and a real sync resets the counter', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const off = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' };
    const on = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };

    runVault(['sync', '--json'], { env: off });
    runVault(['sync', '--json'], { env: off });
    runVault(['sync', '--json'], { env: off });
    assert.equal(readCache(fx).consecutiveSkips, 3);

    const ran = runVault(['sync', '--json'], { env: on });
    assert.equal(ran.json?.committed, true, `sync should have committed: ${ran.stderr}`);
    const after = readCache(fx);
    assert.equal(after.consecutiveSkips, 0);
    assert.equal(after.lastAttemptOutcome, 'ran');
    assert.equal(after.lastAttemptReason, null);
    assert.ok(after.lastSyncAt, 'the successful run is recorded');
  } finally {
    fx.cleanup();
  }
});

test('a skip carries the previous successful run forward instead of erasing it', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const on = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runVault(['sync', '--json'], { env: on });
    const success = readCache(fx);
    assert.ok(success.lastSyncAt && success.lastCommitSha);

    runVault(['sync', '--json'], {
      env: { ...on, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    const afterSkip = readCache(fx);
    assert.equal(afterSkip.lastSyncAt, success.lastSyncAt, 'v:1 success fields survive a skip');
    assert.equal(afterSkip.lastCommitSha, success.lastCommitSha);
    assert.equal(afterSkip.filesTracked, success.filesTracked);
    assert.equal(afterSkip.lastAttemptOutcome, 'skipped');
  } finally {
    fx.cleanup();
  }
});

test('memory-vault-drift FAILS when the option reads on here but the sync was refused as disabled', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    // The exact shape of the bug: the sync context does not see the option,
    // the audit context does.
    runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    const r = runDrift({ vaultOn: true });
    assert.equal(r.status, 'fail', `expected fail, got ${r.status}: ${JSON.stringify(r.findings)}`);
    const text = r.findings.join(' | ');
    assert.match(text, /reads ON here but the last sync attempt was refused as disabled/);
    assert.match(text, /not reaching the context that runs the sync/);
  } finally {
    fx.cleanup();
  }
});

test('memory-vault-drift stays quiet for a backup that actually ran', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    const r = runDrift({ vaultOn: true });
    assert.equal(r.status, 'ok', `a healthy vault must stay quiet: ${JSON.stringify(r.findings)}`);
  } finally {
    fx.cleanup();
  }
});

test('memory-vault-drift skips (not warns) when the option is off everywhere, but still shows the trace', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    const r = runDrift({ vaultOn: false });
    assert.equal(r.status, 'skip', 'deliberately off must not be noisy');
    assert.match(r.findings.join(' | '), /last sync attempt .* skipped \(disabled\)/);
  } finally {
    fx.cleanup();
  }
});

test('memory-vault-drift warns on a run of no-work attempts that are not the option', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const on = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runVault(['sync', '--json'], { env: on });

    // A live lock turns the next syncs away. Two in a row is a run, not a race.
    const lock = join(fx.stateDir, 'state', 'memory-vault-sync.lock');
    mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    const first = runVault(['sync', '--json'], { env: on });
    assert.equal(first.json?.skipped, 'locked');
    const afterOne = runDrift({ vaultOn: true });
    assert.equal(afterOne.status, 'ok',
      `one lock is an ordinary race: ${JSON.stringify(afterOne.findings)}`);

    writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    runVault(['sync', '--json'], { env: on });
    const r = runDrift({ vaultOn: true });
    assert.equal(r.status, 'warn', `expected warn, got ${r.status}: ${JSON.stringify(r.findings)}`);
    assert.match(r.findings.join(' | '), /consecutive attempt\(s\) have done no work/);
  } finally {
    fx.cleanup();
  }
});

test('memory-vault-drift reports the trace even when the skip meant the vault never got created', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    assert.ok(!existsSync(join(fx.stateDir, 'memory-vault')));
    const r = runDrift({ vaultOn: true });
    // The contradiction outranks "not initialized": the vault is missing
    // BECAUSE the sync was refused, and that is the actionable half.
    assert.equal(r.status, 'fail');
    assert.match(r.findings.join(' | '), /no sync has ever actually run/);
  } finally {
    fx.cleanup();
  }
});

test('status --json surfaces the attempt record on both the initialized and uninitialized paths', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const off = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' };
    runVault(['sync', '--json'], { env: off });

    const uninit = runVault(['status', '--json'], { env: off });
    assert.equal(uninit.json.initialized, false);
    assert.equal(uninit.json.lastAttemptOutcome, 'skipped');
    assert.equal(uninit.json.lastAttemptReason, 'disabled');
    assert.equal(uninit.json.consecutiveSkips, 1);

    const on = { ...off, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    runVault(['sync', '--json'], { env: on });
    const init = runVault(['status', '--json'], { env: on });
    assert.equal(init.json.initialized, true);
    assert.equal(init.json.lastAttemptOutcome, 'ran');
    assert.equal(init.json.consecutiveSkips, 0);
    assert.equal(typeof init.json.runDaysAgo, 'number');
  } finally {
    fx.cleanup();
  }
});

test('a v:1 status file is read without error and upgraded in place on the next attempt', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    const legacy = {
      v: 1,
      lastSyncAt: '2026-09-21T19:23:44.642Z',
      lastCommitSha: '0'.repeat(40),
      committed: true,
      filesTracked: 478,
      added: 6, modified: 4, removed: 0, flagged: 0, readErrors: 0,
      projectsTouched: ['proj-a'],
    };
    mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
    writeFileSync(statusCachePath(fx), JSON.stringify(legacy, null, 2));

    runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'false' },
    });
    const after = readCache(fx);
    assert.equal(after.v, 2);
    assert.equal(after.lastSyncAt, legacy.lastSyncAt, 'v:1 history is preserved verbatim');
    assert.equal(after.lastCommitSha, legacy.lastCommitSha);
    assert.equal(after.filesTracked, 478);
    assert.deepEqual(after.projectsTouched, ['proj-a']);
    assert.equal(after.consecutiveSkips, 1, 'a v:1 file counts as zero prior skips');
  } finally {
    fx.cleanup();
  }
});

test('a corrupt status file does not stop a sync from running or recording', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir, { 'proj-a': { 'MEMORY.md': 'index' } });
    mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
    writeFileSync(statusCachePath(fx), '{ not json');
    const res = runVault(['sync', '--json'], {
      env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.equal(res.status, 0, `sync exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.committed, true);
    assert.equal(readCache(fx).lastAttemptOutcome, 'ran');
  } finally {
    fx.cleanup();
  }
});

// G5. status() now runs sync's read-only guards first and reports a vault that
// fails them as refused. The drift check has to say so. Before the guards, it
// reported whatever `git status` saw in that repository.
test('memory-vault-drift FAILS, naming the guard, for a marker planted in a repository the plugin did not create', () => {
  const fx = makeFixture();
  try {
    const vault = join(fx.stateDir, 'memory-vault');
    mkdirSync(vault, { recursive: true });
    const g = (args) => {
      const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    g(['init', '-q', '-b', 'main', vault]);
    g(['-C', vault, 'config', 'user.name', 'owner']);
    g(['-C', vault, 'config', 'user.email', 'owner@example.invalid']);
    writeFileSync(join(vault, 'work.txt'), 'owner work\n');
    g(['-C', vault, 'add', '-A']);
    g(['-C', vault, 'commit', '-q', '-m', 'owner work']);
    writeFileSync(join(vault, '.memory-vault.json'), JSON.stringify({ kind: 'agent-companion-memory-vault', schema: 1 }));
    const r = runDrift({ vaultOn: true });
    assert.equal(r.status, 'fail', JSON.stringify(r.findings));
    assert.match(r.findings[0], /is refused by the memory-vault guards: refusing to write — .* is not a vault this plugin created/);
    assert.equal(r.data?.dirty, undefined, 'no work-tree git call may run on a refused vault');
  } finally {
    fx.cleanup();
  }
});
