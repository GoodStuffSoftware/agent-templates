// Covers the worktree memory-scope resolution bug fix:
// hooks/lib/memory-index.mjs's encodeProjectDir()/resolveMemoryScopeDir(),
// their use in buildMemoryNudge()/buildMemoryBrief() (hooks/lib/memory-brief.mjs),
// and the spawn-guard.mjs telemetry observability that rides on the same facts.
//
// Real git repos/worktrees are created under a temp dir for the worktree
// cases — a fake .git file would not exercise `git rev-parse
// --git-common-dir`/`--show-toplevel`, which is the actual mechanism being
// fixed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  makeFixture, runHook, readJsonl, assertNotRealHome,
} from './helpers.mjs';
import { encodeProjectDir, resolveMemoryScopeDir } from '../hooks/lib/memory-index.mjs';
import { buildMemoryNudge } from '../hooks/lib/memory-brief.mjs';

function git(args, cwd) {
  const r = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  }
  return String(r.stdout || '').trim();
}

// A real repo, with an initial commit (worktree add needs at least one), plus
// a linked worktree — both under the given root. Returns absolute paths.
function makeRepoWithWorktree(root, { branch = 'wt-branch' } = {}) {
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 'test@example.invalid'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  writeFileSync(join(repoRoot, 'README.md'), 'x\n');
  git(['add', '.'], repoRoot);
  git(['commit', '-q', '-m', 'init'], repoRoot);

  const worktreeDir = join(repoRoot, '.claude', 'worktrees', branch);
  mkdirSync(join(repoRoot, '.claude', 'worktrees'), { recursive: true });
  git(['worktree', 'add', '-q', '-b', branch, worktreeDir], repoRoot);

  return { repoRoot, worktreeDir };
}

function makePlainRepo(root) {
  const repoRoot = join(root, 'plain-repo');
  mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 'test@example.invalid'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  writeFileSync(join(repoRoot, 'README.md'), 'x\n');
  git(['add', '.'], repoRoot);
  git(['commit', '-q', '-m', 'init'], repoRoot);
  return repoRoot;
}

function makeMemoryStore(memRoot, dirName, fileCount = 1) {
  const memDir = join(memRoot, dirName, 'memory');
  mkdirSync(memDir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(memDir, `fact-${i}.md`), `---\nname: fact-${i}\n---\nsome fact ${i}\n`);
  }
}

test('encodeProjectDir(): reproduces the harness encoding — colon, backslash, forward-slash, and dot all become their own dash', () => {
  const cases = [
    ['C:\\Users\\alice\\dev\\example-app', 'C--Users-alice-dev-example-app'],
    ['C:\\Users\\alice\\dev\\example-app\\.claude\\worktrees\\some-branch-abc123',
      'C--Users-alice-dev-example-app--claude-worktrees-some-branch-abc123'],
    ['C:\\Users\\alice\\.claude', 'C--Users-alice--claude'],
    ['C:\\WINDOWS\\system32', 'C--WINDOWS-system32'],
    ['\\\\wsl$\\Ubuntu\\home\\alice\\dev\\example-app', '--wsl--Ubuntu-home-alice-dev-example-app'],
    ['/home/alice/dev/example-app', '-home-alice-dev-example-app'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(encodeProjectDir(input), expected, `encodeProjectDir(${JSON.stringify(input)})`);
  }
});

test('encodeProjectDir(): does not collapse runs of dashes (each non-alnum char is its own dash)', () => {
  // Two adjacent non-alnum chars ("\\" then ".") must produce TWO dashes, not one.
  assert.equal(encodeProjectDir('a\\.b'), 'a--b');
});

test('resolveMemoryScopeDir(): ordinary (non-worktree) repo resolves to the literal cwd, encoded — source "literal"', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const repoRoot = makePlainRepo(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 2);

    const scope = resolveMemoryScopeDir({ cwd: repoRoot, root: memRoot });
    assert.equal(scope.dir, encodeProjectDir(repoRoot));
    assert.equal(scope.source, 'literal');
  } finally {
    cleanup();
  }
});

test('resolveMemoryScopeDir(): a git worktree cwd resolves to the MAIN working tree, encoded — source "worktree-main" — THE BUG FIX', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');

    // The main repo's store is populated; the worktree's OWN (literal)
    // encoding has nothing — this is exactly the observed defect: an empty
    // worktree-encoded store sits right next to the real one.
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 5);
    assert.ok(!existsSync(join(memRoot, encodeProjectDir(worktreeDir))),
      'sanity: no store exists yet under the worktree-literal encoding');

    const scope = resolveMemoryScopeDir({ cwd: worktreeDir, root: memRoot });
    assert.equal(scope.dir, encodeProjectDir(repoRoot), 'must resolve to the MAIN repo, not the worktree');
    assert.equal(scope.source, 'worktree-main');
    assert.notEqual(scope.dir, encodeProjectDir(worktreeDir));
  } finally {
    cleanup();
  }
});

test('resolveMemoryScopeDir(): CLAUDE_CODE_PROJECT_DIR_NAME overrides everything, used verbatim', () => {
  const { dir, cleanup } = makeFixture();
  const saved = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 3);
    makeMemoryStore(memRoot, 'operator-named-project', 1);

    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'operator-named-project';
    const scope = resolveMemoryScopeDir({ cwd: worktreeDir, root: memRoot });
    assert.equal(scope.dir, 'operator-named-project');
    assert.equal(scope.source, 'env:CLAUDE_CODE_PROJECT_DIR_NAME');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = saved;
    cleanup();
  }
});

