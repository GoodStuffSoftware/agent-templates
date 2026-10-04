// Bash output tail: trigger logic, the generated wrapper (run for real in
// bash, so exit-code preservation is measured, not assumed), and the hook.
// Decision record: docs/adr/0004-bash-output-tail.md at the repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, readJsonl, decisionOf, PLUGIN_ROOT } from './helpers.mjs';
import {
  analyze, lex, wrapCommand, shellPath, outputTarget, pruneOldOutputs, modeAllowed,
  readPermissionRules, blockingPermissionRule, WRAPPER_HELPERS,
  FULL_MAX_LINES, TAIL_FAILED_LINES, TAIL_PASSED_LINES, KEEP_FILES_MS,
} from '../hooks/lib/bash-tail.mjs';

// Git Bash on Windows (PATH may hold WSL's bash.exe first), plain bash elsewhere.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const HAVE_BASH = spawnSync(BASH, ['-c', 'exit 0'], { windowsHide: true }).status === 0;

function runBash(script, { cwd, env } = {}) {
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', windowsHide: true, cwd, env: env ? { ...process.env, ...env } : process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// --- trigger logic ----------------------------------------------------------

const wraps = (c) => { const a = analyze(c); return Boolean(a.runner) && a.blockers.length === 0; };

test('analyze: known long-runners wrap', () => {
  for (const c of [
    'npm test', 'npm run build', 'npm run build:prod', 'npm ci', 'npm install', 'pnpm test', 'yarn test',
    'npx vitest run', 'vitest run', 'jest --coverage', 'pytest -x', 'python -m pytest', 'cargo build --release',
    'cargo test', 'go test ./...', 'dotnet build', 'make', 'gradle build', 'mvn test', 'tsc --noEmit',
    'node --test tests/*.mjs', 'pip install -r requirements.txt', 'docker build .',
    'cd sub && npm test', 'FOO=1 npm ci', 'time npm test', 'npm test; echo done',
  ]) assert.equal(wraps(c), true, `should wrap: ${c}`);
});

test('analyze: commands that are not runners are never touched (git plumbing, short, interactive)', () => {
  for (const c of [
    'git status', 'git log --oneline', 'git diff', 'git rev-parse HEAD', 'ls -la', 'cat package.json',
    'echo hello', 'pwd', 'cd /tmp', 'grep -rn foo .', 'node script.mjs', 'npm run dev', 'npm start',
    'sudo npm install -g x', 'ssh host', 'vim file', 'read x', 'exit 1', '',
  ]) assert.equal(analyze(c).runner, null, `no runner expected: ${JSON.stringify(c)}`);
});

test('analyze: pipes, redirects, background, subshells and substitution block the wrap', () => {
  const cases = {
    'npm test | tail -20': 'pipe',
    'npm test > out.txt': 'redirect',
    'npm test 2> err.txt': 'redirect',
    'npm test 2>&1': 'redirect',
    'npm test &': 'background',
    '(npm test)': 'subshell',
    'echo $(npm test)': 'substitution',
    'echo `npm test`': 'substitution',
  };
  for (const [c, why] of Object.entries(cases)) {
    const a = analyze(c);
    assert.equal(wraps(c), false, `must not wrap: ${c}`);
    if (a.runner) assert.ok(a.blockers.includes(why) || a.blockers.length > 0, `${c} -> ${a.blockers}`);
  }
});

test('analyze: a pipe or redirect inside quotes is not a pipe or redirect', () => {
  assert.equal(wraps(`pytest -k "a|b"`), true);
  assert.equal(wraps(`npm test -- --grep 'a > b'`), true);
});

test('analyze: watchers, machine-readable output and info flags block the wrap', () => {
  for (const c of [
    'npm test --watch', 'vitest --watch', 'jest --watchAll', 'go test -json ./...', 'cargo build --message-format=json',
    'pytest --collect-only', 'tsc --version', 'make --help', 'npm test -- --reporter=json', 'dotnet build --dry-run',
  ]) {
    const a = analyze(c);
    assert.ok(a.runner, `runner recognised: ${c}`);
    assert.ok(a.blockers.length > 0, `blocked: ${c}`);
  }
});

test('analyze: a runner inside a compound statement or after a shell-ending word is left alone', () => {
  for (const c of [
    'if true; then npm test; fi', 'for f in a b; do npm test; done', 'while true; do npm test; done',
    'npm test && exit 0', 'exec npm test', 'eval "npm test"', 'trap "" INT; npm test',
  ]) {
    const a = analyze(c);
    assert.ok(!a.runner || a.blockers.length > 0, `must not wrap: ${c} -> ${JSON.stringify(a)}`);
  }
});

test('analyze: a heredoc is a redirect and is never wrapped', () => {
  const a = analyze('npm test <<EOF\nx\nEOF');
  assert.ok(a.blockers.length > 0);
});

test('lex: unterminated quotes are reported, not guessed at', () => {
  assert.ok(lex(`npm test "abc`).flags.has('unterminated'));
  assert.equal(wraps(`npm test "abc`), false);
});

test('modeAllowed: bypassPermissions by default, any lifts the limit', () => {
  assert.equal(modeAllowed('bypassPermissions', undefined), true);
  assert.equal(modeAllowed('default', 'bypassPermissions'), false);
  assert.equal(modeAllowed(undefined, 'bypassPermissions'), false);
  assert.equal(modeAllowed('default', 'any'), true);
  assert.equal(modeAllowed('acceptEdits', 'default, acceptEdits'), true);
  assert.equal(modeAllowed('plan', 'default,acceptEdits'), false);
});

test('shellPath turns backslashes into forward slashes', () => {
  assert.equal(shellPath('C:\\a\\b'), 'C:/a/b');
});

// --- the generated wrapper, run in a real bash ------------------------------

function tempDirForBash() {
  const d = mkdtempSync(join(tmpdir(), 'ac-btail-'));
  return { dir: d, sh: shellPath(d), done: () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

function wrapped(command, dirSh, resultLog = '') {
  mkdirSync(`${dirSh}/out`, { recursive: true }); // the hook creates the directory; the wrapper no longer calls mkdir
  return wrapCommand(command, { file: `${dirSh}/out/run1.log`, dir: `${dirSh}/out`, resultLog, id: 'run1' });
}

test('wrapper: exit code is preserved exactly (0, 1, 3, 127) and long output is tailed with the path', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    for (const rc of [0, 1, 3, 127]) {
      const plain = runBash(`seq 1 300; (exit ${rc})`);
      const w = runBash(wrapped(`seq 1 300; (exit ${rc})`, t.sh));
      assert.equal(plain.status, rc);
      assert.equal(w.status, rc, `exit ${rc} preserved through the wrapper`);
      assert.match(w.stdout, new RegExp(`\\[ac-bash-tail\\] exit ${rc}; 300 lines`));
      assert.ok(w.stdout.includes(`${t.sh}/out/run1.log`) || w.stdout.includes('run1.log'), 'full-output path is in the returned text');
      const keep = rc === 0 ? TAIL_PASSED_LINES : TAIL_FAILED_LINES;
      assert.match(w.stdout, new RegExp(`last ${keep} lines`));
      assert.ok(w.stdout.includes('\n300\n'), 'the last line of output is shown');
      assert.ok(!w.stdout.includes('\n100\n'), 'the middle of the output is not');
      // the file holds everything
      const full = readFileSync(join(t.dir, 'out', 'run1.log'), 'utf8').trim().split('\n');
      assert.equal(full.length, 300);
    }
  } finally { t.done(); }
});

test('wrapper: a failing run shows MORE tail than a passing one and never hides the failure text', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const cmd = 'seq 1 500; echo "FAIL: 2 tests failed" >&2; (exit 1)';
    const w = runBash(wrapped(cmd, t.sh));
    assert.equal(w.status, 1);
    assert.ok(w.stdout.includes('FAIL: 2 tests failed'), 'stderr is merged and its last lines are in the tail');
    const lines = w.stdout.trim().split('\n');
    // pre-run notice + header + the failed-run tail (no summary lines: nothing earlier matches the pattern)
    assert.equal(lines.length, 2 + TAIL_FAILED_LINES, 'notice, header and the failed-run tail');
    assert.ok(lines[0].startsWith('[ac-bash-tail] full output of this run goes to '));
  } finally { t.done(); }
});

