// python_stdin_guard (0.31.18): Python reading its program from a NUL stdin on Windows.
// The pure check (hooks/lib/python-stdin.mjs) is exercised in-process with an injected platform;
// the hook-level tests spawn hooks/poll-guard.mjs (the host hook) and run on win32 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { runHook, decisionOf } from './helpers.mjs';
import { pythonStdinCheck, PY_MSG } from '../hooks/lib/python-stdin.mjs';

const NL = '\n';
const P = 'python3';

const DENY = [
  `${P} - < /dev/null`,
  `${P} - </dev/null`,
  `${P} -u - 0</dev/null`,
  `${P} - <NUL`,
  `${P} < /dev/null`,
  `${P} -`,
  `${P}`,
  `${P} - arg1 arg2`,
  `${P} -I -X utf8 -`,
  `python -`,
  `python3.14 -`,
  `py -`,
  `py -3 -`,
  `py -3.14 - < /dev/null`,
  `python.exe -`,
  `/c/Users/someone/AppData/Local/Python/bin/python3.exe -`,
  `C:/Users/someone/AppData/Local/Python/pythoncore-3.14-64/python.exe -`,
  `"C:\\Users\\someone\\AppData\\Local\\Python\\bin\\python3.exe" -`,
  `${P} - <<'E'${NL}E`,
  `${P} - <<E${NL}E${NL}echo next`,
  `${P} - <<-'E'${NL}\tE`,
  `${P} - <<'E'`,
  `${P} - <<'E' 2>/dev/null || node -e 'console.log(1)'${NL}E`,
  `${P} - 2>/dev/null || node - <<'E'${NL}console.log(1)${NL}E`,
  `echo hi && ${P} -`,
  `cd /tmp; ${P} - ; echo done`,
  `FOO=1 ${P} -`,
  `env FOO=1 ${P} -`,
  `exec ${P} -`,
  `x=$(${P} -)`,
  `x=\`${P} -\``,
  `${P} - < /dev/null &`,
  `cat <<'A'${NL}hello${NL}A${NL}${P} -`,
  // review round: these are real commands after a case pattern, a function header or arithmetic
  `case "$x" in${NL}  a) ${P} - ;;${NL}esac`,
  `case "$x" in a|b) echo | cat; ${P} - ;; esac`,
  `x=$(( 1 << 2 ))${NL}${P} -`,
  `(( y = 1 << 2 ))${NL}${P} -`,
  // review round 2 (B-2): a bare subshell or brace group with nothing feeding it hangs like the bare command
  `(${P} -)`,
  `{ ${P} -; }`,
  `( ${P} - )`,
  `echo hi; (${P} -)`,
  `(x=1; ${P} -)`,
  `( ( ${P} - ) )`,
  `(${P} -) < /dev/null`,
  `{ ${P} -; } < /dev/null`,
  `(${P} -) <<E${NL}E`,
  `echo x | (cat); (${P} -)`,
  `echo x | { cat; }; { ${P} -; }`,
  `(${P} -) | cat`,
  `echo x | { ${P} - < /dev/null; }`,
];

