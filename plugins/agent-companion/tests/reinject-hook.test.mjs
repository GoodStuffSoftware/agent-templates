// Optional compaction re-inject hook (shims/global-hooks/agent-companion-
// reinject.mjs) and its opt-in installer (scripts/install-reinject-hook.mjs).
// Everything runs against temp dirs; never the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers.mjs';
import { buildContext, parseArgs, encodeCwd, DEFAULT_MAX_CHARS } from '../shims/global-hooks/agent-companion-reinject.mjs';

const SHIM = join(PLUGIN_ROOT, 'shims', 'global-hooks', 'agent-companion-reinject.mjs');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function runHook(input, args = [], env = {}) {
  return spawnSync(process.execPath, [SHIM, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 15000,
  });
}

test('the hook is NOT wired into the always-on plugin hooks.json', () => {
  const hooks = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8');
  assert.doesNotMatch(hooks, /reinject/i);
});

test('first existing candidate wins; output is SessionStart additionalContext JSON', () => {
  const cwd = tmp('ac-reinj-cwd-');
  try {
    writeFileSync(join(cwd, 'HANDOFF.md'), 'handoff body');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'HANDOFF.md'), 'second');
    const r = runHook({ session_id: 's1', cwd, source: 'compact', hook_event_name: 'SessionStart' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(j.hookSpecificOutput.additionalContext, /handoff body$/);
    assert.doesNotMatch(j.hookSpecificOutput.additionalContext, /second/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('scratchpad SESSION-STATE.md outranks HANDOFF.md by default', () => {
  const cwd = tmp('ac-reinj-cwd-'); const t = tmp('ac-reinj-tmp-');
  try {
    writeFileSync(join(cwd, 'HANDOFF.md'), 'handoff');
    const sp = join(t, 'claude', encodeCwd(cwd), 'sid', 'scratchpad');
    mkdirSync(sp, { recursive: true });
    writeFileSync(join(sp, 'SESSION-STATE.md'), 'state');
    const out = buildContext({ session_id: 'sid', cwd, source: 'compact' }, parseArgs([]), { tmp: t });
    assert.match(out, /state$/);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(t, { recursive: true, force: true }); }
});

test('over the cap the tail is kept behind a truncation marker, within the cap', () => {
  const cwd = tmp('ac-reinj-cwd-');
  try {
    const body = `HEAD${'x'.repeat(5000)}TAIL`;
    writeFileSync(join(cwd, 'HANDOFF.md'), body);
    const out = buildContext({ session_id: 's', cwd, source: 'compact' }, parseArgs(['--max-chars', '1000']));
    assert.ok(out.length <= 1000, String(out.length));
    assert.match(out, /truncated/);
    assert.match(out, /TAIL$/);
    assert.doesNotMatch(out, /HEAD/);
    assert.equal(parseArgs([]).maxChars, DEFAULT_MAX_CHARS);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('custom --file templates replace the defaults; relative paths resolve against cwd', () => {
  const cwd = tmp('ac-reinj-cwd-');
  try {
    writeFileSync(join(cwd, 'HANDOFF.md'), 'default');
    writeFileSync(join(cwd, 'NOTES.md'), 'custom');
    const out = buildContext({ session_id: 's', cwd, source: 'compact' }, parseArgs(['--file', 'NOTES.md']));
    assert.match(out, /custom$/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('nothing found, empty file, bad stdin, or non-compact source: no output, exit 0', () => {
  const cwd = tmp('ac-reinj-cwd-');
  try {
    for (const input of ['', 'not json', { session_id: 's', cwd, source: 'compact' }]) {
      const r = runHook(input); assert.equal(r.status, 0); assert.equal(r.stdout, '');
    }
    writeFileSync(join(cwd, 'HANDOFF.md'), '   \n');
    assert.equal(runHook({ session_id: 's', cwd, source: 'compact' }).stdout, '');
    writeFileSync(join(cwd, 'HANDOFF.md'), 'x');
    const r = runHook({ session_id: 's', cwd, source: 'startup' });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function installerEnv() {
  const home = tmp('ac-reinj-home-');
  const settings = join(home, 'settings.json');
  const hooksDir = join(home, 'hooks');
  const run = (...extra) => runScript('scripts/install-reinject-hook.mjs',
    ['--settings', settings, '--hooks-dir', hooksDir, ...extra],
    { env: { AGENT_COMPANION_HOME_OVERRIDE: home } });
  return { home, settings, hooksDir, run, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('install adds one compact-matcher entry, is idempotent, and uninstall removes it all', () => {
  const e = installerEnv();
  try {
    writeFileSync(e.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
    let r = e.run('--max-chars', '5000');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /installed\./);
    r = e.run();
    assert.match(r.stdout, /already installed/);
    const s = JSON.parse(readFileSync(e.settings, 'utf8'));
    const ours = s.hooks.SessionStart.filter((g) => g.matcher === 'compact');
    assert.equal(ours.length, 1);
    assert.deepEqual(ours[0].hooks[0].args.slice(1), ['--max-chars', '5000']);
    assert.ok(existsSync(join(e.hooksDir, 'agent-companion-reinject.mjs')));
    assert.match(e.run('--status').stdout, /: installed/);

    r = e.run('--uninstall');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /uninstalled/);
    const after = JSON.parse(readFileSync(e.settings, 'utf8'));
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'echo other');
    assert.equal(existsSync(join(e.hooksDir, 'agent-companion-reinject.mjs')), false);
    assert.match(e.run('--uninstall').stdout, /nothing to uninstall/);
  } finally { e.done(); }
});

test('dry run writes nothing', () => {
  const e = installerEnv();
  try {
    const r = e.run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(e.settings), false);
    assert.equal(existsSync(e.hooksDir), false);
  } finally { e.done(); }
});

test('an existing personal re-inject hook is detected and a second one is not installed', () => {
  const e = installerEnv();
  try {
    const personal = { hooks: { SessionStart: [{ matcher: 'compact', hooks: [
      { type: 'command', command: 'node', args: ['C:\\Users\\you\\.claude\\hooks\\reinject-state.mjs'] }] }] } };
    writeFileSync(e.settings, JSON.stringify(personal));
    const r = e.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /equivalent compaction re-inject hook is already configured/);
    assert.deepEqual(JSON.parse(readFileSync(e.settings, 'utf8')), personal);
    assert.equal(existsSync(e.hooksDir), false);
    assert.equal(readdirSync(e.home).length, 1);
    assert.match(e.run('--force').stdout, /installed\./);
  } finally { e.done(); }
});

test('a lookalike hook that never fires on compaction does not block install', () => {
  const e = installerEnv();
  try {
    writeFileSync(e.settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [
      { type: 'command', command: 'cat HANDOFF.md' }] }] } }));
    assert.match(e.run().stdout, /installed\./);
  } finally { e.done(); }
});
