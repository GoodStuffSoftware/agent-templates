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
import {
  mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  makeFixture, runHook, readJsonl, assertNotRealHome,
} from './helpers.mjs';
import { encodeProjectDir, resolveMemoryScopeDir } from '../hooks/lib/memory-index.mjs';
import { buildMemoryNudge } from '../hooks/lib/memory-brief.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
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

// --- Production concern: the git-timeout fallback must degrade SAFELY -----
//
// Under load, the git subprocess in mainWorktreeDir() can miss its 2 s
// timeout. For a linked worktree of an ordinary repository, the literal-cwd
// store is then KNOWN to be the wrong one, so the answer is
// "worktree-unresolved", never "literal". For every other layout whose
// `.git` is a file (a submodule, a --separate-git-dir checkout, a worktree
// of a bare repo) a git failure falls back to literal, exactly as 0.29.1
// did. Git failure is simulated with an injected `gitRunner` stub (and, end
// to end, by taking git off PATH), never with real load.
//
// The layouts below are written directly to disk, in the shapes git itself
// writes: they need no git process, and the only thing under test is what
// this module reads from the filesystem when git gives no answer.

const GIT_FAILS = () => null;

function writeFileEnsuring(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// <root>/main/.git/{HEAD, worktrees/<name>/{HEAD, commondir}} and the
// worktree's own `.git` file. `gitdirVia` lets the `.git` file name the
// worktree's gitdir through another path (a junction), so the fs-only fast
// path cannot parse it while it is still a real linked worktree.
function fakeLinkedWorktree(root, { gitdirVia } = {}) {
  const main = join(root, 'main');
  writeFileEnsuring(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const gitdir = join(main, '.git', 'worktrees', 'wt');
  writeFileEnsuring(join(gitdir, 'HEAD'), 'ref: refs/heads/wt\n');
  writeFileEnsuring(join(gitdir, 'commondir'), '../..\n');
  const wt = join(root, 'wt');
  let named = gitdir;
  if (gitdirVia) {
    symlinkSync(join(main, '.git', 'worktrees'), join(root, gitdirVia), 'junction');
    named = join(root, gitdirVia, 'wt');
  }
  writeFileEnsuring(join(wt, '.git'), `gitdir: ${named.replace(/\\/g, '/')}\n`);
  return { main, wt };
}

const LAYOUTS = {
  // gitdir: ../.git/modules/sub, which holds no commondir.
  submodule(root) {
    const sup = join(root, 'super');
    writeFileEnsuring(join(sup, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileEnsuring(join(sup, '.git', 'modules', 'sub', 'HEAD'), 'ref: refs/heads/main\n');
    const cwd = join(sup, 'sub');
    writeFileEnsuring(join(cwd, '.git'), 'gitdir: ../.git/modules/sub\n');
    return cwd;
  },
  // `git init --separate-git-dir <store>`: the checkout's gitdir is the
  // store itself, which holds no commondir.
  'separate-git-dir main checkout'(root) {
    writeFileEnsuring(join(root, 'store', 'HEAD'), 'ref: refs/heads/main\n');
    const cwd = join(root, 'checkout');
    writeFileEnsuring(join(cwd, '.git'), `gitdir: ${join(root, 'store').replace(/\\/g, '/')}\n`);
    return cwd;
  },
  // A worktree of a --separate-git-dir checkout: commondir names the store,
  // not a `.git` beside a work tree.
  'separate-git-dir worktree'(root) {
    writeFileEnsuring(join(root, 'store', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileEnsuring(join(root, 'store', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/w\n');
    writeFileEnsuring(join(root, 'store', 'worktrees', 'w', 'commondir'), '../..\n');
    const cwd = join(root, 'w');
    writeFileEnsuring(join(cwd, '.git'), `gitdir: ${join(root, 'store', 'worktrees', 'w').replace(/\\/g, '/')}\n`);
    return cwd;
  },
  // A worktree of a bare repository: commondir names x.git, and there is
  // no main working tree at all.
  'bare-repo worktree'(root) {
    writeFileEnsuring(join(root, 'x.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileEnsuring(join(root, 'x.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/w\n');
    writeFileEnsuring(join(root, 'x.git', 'worktrees', 'w', 'commondir'), '../..\n');
    const cwd = join(root, 'w');
    writeFileEnsuring(join(cwd, '.git'), `gitdir: ${join(root, 'x.git', 'worktrees', 'w').replace(/\\/g, '/')}\n`);
    return cwd;
  },
  // A `.git` file with no gitdir line at all.
  'garbage .git file'(root) {
    const cwd = join(root, 'garbage');
    writeFileEnsuring(join(cwd, '.git'), 'this is not a gitdir line\n');
    return cwd;
  },
};

for (const [name, build] of Object.entries(LAYOUTS)) {
  test(`resolveMemoryScopeDir(): ${name}, git failing -> literal, as in 0.29.1 (not a linked worktree of an ordinary repo)`, () => {
    const { dir, cleanup } = makeFixture();
    try {
      const cwd = build(dir);
      const memRoot = join(dir, 'mem-root');
      makeMemoryStore(memRoot, encodeProjectDir(cwd), 4);
      let calls = 0;
      const scope = resolveMemoryScopeDir({ cwd, root: memRoot, gitRunner: (...a) => { calls += 1; return GIT_FAILS(...a); } });
      assert.equal(scope.source, 'literal');
      assert.equal(scope.dir, encodeProjectDir(cwd));
      assert.ok(calls >= 1, 'an unusual `.git`-file layout still asks git first, as 0.29.1 did');

      // And the delivered nudge says "4 here", as before.
      const dataDirPath = join(dir, 'data');
      mkdirSync(dataDirPath, { recursive: true });
      const { text } = buildMemoryNudge({ cwd, root: memRoot, dataDirPath, repoEnabled: false, gitRunner: GIT_FAILS });
      assert.match(text, /user 4 here, 0 elsewhere/);
    } finally {
      cleanup();
    }
  });
}

test('resolveMemoryScopeDir(): worktree resolution needs NO git call at all in the common case (root-cause fix)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { repoRoot, worktreeDir } = makeRepoWithWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(repoRoot), 3);

    // A gitRunner that always fails: if resolution still finds the main
    // tree, the fs-only `.git`-file parse did the work, not a subprocess.
    const scope = resolveMemoryScopeDir({
      cwd: worktreeDir,
      root: memRoot,
      gitRunner: () => { throw new Error('git must not be called for a well-formed worktree'); },
    });
    assert.equal(scope.dir, encodeProjectDir(repoRoot));
    assert.equal(scope.source, 'worktree-main');
  } finally {
    cleanup();
  }
});

test('resolveMemoryScopeDir(): a linked worktree the fs-only parse cannot read, with git failing, is "worktree-unresolved", NEVER "literal"', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { main, wt } = fakeLinkedWorktree(dir, { gitdirVia: 'alias' });
    const memRoot = join(dir, 'mem-root');
    // Only a literal store and the main store exist: a literal answer would
    // look "successful" while naming the wrong store.
    makeMemoryStore(memRoot, encodeProjectDir(wt), 1);
    makeMemoryStore(memRoot, encodeProjectDir(main), 9);

    const scope = resolveMemoryScopeDir({ cwd: wt, root: memRoot, gitRunner: GIT_FAILS });
    assert.equal(scope.dir, null, 'must not confidently name ANY directory, least of all the wrong one');
    assert.equal(scope.source, 'worktree-unresolved');
  } finally {
    cleanup();
  }
});

test('resolveMemoryScopeDir(): the same worktree without the junction resolves fs-only; a missing commondir is not a linked worktree', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { main, wt } = fakeLinkedWorktree(dir);
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(main), 2);
    const scope = resolveMemoryScopeDir({ cwd: wt, root: memRoot, gitRunner: GIT_FAILS });
    assert.equal(scope.source, 'worktree-main');

    // Point the `.git` file through a junction (fast path fails) and drop
    // commondir: git writes one for every linked worktree, so without it
    // this is not one, and literal stands.
    const other = fakeLinkedWorktree(join(dir, 'b'), { gitdirVia: 'alias' });
    rmSync(join(other.main, '.git', 'worktrees', 'wt', 'commondir'));
    makeMemoryStore(memRoot, encodeProjectDir(other.wt), 1);
    const s2 = resolveMemoryScopeDir({ cwd: other.wt, root: memRoot, gitRunner: GIT_FAILS });
    assert.equal(s2.source, 'literal');
  } finally {
    cleanup();
  }
});

test('buildMemoryNudge(): worktree-unresolved is said in the text, never delivered as "0 here"', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const { main, wt } = fakeLinkedWorktree(dir, { gitdirVia: 'alias' });
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(main), 5);
    mkdirSync(join(memRoot, encodeProjectDir(wt), 'memory'), { recursive: true });
    const dataDirPath = join(stateDir, 'data');
    mkdirSync(dataDirPath, { recursive: true });

    const { text, facts } = buildMemoryNudge({
      cwd: wt, root: memRoot, dataDirPath, repoEnabled: false, gitRunner: GIT_FAILS,
    });
    assert.equal(facts.hereSource, 'worktree-unresolved');
    assert.equal(facts.hereProject, null);
    assert.match(text, /memory scope unresolved \(git unavailable\); this worktree's memory not loaded; user 1 elsewhere/);
    assert.doesNotMatch(text, /\b0 here\b/);
  } finally {
    cleanup();
  }
});

// PATH with every directory that holds a git executable removed, under the
// same key the environment already uses (Windows spells it "Path").
function pathWithoutGit() {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const kept = String(process.env[key] || '').split(delimiter).filter((d) => d
    && !existsSync(join(d, 'git.exe')) && !existsSync(join(d, 'git')) && !existsSync(join(d, 'git.cmd')));
  return { [key]: kept.join(delimiter) };
}

test('spawn-guard.mjs end to end, git off PATH: an unresolvable worktree delivers the unresolved message and records "worktree-unresolved"', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const { main, wt } = fakeLinkedWorktree(dir, { gitdirVia: 'alias' });
    const memRoot = join(dir, 'mem-root');
    makeMemoryStore(memRoot, encodeProjectDir(main), 6);
    makeMemoryStore(memRoot, 'some-other-project', 2);

    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-memscope-unresolved',
      agent_type: 'main',
      cwd: wt,
      tool_input: { subagent_type: 'general-purpose', prompt: 'WEIGHT: 2\ndo the thing' },
    }, {
      env: {
        ...pathWithoutGit(),
        CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
        AGENT_COMPANION_MEMORY_ROOT: memRoot,
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH_REPO: 'false',
        CLAUDE_PLUGIN_OPTION_WARRANT_REQUIRED: 'false',
      },
    });
    assert.equal(res.status, 0, `spawn-guard exited ${res.status}: ${res.stderr}`);
    const [row] = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(row.memory_addition_here_source, 'worktree-unresolved');
    assert.equal(row.memory_addition_attached, true);
    const prompt = res.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt, /memory scope unresolved \(git unavailable\); this worktree's memory not loaded; user 2 elsewhere/);
    assert.doesNotMatch(prompt, /\b0 here\b/);
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
