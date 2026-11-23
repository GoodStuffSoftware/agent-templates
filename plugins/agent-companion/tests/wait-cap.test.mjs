// Wait-loop cap: hooks/lib/wait-cap.mjs (the rewrite) and bash-tail.mjs step 0b (the wiring), plus a real
// short run in bash that proves the cap fires without `timeout`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runHook } from './helpers.mjs';
import { waitCapRewrite } from '../hooks/lib/wait-cap.mjs';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';

const payload = (command, extra = {}, input = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-wc', tool_name: 'Bash',
  tool_input: { command, run_in_background: true, ...input },
  permission_mode: 'bypassPermissions', cwd: process.env.AGENT_COMPANION_HOME_OVERRIDE, ...extra,
});
const hook = (command, env = {}, input = {}) => runHook('hooks/bash-tail.mjs', payload(command, {}, input), { env });
const rewritten = (r) => r.json?.hookSpecificOutput?.updatedInput?.command;

const ISSUE = 'until grep -q "^# duration_ms" /tmp/x.log; do sleep 10; done; tail -12 /tmp/x.log';

test('lib: the reported until loop gets a $SECONDS deadline and the message', () => {
  const r = waitCapRewrite(ISSUE, 60);
  assert.equal(r.count, 1);
  assert.match(r.command, /do : "\$\{__ac_wc1:=\$\(\(SECONDS\+3600\)\)\}"; \[ "\$SECONDS" -lt "\$__ac_wc1" \] \|\| \{ echo "wait-cap: gave up after 60 min; condition never met"; exit 124; \}; sleep 10; done; tail -12/);
  assert.ok(r.command.startsWith('until grep -q "^# duration_ms" /tmp/x.log; do'), 'condition untouched');
  assert.doesNotMatch(r.command, /\btimeout\b/);
});

test('lib: while loops, and several loops in one command, each get their own deadline', () => {
  const cmd = 'while ! [ -f /tmp/a ]; do sleep 5; done; echo mid; until [ -f /tmp/b ]; do sleep 5; done';
  const r = waitCapRewrite(cmd, 30);
  assert.equal(r.count, 2);
  assert.match(r.command, /__ac_wc1:=\$\(\(SECONDS\+1800\)\)/);
  assert.match(r.command, /__ac_wc2:=\$\(\(SECONDS\+1800\)\)/);
  assert.ok(r.command.indexOf('__ac_wc1') < r.command.indexOf('echo mid') && r.command.indexOf('echo mid') < r.command.lastIndexOf('__ac_wc2'));
  assert.match(r.command, /echo mid; until \[ -f \/tmp\/b \]; do : /);
});

test('lib: nested loops are both capped; newlines and quoted keywords are handled', () => {
  const nested = waitCapRewrite('while true; do\n  until [ -f /tmp/c ]; do sleep 1; done\n  sleep 2\ndone', 5);
  assert.equal(nested.count, 2);
  const quoted = waitCapRewrite(`echo 'until x; do sleep 1; done'; echo "while y; do sleep 1; done"; # until z; do sleep 1; done`, 5);
  assert.equal(quoted, null, 'loops inside quotes and comments are not loops');
  const nestedQuotes = waitCapRewrite(`until grep -q "it's \\"done\\"" 'a "b" c.log'; do sleep 3; done`, 5);
  assert.equal(nestedQuotes.count, 1);
  assert.match(nestedQuotes.command, /^until grep -q "it's \\"done\\"" 'a "b" c\.log'; do : /);
  const sub = waitCapRewrite('x=$(until [ -f /tmp/d ]; do sleep 1; done; echo hi); echo $x', 5);
  assert.equal(sub, null, '$(...) bodies are not scanned');
});

test('lib: loops that already have a bound, or no sleep, are left alone', () => {
  for (const cmd of [
    'timeout 600 bash -c "until [ -f /tmp/a ]; do sleep 1; done"',
    'until [ -f /tmp/a ] || [ $SECONDS -gt 300 ]; do sleep 1; done',
    'i=0; while [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done',
    'i=0; until [ -f /tmp/a ]; do ((i++)); sleep 1; done',
    'n=0; while [ $n -lt 9 ]; do n=$(expr $n + 1); sleep 1; done',
    'end=$(( $(date +%s) + 60 )); until [ -f /tmp/a ]; do [ $(date +%s) -gt $end ] && break; sleep 1; done',
    'while read l; do echo $l; done < /tmp/f',
    'for i in 1 2 3; do sleep 1; done',
    'sleep 5; echo done',
  ]) assert.equal(waitCapRewrite(cmd, 60), null, cmd);
});

