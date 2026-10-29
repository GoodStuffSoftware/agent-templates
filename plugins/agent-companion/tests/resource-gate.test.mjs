// Resource gate: the classifier (every must-match and must-not-match example from
// the 2026-10-17 heavy-command research), the rewrite, the four settings modes and
// the hook (composition with the bash-tail rewrite, run for real in bash).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import {
  classifyCommand, scanCommand, wordsOf, rewriteCommand, wrapSegment, wrapLosesCwd, gateDecision, gateMode, gateDisabledByEnv, DEFAULT_GATE_MODE,
} from '../hooks/lib/resource-gate.mjs';

// A pretend file system: a set of existing paths and a map of file contents.
function fakeFs(files = {}, dirs = []) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const have = new Set([...Object.keys(files).map(norm), ...dirs.map(norm)]);
  return { exists: (p) => have.has(norm(p)), read: (p) => { const v = files[Object.keys(files).find((k) => norm(k) === norm(p))]; if (v === undefined) throw new Error('ENOENT'); return v; } };
}
const NOFS = fakeFs();
const CWD = '/work/app';
const classes = (command, fs = NOFS, cwd = CWD) => classifyCommand(command, { cwd, ...fs }).heavy.map((h) => h.class);
const heavy = (c, fs, cwd) => classes(c, fs, cwd).length > 0;

// --- must match ---------------------------------------------------------------

test('classify: E2E full, affected, targeted (the spec path still boots the pool)', () => {
  assert.deepEqual(classes('npm run test:e2e'), ['e2e']);
  assert.deepEqual(classes('npm run test:e2e:affected'), ['e2e']);
  assert.deepEqual(classes('pnpm test:e2e'), ['e2e']);
  assert.deepEqual(classes('npm run test:e2e -- install-*.spec.ts'), ['e2e-spec']);
  assert.deepEqual(classes('npx playwright test e2e/game.spec.ts'), ['e2e-spec']);
  assert.deepEqual(classes('cd e2e && npx playwright test'), ['e2e']);
  assert.deepEqual(classes('node scripts/run-test-e2e.mjs'), ['e2e']);
  assert.deepEqual(classes('node scripts/run-affected-e2e.mjs'), ['e2e']);
});

test('classify: E2E must-not-match list', () => {
  for (const c of [
    'npm run test:e2e:who', 'npx playwright install chromium', 'npx playwright --version', 'grep -rn test:e2e package.json',
    'echo "npm run test:e2e"', 'cat scripts/run-test-e2e.mjs', 'npx playwright test --list', 'npm run test:e2e -- --help',
  ]) assert.equal(heavy(c), false, c);
});

test('classify: vitest FULL is heavy, a targeted run is not (the key false positive)', () => {
  for (const c of ['npx vitest run', 'vitest', 'npx vitest run --coverage', 'npm test', 'npm test -- --reporter=dot', 'cd x && npx vitest run --reporter=verbose',
    'pnpm vitest run', 'yarn vitest', 'npm exec -- vitest run', 'pnpm exec vitest run --reporter dot']) {
    assert.deepEqual(classes(c), ['vitest-full'], c);
  }
  for (const c of [
    'vitest run path/x.test.ts', 'npx vitest run src/a.spec.ts src/b.spec.ts', 'vitest run -t "name"', 'vitest related src/a.ts', 'vitest run --changed',
    'vitest --version', 'vitest --watch', 'grep vitest package.json', 'npm install -D vitest', 'npm ls vitest', 'npx vitest run foo', 'npx vitest run --shard=1/3',
    'npm test -- path/x.test.ts',
  ]) assert.equal(heavy(c), false, c);
});

test('classify: a DIRECTORY positional is medium (vitest-dir), still heavier than a file', () => {
  assert.deepEqual(classes('npx vitest run scripts/__tests__'), ['vitest-dir']);
  assert.deepEqual(classes('npx vitest run src/components/'), ['vitest-dir']);
});