test('wrapper: output within the limit is printed whole, the file is removed, exit code kept', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped(`seq 1 ${FULL_MAX_LINES}; (exit 4)`, t.sh));
    assert.equal(w.status, 4);
    const lines = w.stdout.trim().split('\n');
    assert.equal(lines.length, 1 + FULL_MAX_LINES, 'the pre-run notice plus the whole output');
    assert.ok(lines[0].startsWith('[ac-bash-tail] full output of this run goes to '));
    assert.ok(!lines.slice(1).some((l) => l.includes('[ac-bash-tail]')), 'no tail header for a short run');
    assert.ok(!existsSync(join(t.dir, 'out', 'run1.log')), 'no file left for a short run');
  } finally { t.done(); }
});

test('wrapper: many bytes in few lines still trips the byte limit', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped(`printf 'x%.0s' $(seq 1 9000); echo`, t.sh));
    assert.equal(w.status, 0);
    assert.match(w.stdout, /\[ac-bash-tail\] exit 0; 1 lines/);
  } finally { t.done(); }
});

test('wrapper: a very long single line keeps its END (the failure text), the total stays bounded, the file keeps it whole', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    // 100 KB on one line, the interesting part last (minified bundle, JSON blob)
    const w = runBash(wrapped(`seq 1 100; printf 'y%.0s' $(seq 1 100000); echo ' FINAL-ERROR-TEXT'; (exit 1)`, t.sh));
    assert.equal(w.status, 1);
    assert.ok(w.stdout.includes('FINAL-ERROR-TEXT'), 'the end of the huge line survives (the old cut -c1-1000 kept only its start)');
    assert.ok(w.stdout.includes('tail cut to its last 10000 characters'));
    assert.ok(w.stdout.length < 11000, `bounded output, got ${w.stdout.length}`);
    const full = readFileSync(join(t.dir, 'out', 'run1.log'), 'utf8');
    assert.ok(full.includes('y'.repeat(100000)), 'the file keeps the line whole');
  } finally { t.done(); }
});