const ALLOW = [
  `${P} -c 'print(1)'`,
  `${P} -c "print(1)" < /dev/null`,
  `${P} -Ic 'print(1)' < /dev/null`,
  `${P} script.py`,
  `${P} script.py < /dev/null`,
  `${P} -u script.py`,
  `${P} -m pip --version`,
  `${P} -m json.tool < /dev/null`,
  `${P} -X frozen_modules=off script.py`,
  `${P} -W ignore script.py`,
  `${P} --version`,
  `${P} -V`,
  `${P} -h`,
  `py -0p`,
  `py --list`,
  `${P} - <<'E'${NL}print('hi')${NL}E`,
  `${P} <<'E'${NL}print('hi')${NL}E`,
  `${P} - <<'E' 2>/dev/null || node -e 'console.log(1)'${NL}print(1)${NL}E`,
  `${P} - <<-E${NL}\tprint(1)${NL}\tE`,
  `${P} - <<'E'${NL}${NL}E`,
  `${P} - <<< 'print(1)'`,
  `${P} - <<< ""`,
  `echo 'print(1)' | ${P} -`,
  `printf '' | ${P} -`,
  `cat s.py |& ${P} -`,
  `${P} - < script.py`,
  `${P} - < empty.txt`,
  `${P} - < <(echo 'print(1)')`,
  `${P} - 0<&-`,
  `( ${P} - ) < s.py`,
  `{ ${P} -; } < s.py`,
  `while read l; do ${P} - ; done < list.txt`,
  // a heredoc fed to something else, holding the pattern as data
  `cat > run.sh <<'E'${NL}${P} - < /dev/null${NL}${P} -${NL}E`,
  `node - <<'E'${NL}console.log(1)${NL}E`,
  `node -e 'console.log(1)'`,
  `cat <<'E'${NL}E`,
  `cat < /dev/null`,
  `grep -r "${P} -" .`,
  `echo '${P} - < /dev/null'`,
  `echo "${P} -"`,
  `# ${P} -${NL}echo hi`,
  `git commit -m "deny ${P} - with empty stdin"`,
  `ls /c/Users/someone/AppData/Local/Python/bin`,
  `pyenv versions`,
  `pytest -x -`,
  `pip install requests`,
  `${P} - < /dev/null # guard-ack: python-stdin`,
  // review round: case patterns and function names are not commands
  `case "$x" in${NL}  ${P}) echo yes;;${NL}  py|python) echo also;;${NL}esac`,
  `case "$x" in ${P}) echo yes;; esac`,
  `x=$(case "$v" in ${P}) echo a;; esac)`,
  `${P}() { command ${P} -c 1; }`,
  `${P} () { echo hi; }`,
  `x=$(( 1 << 2 ))${NL}echo $x`,
  `case "$x" in${NL}  a) echo a | ${P} - ;;${NL}  ${P}|py) echo b;;${NL}esac`,
  `timeout 5 ${P} - < script.py`,
  // review round 2 (B-2): a group that is piped into, or has a stdin redirect of its own, feeds its python
  `echo 'print(1)' | (${P} -)`,
  `echo 'print(1)' | { ${P} -; }`,
  `(${P} -) < prog.py`,
  `{ ${P} -; } < prog.py`,
  `(${P} -) <<E${NL}print(1)${NL}E`,
  `(${P} -) <<< 'print(1)'`,
  `echo 'print(1)' | { ( ${P} - ); }`,
  `{ ( ${P} - ); } < prog.py`,
  `echo x | ( cat; ${P} - )`,
  `${P}2() { ${P} -; }`,
  `f() { ${P} -; }; echo x | f`,
  `(${P} -c 1)`,
  `{ ${P} -c 1; } < /dev/null`,
];

const check = (cmd, extra = {}) => pythonStdinCheck(cmd, { platform: 'win32', ...extra });

for (const c of DENY) {
  test(`denies ${JSON.stringify(c).slice(0, 90)}`, () => {
    const r = check(c);
    assert.ok(r, 'expected a deny');
    assert.equal(r.mode, 'deny');
    assert.equal(r.message, PY_MSG);
  });
}
for (const c of ALLOW) {
  test(`allows ${JSON.stringify(c).slice(0, 90)}`, () => {
    assert.equal(check(c), null);
  });
}