test('lib: 0, negative and junk minutes are off', () => {
  for (const m of [0, -1, NaN, 'x', undefined]) assert.equal(waitCapRewrite(ISSUE, m), null);
});

test('hook: a background loop is rewritten through updatedInput, silently', () => {
  const r = hook(ISSUE);
  assert.equal(r.status, 0);
  const out = r.json.hookSpecificOutput;
  assert.equal(out.permissionDecision, undefined);
  assert.equal(out.additionalContext, undefined, 'no note');
  assert.equal(out.updatedInput.run_in_background, true, 'other fields pass through');
  assert.match(out.updatedInput.command, /wait-cap: gave up after 60 min/);
});

test('hook: option off (0), foreground calls and bounded loops pass through untouched', () => {
  assert.equal(rewritten(hook(ISSUE, { CLAUDE_PLUGIN_OPTION_WAIT_LOOP_CAP_MINUTES: '0' })), undefined);
  assert.equal(rewritten(hook(ISSUE, {}, { run_in_background: false })), undefined);
  assert.equal(rewritten(hook(ISSUE, {}, { run_in_background: undefined })), undefined);
  assert.equal(rewritten(hook('until [ -f /tmp/a ] || [ $SECONDS -gt 9 ]; do sleep 1; done')), undefined);
  const custom = hook(ISSUE, { CLAUDE_PLUGIN_OPTION_WAIT_LOOP_CAP_MINUTES: '15' });
  assert.match(rewritten(custom), /gave up after 15 min/);
});

test('real run: the capped loop ends at the deadline in this shell, prints the line, exits nonzero, and runs nothing after', () => {
  const r = waitCapRewrite('until [ -f /nonexistent/never ]; do sleep 1; done; echo AFTER', 2 / 60); // 2 seconds
  assert.equal(r.count, 1);
  assert.match(r.command, /SECONDS\+2\)/);
  const t0 = Date.now();
  const ran = spawnSync(BASH, ['-c', r.command], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(ran.status, 124, ran.stderr);
  assert.match(ran.stdout, /wait-cap: gave up after 0\.0\d+ min; condition never met/);
  assert.doesNotMatch(ran.stdout, /AFTER/);
  assert.ok(secs >= 1.5 && secs < 20, `took ${secs}s`);
});

test('real run: a loop whose condition comes true before the cap behaves as before', () => {
  const r = waitCapRewrite('n=0; until [ "$n" = x ] || [ -f /nonexistent/x ] || { n=x; false; }; do sleep 1; done; echo OK-$n', 1);
  // `n=x` makes the second pass see it; the loop body must not trip the cap in a minute.
  const ran = spawnSync(BASH, ['-c', r.command], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /OK-x/);
  assert.doesNotMatch(ran.stdout, /wait-cap/);
});

test('lib: a command with a heredoc is left completely alone (unquoted, quoted, apostrophes)', () => {
  const loop = 'until [ -f /tmp/x ]; do sleep 1; done';
  const cases = [
    `cat > w.sh <<EOF\n${loop}\nEOF\nbash w.sh`,
    `cat > w.sh <<'EOF'\n${loop}\nEOF\nbash w.sh`,
    `cat > w.sh <<-"EOF"\n\t${loop}\nEOF\nbash w.sh`,
    ['cat > w.sh <<EOF', `echo "it's here"; ${loop}; echo 'unterminated`, 'EOF', 'bash w.sh'].join('\n'),
  ];
  for (const c of cases) assert.equal(waitCapRewrite(c, 60), null, c);
});

test('lib: one deadline per command: a loop re-entered inside an outer loop shares the variable', () => {
  const cmd = 'for p in 1 2 3; do until [ -f /tmp/$p ]; do sleep 5; done; done';
  const r = waitCapRewrite(cmd, 60);
  assert.equal(r.count, 1);
  assert.equal((r.command.match(/__ac_wc\d+:=/g) || []).length, 1, 'set with := once, never reset per entry');
  assert.doesNotMatch(r.command, /__ac_wc1=|unset __ac_wc1/);
});