test('wrapper: cd inside the command persists in the calling shell (a group, not a subshell)', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(`${wrapped(`cd "${t.sh}" && seq 1 5`, t.sh)}\npwd`);
    assert.equal(w.status, 0);
    assert.ok(w.stdout.trim().split('\n').pop().toLowerCase().includes(t.sh.split('/').pop().toLowerCase()), 'pwd after the wrapper is the cd target');
  } finally { t.done(); }
});

test('wrapper: stdout and stderr are both captured', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped('echo OUT; echo ERR >&2', t.sh));
    assert.ok(w.stdout.includes('OUT') && w.stdout.includes('ERR'));
    assert.equal(w.stderr, '');
  } finally { t.done(); }
});

test('wrapper: if the output file cannot be created the ORIGINAL command runs as written', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    writeFileSync(join(t.dir, 'blocker'), 'a file, not a directory');
    const cmd = wrapCommand('seq 1 200; (exit 5)', { file: `${t.sh}/blocker/x/run.log`, dir: `${t.sh}/blocker/x`, id: 'r' });
    const w = runBash(cmd);
    assert.equal(w.status, 5);
    assert.equal(w.stdout.trim().split('\n').length, 200, 'the whole output, unwrapped');
    assert.ok(!w.stdout.includes('[ac-bash-tail]'));
  } finally { t.done(); }
});

test('wrapper: the result row is appended as one JSON line with the measured numbers', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const log = `${t.sh}/result.jsonl`;
    runBash(wrapped('seq 1 300; (exit 2)', t.sh, log));
    runBash(wrapped('seq 1 10', t.sh, log));
    const rows = readFileSync(join(t.dir, 'result.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event, 'result');
    assert.equal(rows[0].rc, 2);
    assert.equal(rows[0].lines, 300);
    assert.equal(rows[0].truncated, 1);
    assert.ok(rows[0].bytes > rows[0].shown_chars, 'fewer characters returned than produced');
    assert.equal(rows[1].rc, 0);
    assert.equal(rows[1].truncated, 0);
    assert.equal(rows[1].shown_chars, rows[1].bytes);
  } finally { t.done(); }
});