test('classify: npm test follows package.json scripts.test', () => {
  const pkg = (test) => fakeFs({ '/work/app/package.json': JSON.stringify({ scripts: { test } }) });
  assert.deepEqual(classes('npm test', pkg('vitest run')), ['vitest-full']);
  assert.deepEqual(classes('npm test', pkg('vitest run src/a.test.ts')), []);
  assert.deepEqual(classes('npm test -- src/a.test.ts', pkg('vitest run')), []);
  assert.deepEqual(classes('npm test', pkg('node --test')), ['node-test-full']);
  assert.deepEqual(classes('npm test', pkg('jest')), ['vitest-full'], 'a known runner we do not name is a full run');
  assert.deepEqual(classes('npm test', pkg('echo ok')), []);
  assert.deepEqual(classes('npm test', fakeFs({ '/work/app/package.json': '{}' })), [], 'a package without a test script');
  assert.deepEqual(classes('npm test', fakeFs({ '/work/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })), ['vitest-full'], 'package.json is found above the cwd');
});

test('classify: pre-push gate only where a heavy pre-push hook exists', () => {
  const hooked = fakeFs({ '/work/app/.husky/pre-push': '#!/bin/sh', '/work/app/.git': '' });
  assert.deepEqual(classes('git push origin HEAD:main', hooked), ['push-gate']);
  assert.deepEqual(classes('git push -u origin feat/x', hooked), ['push-gate']);
  assert.deepEqual(classes('git -c core.hooksPath=.githooks push', fakeFs({ '/work/app/.githooks/pre-push': 'x', '/work/app/.git': '' })), ['push-gate']);
  assert.deepEqual(classes('git push', fakeFs({ '/work/app/.git': '' })), [], 'no pre-push hook');
  for (const c of ['git push --delete origin x', 'git push --dry-run', 'git push -n', 'git push --tags origin', 'git log --grep push', 'echo git push']) {
    assert.equal(heavy(c, hooked), false, c);
  }
});

test('classify: agent-templates pushes and ci-local pass through (they hold their own lease)', () => {
  const at = fakeFs({ '/work/app/.githooks/pre-push': 'x', '/work/app/scripts/ci-local.mjs': 'x', '/work/app/.git': '' });
  const r = classifyCommand('git -c core.hooksPath=.githooks push', { cwd: CWD, ...at });
  assert.deepEqual(r.heavy, []);
  assert.deepEqual(r.passed, ['ci-local']);
  assert.deepEqual(classifyCommand('node scripts/ci-local.mjs', { cwd: CWD, ...NOFS }).passed, ['ci-local']);
  assert.deepEqual(classifyCommand('node scripts/ci-local.mjs --full', { cwd: CWD, ...NOFS }).heavy, []);
});

test('classify: node --test, lint, emulator, gradle, firebase emulators, installs', () => {
  assert.deepEqual(classes('node --test'), ['node-test-full']);
  assert.deepEqual(classes('node --test --test-concurrency=8 plugins/agent-companion/tests/'), ['node-test-full']);
  assert.equal(heavy('node --test scripts/tests/foo.test.mjs'), false);
  assert.equal(heavy('node --check x.mjs'), false);

  assert.deepEqual(classes('npx eslint .'), ['lint']);
  assert.deepEqual(classes('tsc --noEmit'), ['lint']);
  assert.deepEqual(classes('npx vue-tsc --noEmit'), ['lint']);
  assert.deepEqual(classes('npm run lint'), ['lint']);
  assert.deepEqual(classes('pnpm typecheck'), ['lint']);
  assert.deepEqual(classes('biome check .'), ['lint']);
  for (const c of ['eslint src/a.ts', 'npx eslint src/a.ts src/b.vue', 'tsc --version', 'tsc --help']) assert.equal(heavy(c), false, c);

  assert.deepEqual(classes('emulator -avd app-native-check -no-window'), ['emulator']);
  assert.deepEqual(classes('emulator @Pixel_7'), ['emulator']);
  for (const c of ['emulator -list-avds', 'adb devices', 'adb emulators', 'echo emulator']) assert.equal(heavy(c), false, c);

  assert.deepEqual(classes('./gradlew assembleDebug'), ['gradle']);
  assert.deepEqual(classes('gradlew.bat bundleRelease'), ['gradle']);
  assert.deepEqual(classes('npm run build:apk:dev'), ['gradle']);
  assert.deepEqual(classes('npx cap sync android'), ['gradle']);
  for (const c of ['./gradlew --stop', './gradlew --version', 'gradle tasks']) assert.equal(heavy(c), false, c);

  assert.deepEqual(classes('npx firebase emulators:start'), ['fs-emulator']);
  assert.deepEqual(classes('firebase emulators:exec "npm test"'), ['fs-emulator']);
  for (const c of ['firebase deploy', 'firebase emulators:export out']) assert.equal(heavy(c), false, c);

  assert.deepEqual(classes('npm ci'), ['install']);
  assert.deepEqual(classes('npm ci --prefer-offline'), ['install']);
  assert.deepEqual(classes('npm install'), ['install']);
  assert.deepEqual(classes('pnpm install --frozen-lockfile'), ['install']);
  assert.deepEqual(classes('yarn'), ['install']);
  for (const c of ['npm install -g foo', 'npm install lodash', 'npm ls', 'npm view x version', 'npm config get registry', 'yarn add foo']) assert.equal(heavy(c), false, c);
});

// --- structure: segments, quotes, shells, prefixes ---------------------------------

test('classify: text inside quotes and heredoc bodies is not a command', () => {
  for (const c of [
    'echo "npm ci"', "echo 'npx vitest run'", 'grep -r "vitest run" src', 'git commit -m "run vitest and npm ci"',
    'printf "%s\\n" "npm run test:e2e"', "cat <<'EOF'\nnpm test\nnpx vitest run\nEOF", 'cat <<EOF > notes.txt\nnpm ci\nEOF\nls',
  ]) assert.equal(heavy(c), false, c);
  // ...but the command after the heredoc is
  assert.deepEqual(classes(['cat <<EOF', 'npm ci', 'EOF', 'npx vitest run'].join('\n')), ['vitest-full']);
});

test('classify: each shell segment is classified on its own', () => {
  assert.deepEqual(classes('cd app && npx vitest run && npm run lint'), ['vitest-full', 'lint']);
  assert.deepEqual(classes('echo start; npm ci; echo done'), ['install']);
  assert.deepEqual(classes('npx vitest run | tail -5'), ['vitest-full']);
  assert.deepEqual(classes('npx vitest run 2>&1 | tee out.txt'), ['vitest-full']);
  assert.deepEqual(classes('npx vitest run > out.txt 2>&1'), ['vitest-full']);
  assert.deepEqual(classes('npm test &'), ['vitest-full']);
  assert.deepEqual(classes('FOO=1 BAR="a b" npx vitest run'), ['vitest-full']);
  assert.deepEqual(classes('time nohup npx vitest run'), ['vitest-full']);
  assert.deepEqual(classes('env CI=1 npm run test:e2e'), ['e2e']);
  assert.deepEqual(classes('cross-env NODE_ENV=test npx vitest run'), ['vitest-full']);
  assert.deepEqual(classes('timeout 600 npm ci'), ['install']);
});

test('classify: looks inside bash -c, sh -c, cmd /c and powershell -Command', () => {
  assert.deepEqual(classes('bash -c "cd x && npx vitest run"'), ['vitest-full']);
  assert.deepEqual(classes("bash -lc 'npm ci'"), ['install']);
  assert.deepEqual(classes('sh -c "npm run test:e2e"'), ['e2e']);
  assert.deepEqual(classes('cmd //c "npm ci"'), ['install']);
  assert.deepEqual(classes('cmd /c start /b npm ci'), ['install']);
  assert.deepEqual(classes('powershell -Command "npm run test:e2e"'), ['e2e']);
  assert.equal(heavy('bash -c "echo hi"'), false);
  assert.equal(heavy('bash script.sh'), false);
});

test('classify: a command already in the queue passes through, inner command unexamined', () => {
  const q = "node 'C:/Users/me/.claude/agent-companion/bin/resource-queue.mjs' run --class vitest-full --label vitest-full -- 'npx vitest run'";
  const r = classifyCommand(q, { cwd: CWD, ...NOFS });
  assert.deepEqual(r.heavy, []);
  assert.deepEqual(r.passed, ['wrapped']);
  for (const c of [
    'node scripts/resource-queue.mjs run --resource box:8 -- npm test',
    'node plugins/agent-companion/scripts/ci-budget.mjs run --resource box:4 -- npx vitest run',
  ]) assert.deepEqual(classifyCommand(c, { cwd: CWD, ...NOFS }).heavy, [], c);
  // a different command after a wrapped one is still examined
  assert.deepEqual(classes(`${q} && npm ci`), ['install']);
});

test('classify: RESOURCE_QUEUE=0 in front of a segment skips that segment only', () => {
  assert.equal(heavy('RESOURCE_QUEUE=0 npm test'), false);
  assert.equal(heavy('env RESOURCE_QUEUE=0 npx vitest run'), false);
  assert.deepEqual(classes('RESOURCE_QUEUE=0 npm test && npm ci'), ['install']);
});

test('scanCommand: offsets, quotes, comments, substitution and groups', () => {
  const c = 'cd "a && b" && npm ci # not && this';
  const { segments } = scanCommand(c);
  assert.deepEqual(segments.map((s) => s.text.trim()), ['cd "a && b"', 'npm ci']);
  assert.equal(c.slice(segments[1].start, segments[1].end).trim(), 'npm ci');
  assert.deepEqual(scanCommand('echo $(npm ci; ls) && ls').segments.map((s) => s.text.trim()), ['echo $(npm ci; ls)', 'ls']);
  assert.ok(scanCommand('(cd x && npm ci)').flags.has('group'));
  assert.ok(scanCommand('cat <<EOF\nx\nEOF').flags.has('heredoc'));
  assert.deepEqual(wordsOf(`npx vitest run 'a b' "c d" > out 2>&1`), ['npx', 'vitest', 'run', 'a b', 'c d']);
});

// --- rewriting ------------------------------------------------------------------

const LAUNCHER = 'C:/Users/me/.claude/agent-companion/bin/resource-queue.mjs';
const rewrite = (command, fs = NOFS) => {
  const f = classifyCommand(command, { cwd: CWD, ...fs });
  return rewriteCommand(command, f.heavy, f.flags, LAUNCHER, (cs) => cs[0]);
};

test('rewrite: the whole line is wrapped unchanged; only a leading cd stays outside', () => {
  assert.equal(rewrite('cd app && npx vitest run'), `cd app && ${wrapSegment('npx vitest run', 'vitest-full', LAUNCHER)}`);
  assert.equal(rewrite('npx vitest run | tail -5'), wrapSegment('npx vitest run | tail -5', 'vitest-full', LAUNCHER));
  assert.equal(rewrite('npm ci && npx vitest run'), wrapSegment('npm ci && npx vitest run', 'install', LAUNCHER), 'one wrap, the first heavy class (the caller picks the heaviest)');
  assert.equal(rewrite('npm test &'), wrapSegment('npm test &', 'vitest-full', LAUNCHER));
  assert.equal(rewrite('M=1; npm ci'), wrapSegment('M=1; npm ci', 'install', LAUNCHER), 'an assignment before the heavy segment goes in with it');
  assert.equal(rewrite('cd $D && npm ci'), wrapSegment('cd $D && npm ci', 'install', LAUNCHER), 'a cd with an expansion is not hoisted');
  assert.equal(rewrite('echo hi'), 'echo hi');
});

test('rewrite: wrapLosesCwd flags a directory change inside the wrapped part only', () => {
  assert.equal(wrapLosesCwd('cd app && npm ci'), false);
  assert.equal(wrapLosesCwd('npm ci && cd app'), true);
  assert.equal(wrapLosesCwd('cd a && npm ci; pushd b'), true);
  assert.equal(wrapLosesCwd('npm ci'), false);
});

test('decision: rewrite mode denies, with the reason, a line whose directory change would not last', async () => {
  const d = await dec('npm ci && cd sub', { mode: 'rewrite' });
  assert.equal(d.action, 'deny');
  assert.match(d.text, /changes directory/);
  assert.equal((await dec('cd sub && npm ci', { mode: 'rewrite' })).action, 'rewrite');
});

test('classify: a push with --no-verify skips the pre-push hook, so it is not heavy', () => {
  const fs = fakeFs({ '/work/app/.git/hooks/pre-push': '#!/bin/sh\nnpm test\n' }, ['/work/app/.git']);
  assert.equal(heavy('git push origin main', fs), true);
  assert.equal(heavy('git push -q --no-verify origin main', fs), false);
});

test('rewrite: a heredoc or a group is wrapped as one whole command', () => {
  const c = '(cd x && npm ci)';
  assert.equal(rewrite(c), wrapSegment(c, 'install', LAUNCHER));
});

const HAVE_BASH = spawnSync('bash', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
// The gate runs the suites without node's directory on PATH; the real-bash tests below need `node` there.
const NODE_PATH = `${dirname(process.execPath).split('\\').join('/')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
const BASH = (() => {
  const gb = 'C:\\Program Files\\Git\\bin\\bash.exe';
  return process.platform === 'win32' && existsSync(gb) ? gb : 'bash';
})();

test('rewrite: quotes, spaces and metacharacters survive as exactly one argument', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const fx = makeFixture();
  try {
    // A stand-in launcher that prints the argv it received as JSON.
    const stub = join(fx.dir, 'stub-queue.mjs');
    writeFileSync(stub, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    for (const cmd of [`FOO='a b' npx vitest run --reporter="dot"`, `FOO="it's" npx vitest run`, 'npx eslint "src/**/*.ts" .']) {
      const f = classifyCommand(cmd, { cwd: CWD, ...NOFS });
      assert.ok(f.heavy.length, cmd);
      const out = rewriteCommand(cmd, f.heavy, f.flags, stub.replace(/\\/g, '/'), (cs) => cs[0]);
      const r = spawnSync(BASH, ['-c', out], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: NODE_PATH } });
      assert.equal(r.status, 0, r.stderr);
      const argv = JSON.parse(r.stdout.trim());
      assert.deepEqual(argv.slice(0, 7), ['run', '--class', f.heavy[0].class, '--label', f.heavy[0].class, '--shell', 'bash']);
      assert.equal(argv[7], '--');
      assert.equal(argv[8].replace(/^\n/, ''), cmd, 'the command line arrives byte for byte as one argument (after a guard newline)');
    }
  } finally { fx.cleanup(); }
});

// --- the setting and the decision --------------------------------------------------

test('setting: names, default deny, unknown values fall back to the default', () => {
  assert.equal(DEFAULT_GATE_MODE, 'deny');
  for (const m of ['rewrite', 'deny', 'hint', 'off']) assert.equal(gateMode(m), m);
  assert.equal(gateMode('REWRITE'), 'rewrite');
  assert.equal(gateMode(undefined), 'deny');
  assert.equal(gateMode('nonsense'), 'deny');
  const pj = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(pj.resource_gate.default, 'deny');
  assert.equal(pj.resource_gate_permission_modes.default, 'bypassPermissions');
  assert.equal(pj.shared_resources_line.default, true);
});

test('env: RESOURCE_QUEUE=0 and a live lease token switch the gate off', () => {
  assert.equal(gateDisabledByEnv({ RESOURCE_QUEUE: '0' }), true);
  assert.equal(gateDisabledByEnv({ AC_RESOURCE_LEASE: 'abc' }), true);
  assert.equal(gateDisabledByEnv({ RESOURCE_QUEUE: '1' }), false);
  assert.equal(gateDisabledByEnv({}), false);
});

test('cloud: CLAUDE_CODE_REMOTE=true switches the gate off; any other value leaves it on', () => {
  assert.equal(gateDisabledByEnv({ CLAUDE_CODE_REMOTE: 'true' }), true);
  assert.equal(gateDisabledByEnv({ CLAUDE_CODE_REMOTE: 'TRUE' }), true);
  for (const v of ['', '0', 'false', '1', 'yes']) assert.equal(gateDisabledByEnv({ CLAUDE_CODE_REMOTE: v }), false, v);
  assert.equal(gateDisabledByEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: 'x' }), false, 'the session id alone is not the cloud flag');
});

const dec = (command, opts = {}) => gateDecision(command, { cwd: CWD, env: { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home' }, ...NOFS, ...opts });

test('decision: deny names the exact wrapped command and suggests run_in_background for a full suite', async () => {
  const d = await dec('cd app && npx vitest run', { mode: 'deny' });
  assert.equal(d.action, 'deny');
  assert.deepEqual(d.classes, ['vitest-full']);
  assert.match(d.text, /^cd app && node '.*resource-queue\.mjs' run --class vitest-full --label vitest-full --shell bash -- 'npx vitest run'$/m, 'the exact command is on a line of its own');
  assert.match(d.text, /run_in_background: true/);
  assert.match(d.text, /10-minute foreground limit/);
  const lint = await dec('npx eslint .', { mode: 'deny' });
  assert.equal(lint.action, 'deny');
  assert.doesNotMatch(lint.text, /run_in_background/, 'a quick class does not get the background advice');
});

test('decision: rewrite returns the wrapped command; hint returns text and no command change; off and not-heavy do nothing', async () => {
  const rw = await dec('npm ci', { mode: 'rewrite' });
  assert.equal(rw.action, 'rewrite');
  assert.match(rw.command, /^node '.*resource-queue\.mjs' run --class install --label install --shell bash -- 'npm ci'$/);
  const h = await dec('npm ci', { mode: 'hint' });
  assert.equal(h.action, 'hint');
  assert.match(h.text, /resource-queue\.mjs/);
  assert.equal((await dec('npm ci', { mode: 'off' })).action, 'none');
  assert.equal((await dec('ls -la', { mode: 'deny' })).action, 'none');
  assert.equal((await dec('npx vitest run src/a.test.ts', { mode: 'deny' })).action, 'none');
  assert.equal((await dec('npm ci', { mode: 'deny', env: { RESOURCE_QUEUE: '0' } })).action, 'none');
  assert.equal((await dec('npm ci', { mode: 'deny', env: { AC_RESOURCE_LEASE: 'x' } })).action, 'none');
});

test('decision: in a cloud session a heavy command passes untouched in every mode; locally it is still gated', async () => {
  const cloud = { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home', CLAUDE_CODE_REMOTE: 'true' };
  for (const mode of ['deny', 'rewrite', 'hint']) {
    for (const c of ['npm ci', 'npx vitest run', 'cd app && npm ci && node scripts/digest.mjs']) {
      assert.deepEqual(await dec(c, { mode, env: cloud }), { action: 'none', classes: [] }, `${mode}: ${c}`);
    }
  }
  const local = { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home', CLAUDE_CODE_REMOTE: 'false' };
  assert.equal((await dec('npm ci', { mode: 'deny', env: local })).action, 'deny');
  assert.equal((await dec('npm ci', { mode: 'deny', env: { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home' } })).action, 'deny');
});

test('decision: rewrite that is not allowed (mode or permission rule) becomes a deny with the same command', async () => {
  const d = await dec('npm ci', { mode: 'rewrite', rewriteAllowed: false });
  assert.equal(d.action, 'deny');
  assert.match(d.text, /not run \(rewrite does not apply/);
  assert.match(d.text, /resource-queue\.mjs/);
});

test('decision: a class the user turned off (box 0) is not heavy', async () => {
  const rules = { classes: [{ id: 'install', box: 0 }, { id: 'lint', box: 3 }], claudeHome: '/nonexistent-home' };
  assert.equal((await dec('npm ci', { mode: 'deny', rulesInline: rules })).action, 'none');
  assert.equal((await dec('npx eslint .', { mode: 'deny', rulesInline: rules })).action, 'deny');
});

test('decision: fails open on garbage', async () => {
  for (const c of [undefined, null, '', '   ', 5, '"unterminated', 'a && && b', '((((']) {
    const d = await gateDecision(c, { cwd: CWD, mode: 'deny' });
    assert.ok(['none', 'deny'].includes(d.action));
  }
});

// --- the hook -----------------------------------------------------------------

const pl = (command, extra = {}, input = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-gate', tool_name: 'Bash',
  tool_input: { command, ...input }, permission_mode: 'bypassPermissions', ...extra,
});
const env = (fx, extra = {}) => ({ AGENT_COMPANION_BASH_TAIL_DIR: join(fx.dir, 'tail-out'), CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'deny', ...extra });
const gateRows = (fx) => readJsonl(join(fx.stateDir, 'telemetry', 'resource-gate.jsonl'));

test('hook: default setting is deny and the reason carries the wrapped command', () => {
  const fx = makeFixture();
  try {
    // no setting passed: the shipped default applies (the test helper's off is overridden to unset)
    const r = runHook('hooks/bash-tail.mjs', pl('npx vitest run'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: '' }) });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /resource-queue\.mjs' run --class vitest-full/);
    assert.equal(r.json.hookSpecificOutput.updatedInput, undefined);
    const rows = gateRows(fx);
    assert.equal(rows[0].event, 'denied');
    assert.deepEqual(rows[0].classes, ['vitest-full']);
    assert.ok(!JSON.stringify(rows).includes('npx vitest'), 'the command text is never logged');
  } finally { fx.cleanup(); }
});

test('hook: deny also works for a subagent and ignores the permission mode', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', pl('npm ci', { agent_id: 'agent-9', permission_mode: 'default' }), { env: env(fx) });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('hook: rewrite copies timeout, run_in_background and description unchanged and sets no permissionDecision', () => {
  const fx = makeFixture();
  try {
    const input = { description: 'install deps', timeout: 123000, run_in_background: true };
    const r = runHook('hooks/bash-tail.mjs', pl('npm ci', {}, input), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' }) });
    const out = r.json.hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined);
    assert.equal(out.updatedInput.description, 'install deps');
    assert.equal(out.updatedInput.timeout, 123000);
    assert.equal(out.updatedInput.run_in_background, true);
    assert.match(out.updatedInput.command, /^node '.*resource-queue\.mjs' run --class install --label install --shell bash -- 'npm ci'$/);
    assert.equal(gateRows(fx)[0].event, 'rewritten');
  } finally { fx.cleanup(); }
});

test('hook: rewrite outside the allowed permission modes denies; "any" lifts the limit', () => {
  const fx = makeFixture();
  try {
    const e = env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' });
    const d = runHook('hooks/bash-tail.mjs', pl('npm ci', { permission_mode: 'default' }), { env: e });
    assert.equal(d.json.hookSpecificOutput.permissionDecision, 'deny');
    const any = runHook('hooks/bash-tail.mjs', pl('npm ci', { permission_mode: 'default' }), { env: { ...e, CLAUDE_PLUGIN_OPTION_RESOURCE_GATE_PERMISSION_MODES: 'any' } });
    assert.ok(any.json.hookSpecificOutput.updatedInput.command.includes('resource-queue.mjs'));
  } finally { fx.cleanup(); }
});

test('hook: a deny rule that could match the original blocks the rewrite (it must not step around Bash(npm ci:*))', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'proj');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(npm ci:*)'] } }));
    const r = runHook('hooks/bash-tail.mjs', pl('npm ci', { cwd: proj }), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' }) });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /rewrite does not apply/);
  } finally { fx.cleanup(); }
});

test('hook: hint adds context and changes nothing; off prints nothing', () => {
  const fx = makeFixture();
  try {
    const h = runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'hint', CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0' }) });
    const out = h.json.hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined);
    assert.equal(out.updatedInput, undefined);
    assert.match(out.additionalContext, /resource-queue\.mjs/);
    const off = runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'off', CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0' }) });
    assert.equal(off.json, null);
  } finally { fx.cleanup(); }
});

test('hook: in a cloud session (CLAUDE_CODE_REMOTE=true) a heavy install passes through in deny, rewrite and hint; locally it is still denied', () => {
  const fx = makeFixture();
  try {
    for (const mode of ['deny', 'rewrite', 'hint']) {
      const e = env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: mode, CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0', CLAUDE_CODE_REMOTE: 'true' });
      const r = runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: e });
      assert.equal(r.status, 0, mode);
      assert.equal(r.json, null, `${mode}: no decision, no rewrite, no message`);
    }
    assert.deepEqual(gateRows(fx), [], 'the gate logged nothing');
    const local = runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0', CLAUDE_CODE_REMOTE: 'false' }) });
    assert.equal(local.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(local.json.hookSpecificOutput.permissionDecisionReason, /resource-queue\.mjs/);
  } finally { fx.cleanup(); }
});

test('hook: never touches a command that is not heavy, one already queued, ci-local, or an opt-out', () => {
  const fx = makeFixture();
  try {
    const e = env(fx, { CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0' });
    for (const c of [
      'ls -la', 'git status', 'npx vitest run src/a.test.ts', 'echo "npm ci"', 'node scripts/ci-local.mjs',
      "node 'C:/x/resource-queue.mjs' run --class install -- 'npm ci'", 'RESOURCE_QUEUE=0 npm ci', 'npm install lodash',
    ]) {
      const r = runHook('hooks/bash-tail.mjs', pl(c), { env: e });
      assert.equal(r.json, null, c);
    }
    assert.equal(runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: { ...e, RESOURCE_QUEUE: '0' } }).json, null, 'RESOURCE_QUEUE=0 in the environment');
    assert.equal(runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: { ...e, AC_RESOURCE_LEASE: 'lease-1' } }).json, null, 'nested inside a queued run');
    assert.equal(runHook('hooks/bash-tail.mjs', pl('npm ci', { session_id: 'served:abc' }), { env: e }).json, null, 'a served (remote) call');
    assert.equal(runHook('hooks/bash-tail.mjs', { ...pl('npm ci'), tool_name: 'Read' }, { env: e }).json, null);
  } finally { fx.cleanup(); }
});

// --- composition with the bash-tail rewrite --------------------------------------

test('compose: gate rewrite and output tail both survive in ONE updatedInput', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-tail.mjs', pl('cd app && npm ci', {}, { description: 'd', timeout: 5000 }), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' }) });
    const u = r.json.hookSpecificOutput.updatedInput;
    assert.ok(u.command.includes('[ac-bash-tail]'), 'the output tail wrapped the command');
    assert.match(u.command, /cd app && node '.*resource-queue\.mjs' run --class install --label install --shell bash -- 'npm ci'/, 'the gate wrapped the line after its leading cd, inside the tail wrapper');
    assert.equal(u.description, 'd');
    assert.equal(u.timeout, 5000);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(readJsonl(join(fx.stateDir, 'telemetry', 'bash-tail.jsonl'))[0].event, 'wrapped');
    assert.equal(gateRows(fx)[0].event, 'rewritten');
  } finally { fx.cleanup(); }
});

test('compose: with the tail off, or a background run, only the gate rewrite is applied', () => {
  const fx = makeFixture();
  try {
    const e = env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' });
    const noTail = runHook('hooks/bash-tail.mjs', pl('npm ci'), { env: { ...e, CLAUDE_PLUGIN_OPTION_BASH_TAIL: '0' } });
    assert.ok(!noTail.json.hookSpecificOutput.updatedInput.command.includes('[ac-bash-tail]'));
    assert.ok(noTail.json.hookSpecificOutput.updatedInput.command.includes('resource-queue.mjs'));
    const bg = runHook('hooks/bash-tail.mjs', pl('npm ci', {}, { run_in_background: true }), { env: e });
    assert.ok(!bg.json.hookSpecificOutput.updatedInput.command.includes('[ac-bash-tail]'), 'a background command is not tailed');
    assert.equal(bg.json.hookSpecificOutput.updatedInput.run_in_background, true);
    assert.ok(bg.json.hookSpecificOutput.updatedInput.command.includes('resource-queue.mjs'));
    const piped = runHook('hooks/bash-tail.mjs', pl('npm ci | tail -2'), { env: e });
    assert.match(piped.json.hookSpecificOutput.updatedInput.command, /--shell bash -- 'npm ci \| tail -2'$/, 'piped: tail declines, the gate wraps the whole line');
  } finally { fx.cleanup(); }
});

test('compose: a command that is only tail-eligible is rewritten exactly as before (gate has no effect)', () => {
  const fx = makeFixture();
  try {
    const off = runHook('hooks/bash-tail.mjs', pl('pytest -x'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' }) });
    const base = runHook('hooks/bash-tail.mjs', pl('pytest -x'), { env: env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'off' }) });
    assert.ok(off.json.hookSpecificOutput.updatedInput.command.includes('[ac-bash-tail]'));
    assert.ok(!off.json.hookSpecificOutput.updatedInput.command.includes('resource-queue'));
    assert.equal(off.json.hookSpecificOutput.additionalContext, undefined);
    assert.equal(base.json.hookSpecificOutput.updatedInput.command.includes('[ac-bash-tail]'), true);
  } finally { fx.cleanup(); }
});

test('compose: the rewritten command, run in real bash through the real queue, keeps the exit code and leaves the ledger empty', { skip: !HAVE_BASH && 'bash unavailable' }, () => {
  const fx = makeFixture();
  try {
    const bin = join(fx.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nseq 1 300\necho BUILD-BROKE >&2\nexit 7\n', { mode: 0o755 });
    const ledger = join(fx.dir, 'ledger');
    const lock = join(fx.dir, 'lock');
    const hookEnv = env(fx, { CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' });
    const r = runHook('hooks/bash-tail.mjs', pl('npm test'), { env: hookEnv });
    const cmd = r.json.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes('[ac-bash-tail]') && cmd.includes('resource-queue.mjs'));
    const sep = process.platform === 'win32' ? ';' : ':';
    const w = spawnSync(BASH, ['-c', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: {
        ...process.env, PATH: `${bin.replace(/\\/g, '/')}${sep}${NODE_PATH}`, CI_BUDGET_DIR: ledger, CI_LOCAL_LOCK_DIR: lock,
        AGENT_COMPANION_HOME_OVERRIDE: fx.dir, CLAUDE_CONFIG_DIR: join(fx.dir, '.claude'),
      },
    });
    assert.equal(w.status, 7, `exit code passes through both wrappers: ${w.stderr}`);
    assert.ok(w.stdout.includes('BUILD-BROKE'), 'the failing output reached the tail');
    const leftovers = existsSync(ledger) ? readdirSync(ledger).filter((f) => /^(lease|ticket)-/.test(f) && !/\.(act|cleared)$/.test(f)) : [];
    assert.deepEqual(leftovers, [], 'the lease was released when the command exited');
  } finally { fx.cleanup(); }
});

// --- cost ------------------------------------------------------------------------

test('cost: classifying a plain command is far below a millisecond', async () => {
  const cmds = ['ls -la', 'git status', 'cd app && git diff --stat', 'node script.mjs', 'echo hello world', 'cat package.json | head -5', 'grep -rn "foo" src'];
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i += 1) for (const c of cmds) classifyCommand(c, { cwd: CWD, ...NOFS });
  const per = (performance.now() - t0) / (N * cmds.length);
  assert.ok(per < 0.5, `${per.toFixed(4)} ms per command`);
});
