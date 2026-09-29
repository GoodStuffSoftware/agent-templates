// The plugin folder as claude.ai packages it.
//
// claude.ai registers a plugin by packaging its folder, and refuses the
// package unless it holds exactly ONE `.claude-plugin/plugin.json` ("plugin.json
// must be at .claude-plugin/plugin.json at the zip root (or inside a single
// top-level directory)"). It also refuses a plugin with a top-level `bin/`.
// Claude Code itself and `claude plugin validate` accept both shapes, so
// nothing else in the suite notices: a benchmark fixture that shipped its own
// manifest (bench/fixtures/real-opt-fallback/src/.claude-plugin/plugin.json,
// added 2026-09-23) kept the plugin out of claude.ai while every check here
// stayed green. The fixture now keeps that file under a non-manifest name and
// the task's setup() writes it into the sandbox.
//
// The file set is git's committable set (tracked, plus untracked files that
// are not ignored), the same enumeration scripts/leak-check.mjs uses for
// "what could ship": a gitignored local file can neither fail this test nor
// hide from it by being ignored, and an untracked file that a commit would
// pick up is caught before it is committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PLUGIN_ROOT } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

// Paths relative to PLUGIN_ROOT, `/`-separated. -z: no quoting of unusual
// names. cleanGitEnv(): under the pre-push hook GIT_DIR is exported, and in
// --ci-parity mode it names the ORIGINAL repository, not the clone under test.
function pluginFiles() {
  const out = execFileSync(
    'git',
    ['-C', PLUGIN_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
    { encoding: 'utf8', windowsHide: true, env: cleanGitEnv(), maxBuffer: 64 * 1024 * 1024 },
  );
  const files = out.split('\0').filter(Boolean);
  // An empty or tiny listing means git answered for some other directory, not
  // that the plugin is clean.
  assert.ok(files.length > 50, `expected the plugin's full file list from git, got ${files.length} path(s)`);
  return files;
}

test('the plugin ships exactly one .claude-plugin/plugin.json, at its root', () => {
  const manifests = pluginFiles().filter((f) => /(^|\/)\.claude-plugin\/plugin\.json$/i.test(f));
  assert.deepEqual(
    manifests,
    ['.claude-plugin/plugin.json'],
    'claude.ai refuses a plugin package holding more than one .claude-plugin/plugin.json. '
      + 'Keep a fixture manifest under another name and write it into the sandbox at setup() time '
      + '(see bench/tasks/real-opt-fallback.mjs).',
  );
});

test('the plugin has no top-level bin/ directory', () => {
  const bin = pluginFiles().filter((f) => /^bin\//i.test(f));
  assert.deepEqual(bin, [], 'claude.ai refuses a plugin with a top-level bin/ directory');
});
