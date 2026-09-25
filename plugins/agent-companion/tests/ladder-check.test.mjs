// Ladder track (0292): hooks/ladder-check.mjs (SessionStart).
//
// Two things it can verify from disk (registration itself cannot be verified
// from a hook — see the file's own header):
//   1. every rung in config/model-tiers.json's `ladder` has a matching
//      agents/*.md file that parses and carries the right model/effort.
//   2. round 2: whether THIS copy is an orphaned plugin-cache copy OLDER than
//      the install that applies to the session's cwd. Directional, per
//      install scope, fresh processes only, never a source checkout, and it
//      cannot fire after a normal update. (The round-1 machine-wide
//      running-version marker is gone: it could not see the real incident and
//      raised false alarms after updates, across projects and for newer dev
//      checkouts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const REAL_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function writeInstalled(dir, list) {
  mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'agent-companion@agent-templates': list } }));
}

// A copy of the plugin's hook-relevant parts inside the fixture's plugin
// cache, stamped with `version` — what the harness would load from
// ~/.claude/plugins/cache/<marketplace>/agent-companion/<version>/.
function cacheCopy(dir, version) {
  const root = join(dir, '.claude', 'plugins', 'cache', 'agent-templates', 'agent-companion', version);
  for (const d of ['hooks', 'config', 'agents', '.claude-plugin']) {
    cpSync(join(PLUGIN_ROOT, d), join(root, d), { recursive: true });
  }
  const pjFile = join(root, '.claude-plugin', 'plugin.json');
  writeFileSync(pjFile, JSON.stringify({ ...JSON.parse(readFileSync(pjFile, 'utf8')), version }, null, 2));
  return root;
}
function runFrom(root, payload, env = {}) {
  const res = spawnSync(process.execPath, [join(root, 'hooks', 'ladder-check.mjs')], {
    windowsHide: true, encoding: 'utf8', input: JSON.stringify(payload), env: { ...process.env, ...env }, timeout: 15000,
  });
  const out = (res.stdout || '').trim();
  return { status: res.status, stderr: res.stderr, stdout: out, json: out ? JSON.parse(out) : null };
}

test('quiet when the ladder files are intact and nothing is installed', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's1', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('an orphaned cache copy OLDER than the install for this scope warns, naming both versions and the recovery', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const stale = cacheCopy(dir, '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, '.claude', 'plugins', 'cache', 'agent-templates', 'agent-companion', '0.29.1'), lastUpdated: iso(2 * HOUR) }]);
    const res = runFrom(stale, { session_id: 's2', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /older cached copy of the plugin \(0\.29\.0\) than the one installed for it \(0\.29\.1, user scope\)/);
    assert.match(msg, /remove the stale agent-companion entry in the desktop plugin manager, then \/reload-plugins, then verify with a trivial ladder spawn; start a fresh session if that still fails/);
  } finally {
    cleanup();
  }
});

test('after a normal update, no warning: the fresh process loads the installed copy itself', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const current = cacheCopy(dir, '0.29.1');
    cacheCopy(dir, '0.29.0'); // the previous version's dir is still on disk, as the harness leaves it
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: current, lastUpdated: iso(2 * HOUR) }]);
    for (const source of ['startup', 'resume']) {
      const res = runFrom(current, { session_id: `s3-${source}`, cwd: dir, source });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '', `${source}: ${res.stdout}`);
    }
  } finally {
    cleanup();
  }
});

test('an old process after an update (/clear or compaction) is not a stale install: silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const old = cacheCopy(dir, '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'elsewhere', '0.29.1'), lastUpdated: iso(2 * HOUR) }]);
    for (const source of ['clear', 'compact']) {
      const res = runFrom(old, { session_id: `s4-${source}`, cwd: dir, source });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '', `${source}: ${res.stdout}`);
    }
  } finally {
    cleanup();
  }
});

