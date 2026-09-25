// Ladder track (0292), item 4: the documented, never-auto-run fallback for
// when plugin-scoped agent registration fails — copy the ladder's ac-*.md
// files to a user-level agents directory. Never writes without --yes, never
// overwrites a file it did not itself install (or that was hand-edited
// since), and tracks what it wrote in a manifest so update/uninstall can
// tell "safe to touch" from "something else is there".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

function tempAgentsDir() {
  return mkdtempSync(join(tmpdir(), 'ac-ladder-agents-'));
}

test('with no flags, the script writes NOTHING — plan only', () => {
  const dir = tempAgentsDir();
  try {
    const res = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /plan only/);
    assert.equal(existsSync(join(dir, 'ac-opus-low.md')), false);
    assert.equal(existsSync(join(dir, '.agent-companion-ladder-manifest.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--yes copies every ladder file and writes a manifest recording what it installed', () => {
  const dir = tempAgentsDir();
  try {
    const res = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /wrote \d+ file/);
    assert.ok(existsSync(join(dir, 'ac-opus-low.md')));
    const source = readFileSync(join(PLUGIN_ROOT, 'agents', 'ac-opus-low.md'), 'utf8');
    assert.equal(readFileSync(join(dir, 'ac-opus-low.md'), 'utf8'), source);

    const manifest = JSON.parse(readFileSync(join(dir, '.agent-companion-ladder-manifest.json'), 'utf8'));
    assert.ok(manifest['ac-opus-low.md']);
    assert.ok(manifest['ac-opus-low.md'].sha256);
    assert.ok(manifest['ac-opus-low.md'].installedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-running --yes when everything already matches the source is a no-op', () => {
  const dir = tempAgentsDir();
  try {
    runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    const res = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to do/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-existing, NOT manifest-tracked file with the same name is a collision — never overwritten', () => {
  const dir = tempAgentsDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ac-opus-low.md'), '---\nname: ac-opus-low\nmodel: sonnet\n---\nthe operator\'s own custom agent\n');

    const planRes = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir]);
    assert.match(planRes.stdout, /ac-opus-low\.md: SKIP \(name collision/);

    const applyRes = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    assert.equal(applyRes.status, 0, applyRes.stderr);
    // Untouched: still the operator's own content.
    assert.match(readFileSync(join(dir, 'ac-opus-low.md'), 'utf8'), /the operator's own custom agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest-tracked file the operator has since hand-edited is a collision on update, not silently overwritten', () => {
  const dir = tempAgentsDir();
  try {
    runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    // Operator hand-edits the installed copy.
    writeFileSync(join(dir, 'ac-opus-low.md'), '---\nname: ac-opus-low\nmodel: opus\neffort: low\n---\nhand-edited by the operator after install\n');

    const res = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir]);
    assert.match(res.stdout, /ac-opus-low\.md: SKIP \(name collision/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--uninstall without --yes only plans, and with --yes removes only manifest-tracked, unmodified files', () => {
  const dir = tempAgentsDir();
  try {
    runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']);
    // Hand-edit one file so it must survive uninstall.
    writeFileSync(join(dir, 'ac-haiku.md'), 'hand-edited, must survive uninstall\n');

    const planRes = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--uninstall']);
    assert.equal(planRes.status, 0, planRes.stderr);
    assert.match(planRes.stdout, /ac-opus-low\.md: REMOVE/);
    assert.match(planRes.stdout, /ac-haiku\.md: SKIP \(hand-edited/);
    assert.ok(existsSync(join(dir, 'ac-opus-low.md')), 'plan-only must not remove anything yet');

    const applyRes = runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--uninstall', '--yes']);
    assert.equal(applyRes.status, 0, applyRes.stderr);
    assert.equal(existsSync(join(dir, 'ac-opus-low.md')), false);
    assert.ok(existsSync(join(dir, 'ac-haiku.md')), 'hand-edited file must survive uninstall');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Round 2 hardening -----------------------------------------------------

test('uninstall refuses manifest entries that are not plain ac-*.md names inside the agents dir, even with matching hashes', () => {
  const root = tempAgentsDir();
  try {
    const agentsDir = join(root, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const victims = {
      '../settings.json': join(root, 'settings.json'),
      'sub/ac-x.md': join(agentsDir, 'sub', 'ac-x.md'),
      'notes.md': join(agentsDir, 'notes.md'),
    };
    mkdirSync(join(agentsDir, 'sub'), { recursive: true });
    const manifest = {};
    for (const [key, file] of Object.entries(victims)) {
      writeFileSync(file, `content of ${key}`);
      manifest[key] = { sha256: createHash('sha256').update(`content of ${key}`).digest('hex') };
    }
    const abs = join(root, 'abs-victim.md');
    writeFileSync(abs, 'abs');
    manifest[abs] = { sha256: createHash('sha256').update('abs').digest('hex') };
    writeFileSync(join(agentsDir, '.agent-companion-ladder-manifest.json'), JSON.stringify(manifest));

    const res = runScript('scripts/install-ladder-agents.mjs', ['--uninstall', '--yes', '--agents-dir', agentsDir]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /REFUSED/);
    for (const file of [...Object.values(victims), abs]) assert.ok(existsSync(file), `must survive: ${file}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall deletes only manifest-named files whose hash still matches', () => {
  const dir = tempAgentsDir();
  try {
    assert.equal(runScript('scripts/install-ladder-agents.mjs', ['--agents-dir', dir, '--yes']).status, 0);
    writeFileSync(join(dir, 'ac-opus-high.md'), 'hand edited\n');
    writeFileSync(join(dir, 'my-agent.md'), 'mine\n'); // never in the manifest
    const res = runScript('scripts/install-ladder-agents.mjs', ['--uninstall', '--yes', '--agents-dir', dir]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(dir, 'ac-opus-low.md')), false);
    assert.equal(readFileSync(join(dir, 'ac-opus-high.md'), 'utf8'), 'hand edited\n');
    assert.ok(existsSync(join(dir, 'my-agent.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument parsing: --agents-dir followed by a flag, a dangling --agents-dir, and unknown flags are errors that write nothing', () => {
  const cwd = tempAgentsDir();
  try {
    for (const args of [['--agents-dir', '--yes'], ['--yes', '--agents-dir'], ['--agents-dir=', '--yes'], ['--yse'], ['--yes', '--dry-run']]) {
      // HOME redirected too: a parse bug must never reach the real ~/.claude/agents.
      const res = runScript('scripts/install-ladder-agents.mjs', args, { cwd, env: { AGENT_COMPANION_HOME_OVERRIDE: cwd, CLAUDE_CONFIG_DIR: '' } });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /usage:/);
    }
    assert.equal(existsSync(join(cwd, '--yes')), false, 'no folder named "--yes"');
    assert.equal(existsSync(join(cwd, 'ac-opus-low.md')), false);
    assert.equal(existsSync(join(cwd, '.claude', 'agents')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--agents-dir=<path> is accepted as well as --agents-dir <path>', () => {
  const dir = tempAgentsDir();
  try {
    const res = runScript('scripts/install-ladder-agents.mjs', [`--agents-dir=${dir}`, '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(dir, 'ac-opus-low.md')));
    assert.match(res.stdout, /bare ac-opus-low/); // a user-level copy registers under its bare name
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});