test('resolveMemoryScopeDir(): a resolved store that does not exist on disk falls through, not to a confident zero', () => {
  const { dir, cleanup } = makeFixture();
  const saved = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    // Only the MAIN repo's store exists — the env override below names a
    // directory nothing has ever created.
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 4);

    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'nothing-here-ever';
    const scope = resolveMemoryScopeDir({ cwd: worktreeDir, root: memRoot });
    assert.notEqual(scope.dir, 'nothing-here-ever', 'must not return a candidate with nothing behind it');
    assert.equal(scope.dir, encodeProjectDir(repoRoot), 'must fall through to the next candidate that exists');
    assert.equal(scope.source, 'worktree-main');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = saved;
    cleanup();
  }
});

test('resolveMemoryScopeDir(): when NOTHING resolved exists on disk, the final literal candidate is still returned (honest zero, not silence)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const repoRoot = makePlainRepo(dir);
    const memRoot = join(dir, 'mem-root-empty'); // nothing under here at all
    mkdirSync(memRoot, { recursive: true });

    const scope = resolveMemoryScopeDir({ cwd: repoRoot, root: memRoot });
    assert.equal(scope.dir, encodeProjectDir(repoRoot));
    assert.equal(scope.source, 'literal');
  } finally {
    cleanup();
  }
});

test('resolveMemoryScopeDir(): autoMemoryDirectory from cwd .claude/settings.json is honored', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 2);
    makeMemoryStore(memRoot, 'settings-named-project', 1);

    mkdirSync(join(worktreeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(worktreeDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: 'settings-named-project' }),
    );

    const scope = resolveMemoryScopeDir({ cwd: worktreeDir, root: memRoot });
    assert.equal(scope.dir, 'settings-named-project');
    assert.equal(scope.source, 'settings:autoMemoryDirectory');
  } finally {
    cleanup();
  }
});

test('buildMemoryNudge(): from a worktree cwd, reports the MAIN repo\'s file count as "here", not zero', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 7);
    makeMemoryStore(memRoot, 'some-other-project', 3);

    const dataDirPath = join(stateDir, 'data');
    mkdirSync(dataDirPath, { recursive: true });

    const { text, facts } = buildMemoryNudge({
      cwd: worktreeDir,
      root: memRoot,
      dataDirPath,
      repoEnabled: false, // isolate the user-scope count being tested
    });

    assert.equal(facts.hereCount, 7, 'must report the MAIN repo\'s 7 files, not the empty worktree store\'s 0');
    assert.equal(facts.hereSource, 'worktree-main');
    assert.equal(facts.otherCount, 1);
    assert.equal(facts.attached, true);
    assert.match(text, /user 7 here, 1 elsewhere/);
  } finally {
    cleanup();
  }
});

test('buildMemoryNudge(): ordinary (non-worktree) cwd is unaffected by this fix', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const repoRoot = makePlainRepo(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 4);

    const dataDirPath = join(stateDir, 'data');
    mkdirSync(dataDirPath, { recursive: true });

    const { facts } = buildMemoryNudge({
      cwd: repoRoot, root: memRoot, dataDirPath, repoEnabled: false,
    });
    assert.equal(facts.hereCount, 4);
    assert.equal(facts.hereSource, 'literal');
  } finally {
    cleanup();
  }
});

// --- End-to-end through the actual hook, so the observability half (the
// spawn-telemetry facts) is covered too, not just the pure functions.
test('spawn-guard.mjs: worktree spawn telemetry records the MAIN repo\'s here-count and "worktree-main" as the source', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 6);

    const pluginDataDir = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    const payload = {
      session_id: 'sess-memscope-1',
      agent_type: 'main',
      cwd: worktreeDir,
      tool_input: {
        subagent_type: 'general-purpose',
        prompt: 'WEIGHT: 2\ndo the thing',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: {
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        AGENT_COMPANION_MEMORY_ROOT: memRoot,
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH_REPO: 'false',
        CLAUDE_PLUGIN_OPTION_WARRANT_REQUIRED: 'false',
      },
    });
    assert.equal(res.status, 0, `spawn-guard exited ${res.status}: ${res.stderr}`);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];

    assert.equal(row.memory_addition_mode, 'nudge');
    assert.equal(row.memory_addition_attached, true);
    assert.equal(row.memory_addition_here_count, 6, 'telemetry must show the MAIN repo\'s count');
    assert.equal(row.memory_addition_here_source, 'worktree-main');

    // The prompt actually sent to the subagent carries the nudge too — the
    // telemetry facts and the delivered text must agree.
    const updatedPrompt = res.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(updatedPrompt, /user 6 here/);
  } finally {
    cleanup();
  }
});

test('spawn-guard.mjs: memory feature off -> memory_addition_* fields are all null (not false/0)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-memscope-2',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'plain spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.memory_addition_mode, null);
    assert.equal(row.memory_addition_attached, null);
    assert.equal(row.memory_addition_here_count, null);
    assert.equal(row.memory_addition_here_source, null);
  } finally {
    cleanup();
  }
});

// Guard the guard: fixtures must never resolve into the real home.
test('sanity: fixtures in this file never touch the real ~/.claude', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assertNotRealHome(dir, 'fixture dir');
  } finally {
    cleanup();
  }
});
