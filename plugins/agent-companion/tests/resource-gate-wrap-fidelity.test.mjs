// The resource-queue wrap must run the ORIGINAL command line unchanged: same output,
// same exit status as the command run without the wrap. Regression for the
// 2026-10-18 incident: `M=$(git commit-tree ...); git push origin $M:refs/heads/b`
// had only its push segment wrapped, the wrapped segment ran in a child shell where
// the unexported M was unset, and git received ":refs/heads/b" (a remote delete).
//
// Each case is run twice in real bash, once as typed and once as the gate rewrites
// it (through the real queue CLI, on a private ledger), and the two runs are compared.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './isolate.mjs';
import { scanCommand, rewriteCommand, gateDecision } from '../hooks/lib/resource-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'resource-queue.mjs').replace(/\\/g, '/');
const BASH = (() => {
  const gb = 'C:\\Program Files\\Git\\bin\\bash.exe';
  return process.platform === 'win32' && existsSync(gb) ? gb : 'bash';
})();
const HAVE_BASH = spawnSync(BASH, ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const SEP = process.platform === 'win32' ? ';' : ':';
const NODE_DIR = dirname(process.execPath).split('\\').join('/');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), `ac-test-${process.pid}-`));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.toUpperCase() === 'PATH') delete base[k]; // Windows spells it Path
  const env = {
    ...base,
    PATH: `${NODE_DIR}${SEP}${process.env.PATH}`,
    CI_BUDGET_DIR: join(dir, 'ledger'),
    CI_LOCAL_LOCK_DIR: join(dir, 'lock'),
    AGENT_COMPANION_HOME_OVERRIDE: dir,
    CLAUDE_CONFIG_DIR: join(dir, '.claude'),
  };
  delete env.AC_RESOURCE_LEASE;
  delete env.RESOURCE_QUEUE;
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The gate marks the LAST segment heavy (the shape of the incident: the push came last).
function wrap(command) {
  const scanned = scanCommand(command);
  const last = scanned.segments[scanned.segments.length - 1];
  return rewriteCommand(command, [{ class: 'install', start: last.start, end: last.end }], scanned.flags, CLI, (cs) => cs[0]);
}

const runBash = (cmd, env, cwd) => spawnSync(BASH, ['-c', cmd], { encoding: 'utf8', windowsHide: true, env, cwd, timeout: 60000 });

// [name, command]. Every one must print and exit the same wrapped as unwrapped.
const CASES = [
  ['assignment earlier in the line (the incident)', 'M=abc; echo "$M:refs/heads/x"'],
  ['assignment, unquoted refspec', 'M=abc; echo $M:refs/heads/x'],
  ['command substitution then &&', 'M=$(echo abc) && echo "${M}:refs/heads/x"'],
  ['backtick substitution', 'M=`echo bt`; echo "$M"'],
  ['export', 'export ZZ_W=1; echo "z=$ZZ_W"'],
  ['; && || and pipes', 'false || echo "rc=$?"; true && echo ok | tr a-z A-Z; printf "b\\na\\n" | sort | head -1'],
  ['$? after a failure', 'false; echo "status $?"'],
  ['quotes of every kind', `echo 'single $NOPE' "double \\"q\\" $HOME_NOPE_X" $'ansi\\tc' "it's"`],
  ['quoted heredoc', "cat <<'EOF'\nline $NOT here\nEOF\necho after"],
  ['unquoted heredoc sees an earlier assignment', `V=7; cat <<EOF
v=$V
EOF`],
  ['here-string (bash only)', 'V=hs; cat <<< "$V here"'],
  ['backslashes', `printf '%s\\n' 'a\\b' "c\\\\d" e\\ f`],
  ['Windows paths', `echo C:\\\\Work\\\\x 'C:\\Work\\y' "C:\\\\Program Files\\\\z"`],
  ['CRLF line ends', 'echo crlf\r\necho two\r\n'],
  ['a function defined in the line', 'f() { echo "fn $1"; }; f arg'],
  ['exit status', 'echo x; exit 5'],
  ['leading cd stays in the outer shell', 'cd .. && echo "$PWD" && pwd'],
  ['bash arrays', 'a=(one two); echo "${a[1]} ${#a[@]}"'],
  ['a line that starts with a POSIX path', '/usr/bin/env echo direct'],
  ['a first word NAME=/path (env prefix)', 'ZZ_P=/tmp/a printenv ZZ_P'],
  ['a first word NAME=/path (assignment)', 'ZZ_P=/tmp/a:/tmp/b; echo "$ZZ_P"'],
];

test('wrap fidelity: wrapped and unwrapped runs print and exit the same', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const sb = sandbox();
  try {
    const cwd = join(sb.dir, 'work');
    mkdirSync(cwd);
    for (const [name, cmd] of CASES) {
      const wrapped = wrap(cmd);
      assert.notEqual(wrapped, cmd, `${name}: the command was wrapped`);
      const a = runBash(cmd, sb.env, cwd);
      const b = runBash(wrapped, sb.env, cwd);
      assert.equal(b.stdout, a.stdout, `${name}: same output\nwrapped: ${wrapped}\nstderr: ${b.stderr}`);
      assert.equal(b.status, a.status, `${name}: same exit status\nstderr: ${b.stderr}`);
    }
  } finally { sb.cleanup(); }
});