// Linear time: 300K-character shapes aimed at the scanner.
const N = 300000;
const fill = (head, unit) => (head + unit.repeat(Math.ceil((N - head.length) / unit.length))).slice(0, N);
const BIG = [
  ['heredoc of python lines', fill(`${P} -c 1; cat <<'E'${NL}`, `${P} -${NL}`), 'allow'],
  ['nested groups', fill('', '( '), 'allow'],
  ['nested substitutions', fill('', '$( '), 'allow'],
  ['nested braces', fill('', '{ '), 'allow'],
  ['do keywords', fill('', 'do '), 'allow'],
  ['backticks', fill('', '`'), 'allow'],
  ['many pending heredocs', fill('cat ', '<<E '), 'allow'],
  ['many heredocs, python line is a body', fill('cat ', '<<E ') + `${NL}${P} -`, 'allow'],
  ['quotes', fill('', `'a' "b" `), 'allow'],
  ['fd digits', fill('', '1'), 'allow'],
  ['fd redirects', fill('', '1>x '), 'allow'],
  ['param braces', fill('', '${'), 'allow'],
  ['python words, one command', fill(`${P} `, '-u '), 'deny'],
  ['python commands', fill('', `${P} -c 1;`), 'allow'],
  ['arithmetic opens', fill('', '$(('), 'allow'],
  ['case words', fill('', 'case x in a) '), 'allow'],
  ['stray parens', fill('', 'a) '), 'allow'],
  ['function headers', fill('', 'f() '), 'allow'],
  ['python deep in nested subshells', `${'( '.repeat(100000)}${P} -`, 'deny'],
  ['python deep in nested braces', `${'{ '.repeat(100000)}${P} -`, 'deny'],
  ['many subshells, one stdin python', fill('', `(${P} -c 1);`) + `(${P} -)`, 'deny'],
  ['many piped subshells', fill('echo x | ', `(${P} -c 1) | `), 'allow'],
  ['subshell chain with trailing redirects', fill('', `(${P} -c 1) < f; `), 'allow'],
  ['deep piped group then python', `echo x | ${'{ '.repeat(100000)}${P} -`, 'allow'],
];
for (const [name, cmd, want] of BIG) {
  test(`300K shape: ${name}`, () => {
    const t0 = Date.now();
    const r = check(cmd);
    const ms = Date.now() - t0;
    assert.equal(r ? 'deny' : 'allow', want);
    assert.ok(ms < 1000, `took ${ms} ms`);
  });
}

test('inert on non-win32 platforms', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const c of DENY) assert.equal(pythonStdinCheck(c, { platform }), null, platform + ' ' + c);
  }
});

test('modes: off allows, warn reports mode warn, unknown value denies', () => {
  assert.equal(check(`${P} -`, { mode: 'off' }), null);
  assert.equal(check(`${P} -`, { mode: 'warn' }).mode, 'warn');
  assert.equal(check(`${P} -`, { mode: 'DENY' }).mode, 'deny');
});

test('message names the safe forms and the override', () => {
  for (const s of ['-c', '-m', 'script', 'heredoc with a body', 'pipe', '# guard-ack: python-stdin', 'python_stdin_guard']) {
    assert.ok(PY_MSG.includes(s), s);
  }
});

test('fail-open on garbage input', () => {
  assert.equal(check(undefined), null);
  assert.equal(check(null), null);
  assert.equal(check({ toString() { throw new Error('x'); } }), null);
});

// Hook level (the host hook runs this check on Bash). The real platform decides, so win32 only.
const winOnly = { skip: process.platform !== 'win32' };
const bash = (command, env = {}, tool_name = 'Bash') =>
  runHook('hooks/poll-guard.mjs', { tool_name, tool_input: { command }, session_id: 's' }, { env });

test('hook denies on win32 with permissionDecision deny', winOnly, () => {
  const r = bash(`${P} - < /dev/null`);
  assert.equal(r.status, 0);
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /guard-ack: python-stdin/);
});

test('hook: ack comment, warn, off', winOnly, () => {
  assert.equal(decisionOf(bash(`${P} - < /dev/null # guard-ack: python-stdin`).json), null);
  const w = bash(`${P} -`, { CLAUDE_PLUGIN_OPTION_PYTHON_STDIN_GUARD: 'warn' });
  assert.equal(decisionOf(w.json), 'proceed');
  assert.match(w.json.hookSpecificOutput.additionalContext, /stdin/);
  assert.equal(bash(`${P} -`, { CLAUDE_PLUGIN_OPTION_PYTHON_STDIN_GUARD: 'off' }).json, null);
});

test('hook: PowerShell and safe commands are untouched', winOnly, () => {
  assert.equal(bash(`${P} -`, {}, 'PowerShell').json, null);
  assert.equal(bash(`${P} -c 'print(1)'`).json, null);
});