test('wrapper: a path with a space and a quote survives', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const dir = `${t.sh}/it's here`;
    mkdirSync(dir, { recursive: true });
    const w = runBash(wrapCommand('seq 1 200', { file: `${dir}/r.log`, dir, id: 'q' }));
    assert.equal(w.status, 0);
    assert.ok(existsSync(join(t.dir, "it's here", 'r.log')));
  } finally { t.done(); }
});

test('outputTarget honours the env override and names each run uniquely; pruneOldOutputs drops only old .log files', () => {
  const t = tempDirForBash();
  try {
    const a = outputTarget({ AGENT_COMPANION_BASH_TAIL_DIR: t.dir });
    const b = outputTarget({ AGENT_COMPANION_BASH_TAIL_DIR: t.dir });
    assert.equal(a.dir, shellPath(t.dir));
    assert.notEqual(a.file, b.file);
    const old = join(t.dir, 'old.log'); const fresh = join(t.dir, 'fresh.log'); const other = join(t.dir, 'keep.txt');
    for (const f of [old, fresh, other]) writeFileSync(f, 'x');
    const past = new Date(Date.now() - KEEP_FILES_MS - 60000);
    utimesSync(old, past, past); utimesSync(other, past, past);
    pruneOldOutputs(t.dir);
    const left = readdirSync(t.dir).sort();
    assert.deepEqual(left, ['fresh.log', 'keep.txt']);
  } finally { t.done(); }
});

// --- the hook ---------------------------------------------------------------

function hookEnv(fx, extra = {}) {
  return { AGENT_COMPANION_BASH_TAIL_DIR: join(fx.dir, 'tail-out'), ...extra };
}
const payload = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-btail', tool_name: 'Bash',
  tool_input: { command }, permission_mode: 'bypassPermissions', ...extra,
});

test('hook: a known runner is rewritten with updatedInput and NO permissionDecision', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('cd app && npm test', { tool_input: { command: 'cd app && npm test', description: 'run tests', timeout: 90000 } }), { env: hookEnv(fx) });
    assert.equal(r.status, 0);
    assert.equal(decisionOf(r.json), 'proceed', 'no permissionDecision: the permission flow is not this hook\'s call');
    const out = r.json.hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.ok(out.updatedInput.command.includes('cd app && npm test'), 'the original command is inside');
    assert.ok(out.updatedInput.command.includes('(exit "$__acrc")'), 'exit status is re-raised');
    assert.equal(out.updatedInput.description, 'run tests', 'other tool_input fields pass through');
    assert.equal(out.updatedInput.timeout, 90000);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'wrapped');
    assert.equal(rows[0].runner, 'npm test');
  } finally { fx.cleanup(); }
});

test('hook: leaves alone (prints nothing) short, piped, redirected, git, background and non-Bash calls', () => {
  const fx = makeFixture();
  try {
    const none = [
      payload('git status'), payload('ls -la'), payload('npm test | tail -5'), payload('npm test > out.txt'),
      payload('npm test --watch'), payload('echo hi'),
      payload('npm test', { tool_input: { command: 'npm test', run_in_background: true } }),
      payload('npm test', { tool_name: 'PowerShell' }),
      payload('npm test', { tool_input: {} }),
    ];
    for (const p of none) {
      const r = runHook('hooks/bash-tail.mjs', p, { env: hookEnv(fx) });
      assert.equal(r.status, 0);
      assert.equal(r.json, null, `no output for ${JSON.stringify(p.tool_input)} / ${p.tool_name}`);
    }
  } finally { fx.cleanup(); }
});

test('hook: opt-out through the environment', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx, { CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0' }) });
    assert.equal(r.json, null);
    assert.ok(!existsSync(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl')), 'opted out: nothing logged either');
    const on = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx, { CLAUDE_PLUGIN_OPTION_BASH_TAIL: '1' }) });
    assert.ok(on.json?.hookSpecificOutput?.updatedInput);
  } finally { fx.cleanup(); }
});