test('an update landing right now (inside the settle window) does not warn', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const old = cacheCopy(dir, '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'elsewhere', '0.29.1'), lastUpdated: iso(60 * 1000) }]);
    const res = runFrom(old, { session_id: 's5', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  } finally {
    cleanup();
  }
});

test('a copy NEWER than installed is never called stale, nor is a source checkout of any version', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const newer = cacheCopy(dir, '0.29.9');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'elsewhere', '0.29.1'), lastUpdated: iso(2 * HOUR) }]);
    assert.equal(runFrom(newer, { session_id: 's6a', cwd: dir, source: 'startup' }).stdout, '');
    // The repo checkout itself, with an install both newer and older than it.
    for (const v of ['9.9.9', '0.0.1']) {
      writeInstalled(dir, [{ scope: 'user', version: v, installPath: join(dir, 'elsewhere', v), lastUpdated: iso(2 * HOUR) }]);
      const res = runHook('hooks/ladder-check.mjs', { session_id: `s6-${v}`, cwd: dir, source: 'startup' });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), '', `installed ${v} vs checkout ${REAL_VERSION}: ${res.stdout}`);
    }
  } finally {
    cleanup();
  }
});

test('scoped per install: judged against the entry for THIS cwd, and multiple installs are listed', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const copy = cacheCopy(dir, '0.29.1');
    const projA = join(dir, 'projA');
    const projB = join(dir, 'projB');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeInstalled(dir, [
      { scope: 'user', version: '0.29.0', installPath: join(dir, 'elsewhere', '0.29.0'), lastUpdated: iso(3 * HOUR) },
      { scope: 'project', projectPath: projB, version: '0.29.3', installPath: join(dir, 'elsewhere', '0.29.3'), lastUpdated: iso(3 * HOUR) },
    ]);
    // In project A the user install (0.29.0) applies: this 0.29.1 copy is newer, so silent.
    assert.equal(runFrom(copy, { session_id: 's7a', cwd: projA, source: 'startup' }).stdout, '');
    // In project B its own 0.29.3 install applies: this copy is behind it.
    const res = runFrom(copy, { session_id: 's7b', cwd: projB, source: 'startup' });
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /\(0\.29\.1\) than the one installed for it \(0\.29\.3, project scope\)/);
    assert.match(msg, /More than one agent-companion install\/cache dir is visible — installed_plugins\.json: user@0\.29\.0, project@0\.29\.3/);
  } finally {
    cleanup();
  }
});

test('a missing ladder agent file is reported, with the reinstall recovery (not the stale-entry one)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const copy = cacheCopy(dir, '0.29.1');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: copy, lastUpdated: iso(2 * HOUR) }]);
    const victim = join(copy, 'agents', 'ac-opus-low.md');
    assert.ok(existsSync(victim));
    writeFileSync(victim, 'no frontmatter at all\n');
    const res = runFrom(copy, { session_id: 's8', cwd: dir, source: 'startup' });
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /agents\/ac-opus-low\.md has no parseable frontmatter/);
    assert.match(msg, /update or reinstall the plugin/);
    assert.doesNotMatch(msg, /remove the stale agent-companion entry/);
  } finally {
    cleanup();
  }
});

test('YAML-quoted frontmatter values are read as their plain values (no false "broken")', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const copy = cacheCopy(dir, '0.29.1');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: copy, lastUpdated: iso(2 * HOUR) }]);
    const f = join(copy, 'agents', 'ac-opus-low.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^effort: low\r?$/m, 'effort: "low"').replace(/^model: opus\r?$/m, "model: 'opus'"));
    assert.match(readFileSync(f, 'utf8'), /^effort: "low"$/m);
    assert.match(readFileSync(f, 'utf8'), /^model: 'opus'$/m);
    assert.equal(runFrom(copy, { session_id: 's9', cwd: dir, source: 'startup' }).stdout, '');
  } finally {
    cleanup();
  }
});