test('wrap fidelity: the incident shape through the real decision, against a fake git', { skip: !HAVE_BASH && 'bash unavailable' }, async () => {
  const sb = sandbox();
  try {
    // A heavy pre-push hook makes the push a push-gate; a fake git prints its argv.
    const repo = join(sb.dir, 'repo');
    const bin = join(sb.dir, 'bin');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    mkdirSync(bin);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nnpm test\n');
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = commit-tree ]; then echo newcommit; exit 0; fi\nfor a in "$@"; do printf "[%s]" "$a"; done; echo\n', { mode: 0o755 });
    // Git for Windows' bash puts /usr/bin first on PATH when it starts, so the fake goes first inside the command line.
    const shBin = process.platform === 'win32' ? bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, dl) => `/${dl.toLowerCase()}`) : bin;
    const cmd = `export PATH='${shBin}':"$PATH"; M=$(git commit-tree HEAD^{tree} -m x) && git push -q origin $M:refs/heads/topic`;
    const d = await gateDecision(cmd, {
      cwd: repo, mode: 'rewrite', env: sb.env,
      rulesInline: { classes: [{ id: 'push-gate', box: 4 }], claudeHome: join(sb.dir, '.claude') },
    });
    assert.equal(d.action, 'rewrite', 'the push is heavy here');
    const a = runBash(cmd, sb.env, repo);
    const b = runBash(d.command, sb.env, repo);
    assert.equal(a.stdout.trim(), '[push][-q][origin][newcommit:refs/heads/topic]', `unwrapped run: ${a.stderr}`);
    assert.equal(b.stdout, a.stdout, `the refspec source survives the wrap\nwrapped: ${d.command}\nstderr: ${b.stderr}`);
  } finally { sb.cleanup(); }
});

// --- run --shell bash ------------------------------------------------------------------

test('run --shell bash: only bash, exactly one argument', async () => {
  const { cli } = await import('../scripts/resource-queue.mjs');
  const errs = [];
  const io = { err: (l) => errs.push(l), env: { ...process.env, RESOURCE_QUEUE: '0' } };
  assert.equal(await cli(['run', '--resource', 'box:1', '--shell', 'zsh', '--', 'echo x'], io), 2);
  assert.equal(await cli(['run', '--resource', 'box:1', '--shell', 'bash', '--', 'echo', 'x'], io), 2);
  assert.ok(errs.some((l) => /exactly one argument/.test(l)));
});

test('run --shell bash: no bash found means the command does not run (no other shell)', async () => {
  const { cli } = await import('../scripts/resource-queue.mjs');
  const errs = []; let spawned = 0;
  const io = { err: (l) => errs.push(l), env: { ...process.env, RESOURCE_QUEUE: '0' }, bashFor: () => null, spawn: () => { spawned += 1; throw new Error('must not spawn'); } };
  assert.equal(await cli(['run', '--resource', 'box:1', '--shell', 'bash', '--', 'echo x'], io), 127);
  assert.equal(spawned, 0);
  assert.ok(errs.some((l) => /no bash found/.test(l)));
});

test('run --shell bash: the command travels in the environment, bash runs it with eval', { skip: !HAVE_BASH && 'bash unavailable' }, async () => {
  const { cli, SHELL_COMMAND_ENV } = await import('../scripts/resource-queue.mjs');
  let seen = null;
  const io = {
    err: () => {}, env: { ...process.env, RESOURCE_QUEUE: '0' }, bashFor: () => BASH,
    spawn: (file, args, opts) => {
      seen = { file, args, cmd: opts.env[SHELL_COMMAND_ENV] };
      return spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    },
  };
  const line = 'M=abc; echo "$M:x" \'q\' C:\\path\r\n';
  assert.equal(await cli(['run', '--resource', 'box:1', '--shell', 'bash', '--', line], io), 0);
  assert.equal(seen.file, BASH);
  assert.deepEqual(seen.args, ['-c', `eval "$${SHELL_COMMAND_ENV}"`]);
  assert.equal(seen.cmd, line, 'byte for byte');
});

test('bashFor: never the System32 or WindowsApps bash (WSL); prefers the usr\\bin bash next to Git bin', { skip: process.platform !== 'win32' && 'Windows paths' }, async () => {
  const { bashFor } = await import('../scripts/resource-queue.mjs');
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe', PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\NoSuchDir' };
  assert.equal(bashFor(env, (p) => /system32/i.test(p)), null);
  const gitEnv = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Tools\\Git\\bin\\bash.exe', PATH: '', ProgramFiles: 'C:\\NoSuchDir' };
  const have = new Set(['C:\\Tools\\Git\\bin\\bash.exe', 'C:\\Tools\\Git\\usr\\bin\\bash.exe']);
  assert.equal(bashFor(gitEnv, (p) => have.has(p)), 'C:\\Tools\\Git\\usr\\bin\\bash.exe');
  assert.equal(bashFor(gitEnv, (p) => p === 'C:\\Tools\\Git\\bin\\bash.exe'), 'C:\\Tools\\Git\\bin\\bash.exe');
});