test('hook: outside bypassPermissions it passes through and logs why; "any" lifts the limit', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('npm test', { permission_mode: 'default' }), { env: hookEnv(fx) });
    assert.equal(r.json, null);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows[0].event, 'skipped');
    assert.equal(rows[0].reason, 'permission_mode:default');
    const any = runHook('hooks/bash-tail.mjs', payload('npm test', { permission_mode: 'default' }), { env: hookEnv(fx, { CLAUDE_PLUGIN_OPTION_BASH_TAIL_PERMISSION_MODES: 'any' }) });
    assert.ok(any.json?.hookSpecificOutput?.updatedInput);
    const absent = runHook('hooks/bash-tail.mjs', { ...payload('npm test'), permission_mode: undefined }, { env: hookEnv(fx) });
    assert.equal(absent.json, null, 'an unknown mode is treated as not bypass');
  } finally { fx.cleanup(); }
});

test('hook: a blocked known runner logs a skipped row with the blockers', () => {
  const fx = makeFixture();
  try {
    runHook('hooks/bash-tail.mjs', payload('npm test | tee x'), { env: hookEnv(fx) });
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'skipped');
    assert.match(rows[0].reason, /pipe/);
  } finally { fx.cleanup(); }
});

test('hook: applies inside a subagent and records that', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('pytest -x', { agent_id: 'agent-123', agent_type: 'agent-companion:ac-sonnet-low' }), { env: hookEnv(fx) });
    assert.ok(r.json?.hookSpecificOutput?.updatedInput);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows[0].caller_is_subagent, true);
  } finally { fx.cleanup(); }
});

test('hook: the rewritten command, run in bash, gives the right exit code and the path of a real file', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const fx = makeFixture();
  try {
    // A stand-in `npm` first on PATH: a known runner whose output and exit status we control.
    const bin = join(fx.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nseq 1 400\necho BUILD-BROKE >&2\nexit 7\n', { mode: 0o755 });
    const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx) });
    const rewritten = r.json?.hookSpecificOutput?.updatedInput?.command;
    assert.ok(rewritten, 'npm test is a known runner');
    const sep = process.platform === 'win32' ? ';' : ':';
    const w = runBash(rewritten, { env: { PATH: `${shellPath(bin)}${sep}${process.env.PATH}` } });
    assert.equal(w.status, 7, 'the stand-in exit status passes through the wrapper');
    assert.ok(w.stdout.includes('BUILD-BROKE'));
    const files = readdirSync(join(fx.dir, 'tail-out'));
    assert.equal(files.length, 1);
    const header = w.stdout.split('\n')[0];
    assert.ok(header.includes(files[0]), 'the printed path names the file that exists');
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.deepEqual(rows.map((x) => x.event), ['wrapped', 'result']);
    assert.equal(rows[1].rc, 7);
  } finally { fx.cleanup(); }
});

test('hook: a fixture session does not write result rows into the production stream', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', payload('npm test', { session_id: 'test-bash-tail' }), { env: hookEnv(fx) });
    const cmd = r.json.hookSpecificOutput.updatedInput.command;
    assert.ok(!cmd.includes('bash-tail.jsonl'), 'no result-log write in the wrapper for a fixture session');
  } finally { fx.cleanup(); }
});

test('hook: hooks.json registers it on exactly ^Bash$ and plugin.json declares both options', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const entry = hooks.find((h) => h.matcher === '^Bash$');
  assert.ok(entry);
  assert.ok(entry.hooks[0].args[0].endsWith('hooks/bash-tail.mjs'));
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.bash_tail.default, true);
  assert.equal(cfg.bash_tail_permission_modes.default, 'bypassPermissions');
});

// =============================================================================
// Review round 2 (2026-10-03): findings 1-5, each with a test that runs the
// generated shell in a real bash or drives the hook.
// =============================================================================

// --- finding 1: a timeout or kill leaves nothing -> name the file BEFORE the run

test('wrapper: the file path is printed BEFORE the command runs, so a killed run still names its file', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    // kill -9 on the shell stands in for the tool timeout killing the run mid-command
    const w = runBash(wrapped('echo partial-line; kill -9 $$', t.sh));
    assert.notEqual(w.status, 0, 'the shell was killed');
    assert.match(w.stdout, /^\[ac-bash-tail\] full output of this run goes to .*run1\.log/, 'the notice is the first thing printed');
    assert.ok(!w.stdout.includes('partial-line'), 'the command output went to the file, not the terminal');
    const full = readFileSync(join(t.dir, 'out', 'run1.log'), 'utf8');
    assert.ok(full.includes('partial-line'), 'the file the notice named holds the partial output');
  } finally { t.done(); }
});

