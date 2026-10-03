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
    assert.equal(lines.length, 1 + TAIL_FAILED_LINES, 'header plus the failed-run tail');
  } finally { t.done(); }
});

test('wrapper: output within the limit is printed whole, the file is removed, exit code kept', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped(`seq 1 ${FULL_MAX_LINES}; (exit 4)`, t.sh));
    assert.equal(w.status, 4);
    assert.equal(w.stdout.trim().split('\n').length, FULL_MAX_LINES);
    assert.ok(!w.stdout.includes('[ac-bash-tail]'));
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

test('wrapper: very long single lines are cut in the tail, the file keeps them whole', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const t = tempDirForBash();
  try {
    const w = runBash(wrapped(`seq 1 100; printf 'y%.0s' $(seq 1 5000); echo`, t.sh));
    assert.ok(Math.max(...w.stdout.split('\n').map((l) => l.length)) < 1100);
    const full = readFileSync(join(t.dir, 'out', 'run1.log'), 'utf8');
    assert.ok(full.includes('y'.repeat(5000)));
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
