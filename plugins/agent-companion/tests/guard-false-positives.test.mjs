// 0.31.25 review fixes: false positives of the resource gate and the guards.
// The pure checks run in-process; nothing here spawns a hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { classifyCommand } from '../hooks/lib/resource-gate.mjs';
import { processGuardHits } from '../hooks/lib/process-kill-guard.mjs';
import { envDumpHits, envDumpGuard } from '../hooks/lib/env-dump-guard.mjs';

const NL = '\n';

// A pretend file system: a set of existing paths and a map of file contents.
function fakeFs(files = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const have = new Set(Object.keys(files).map(norm));
  return {
    exists: (p) => have.has(norm(p)),
    read: (p) => { const k = Object.keys(files).find((x) => norm(x) === norm(p)); if (k === undefined) throw new Error('ENOENT'); return files[k]; },
  };
}
const classes = (command, fs = fakeFs()) => classifyCommand(command, { cwd: '/work/app', ...fs }).heavy.map((h) => h.class);

// --- resource gate -------------------------------------------------------------------------------

test('gate: a pre-push hook that only runs git-lfs or echoes is light, an unknown hook stays heavy', () => {
  const at = (body) => fakeFs({ '/work/app/.git/hooks/pre-push': body, '/work/app/.git': '' });
  assert.deepEqual(classes('git push', at(['#!/bin/sh', 'command -v git-lfs >/dev/null 2>&1 || { echo >&2 "no lfs"; exit 2; }', 'git lfs pre-push "$@"', ''].join(NL))), []);
  assert.deepEqual(classes('git push', at(['#!/bin/sh', '. "$(dirname "$0")/_/husky.sh"', 'echo ok', ''].join(NL))), []);
  assert.deepEqual(classes('git push', at('#!/bin/sh\nnpm test\n')), ['push-gate']);
  assert.deepEqual(classes('git push', at('#!/bin/sh\ngit lfs pre-push "$@"\nnpm run lint\n')), ['push-gate']);
  assert.deepEqual(classes('git push', at('#!/bin/sh\n')), ['push-gate'], 'an empty body is not known to be light');
});

test('gate: quotes inside a commit-message heredoc are data', () => {
  const msgs = [
    ['fix: run "npm ci && npm test --silent" in CI'],
    ['fix 5" bug', 'npm test'],
    ["it's (not) fine :)", 'vitest'],
  ];
  for (const lines of msgs) {
    const c = `git commit -m "$(cat <<'EOF'${NL}${lines.join(NL)}${NL}EOF${NL})"`;
    assert.deepEqual(classes(c), [], c);
  }
  const pkg = fakeFs({ '/work/app/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
  assert.deepEqual(classes(`echo "$(cat <<'EOF'${NL}x${NL}EOF${NL})" && npm test`, pkg), ['vitest-full']);
});

// --- kill-by-name and plugin-uninstall guards -----------------------------------------------------

test('kill guard: an odd apostrophe count with backticked words in a commit heredoc is data', () => {
  for (const word of ['env', 'set', 'export', 'printenv', 'pkill node', 'taskkill /IM node.exe', 'claude plugin uninstall x']) {
    const cmd = `git commit -m "$(cat <<'EOF'${NL}fix: don't crash when \`${word}\` is empty${NL}EOF${NL})"`;
    const h = processGuardHits(cmd, 'bash');
    assert.ok(!h.kill, word);
    assert.ok(!h.uninstall, word);
    assert.equal(envDumpHits(cmd, 'bash').env, null, word);
  }
  // the heredoc ends at its terminator: a kill after it is still seen
  assert.ok(processGuardHits(`echo "$(cat <<'EOF'${NL}it's here${NL}EOF${NL})" && pkill node`, 'bash').kill);
});

test('plugin uninstall: a project\'s own cli.js is not the claude CLI', () => {
  const un = (c) => processGuardHits(c, 'bash').uninstall;
  assert.ok(!un('node cli.js plugin remove foo'));
  assert.ok(!un('node ./tools/cli.js plugin rm foo'));
  assert.ok(un('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js plugin uninstall x'));
  assert.ok(un('claude plugin uninstall x'));
});

// --- env-dump guard -------------------------------------------------------------------------------

test('env guard: a secret piped into a consumer (stdin login idioms) is not a print', () => {
  const hit = (c) => envDumpHits(c, 'bash').env;
  for (const c of [
    'echo "$GITHUB_TOKEN" | gh auth login --with-token',
    'echo $DOCKER_PASSWORD | docker login -u u --password-stdin',
    "printf '%s' \"$NPM_TOKEN\" | npm login",
  ]) assert.equal(hit(c), null, c);
  for (const c of ['echo $GITHUB_TOKEN | tee out.txt', 'echo $GITHUB_TOKEN | cat', 'echo $GITHUB_TOKEN | sed s/a/b/', 'echo $GITHUB_TOKEN', 'echo $GITHUB_TOKEN | base64']) {
    assert.ok(hit(c), c);
  }
});

test('env guard: the recorded detail is the kind and the program only, never an inline literal', () => {
  const run = (command) => envDumpGuard({ tool_name: 'Bash', tool_input: { command } }, {});
  const a = run('env API_KEY=sk-live-abc123 | grep API');
  assert.ok(a);
  assert.ok(!/sk-live|abc123|API_KEY/.test(a.detail), a.detail);
  const b = run('echo ghp_abcdefghijklmnopqrstuvwxyz0123456789 $API_KEY');
  assert.ok(b);
  assert.ok(!/ghp_/.test(b.detail), b.detail);
});