// --- finding 2: set -e must not make all output disappear

test('wrapper: with errexit already on, the original runs as written and nothing is lost (set -e, set -euo pipefail)', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  for (const setLine of ['set -e', 'set -euo pipefail', 'set -eu']) {
    const t = tempDirForBash();
    try {
      const w = runBash(`${setLine}\n${wrapped('echo VISIBLE-BEFORE-FAIL; seq 1 200; (exit 3)', t.sh)}\necho NOT-REACHED`);
      assert.equal(w.status, 3, `${setLine}: the failing exit status is the script's status`);
      assert.ok(w.stdout.includes('VISIBLE-BEFORE-FAIL'), `${setLine}: output is visible`);
      assert.ok(w.stdout.includes('\n200\n'), `${setLine}: the whole output is visible (the original ran unwrapped)`);
      assert.ok(!w.stdout.includes('NOT-REACHED'), `${setLine}: errexit semantics are kept`);
    } finally { t.done(); }
  }
  // control: without errexit the same wrapper does its job
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped('seq 1 200; (exit 3)', t.sh));
    assert.equal(w.status, 3);
    assert.match(w.stdout, /\[ac-bash-tail\] exit 3; 200 lines/);
  } finally { t.done(); }
});

test('analyze: source and "." are blocked, because they can switch errexit on in the middle of the command', () => {
  for (const c of ['source env.sh && npm test', '. ./env.sh && npm test', 'npm test && source x.sh', 'set -e; npm test']) {
    assert.equal(wraps(c), false, `must not wrap: ${c}`);
  }
});

// --- finding 3: never-exiting, watch and interactive commands

test('analyze: every dev server, watcher and interactive command from the review passes through', () => {
  const never = [
    'npx vite', 'npx vite preview', 'npx vite dev', 'pnpm dlx vite', 'npx next dev', 'npx wrangler dev', 'npx quasar dev',
    'npx ng serve', 'npx expo start', 'npx webpack serve', 'npx nuxt dev', 'npx astro dev', 'npx turbo dev', 'npx nx serve app',
    'npx wrangler login', 'npx vitest --ui', 'npx playwright test --ui', 'npx playwright show-report', 'npx playwright codegen',
    'npx cypress open', 'npm run build:watch', 'npm run test:watch', 'npm run test:e2e:ui', 'npm run dev', 'npm start',
    'pytest -f', 'pytest --looponfail', 'pytest --pdb', 'tsc -w', 'jest -w', 'mocha -w', 'tsc --watch',
    'make run', 'make serve', 'make dev', 'gradle bootRun', './gradlew bootRun', 'mvn spring-boot:run', 'gradle build --continuous',
  ];
  for (const c of never) assert.equal(wraps(c), false, `must pass through: ${c}`);
});

test('analyze: a chain passes through when ANY segment is a server, a watcher or not a known runner', () => {
  for (const c of [
    'npm install && npm run dev', 'npm run build && npx vite preview', 'cargo build && cargo run', 'make -j8 && ./a.out',
    'npm ci && npx wrangler dev', 'cd app && npm test && npm run test:watch', 'npm test; node server.mjs',
  ]) assert.equal(wraps(c), false, `must pass through: ${c}`);
});

test('analyze: the list is consistent (vite and npx vite agree; bare watcher names never wrap)', () => {
  assert.equal(wraps('vite'), wraps('npx vite'));
  assert.equal(wraps('vite preview'), wraps('npx vite preview'));
  assert.equal(wraps('next dev'), wraps('npx next dev'));
  assert.equal(wraps('wrangler dev'), wraps('npx wrangler dev'));
  assert.equal(wraps('pnpm dlx vite'), false);
  assert.equal(wraps('pnpm exec vite'), false);
});

test('analyze: one-shot forms of the same tools still wrap', () => {
  for (const c of [
    'npx vite build', 'npx vitest run', 'npx playwright test', 'npx wrangler deploy', 'npx next build', 'npx nx build app',
    'npx turbo build', 'npx ng build', 'npx webpack', 'make test', 'make -j8', 'gradle build', 'mvn test', 'mvn -q package',
    'pytest -x', 'pytest -q tests/', 'npm run test:unit', 'npm run build && npm test', 'npm ci && npm test', 'cargo build && cargo test',
  ]) assert.equal(wraps(c), true, `should still wrap: ${c}`);
});

