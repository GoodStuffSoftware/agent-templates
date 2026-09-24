// bench/tasks/common.mjs runNodeTest() runs a task's hidden tests with a
// nested `node --test`. Those hidden tests (frozen fixtures, e.g.
// real-publication-sweep's) build throwaway repositories with `git init`,
// `config` and `commit` and pass their env straight through. Under a git
// hook, which exports GIT_DIR, every one of those commands would act on the
// CALLER's repository. runNodeTest must hand its child an env without the
// repo-locating GIT_* variables.
//
// The runner is driven from a child process, so GIT_* is only ever set on a
// child and never on this test process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

const COMMON = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'tasks', 'common.mjs');

// No auto-maintenance/gc: a recent git detaches `maintenance run --auto`
// after a commit, and its transient objects/maintenance.lock (or a repack)
// races hashTree() below. Seen on the Linux CI runner.
const NO_AUTO_MAINT = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

function git(args, cwd) {
  const r = spawnSync('git', [...NO_AUTO_MAINT, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function hashTree(dir, out = {}, base = dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { out[p.slice(base.length)] = 'LINK'; continue; }
    if (st.isDirectory()) { hashTree(p, out, base); continue; }
    out[p.slice(base.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}

// A hidden test shaped like the frozen fixtures': env passed straight through.
const HIDDEN_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
test('hidden test builds its own repository', () => {
  const repo = join(process.cwd(), 'scratch-repo');
  mkdirSync(repo, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: process.env });
  g(['init', '-q', '-b', 'main', repo]);
  g(['-C', repo, 'config', 'user.name', 'hidden']);
  g(['-C', repo, 'config', 'user.email', 'hidden@example.invalid']);
  assert.equal(process.env.GIT_DIR, undefined, 'GIT_DIR reached the hidden test');
  assert.equal(process.env.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE reached the hidden test');
});
`;

test('runNodeTest strips an inherited GIT_DIR/GIT_WORK_TREE before running hidden tests', () => {
  const fx = makeFixture();
  try {
    const victim = join(fx.dir, 'victim');
    mkdirSync(victim, { recursive: true });
    git(['init', '-q', '-b', 'main', victim]);
    git(['-C', victim, 'config', 'user.name', 'fixture']);
    git(['-C', victim, 'config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(victim, 'a.txt'), 'a\n');
    git(['-C', victim, 'add', '-A']);
    git(['-C', victim, 'commit', '-q', '-m', 'seed']);
    const before = hashTree(join(victim, '.git'));

    const task = join(fx.dir, 'task');
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, 'hidden.test.mjs'), HIDDEN_TEST);

    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NODE_TEST_')) env[k] = v;
    env.GIT_DIR = join(victim, '.git');
    env.GIT_WORK_TREE = victim;
    const driver = `import { runNodeTest } from ${JSON.stringify(pathToFileURL(COMMON).href)};
process.stdout.write(JSON.stringify(runNodeTest(${JSON.stringify(task)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8', windowsHide: true, env, timeout: 120000,
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);

    assert.deepEqual(hashTree(join(victim, '.git')), before, "the caller's repository changed");
    assert.equal(result.pass, true, `hidden test failed:\n${result.output}`);
  } finally {
    fx.cleanup();
  }
});
