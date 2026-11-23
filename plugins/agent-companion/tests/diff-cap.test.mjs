// Diff cap: which commands are capped (pure), the generated wrapper run for real in bash (output, exit status), and the hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook } from './helpers.mjs';
import { diffCapTarget, diffCapWrap, DIFF_CAP_LINES, DIFF_SHOW_LINES } from '../hooks/lib/diff-cap.mjs';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const HAVE_BASH = spawnSync(BASH, ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });

test('diffCapTarget: git diff, show and log -p are capped', () => {
  for (const c of [
    'git diff', 'git diff HEAD~1', 'git diff main...feature -- src/a.mjs', 'git -C /repo diff', 'git --no-pager diff', 'git -c core.x=1 diff',
    'git show', 'git show abc123', 'git log -p', 'git log --patch -3', 'git log -u', 'cd repo && git diff', 'git diff --stat -p', 'git show --stat --patch',
  ]) assert.ok(diffCapTarget(c), `should cap: ${c}`);
});

test('diffCapTarget: non-patch output, redirected or piped output, and other git or patch flows are left alone', () => {
  for (const c of [
    'git diff --stat', 'git diff --name-only', 'git diff --name-status', 'git diff --quiet', 'git diff --exit-code', 'git diff --shortstat',
    'git diff --numstat', 'git diff --check', 'git show -s', 'git show --stat', 'git show --name-only HEAD', 'git show --no-patch HEAD',
    'git log', 'git log --oneline', 'git log --stat', 'git diff > out.patch', 'git diff | head -50', 'git diff | wc -l', 'git diff &',
    'git show HEAD:src/a.mjs', 'git apply fix.patch', 'patch -p1 < fix.patch', 'git status', 'git diff --output=x.patch', '',
    'git diff; npm test', 'echo $(git diff)',
  ]) assert.equal(diffCapTarget(c), null, `should not cap: ${JSON.stringify(c)}`);
});

test('diffCapTarget: flags after -- are paths, not options', () => {
  assert.ok(diffCapTarget('git diff -- --stat'));
});

function repoWith(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'dcap-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@example.test');
  git(dir, 'config', 'user.name', 'A');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'widget.txt'), 'start\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'widget.txt'), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n');
  return dir;
}
const wrapRun = (dir, command, file) => spawnSync(BASH, ['-c', diffCapWrap(command, { file })], { cwd: dir, encoding: 'utf8', windowsHide: true });

test('wrapper: a short diff prints whole, the file is removed', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const dir = repoWith(20);
  try {
    const file = join(dir, 'out.log').replace(/\\/g, '/');
    const r = wrapRun(dir, 'git diff', file);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\+line 19/);
    assert.doesNotMatch(r.stdout, /ac-diff-cap/);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wrapper: a long diff prints the stat, the first lines and the file path; the file holds the whole diff', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const dir = repoWith(900);
  try {
    const file = join(dir, 'out.log').replace(/\\/g, '/');
    const r = wrapRun(dir, 'git diff', file);
    assert.equal(r.status, 0);
    const shown = r.stdout.split('\n').length;
    assert.ok(shown < DIFF_CAP_LINES, `${shown} lines come back`);
    assert.match(r.stdout, /widget\.txt \|\s+\d+/, 'the stat of the whole diff');
    assert.match(r.stdout, /\+line 10\b/);
    assert.doesNotMatch(r.stdout, /\+line 800\b/);
    assert.ok(r.stdout.includes(file), 'names the file');
    assert.ok(r.stdout.includes(`offset=${DIFF_SHOW_LINES + 1}`), 'names the Read range');
    const full = readFileSync(file, 'utf8');
    assert.match(full, /\+line 899\b/, 'the whole diff is on disk');
    assert.ok(full.split('\n').length > DIFF_CAP_LINES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wrapper: the exit status of the command survives, short and long', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const dir = repoWith(900);
  try {
    const file = join(dir, 'out.log').replace(/\\/g, '/');
    assert.equal(wrapRun(dir, 'git diff --no-such-flag-xyz -p', file).status, 129, 'usage error comes back');
    assert.equal(wrapRun(dir, 'git show nosuchrev -p', file).status, 128, 'bad revision comes back');
    assert.equal(wrapRun(dir, 'git diff', file).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wrapper: a single very long line is cut by bytes', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcap-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'a@example.test');
    git(dir, 'config', 'user.name', 'A');
    writeFileSync(join(dir, 'min.js'), 'x\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'min.js'), 'y'.repeat(120000) + '\n');
    const file = join(dir, 'out.log').replace(/\\/g, '/');
    const r = wrapRun(dir, 'git diff', file);
    assert.ok(r.stdout.length < 45000, `${r.stdout.length} chars`);
    assert.match(r.stdout, /ac-diff-cap\] cut here/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const payload = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-dcap', tool_name: 'Bash', tool_input: { command }, permission_mode: 'bypassPermissions', ...extra,
});
const hookEnv = (fx, extra = {}) => ({ AGENT_COMPANION_BASH_TAIL_DIR: join(fx.dir, 'tail-out'), ...extra });

test('hook: git diff is rewritten with updatedInput and no permissionDecision', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('git diff main...feature'), { env: hookEnv(fx) });
    assert.equal(r.status, 0);
    const out = r.json.hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined);
    assert.match(out.updatedInput.command, /git diff main\.\.\.feature/);
    assert.match(out.updatedInput.command, /ac-diff-cap/);
  } finally { fx.cleanup(); }
});

test('hook: a subagent call is capped too (reviewers read diffs in parts)', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('git show abc123', { agent_id: 'agent-1' }), { env: hookEnv(fx) });
    assert.match(r.json.hookSpecificOutput.updatedInput.command, /ac-diff-cap/);
  } finally { fx.cleanup(); }
});

test('hook: stat, name-only, piped and redirected diffs pass through with no output', () => {
  const fx = makeFixture();
  try {
    for (const c of ['git diff --stat', 'git diff --name-only', 'git diff | head -20', 'git diff > x.patch', 'git log --oneline', 'git apply x.patch']) {
      const r = runHook('hooks/bash-tail.mjs', payload(c), { env: hookEnv(fx) });
      assert.equal(r.status, 0);
      assert.equal(String(r.stdout).trim(), '', `no output for ${c}`);
    }
  } finally { fx.cleanup(); }
});

test('hook: diff_cap=false, a background call, PowerShell and other permission modes pass through', () => {
  const fx = makeFixture();
  try {
    const off = runHook('hooks/bash-tail.mjs', payload('git diff'), { env: hookEnv(fx, { CLAUDE_PLUGIN_OPTION_DIFF_CAP: '0' }) });
    assert.equal(String(off.stdout).trim(), '');
    const bg = runHook('hooks/bash-tail.mjs', payload('git diff', { tool_input: { command: 'git diff', run_in_background: true } }), { env: hookEnv(fx) });
    assert.equal(String(bg.stdout).trim(), '');
    const ps = runHook('hooks/bash-tail.mjs', payload('git diff', { tool_name: 'PowerShell' }), { env: hookEnv(fx) });
    assert.equal(String(ps.stdout).trim(), '');
    const mode = runHook('hooks/bash-tail.mjs', payload('git diff', { permission_mode: 'default' }), { env: hookEnv(fx) });
    assert.equal(String(mode.stdout).trim(), '');
  } finally { fx.cleanup(); }
});