// --- finding 4: permission rules

test('hook: a deny rule that the wrapper\'s helpers could trip (Bash(rm *)) leaves the command alone, user settings', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.dir, '.claude'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
    const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx) });
    assert.equal(r.json, null, 'passes through untouched');
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows[0].event, 'skipped');
    assert.equal(rows[0].reason, 'permission-rule:deny');
  } finally { fx.cleanup(); }
});

test('hook: an ask rule in project settings.local.json (found from the payload cwd, walking up) also stops the wrap', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'proj');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    mkdirSync(join(proj, 'deep', 'er'), { recursive: true });
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['Bash(tail *)'] } }));
    const r = runHook('hooks/bash-tail.mjs', payload('npm test', { cwd: join(proj, 'deep', 'er') }), { env: hookEnv(fx) });
    assert.equal(r.json, null);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'));
    assert.equal(rows[0].reason, 'permission-rule:ask');
  } finally { fx.cleanup(); }
});

test('hook: a rule that matches the ORIGINAL command (Bash(npm test:*), Bash(npm *)) stops the wrap too', () => {
  for (const rule of ['Bash(npm test:*)', 'Bash(npm *)', 'Bash(npm test)']) {
    const fx = makeFixture();
    try {
      mkdirSync(join(fx.dir, '.claude'), { recursive: true });
      writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [rule] } }));
      const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx) });
      assert.equal(r.json, null, `${rule}: untouched`);
    } finally { fx.cleanup(); }
  }
});

test('hook: rules that cannot match the original or any helper do not stop the wrap; allow rules and non-Bash rules are ignored', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.dir, '.claude'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify({
      permissions: {
        deny: ['Bash(rm -rf /*)', 'Bash(git push *)', 'Bash(curl *)', 'Read(./.env)'],
        ask: ['Bash(docker run *)'],
        allow: ['Bash'],
      },
    }));
    const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx) });
    assert.ok(r.json?.hookSpecificOutput?.updatedInput?.command, 'still wrapped');
  } finally { fx.cleanup(); }
});

test('hook: a bare Bash rule and a redirect rule block the wrap (the wrapper adds a redirect)', () => {
  for (const rule of ['Bash', 'Bash(*)', 'Bash(* > /tmp/*)']) {
    const fx = makeFixture();
    try {
      mkdirSync(join(fx.dir, '.claude'), { recursive: true });
      writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: [rule] } }));
      const r = runHook('hooks/bash-tail.mjs', payload('npm test'), { env: hookEnv(fx) });
      assert.equal(r.json, null, `${rule}: untouched`);
    } finally { fx.cleanup(); }
  }
});