test('a harness payload that lists registered agents without the ladder is reported with the stale-entry recovery', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/ladder-check.mjs', {
      session_id: 's10', cwd: dir, source: 'startup', agents: ['general-purpose', 'claude'],
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /is not in the harness's own registered-agent list/);
    assert.match(msg, /remove the stale agent-companion entry in the desktop plugin manager/);
  } finally {
    cleanup();
  }
});

test('the ladder_check option turns the whole hook off', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const stale = cacheCopy(dir, '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'elsewhere', '0.29.1'), lastUpdated: iso(2 * HOUR) }]);
    const res = runFrom(stale, { session_id: 's11', cwd: dir, source: 'startup' }, { CLAUDE_PLUGIN_OPTION_LADDER_CHECK: 'false' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  } finally {
    cleanup();
  }
});

// --- round 3: in-process /resume, and copies outside the cache ---------------

// A copy of the plugin outside the plugin cache and outside any source
// checkout: what an app-extracted desktop bundle looks like to copySource().
function bundleCopy(dir, version) {
  const root = join(dir, 'app-bundle', 'agent-companion');
  for (const d of ['hooks', 'config', 'agents', '.claude-plugin']) {
    cpSync(join(PLUGIN_ROOT, d), join(root, d), { recursive: true });
  }
  const pjFile = join(root, '.claude-plugin', 'plugin.json');
  writeFileSync(pjFile, JSON.stringify({ ...JSON.parse(readFileSync(pjFile, 'utf8')), version }, null, 2));
  return root;
}

test('an in-process /resume after a normal update is silent; a resume in a FRESH process that loaded the stale copy warns', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const old = cacheCopy(dir, '0.29.1');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: join(dir, 'elsewhere', '0.29.2'), lastUpdated: iso(1 * HOUR) }]);
    // Process 4242 reaches SessionStart once (startup) and records its load.
    const startup = runFrom(old, { session_id: 'r3-session-a', cwd: dir, source: 'startup' }, { CLAUDE_PID: '4242' });
    assert.equal(startup.status, 0, startup.stderr);
    // /resume inside that same process, into another session: no plugin load
    // happened, so it must stay silent.
    const inProcess = runFrom(old, { session_id: 'r3-session-b', cwd: dir, source: 'resume' }, { CLAUDE_PID: '4242' });
    assert.equal(inProcess.status, 0, inProcess.stderr);
    assert.equal(inProcess.stdout, '', `in-process /resume fired: ${inProcess.stdout}`);
    // A resume with no CLAUDE_PID cannot be told apart, so it is not judged.
    const noPid = runFrom(old, { session_id: 'r3-session-c', cwd: dir, source: 'resume' }, { CLAUDE_PID: '' });
    assert.equal(noPid.stdout, '', `resume without CLAUDE_PID fired: ${noPid.stdout}`);
    // A fresh `claude --resume` process (a pid never seen) that loaded this copy: warns.
    const fresh = runFrom(old, { session_id: 'r3-session-d', cwd: dir, source: 'resume' }, { CLAUDE_PID: '5353' });
    assert.match(fresh.json?.systemMessage || '', /older cached copy of the plugin \(0\.29\.1\) than the one installed for it \(0\.29\.2, user scope\)/);
  } finally {
    cleanup();
  }
});

test('a copy loaded from outside the plugin cache (a desktop bundle) older than the install warns; an equal one is silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const bundle = bundleCopy(dir, '0.29.1');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: join(dir, 'elsewhere', '0.29.2'), lastUpdated: iso(2 * HOUR) }]);
    const res = runFrom(bundle, { session_id: 'r3-bundle', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /a copy of the plugin from outside the plugin cache \(0\.29\.1; for example a desktop app bundle\) that is older than the one installed for it \(0\.29\.2, user scope\)/);
    assert.match(msg, /remove the stale agent-companion entry in the desktop plugin manager/);
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'elsewhere', '0.29.1'), lastUpdated: iso(2 * HOUR) }]);
    assert.equal(runFrom(bundle, { session_id: 'r3-bundle-eq', cwd: dir, source: 'startup' }).stdout, '');
  } finally {
    cleanup();
  }
});