test('blockingPermissionRule / readPermissionRules: unit behaviour', () => {
  const mk = (...p) => p.map((pattern) => ({ kind: 'deny', pattern, rule: `Bash(${pattern})`, file: 'x' }));
  assert.equal(blockingPermissionRule([], 'npm test'), null);
  assert.equal(blockingPermissionRule(mk('rm -rf /*'), 'npm test'), null);
  assert.ok(blockingPermissionRule(mk('rm *'), 'npm test'), 'rm is a helper');
  assert.ok(blockingPermissionRule(mk('grep *'), 'npm test'), 'grep is a helper');
  assert.ok(blockingPermissionRule(mk('printf *'), 'npm test'), 'printf is a helper');
  assert.ok(blockingPermissionRule(mk('cargo build'), 'cd x && cargo build'), 'a segment of the original');
  assert.equal(blockingPermissionRule(mk('cargo build'), 'cd x && cargo test'), null);
  // reading: scopes, shapes, junk
  const fx = makeFixture();
  try {
    const cd = join(fx.dir, 'cfg'); const proj = join(fx.dir, 'p');
    mkdirSync(cd, { recursive: true }); mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(join(cd, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(a *)', 'Edit(x)', 5] } }));
    writeFileSync(join(cd, 'settings.local.json'), '{ not json');
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Bash(b:*)'] } }));
    const rules = readPermissionRules({ cwd: join(proj, 'sub'), claudeDirPath: cd, projectDir: proj, stopAt: fx.dir });
    assert.deepEqual(rules.map((r) => `${r.kind}:${r.pattern}`).sort(), ['ask:', 'deny:a *', 'deny:b:*']);
    assert.deepEqual(readPermissionRules({ cwd: join(fx.dir, 'nothing'), claudeDirPath: join(fx.dir, 'none'), stopAt: fx.dir }), []);
  } finally { fx.cleanup(); }
});

test('wrapper: only the helper commands in WRAPPER_HELPERS are used (no mkdir, tr, cut, cygpath, head, sed, awk)', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const allowed = new Set([...WRAPPER_HELPERS.map((h) => h.split(' ')[0]), 'seq', 'exit', ':', 'case' /* a shell keyword, not a command */]);
  for (const cmd of ['seq 1 300; (exit 1)', 'seq 1 300', 'seq 1 5']) {
    const t = tempDirForBash();
    try {
      const r = spawnSync(BASH, ['-x', '-c', wrapped(cmd, t.sh)], { encoding: 'utf8', windowsHide: true });
      const used = new Set();
      for (const line of r.stderr.split('\n')) {
        const m = /^\++ (.*)$/.exec(line);
        if (!m) continue;
        const first = m[1].split(' ')[0].replace(/['"]/g, '');
        if (!first || first.includes('=')) continue; // assignments
        used.add(first);
      }
      for (const u of used) assert.ok(allowed.has(u), `wrapper ran ${u}, which WRAPPER_HELPERS does not cover (${cmd})`);
      for (const bad of ['mkdir', 'tr', 'cut', 'cygpath', 'head', 'sed', 'awk']) assert.ok(!used.has(bad), `wrapper must not use ${bad}`);
    } finally { t.done(); }
  }
});

// --- finding 5: lower-severity items

test('analyze: separate-argument machine-format flags pass through (--reporter json, -f json, --junitxml)', () => {
  for (const c of [
    'npm test -- --reporter json', 'npx vitest run --reporter json', 'eslint . -f json', 'eslint . --format json',
    'pytest --junitxml report.xml', 'pytest --junitxml=report.xml', 'npx jest --coverageReporters=json', 'jest --json',
    'npx mocha --reporter json', 'cargo test --message-format json',
  ]) assert.equal(wraps(c), false, `must pass through: ${c}`);
  assert.equal(wraps('npm test -- --reporter dot'), true, 'a human reporter still wraps');
});

test('wrapper: a failing run whose summary comes FIRST still shows it (summary-looking lines from earlier in the file)', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped('echo "SUMMARY: 3 failing"; for i in 1 2 3 4 5; do echo "failure block $i"; seq 1 40; done; (exit 1)', t.sh));
    assert.equal(w.status, 1);
    assert.ok(w.stdout.includes('SUMMARY: 3 failing'), 'the summary line from the top is surfaced');
    assert.match(w.stdout, /summary-looking lines from earlier in the file/);
    // a line already inside the tail is not repeated as a "summary" line
    const w2 = runBash(wrapped('seq 1 200; echo "3 failed, 7 passed"; (exit 1)', t.sh));
    assert.ok(!/summary-looking lines/.test(w2.stdout), 'nothing earlier than the tail matched');
    // a passing run does not get the extra block
    const w3 = runBash(wrapped('echo "SUMMARY: ok"; seq 1 300', t.sh));
    assert.ok(!/summary-looking lines/.test(w3.stdout));
  } finally { t.done(); }
});

test('wrapper: an over-long summary line is cut and the extra block is capped at five lines', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped(`printf 'FAIL%.0s' $(seq 1 600); echo; for i in 1 2 3 4 5 6 7 8; do echo "FAIL case $i"; done; seq 1 300; (exit 1)`, t.sh));
    const block = w.stdout.split('\n').filter((l) => /^\d+:/.test(l));
    assert.ok(block.length > 0 && block.length <= 5, `1..5 summary lines, got ${block.length}`);
    assert.ok(block.every((l) => l.length <= 300 + 8), 'each cut to 300 chars (plus the line number)');
  } finally { t.done(); }
});
