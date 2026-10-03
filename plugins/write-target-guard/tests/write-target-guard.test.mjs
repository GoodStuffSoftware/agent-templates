// Tests for write-target-guard.mjs — run: node --test plugins/write-target-guard/tests/write-target-guard.test.mjs
//
// This is the HERMETIC, config-driven port of the original (pre-alias) live-hook test.
// The 43 original cases are preserved 1:1 — only their PARAMETERISATION changed:
//   • `decide(x, { primary })`            -> `decide(x, { config: FIX, primary })`
//     FIX is a fixture config that mirrors the first-configured repo (BSK) rules, so the
//     same inputs produce the same decisions. The real rules now come from a config file;
//     the test supplies them explicitly instead of relying on a hard-coded project.
//   • test 31 (bare default): `decide(write('C:\\...\\my-project[-slug]\\...'))`
//     -> `decide(write(<repo>[-slug]\\...), { config: FIX })` (FIX.repos[0].primary = <repo>).
//   • the END-TO-END cases spawned the installed hook against a hard-coded my-project path
//     and the real home config. They now spawn it with USERPROFILE/HOME pointed at a temp
//     home holding a fixture config whose primary is the temp repo (os.homedir() honours the
//     USERPROFILE override on Windows — verified on-box), and CLAUDE_PLUGIN_ROOT stripped.
// After the 43 come NEW cases for the 2026-10-03 work: P1/P2/P3 alias-hardening, P5 root
// config files, self-protection of the trust anchor, the loud fail-open / opt-out, the
// denial of unresolvable UNC targets (lexically and after realpath), configured paths
// canonicalised like targets (8.3 / junction primaries, a missing primary warns), and the
// loud salvage of malformed config entries.
//
// The temp dir is used AS os.tmpdir() spells it (no realpath): on a CI runner whose tmpdir
// is an 8.3 path (the profile dir shortened to <user>~1) every fixture primary is then an aliased spelling,
// which the hook must canonicalise like a target.
//
// Windows-only: the fixtures build git worktrees at path.win32 paths and the alias tests use
// junctions, 8.3 names and drive letters. The whole suite self-skips (with a message) off win32.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/write-target-guard.mjs';
import * as guard from '../hooks/write-target-guard.mjs'; // namespace: a missing seam fails one test, not the file

const HOOK = fileURLToPath(new URL('../hooks/write-target-guard.mjs', import.meta.url));
const WINONLY = process.platform === 'win32'
  ? false
  : 'Windows-only (path.win32 git-worktree fixtures, junctions, 8.3 names, drive letters)';

describe('write-target-guard', { skip: WINONLY }, () => {
  let tmp, repo, primary, FIX, homeValid;

  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  const wt = (name) => path.win32.join(repo, '.claude', 'worktrees', name);
  const addWorktree = (name, ...branchArgs) => {
    git(repo, 'worktree', 'add', ...branchArgs.slice(0, -1), wt(name), branchArgs.at(-1));
  };
  const write = (file, content = 'x') => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
  const edit = (file, newString = 'x') => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: newString } });
  const D = (input) => decide(input, { config: FIX, primary });
  const denied = (d) => assert.equal(d.decision, 'deny', JSON.stringify(d));
  const allowed = (d) => assert.equal(d.decision, 'allow', JSON.stringify(d));
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The ACTUAL 8.3 short name (MYPROJ~1 etc.) of the directory `longBase` inside `dir`, or ''
  // when the volume has 8dot3 creation disabled (some CI runners). Query a SMALL dir: `dir /x`
  // on the shared tmpdir can overflow the child stdout buffer (ENOBUFS) and is slow.
  const shortOf = (dir, longBase) => {
    const out = execFileSync('cmd', ['/c', 'dir', '/x', '/a:d', dir], { maxBuffer: 1 << 20 }).toString();
    const re = new RegExp('<DIR>\\s+(\\S+)\\s+' + escRe(longBase) + '\\s*$', 'i');
    for (const line of out.split(/\r?\n/)) { const m = re.exec(line); if (m && m[1].includes('~')) return m[1]; }
    return '';
  };

  // Child env for the spawned-hook E2E cases: point os.homedir() at a temp home and strip
  // any inherited CLAUDE_PLUGIN_ROOT (set it explicitly per-test to exercise plugin mode).
  const childEnv = (home, extra = {}) => {
    const e = { ...process.env, USERPROFILE: home, HOME: home };
    delete e.CLAUDE_PLUGIN_ROOT;
    return { ...e, ...extra };
  };
  const spawnHook = (home, inputObj, extraEnv = {}, entry = HOOK) =>
    spawnSync(process.execPath, [entry], {
      input: typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj),
      encoding: 'utf8',
      env: childEnv(home, extraEnv),
    });

  // The fixture config — mirrors the first-configured repo (BSK) rules so the ported
  // expectations hold. primary is overridden to the temp repo per call (opts.primary),
  // and is also baked into repos[0].primary for the bare-config test 31.
  const repoCfg = () => ({
    primary,
    worktreeMark: '.claude\\worktrees\\',
    allowedBranchPrefixes: ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert', 'wip'],
    codeDirs: ['src', 'e2e', 'functions', 'dashboard-ui', 'src-capacitor'],
    scriptDir: 'scripts',
    scriptExts: ['mjs', 'cjs', 'js', 'ts', 'ps1', 'vbs'],
    rootCodeFiles: ['package.json', 'package-lock.json', 'quasar.config.ts', 'eslint.config.js', 'firestore.rules', 'firestore.indexes.json', 'index.html'],
    rootCodeFilesAtWorktreeRoots: true,
    exemptDirs: ['.claude', 'docs', '.husky'],
    exemptExts: ['md'],
    coworkAck: 'cowork-worktree',
    primaryAck: 'primary-worktree',
    hints: {
      primaryLabel: 'PRIMARY worktree (holds main/staging — merges land here via git, code work does not)',
      siblingSlug: 'my-project-<slug>',
      worktreeAddExample: `git -C ${repo} worktree add -b <type>/<scope> ${repo}-<slug> origin/<base>`,
    },
  });

  before(() => {
    if (process.platform !== 'win32') return; // belt-and-suspenders; describe-skip already covers it
    tmp = mkdtempSync(path.join(os.tmpdir(), 'wtg-test-')); // NOT realpath'd: see the header
    repo = path.win32.join(tmp, 'my-project');
    mkdirSync(repo);
    primary = (repo + '\\').toLowerCase();
    FIX = { version: 1, enabled: true, repos: [repoCfg()] };

    git(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), 'r');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    addWorktree('feat-wt', '-b', 'feat/x', 'HEAD');
    addWorktree('docs-wt', '-b', 'docs/x', 'HEAD');
    addWorktree('claude-auto', '-b', 'claude/some-auto-name', 'HEAD');
    addWorktree('feat-y', '-b', 'claude/z', 'HEAD'); // dir name looks allowed, branch is not
    addWorktree('detached-wt', '--detach', 'HEAD');
    addWorktree('staging-wt', '-b', 'staging', 'HEAD');
    addWorktree('backup-wt', '-b', 'backup/feat-x-pre-thing', 'HEAD');
    addWorktree('agent-wt', '-b', 'worktree-agent-a1b2c3', 'HEAD');
    addWorktree('rel-wt', '-b', 'fix/relative', 'HEAD');
    // relative gitdir (git 2.46 cannot write these itself): <root>\.git -> ..\..\..\.git\worktrees\<name>
    rmSync(path.join(wt('rel-wt'), '.git'));
    writeFileSync(path.join(wt('rel-wt'), '.git'), 'gitdir: ../../../.git/worktrees/rel-wt\n');
    // plain clone (.git is a directory) under worktrees
    mkdirSync(wt('plain-clone'), { recursive: true });
    git(wt('plain-clone'), 'init', '-b', 'chore/plain');
    // garbled .git file, missing .git
    mkdirSync(wt('garbled'), { recursive: true });
    writeFileSync(path.join(wt('garbled'), '.git'), 'this is not a gitdir line\n');
    mkdirSync(wt('no-git'), { recursive: true });
    // .git file pointing at a nonexistent gitdir
    mkdirSync(wt('dangling'), { recursive: true });
    writeFileSync(path.join(wt('dangling'), '.git'), 'gitdir: ../../../.git/worktrees/nope\n');
    addWorktree('claude-fix', '-b', 'claude/fix/x', 'HEAD'); // contains an allowed prefix, but not at the start

    // Hand-built worktrees with forged HEAD / .git contents (absolute gitdir outside the repo).
    const fakeWt = (name, head, dotGit) => {
      const gd = path.win32.join(tmp, 'fake-gitdirs', name);
      mkdirSync(gd, { recursive: true });
      writeFileSync(path.join(gd, 'HEAD'), head);
      mkdirSync(wt(name), { recursive: true });
      writeFileSync(path.join(wt(name), '.git'), (dotGit ?? 'gitdir: ') + gd + '\n');
    };
    fakeWt('fake-ok', 'ref: refs/heads/feat/x\n'); // control: proves the fake setup itself resolves
    fakeWt('head-junk-space', 'ref: refs/heads/feat/x junk\n');
    fakeWt('head-junk-line', 'ref: refs/heads/feat/x\nJUNK\n');
    fakeWt('head-bom', '\uFEFFref: refs/heads/feat/x\n');
    fakeWt('head-dotdot', 'ref: refs/heads/feat/../claude/z\n');
    fakeWt('git-bom', 'ref: refs/heads/feat/x\n', '\uFEFFgitdir: ');

    // Rebases stopped on a conflict (HEAD detached mid-rebase).
    const init = git(repo, 'rev-parse', 'HEAD').trim();
    const rebaseWts = [['reb-feat', 'feat/reb', []], ['reb-apply', 'fix/reb-apply', ['--apply']], ['reb-claude', 'claude/reb', []]];
    for (const [name, branch] of rebaseWts) {
      addWorktree(name, '-b', branch, init);
      writeFileSync(path.join(wt(name), 'f.txt'), `from ${branch}\n`);
      git(wt(name), 'add', 'f.txt');
      git(wt(name), 'commit', '-m', `${branch} change`);
    }
    writeFileSync(path.join(repo, 'f.txt'), 'from main\n');
    git(repo, 'add', 'f.txt');
    git(repo, 'commit', '-m', 'main change');
    for (const [name, , extra] of rebaseWts) {
      try {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.editor=true', 'rebase', ...extra, 'main'], {
          cwd: wt(name), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' },
        });
      } catch { /* expected: stops on the conflict */ }
    }

    // Temp home with a VALID fixture config whose primary is the temp repo, for the E2E cases.
    homeValid = path.win32.join(tmp, 'home-valid');
    mkdirSync(path.win32.join(homeValid, '.claude'), { recursive: true });
    writeFileSync(path.win32.join(homeValid, '.claude', 'write-target-guard.config.json'), JSON.stringify(FIX));
  });

  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  // ---------------------------------------------------------------------------
  // The 43 original cases, parameterised (see the header). Titles kept verbatim.
  // ---------------------------------------------------------------------------

  test('feat/x worktree: src Write without ack -> allow', () => {
    allowed(D(write(path.win32.join(wt('feat-wt'), 'src', 'a.ts'))));
  });

  test('docs/x worktree: scripts Edit (new_string) without ack -> allow (incident case)', () => {
    allowed(D(edit(path.win32.join(wt('docs-wt'), 'scripts', 'b.mjs'), 'const a = 1;')));
  });

  test('forward-slash path form resolves the same way', () => {
    allowed(D(write(path.win32.join(wt('feat-wt'), 'src', 'a.ts').replace(/\\/g, '/'))));
  });

  test('plain clone (.git directory) on chore/ branch -> allow', () => {
    allowed(D(write(path.win32.join(wt('plain-clone'), 'src', 'a.ts'))));
  });

  test('relative gitdir resolves against the worktree root -> allow on fix/ branch', () => {
    allowed(D(write(path.win32.join(wt('rel-wt'), 'src', 'a.ts'))));
  });

  test('claude/* worktree: code write without ack -> deny, message names branch and the allowed prefixes', () => {
    const d = D(write(path.win32.join(wt('claude-auto'), 'src', 'a.ts')));
    denied(d);
    assert.match(d.reason, /branch claude\/some-auto-name/);
    assert.match(d.reason, /feat\/ fix\/ docs\/ chore\//);
    assert.match(d.reason, /guard-ack: cowork-worktree/);
    assert.match(d.reason, /my-project-<slug>/);
  });

  test('claude/* worktree: code write WITH cowork ack -> allow', () => {
    allowed(D(write(path.win32.join(wt('claude-auto'), 'src', 'a.ts'), '// guard-ack: cowork-worktree')));
    allowed(D(edit(path.win32.join(wt('claude-auto'), 'scripts', 'a.mjs'), 'guard-ack: cowork-worktree')));
  });

  test('primary ack does not satisfy the cowork-worktree gate', () => {
    denied(D(write(path.win32.join(wt('claude-auto'), 'src', 'a.ts'), 'guard-ack: primary-worktree')));
  });

  test('keyed on branch, not directory name: dir feat-y on branch claude/z -> deny', () => {
    denied(D(write(path.win32.join(wt('feat-y'), 'src', 'a.ts'))));
  });

  test('detached HEAD worktree -> deny, says detached HEAD', () => {
    const d = D(write(path.win32.join(wt('detached-wt'), 'src', 'a.ts')));
    denied(d);
    assert.match(d.reason, /detached HEAD/);
  });

  test('staging / backup/* / agent-isolation branch -> deny', () => {
    denied(D(write(path.win32.join(wt('staging-wt'), 'src', 'a.ts'))));
    denied(D(write(path.win32.join(wt('backup-wt'), 'src', 'a.ts'))));
    denied(D(write(path.win32.join(wt('agent-wt'), 'src', 'a.ts'))));
  });

  test('.git missing / garbled / dangling -> deny, says branch unreadable', () => {
    for (const n of ['no-git', 'garbled', 'dangling']) {
      const d = D(write(path.win32.join(wt(n), 'src', 'a.ts')));
      denied(d);
      assert.match(d.reason, /branch unreadable/, n);
    }
  });

  test('worktree dir that does not exist at all -> deny (UNKNOWN)', () => {
    denied(D(write(path.win32.join(wt('ghost'), 'src', 'a.ts'))));
  });

  test('code path whose "worktree" segment is not a worktree (worktrees\\scripts\\a.mjs) -> deny', () => {
    denied(D(write(path.win32.join(repo, '.claude', 'worktrees', 'scripts', 'a.mjs'))));
  });

  test('non-code file (.md) in a claude/* worktree -> allow (unchanged)', () => {
    allowed(D(write(path.win32.join(wt('claude-auto'), 'README.md'))));
    allowed(D(write(path.win32.join(wt('claude-auto'), 'docs', 'y.md'))));
  });

  // Raw string concatenation below on purpose: path.win32.join would collapse the path
  // before decide() sees it, and the tests would no longer exercise decide()'s own normalise.
  test('traversal out of an allowed worktree into the primary cannot borrow its allowance', () => {
    denied(D(write(wt('feat-wt') + '\\..\\..\\..\\src\\x.ts')));
  });

  test('traversal out of the primary is allowed (target is outside)', () => {
    allowed(D(write(repo + '\\src\\..\\..\\other\\src\\x.ts')));
  });

  test('traversal from an allowed worktree into a claude/* worktree -> deny', () => {
    denied(D(write(wt('feat-wt') + '\\..\\claude-auto\\src\\a.ts')));
  });

  test('doubled separators cannot dodge the worktree check -> deny', () => {
    denied(D(write(repo + '\\.claude\\\\worktrees\\\\claude-auto\\\\src\\\\a.ts')));
  });

  test('a "." segment cannot dodge the worktree check -> deny', () => {
    denied(D(write(repo + '\\.claude\\.\\worktrees\\claude-auto\\src\\a.ts')));
  });

  test('branch claude/fix/x (allowed prefix not at the start) -> deny', () => {
    const d = D(write(path.win32.join(wt('claude-fix'), 'src', 'a.ts')));
    denied(d);
    assert.match(d.reason, /branch claude\/fix\/x/);
  });

  test('forged-HEAD control: clean ref to feat/x via an absolute gitdir -> allow', () => {
    allowed(D(write(path.win32.join(wt('fake-ok'), 'src', 'a.ts'))));
  });

  test('HEAD "ref: refs/heads/feat/x junk" -> deny', () => {
    denied(D(write(path.win32.join(wt('head-junk-space'), 'src', 'a.ts'))));
  });

  test('HEAD with a junk second line after a feat/x ref -> deny', () => {
    denied(D(write(path.win32.join(wt('head-junk-line'), 'src', 'a.ts'))));
  });

  test('BOM-prefixed HEAD on feat/x -> allow', () => {
    allowed(D(write(path.win32.join(wt('head-bom'), 'src', 'a.ts'))));
  });

  test('BOM-prefixed .git file -> gitdir still resolves -> allow', () => {
    allowed(D(write(path.win32.join(wt('git-bom'), 'src', 'a.ts'))));
  });

  test('forged branch feat/../claude/z (contains "..") -> deny', () => {
    const d = D(write(path.win32.join(wt('head-dotdot'), 'src', 'a.ts')));
    denied(d);
    assert.match(d.reason, /feat\/\.\.\/claude\/z/);
  });

  const rebaseState = (name) => {
    const gd = path.win32.join(repo, '.git', 'worktrees', name);
    return {
      detached: !readFileSync(path.join(gd, 'HEAD'), 'utf8').startsWith('ref:'),
      merge: existsSync(path.join(gd, 'rebase-merge', 'head-name')),
      apply: existsSync(path.join(gd, 'rebase-apply', 'head-name')),
    };
  };

  test('feat/ worktree stopped mid-rebase (merge backend, HEAD detached) -> allow', () => {
    assert.deepEqual(rebaseState('reb-feat'), { detached: true, merge: true, apply: false }, 'fixture: rebase not in progress');
    allowed(D(write(path.win32.join(wt('reb-feat'), 'src', 'a.ts'))));
  });

  test('fix/ worktree stopped mid-rebase (apply backend, HEAD detached) -> allow', () => {
    assert.deepEqual(rebaseState('reb-apply'), { detached: true, merge: false, apply: true }, 'fixture: rebase not in progress');
    allowed(D(write(path.win32.join(wt('reb-apply'), 'src', 'a.ts'))));
  });

  test('claude/* worktree stopped mid-rebase -> deny, names the branch being rebased', () => {
    assert.deepEqual(rebaseState('reb-claude'), { detached: true, merge: true, apply: false }, 'fixture: rebase not in progress');
    const d = D(write(path.win32.join(wt('reb-claude'), 'src', 'a.ts')));
    denied(d);
    assert.match(d.reason, /branch claude\/reb \(rebase in progress\)/);
  });

  test('REAL default PRIMARY (bare config, no primary option): sibling my-project-slug -> allow, my-project -> deny', () => {
    // Parameterised from the original bare-decide case: FIX.repos[0].primary = <repo>.
    allowed(decide(write(repo + '-slug\\src\\a.ts'), { config: FIX }));
    denied(decide(write(repo + '\\src\\a.ts'), { config: FIX }));
  });

  test('\\.claude\\worktrees\\ not directly under primary gets no worktree treatment (primary \\.claude\\ exemption applies)', () => {
    allowed(D(write(path.win32.join(repo, 'src', '.claude', 'worktrees', 'claude-auto', 'a.ts'))));
  });

  test('primary: src\\x.ts -> deny; with primary ack -> allow; docs\\y.md -> allow', () => {
    const d = D(write(path.win32.join(repo, 'src', 'x.ts')));
    denied(d);
    assert.match(d.reason, /PRIMARY worktree/);
    allowed(D(write(path.win32.join(repo, 'src', 'x.ts'), 'guard-ack: primary-worktree')));
    allowed(D(write(path.win32.join(repo, 'docs', 'y.md'))));
    allowed(D(write(path.win32.join(repo, '.claude', 'settings.json'))));
    denied(D(write(path.win32.join(repo, 'package.json'))));
    denied(D(edit(path.win32.join(repo, 'scripts', 'z.ps1'))));
  });

  test('cowork ack does not satisfy the primary gate', () => {
    denied(D(write(path.win32.join(repo, 'src', 'x.ts'), 'guard-ack: cowork-worktree')));
  });

  test('path outside primary (incl. my-project-<slug> sibling) -> allow', () => {
    allowed(D(write(path.win32.join(tmp, 'elsewhere', 'src', 'x.ts'))));
    allowed(D(write(path.win32.join(tmp, 'my-project-feature', 'src', 'x.ts'))));
  });

  test('non-Write/Edit tool, missing path, empty input -> allow', () => {
    allowed(D({ tool_name: 'Read', tool_input: { file_path: path.win32.join(repo, 'src', 'x.ts') } }));
    allowed(D({ tool_name: 'Write', tool_input: {} }));
    allowed(D({}));
    allowed(D(undefined));
  });

  test('END-TO-END: real hook file run directly, path outside the primary -> {} exit 0', () => {
    const r = spawnHook(homeValid, write('C:\\somewhere\\else\\src\\x.ts'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{}');
  });

  test('END-TO-END: real hook file run directly, primary code path -> deny JSON (main really runs)', () => {
    const r = spawnHook(homeValid, write(path.win32.join(repo, 'src', 'App.vue')));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  // Launch the real hook via `entry` with a primary code path; main must run and deny.
  const assertMainDenies = (entry) => {
    const r = spawnHook(homeValid, write(path.win32.join(repo, 'src', 'App.vue')), {}, entry);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(r.stdout, '', `main did not run for ${entry} (empty stdout = allow everything)`);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  };

  test('END-TO-END: lowercase drive letter in the invoked path still runs main', () => {
    assertMainDenies(HOOK[0].toLowerCase() + HOOK.slice(1));
  });

  test('END-TO-END: upper-case basename in the invoked path still runs main', () => {
    assertMainDenies(path.join(path.dirname(HOOK), 'WRITE-TARGET-GUARD.mjs'));
  });

  test('END-TO-END: launched through a junction to the hooks dir, main still runs', () => {
    const link = path.win32.join(tmp, 'hooks-junction');
    symlinkSync(path.dirname(HOOK), link, 'junction');
    try {
      assertMainDenies(path.win32.join(link, 'write-target-guard.mjs'));
    } finally {
      unlinkSync(link); // removes the junction only, never the hooks dir
    }
  });

  test('END-TO-END: launched via a \\\\?\\ path, main still runs', () => {
    assertMainDenies('\\\\?\\' + HOOK);
  });

  test('END-TO-END: garbage stdin fails open -> {}', () => {
    const r = spawnHook(homeValid, 'not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 P1 alias-hardening: device/UNC spellings cannot dodge the guard.
  // ---------------------------------------------------------------------------

  const inPrimary = (raw) => D(write(raw)); // raw string on purpose (no path.win32.join collapsing)
  const drive = () => repo[0].toLowerCase();
  const tail = () => repo.slice(2) + '\\src\\a.ts'; // "\\Users\\...\\my-project\\src\\a.ts"

  test('P1: \\\\?\\ device prefix into the primary -> deny', () => {
    denied(inPrimary('\\\\?\\' + repo + '\\src\\a.ts'));
  });
  test('P1: \\\\.\\ device prefix into the primary -> deny', () => {
    denied(inPrimary('\\\\.\\' + repo + '\\src\\a.ts'));
  });
  test('P1: //?/ (forward-slash device prefix) into the primary -> deny', () => {
    denied(inPrimary('//?/' + repo.replace(/\\/g, '/') + '/src/a.ts'));
  });
  test('P1: admin-share UNC \\\\localhost\\C$ into the primary -> deny', () => {
    denied(inPrimary('\\\\localhost\\' + drive() + '$' + tail()));
  });
  test('P1: admin-share UNC \\\\127.0.0.1\\C$ into the primary -> deny', () => {
    denied(inPrimary('\\\\127.0.0.1\\' + drive() + '$' + tail()));
  });
  test('P1: admin-share UNC \\\\[::1]\\C$ into the primary -> deny', () => {
    denied(inPrimary('\\\\[::1]\\' + drive() + '$' + tail()));
  });
  test('P1: admin-share UNC to this host\'s own name into the primary -> deny', () => {
    denied(inPrimary('\\\\' + os.hostname() + '\\' + drive() + '$' + tail()));
  });
  test('P1: \\\\?\\UNC\\localhost\\C$ into the primary -> deny', () => {
    denied(inPrimary('\\\\?\\UNC\\localhost\\' + drive() + '$' + tail()));
  });

  test('P1: \\\\?\\Volume{GUID} is unresolvable -> deny (device/volume namespace)', () => {
    const d = inPrimary('\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\my-project\\src\\a.ts');
    denied(d);
    assert.match(d.reason, /device or volume namespace/);
  });
  test('P1: \\\\.\\GLOBALROOT is unresolvable -> deny', () => {
    const d = inPrimary('\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\my-project\\src\\a.ts');
    denied(d);
    assert.match(d.reason, /device or volume namespace/);
  });
  test('P1: \\\\.\\PhysicalDrive0 is unresolvable -> deny', () => {
    denied(inPrimary('\\\\.\\PhysicalDrive0'));
  });

  test('P1: remote UNC share (not loopback/this host), even outside the primary -> deny (unresolvable UNC target)', () => {
    uncDenied(inPrimary('\\\\someserver\\share\\src\\a.ts'));
    uncDenied(inPrimary('\\\\someserver\\' + drive() + '$\\not-the-repo\\src\\a.ts'));
  });
  test('P1: \\\\?\\ device prefix on a path OUTSIDE the primary -> allow', () => {
    allowed(inPrimary('\\\\?\\' + repo + '-sibling\\src\\a.ts'));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 unresolvable UNC targets: ANY write (code or not) whose target is a
  // UNC path P1 cannot fold to a local drive is DENIED — lexically, and after realpath.
  // ---------------------------------------------------------------------------

  function uncDenied(d) {
    denied(d);
    assert.match(d.reason, /network \(UNC\) path/, d.reason);
    assert.match(d.reason, /Use the local drive path/, d.reason);
  }
  // `p` (a drive path under <drive>:\Users\) spelled through the \\<host>\Users share, or
  // null when it does not live under \Users\ (then the case skips).
  const viaUsersShare = (host, p) => {
    const m = /^[a-z]:\\users\\(.+)$/i.exec(p);
    return m ? '\\\\' + host + '\\Users\\' + m[1] : null;
  };
  const usersAlias = (t, host) => {
    const p = viaUsersShare(host, repo);
    if (!p) t.skip(`the test repo is not under <drive>:\\Users\\ (${repo})`);
    return p && p + '\\src\\a.ts';
  };

  test('UNC: \\\\localhost\\Users alias of a primary code file -> deny', (t) => {
    const p = usersAlias(t, 'localhost');
    if (p) uncDenied(inPrimary(p));
  });
  test('UNC: \\\\127.0.0.1\\Users alias of a primary code file -> deny', (t) => {
    const p = usersAlias(t, '127.0.0.1');
    if (p) uncDenied(inPrimary(p));
  });
  test('UNC: \\\\<this host\'s name>\\Users alias of a primary code file -> deny', (t) => {
    const p = usersAlias(t, os.hostname());
    if (p) uncDenied(inPrimary(p));
  });
  test('UNC: \\\\?\\UNC\\localhost\\Users alias of a primary code file -> deny', (t) => {
    const p = usersAlias(t, 'localhost');
    if (p) uncDenied(inPrimary('\\\\?\\UNC\\' + p.slice(2)));
  });
  test('UNC: \\\\0--1.ipv6-literal.net\\C$ (IPv6 loopback literal) alias of a primary code file -> deny', () => {
    uncDenied(inPrimary('\\\\0--1.ipv6-literal.net\\' + drive() + '$' + tail()));
  });
  test('UNC: \\\\<a local IPv4>\\C$ alias of a primary code file -> deny (skips with no non-internal IPv4)', (t) => {
    const ip = Object.values(os.networkInterfaces()).flat()
      .find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal);
    if (!ip) { t.skip('no non-internal IPv4 address on this machine'); return; }
    uncDenied(inPrimary('\\\\' + ip.address + '\\' + drive() + '$' + tail()));
  });
  test('UNC: a remote-looking host, non-code (\\\\fileserver\\share\\x.md) -> deny', () => {
    uncDenied(D(write('\\\\fileserver\\share\\x.md')));
  });
  test('UNC: END-TO-END a non-code \\\\localhost\\Users alias of the guard\'s own config -> deny (no self-protection bypass)', (t) => {
    const cfgPath = path.win32.join(homeValid, '.claude', 'write-target-guard.config.json');
    const alias = viaUsersShare('localhost', cfgPath);
    if (!alias) { t.skip(`the temp home is not under <drive>:\\Users\\ (${cfgPath})`); return; }
    const r = spawnHook(homeValid, write(alias, JSON.stringify({ version: 1, repos: [] })));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision, 'deny', r.stdout);
    uncDenied({ decision: 'deny', reason: o.hookSpecificOutput.permissionDecisionReason });
  });

  // The post-realpath case: a mapped drive or a symlink to a share realpaths to
  // \\server\share\... (or \\?\UNC\...). Creating either needs `net use` or symlink
  // privilege, so it runs through the hook's resolveTarget(raw, realpathFn) seam with a
  // fake realpath that maps Z:\mapped\ onto `to`; every other path gets the real realpath.
  const mappedRealpath = (to) => (p) =>
    (/^z:\\mapped(\\|$)/i.test(p) ? to + p.slice('z:\\mapped'.length) : realpathSync.native(p));

  test('UNC after realpath: a drive path that realpaths to \\\\server\\share\\... or \\\\?\\UNC\\... -> deny (resolveTarget seam)', () => {
    assert.equal(typeof guard.resolveTarget, 'function', 'the hook exports no resolveTarget(rawPath, realpathFn) seam');
    for (const to of ['\\\\fileserver\\share\\proj', '\\\\?\\UNC\\fileserver\\share\\proj']) {
      for (const target of ['Z:\\mapped\\src\\a.ts', 'Z:\\mapped\\notes.md']) {
        const r = guard.resolveTarget(target, mappedRealpath(to));
        assert.ok(r.deny, `${target} via ${to}: ${JSON.stringify(r)}`);
        uncDenied(r.deny);
        assert.match(r.deny.reason, /resolves to the network \(UNC\) path .*fileserver/);
      }
    }
  });
  test('UNC after realpath control: a realpath onto a loopback admin share P1 recognises folds back to the drive', () => {
    assert.equal(typeof guard.resolveTarget, 'function', 'the hook exports no resolveTarget(rawPath, realpathFn) seam');
    const r = guard.resolveTarget('Z:\\mapped\\src\\a.ts', mappedRealpath('\\\\localhost\\' + drive() + '$' + repo.slice(2)));
    assert.equal(r.deny, undefined, JSON.stringify(r));
    assert.equal(r.norm, realpathSync.native(repo).toLowerCase() + '\\src\\a.ts');
  });

  test('UNC controls: P1-recognised forms keep their pre-fix decisions', () => {
    const outside = path.win32.join(tmp, 'elsewhere').slice(2) + '\\src\\a.ts';
    allowed(inPrimary('\\\\localhost\\' + drive() + '$' + outside)); // admin share, outside the primary
    allowed(inPrimary('\\\\localhost\\' + drive() + '$' + repo.slice(2) + '\\docs\\y.md')); // admin share, non-code
    denied(inPrimary('\\\\localhost\\' + drive() + '$' + tail())); // admin share, primary code
    allowed(inPrimary('\\\\?\\' + repo + '\\docs\\y.md')); // \\?\C:, non-code
    denied(inPrimary('\\\\?\\' + repo + '\\src\\a.ts')); // \\?\C:, primary code
    allowed(inPrimary(drive() + ':' + outside)); // plain drive path outside
    denied(inPrimary(repo + '\\src\\a.ts')); // plain drive path, primary code
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 P2 alias-hardening: ADS streams + trailing dots/spaces.
  // ---------------------------------------------------------------------------

  test('P2: ::$DATA stream on a primary code file -> deny', () => {
    denied(inPrimary(repo + '\\src\\App.vue::$DATA'));
  });
  test('P2: :$DATA stream on a primary code file -> deny', () => {
    denied(inPrimary(repo + '\\src\\App.vue:$DATA'));
  });
  test('P2: trailing dot+space on a primary code file -> deny', () => {
    denied(inPrimary(repo + '\\src\\App.vue. '));
  });
  test('P2: trailing dot+space on a directory segment -> deny', () => {
    denied(inPrimary(repo + '\\src. \\a.ts'));
  });
  test('P2: ADS/trailing junk on a path OUTSIDE the primary -> allow', () => {
    allowed(inPrimary(repo + '-sib\\src\\a.ts::$DATA'));
    allowed(inPrimary(repo + '-sib\\src\\a.ts. '));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 P3 alias-hardening: 8.3 / junctions / symlinks resolved via realpath.
  // ---------------------------------------------------------------------------

  test('P3: a junction into the primary folds to it -> deny', () => {
    const jx = path.win32.join(tmp, 'jx-into-repo');
    symlinkSync(repo, jx, 'junction');
    try { denied(D(write(jx + '\\src\\a.ts'))); }
    finally { try { unlinkSync(jx); } catch { /* ignore */ } }
  });
  test('P3: a junction to a non-repo dir -> allow', () => {
    const elsewhere = path.win32.join(tmp, 'elsewhere-real');
    mkdirSync(elsewhere, { recursive: true });
    const jx = path.win32.join(tmp, 'jx-elsewhere');
    symlinkSync(elsewhere, jx, 'junction');
    try { allowed(D(write(jx + '\\src\\a.ts'))); }
    finally { try { unlinkSync(jx); } catch { /* ignore */ } }
  });
  test('P3: an 8.3 short name folds to the primary -> deny + allow (skips only if 8.3 creation is off on this volume)', (t) => {
    // The fixture gets its OWN small parent dir: `dir /x` on the shared tmpdir can
    // overflow the child stdout buffer (ENOBUFS) and is slow; a 2-entry dir parses
    // cleanly. We query the ACTUAL short basename (MYPROJ~1 etc.) rather than guessing
    // a form, and build the write path through it. On a volume with 8dot3 creation
    // disabled (some CI runners) no short name exists and the case self-skips.
    const box = mkdtempSync(path.win32.join(tmp, 'wtg83-'));
    const longRepo = path.win32.join(box, 'my-project-primary-longname');
    const longOther = path.win32.join(box, 'unrelated-project-longname');
    mkdirSync(path.win32.join(longRepo, 'src'), { recursive: true });
    mkdirSync(path.win32.join(longOther, 'src'), { recursive: true });
    try {
      const sr = shortOf(box, 'my-project-primary-longname');
      const so = shortOf(box, 'unrelated-project-longname');
      if (!sr || !so) { t.skip('8dot3 short-name creation is disabled on this volume'); return; }
      // deny-bypass: the 8.3 spelling of the primary's src still resolves into it.
      denied(decide(write(path.win32.join(box, sr) + '\\src\\a.ts'), { config: FIX, primary: longRepo }));
      // allow-legitimate: the 8.3 spelling of an UNRELATED repo stays allowed.
      allowed(decide(write(path.win32.join(box, so) + '\\src\\a.ts'), { config: FIX, primary: longRepo }));
    } finally {
      try { rmSync(box, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  test('P3: a directory symlink into the primary folds to it -> deny (skips without privilege; the junction cases above exercise the same realpath.native reparse-point fold)', (t) => {
    const ln = path.win32.join(tmp, 'sym-into-repo');
    try { symlinkSync(repo, ln, 'dir'); }
    catch (e) { t.skip('no symlink privilege: ' + (e && e.code)); return; }
    try { denied(D(write(ln + '\\src\\a.ts'))); }
    finally { try { unlinkSync(ln); } catch { /* ignore */ } }
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 P5: root config files are code at a checkout root.
  // ---------------------------------------------------------------------------

  test('P5: a root config file in a claude/* worktree is code -> deny', () => {
    denied(D(write(path.win32.join(wt('claude-auto'), 'package.json'))));
  });
  test('P5: a root config file in a feat/ worktree is code but the branch is allowed -> allow', () => {
    allowed(D(write(path.win32.join(wt('feat-wt'), 'package.json'))));
  });
  test('P5: with rootCodeFilesAtWorktreeRoots=false, a root config file in a worktree is not code -> allow', () => {
    const cfg = { ...FIX, repos: [{ ...FIX.repos[0], primary, rootCodeFilesAtWorktreeRoots: false }] };
    allowed(decide(write(path.win32.join(wt('claude-auto'), 'package.json')), { config: cfg }));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 self-protection: the trust anchor (config) and the hook file.
  // ---------------------------------------------------------------------------

  test('self-protection: Write to the config path without ack -> deny (trust anchor)', () => {
    const cfgPath = path.win32.join(tmp, 'home-x', '.claude', 'write-target-guard.config.json');
    const d = decide(write(cfgPath), { config: FIX, primary, configPath: cfgPath });
    denied(d);
    assert.match(d.reason, /trust anchor/);
  });
  test('self-protection: Write to the config path WITH guard-config ack -> allow', () => {
    const cfgPath = path.win32.join(tmp, 'home-x', '.claude', 'write-target-guard.config.json');
    allowed(decide(write(cfgPath, '// guard-ack: guard-config'), { config: FIX, primary, configPath: cfgPath }));
  });
  test('self-protection: Write to the hook file (selfPaths) -> deny without ack, allow with it', () => {
    denied(decide(write(HOOK), { config: FIX, primary, selfPaths: [HOOK] }));
    allowed(decide(write(HOOK, 'x // guard-ack: guard-config'), { config: FIX, primary, selfPaths: [HOOK] }));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 loud fail-open and the explicit opt-out (spawned hook, E2E).
  // ---------------------------------------------------------------------------

  test('loud: MISSING config (standalone) -> exit 0, systemMessage + stderr INACTIVE', () => {
    const home = path.win32.join(tmp, 'home-missing');
    mkdirSync(home, { recursive: true });
    const r = spawnHook(home, write(path.win32.join(repo, 'src', 'App.vue')));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.match(o.systemMessage, /INACTIVE/);
    assert.match(o.systemMessage, /no config file/);
    assert.match(r.stderr, /INACTIVE/);
  });
  test('loud: MISSING config (plugin mode, CLAUDE_PLUGIN_ROOT set) -> STILL loud', () => {
    const home = path.win32.join(tmp, 'home-missing2');
    mkdirSync(home, { recursive: true });
    const r = spawnHook(home, write(path.win32.join(repo, 'src', 'App.vue')), { CLAUDE_PLUGIN_ROOT: path.win32.join(tmp, 'plugin-root') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).systemMessage, /INACTIVE/);
  });
  test('loud: MALFORMED config -> systemMessage names it malformed (both modes)', () => {
    const home = path.win32.join(tmp, 'home-bad');
    mkdirSync(path.win32.join(home, '.claude'), { recursive: true });
    writeFileSync(path.win32.join(home, '.claude', 'write-target-guard.config.json'), '{ not valid json');
    for (const extra of [{}, { CLAUDE_PLUGIN_ROOT: path.win32.join(tmp, 'pr') }]) {
      const r = spawnHook(home, write(path.win32.join(repo, 'src', 'App.vue')), extra);
      assert.equal(r.status, 0, r.stderr);
      assert.match(JSON.parse(r.stdout).systemMessage, /malformed/);
    }
  });
  test('opt-out: "enabled": false -> silent allow ({})', () => {
    const home = path.win32.join(tmp, 'home-off');
    mkdirSync(path.win32.join(home, '.claude'), { recursive: true });
    writeFileSync(path.win32.join(home, '.claude', 'write-target-guard.config.json'), JSON.stringify({ version: 1, enabled: false, repos: [FIX.repos[0]] }));
    const r = spawnHook(home, write(path.win32.join(repo, 'src', 'App.vue')));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{}');
  });
  test('opt-out: empty "repos": [] -> silent allow ({})', () => {
    const home = path.win32.join(tmp, 'home-empty-repos');
    mkdirSync(path.win32.join(home, '.claude'), { recursive: true });
    writeFileSync(path.win32.join(home, '.claude', 'write-target-guard.config.json'), JSON.stringify({ version: 1, repos: [] }));
    const r = spawnHook(home, write(path.win32.join(repo, 'src', 'App.vue')));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{}');
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 configured paths are canonicalised like targets (P1/P2/P3): an 8.3 or
  // junction spelling of a primary (or of worktreeMark) in the CONFIG still guards it, and a
  // configured primary that does not exist warns loudly.
  // ---------------------------------------------------------------------------

  // A temp home whose config is `cfg` (an object, written as JSON), for the spawned-hook cases.
  const homeWith = (name, cfg) => {
    const home = path.win32.join(tmp, 'home-' + name);
    mkdirSync(path.win32.join(home, '.claude'), { recursive: true });
    writeFileSync(path.win32.join(home, '.claude', 'write-target-guard.config.json'), JSON.stringify(cfg));
    return home;
  };
  // Spawn the hook on a Write of `target`; exit 0 is required, stdout must be JSON.
  const runHook = (home, target) => {
    const r = spawnHook(home, write(target));
    assert.equal(r.status, 0, r.stderr);
    return { r, o: JSON.parse(r.stdout) };
  };
  const hookDenied = ({ o }) =>
    assert.equal(o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(o));
  const hookNotDenied = ({ o }) => assert.equal(o.hookSpecificOutput, undefined, JSON.stringify(o));
  // The config warning reached BOTH channels: a stderr WARNING line and the systemMessage.
  const loudAbout = ({ r, o }, what) => {
    assert.match(r.stderr, new RegExp('\\[write-target-guard\\] WARNING: .*' + escRe(what)), r.stderr);
    assert.match(o.systemMessage || '', new RegExp(escRe(what)), JSON.stringify(o));
  };

  test('config path: an 8.3 spelling of the primary in the config still guards it -> deny (skips only if 8.3 creation is off)', (t) => {
    const box = mkdtempSync(path.win32.join(tmp, 'cfg83-'));
    const longRepo = path.win32.join(box, 'configured-primary-longname');
    mkdirSync(path.win32.join(longRepo, 'src'), { recursive: true });
    try {
      const sr = shortOf(box, 'configured-primary-longname');
      if (!sr) { t.skip('8dot3 short-name creation is disabled on this volume'); return; }
      const cfg83 = path.win32.join(box, sr); // ...\cfg83-xxxx\CONFIG~1
      // decide() with the 8.3 primary: code under the LONG spelling is still the primary's.
      denied(decide(write(path.win32.join(longRepo, 'src', 'a.ts')), { config: FIX, primary: cfg83 }));
      denied(decide(write(path.win32.join(longRepo, 'package.json')), { config: FIX, primary: cfg83 + '\\' }));
      allowed(decide(write(path.win32.join(longRepo, 'docs', 'y.md')), { config: FIX, primary: cfg83 }));
      allowed(decide(write(longRepo + '-sib\\src\\a.ts'), { config: FIX, primary: cfg83 }));
      // and through the real hook, with the 8.3 primary in the home config file.
      const home = homeWith('cfg83', { version: 1, repos: [{ ...FIX.repos[0], primary: cfg83 }] });
      hookDenied(runHook(home, path.win32.join(longRepo, 'src', 'a.ts')));
    } finally {
      try { rmSync(box, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('config path: a junction spelling of the primary in the config still guards it -> deny; worktree rules apply through it', (t) => {
    const jx = path.win32.join(tmp, 'cfg-jx-to-repo');
    try { symlinkSync(repo, jx, 'junction'); } // a junction needs no privilege (same as mklink /J)
    catch (e) { t.skip('could not create a junction: ' + (e && e.code)); return; }
    try {
      const J = (input) => decide(input, { config: FIX, primary: jx });
      denied(J(write(path.win32.join(repo, 'src', 'a.ts'))));
      const d = J(write(path.win32.join(wt('claude-auto'), 'src', 'a.ts')));
      denied(d);
      assert.match(d.reason, /branch claude\/some-auto-name/);
      allowed(J(write(path.win32.join(wt('feat-wt'), 'src', 'a.ts'))));
      allowed(J(write(path.win32.join(repo, 'docs', 'y.md'))));
      const home = homeWith('cfg-jx', { version: 1, repos: [{ ...FIX.repos[0], primary: jx }] });
      hookDenied(runHook(home, path.win32.join(repo, 'src', 'a.ts')));
    } finally {
      try { unlinkSync(jx); } catch { /* ignore: removes the junction only */ }
    }
  });

  test('config path: an 8.3 spelling of worktreeMark still finds the worktrees -> claude/* code write denied (skips if 8.3 is off)', (t) => {
    const sw = shortOf(path.win32.join(repo, '.claude'), 'worktrees');
    if (!sw) { t.skip('8dot3 short-name creation is disabled on this volume'); return; }
    const cfg = { ...FIX, repos: [{ ...FIX.repos[0], primary, worktreeMark: '.claude\\' + sw + '\\' }] };
    const d = decide(write(path.win32.join(wt('claude-auto'), 'src', 'a.ts')), { config: cfg });
    denied(d);
    assert.match(d.reason, /branch claude\/some-auto-name/);
    allowed(decide(write(path.win32.join(wt('feat-wt'), 'src', 'a.ts')), { config: cfg }));
  });

  test('config path: a configured primary that does not exist -> loud WARNING (stderr + systemMessage), exit 0, other entries still enforced', () => {
    const missing = path.win32.join(tmp, 'no-such-primary');
    const home = homeWith('missing-primary', { version: 1, repos: [{ ...FIX.repos[0], primary: missing }, FIX.repos[0]] });
    const a = runHook(home, path.win32.join(repo, 'src', 'a.ts'));
    hookDenied(a); // the valid second entry is still enforced, and the warning rides on the deny
    loudAbout(a, 'repos[0].primary');
    assert.match(a.r.stderr, /does not exist/);
    assert.match(a.o.systemMessage, /does not exist/);
    const b = runHook(home, path.win32.join(tmp, 'elsewhere', 'src', 'x.ts'));
    hookNotDenied(b);
    loudAbout(b, 'repos[0].primary'); // loud on an allow too, not only on a deny
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 malformed config entries are dropped LOUDLY, never silently: each invalid
  // element or entry is dropped with a warning naming the field, every valid rule stays
  // enforced, and only a config with NO usable repo entry takes the loud fail-open.
  // ---------------------------------------------------------------------------

  const repoWith = (over) => ({ version: 1, repos: [{ ...FIX.repos[0], ...over }] });

  test('malformed: codeDirs ["src", 1] -> the 1 is dropped loudly; src is still code -> deny', () => {
    const home = homeWith('bad-codedirs', repoWith({ codeDirs: ['src', 1] }));
    const a = runHook(home, path.win32.join(repo, 'src', 'a.ts'));
    hookDenied(a);
    loudAbout(a, 'repos[0].codeDirs');
  });
  test('malformed: scriptExts [null] -> dropped loudly; the other rules still apply (package.json -> deny); the scripts allow is loud', () => {
    const home = homeWith('bad-scriptexts', repoWith({ scriptExts: [null] }));
    const a = runHook(home, path.win32.join(repo, 'package.json'));
    hookDenied(a);
    loudAbout(a, 'repos[0].scriptExts');
    const b = runHook(home, path.win32.join(repo, 'scripts', 'b.mjs')); // no valid script extension is left
    hookNotDenied(b);
    loudAbout(b, 'repos[0].scriptExts');
  });
  test('malformed: rootCodeFiles [{}] -> dropped loudly; the script rule still applies (scripts\\b.mjs -> deny); the package.json allow is loud', () => {
    const home = homeWith('bad-rootfiles', repoWith({ rootCodeFiles: [{}] }));
    const a = runHook(home, path.win32.join(repo, 'scripts', 'b.mjs'));
    hookDenied(a);
    loudAbout(a, 'repos[0].rootCodeFiles');
    const b = runHook(home, path.win32.join(repo, 'package.json')); // no valid root file name is left
    hookNotDenied(b);
    loudAbout(b, 'repos[0].rootCodeFiles');
  });
  test('malformed: primary 42 in the only entry -> no usable entry -> the existing loud fail-open (INACTIVE, malformed)', () => {
    const home = homeWith('bad-primary', repoWith({ primary: 42 }));
    const a = runHook(home, path.win32.join(repo, 'src', 'a.ts'));
    hookNotDenied(a);
    assert.match(a.o.systemMessage || '', /INACTIVE/, JSON.stringify(a.o));
    assert.match(a.o.systemMessage, /malformed/);
    assert.match(a.o.systemMessage, /repos\[0\]\.primary/);
    assert.match(a.r.stderr, /\[write-target-guard\] INACTIVE: malformed config/);
  });
  test('malformed: repos [null, <valid>] -> the null entry is dropped loudly; the valid repo is still guarded -> deny', () => {
    const home = homeWith('null-repo', { version: 1, repos: [null, FIX.repos[0]] });
    const a = runHook(home, path.win32.join(repo, 'src', 'a.ts'));
    hookDenied(a);
    loudAbout(a, 'repos[0]');
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 (fix C) drive-relative (C:foo) and rooted-relative (\foo) targets are
  // DENIED for every write: Windows resolves them against a per-drive current directory the
  // guard cannot see. Every case also makes a REAL write of the same string (Node, which the
  // Write/Edit tools use) from a cwd inside the fixture, proving where it would have landed.
  // ---------------------------------------------------------------------------

  let fixcSeq = 0;
  const uniq = (ext = 'ts') => `wtg-fixc-${process.pid}-${++fixcSeq}.${ext}`;
  const fixcDirs = () => {
    for (const d of ['src', 'docs', 'scripts', path.win32.join('docs', 'src')]) mkdirSync(path.win32.join(repo, d), { recursive: true });
    mkdirSync(path.win32.join(tmp, 'outside'), { recursive: true });
  };
  // A REAL Node write (fs.writeFileSync: what the Write/Edit tools use) of `raw` from `cwd`.
  const nodeWriteFrom = (cwd, raw) => (spawnSync(process.execPath, ['-e',
    'try{require("fs").writeFileSync(JSON.parse(process.argv[1]),"probe");console.log("WROTE")}catch(e){console.log("ERR "+e.code)}',
    JSON.stringify(raw)], { cwd, encoding: 'utf8' }).stdout || '').trim();
  // A REAL plain Win32 write (Python open(): CreateFileW with Win32 path normalisation, no
  // \\?\ prefix), or null when python is not on PATH (the Win32 half of a case then skips).
  let pyOk;
  const win32WriteFrom = (cwd, raw) => {
    if (pyOk === undefined) pyOk = (spawnSync('python', ['-c', 'print("ok")'], { encoding: 'utf8' }).stdout || '').trim() === 'ok';
    if (!pyOk) return null;
    return (spawnSync('python', ['-c',
      'import json,sys;f=open(json.loads(sys.argv[1]),"w");f.write("probe");f.close();print("WROTE")',
      JSON.stringify(raw)], { cwd, encoding: 'utf8' }).stdout || '').trim();
  };
  // The write of `raw` from `cwd` lands at `expected` (checked literally, then removed).
  const landed = (expected) => {
    const lit = '\\\\?\\' + expected;
    const ok = existsSync(lit);
    if (ok) unlinkSync(lit);
    return ok;
  };
  const landsAt = (cwd, raw, expected) => {
    assert.equal(nodeWriteFrom(cwd, raw), 'WROTE', `a Node write of ${raw} from ${cwd}`);
    assert.ok(landed(expected), `a Node write of ${raw} from ${cwd} should land at ${expected}`);
  };
  const landsAtWin32 = (t, cwd, raw, expected) => {
    const w = win32WriteFrom(cwd, raw);
    if (w === null) { t.diagnostic('python not on PATH: the Win32-writer half of this case is not checked'); return; }
    assert.equal(w, 'WROTE', `a Win32 write of ${raw} from ${cwd}`);
    assert.ok(landed(expected), `a Win32 write of ${raw} from ${cwd} should land at ${expected}`);
  };
  const relDenied = (d) => {
    denied(d);
    assert.match(d.reason, /drive-relative .* or rooted-relative/, d.reason);
    assert.match(d.reason, /fully qualified path/, d.reason);
  };
  const dl = () => repo.slice(0, 2); // the fixture's drive, e.g. "C:"
  const nodrive = (p) => p.slice(2); // "\Users\...\my-project"

  test('fix C: drive-relative C:..\\src\\x.ts (written from <primary>\\docs) -> deny, Write and Edit; it really lands in <primary>\\src', () => {
    fixcDirs();
    const f = uniq();
    const raw = dl() + '..\\src\\' + f;
    relDenied(D(write(raw)));
    relDenied(D(edit(raw)));
    landsAt(path.win32.join(repo, 'docs'), raw, path.win32.join(repo, 'src', f));
  });
  test('fix C: drive-relative C:.\\src\\x.ts (written from the primary root) -> deny; it really lands in <primary>\\src', () => {
    fixcDirs();
    const f = uniq();
    const raw = dl() + '.\\src\\' + f;
    relDenied(D(write(raw)));
    landsAt(repo, raw, path.win32.join(repo, 'src', f));
  });
  test('fix C: drive-relative C:..\\..\\..\\src\\x.ts from a feat/* worktree -> deny; it really lands in <primary>\\src', () => {
    fixcDirs();
    const f = uniq();
    const raw = dl() + '..\\..\\..\\src\\' + f;
    relDenied(D(write(raw)));
    landsAt(wt('feat-wt'), raw, path.win32.join(repo, 'src', f));
  });
  test('fix C: drive-relative C:src\\x.ts and C:../src/x.ts (forward slashes) -> deny, with the relative-path message', () => {
    fixcDirs();
    const f = uniq();
    relDenied(D(write(dl() + 'src\\' + f)));
    landsAt(repo, dl() + 'src\\' + f, path.win32.join(repo, 'src', f));
    const g = uniq();
    relDenied(D(write(dl() + '../src/' + g)));
    landsAt(path.win32.join(repo, 'docs'), dl() + '../src/' + g, path.win32.join(repo, 'src', g));
  });
  test('fix C: drive-relative targets are denied for EVERY write: non-code (C:x.md) and outside the repo (C:..\\outside\\x.ts)', () => {
    fixcDirs();
    const f = uniq('md');
    relDenied(D(write(dl() + f)));
    landsAt(path.win32.join(repo, 'docs'), dl() + f, path.win32.join(repo, 'docs', f));
    const g = uniq();
    relDenied(D(write(dl() + '..\\outside\\' + g)));
    landsAt(repo, dl() + '..\\outside\\' + g, path.win32.join(tmp, 'outside', g));
    relDenied(D(write(dl()))); // a bare drive is drive-relative too
  });
  test('fix C: drive-relative behind a device prefix (\\\\?\\C:..\\src, \\??\\C:..\\src) -> deny', () => {
    denied(D(write('\\\\?\\' + dl() + '..\\src\\a.ts')));
    denied(D(write('\\??\\' + dl() + '..\\src\\a.ts')));
  });
  test('fix C: rooted-relative \\<primary-without-drive>\\src\\x.ts and /<...>/src/x.ts -> deny; they really land in <primary>\\src', () => {
    fixcDirs();
    const f = uniq();
    const raw = nodrive(repo) + '\\src\\' + f;
    const d = D(write(raw));
    relDenied(d);
    assert.ok(d.reason.includes(raw), d.reason);
    landsAt(tmp, raw, path.win32.join(repo, 'src', f));
    const g = uniq();
    const fwd = nodrive(repo).replace(/\\/g, '/') + '/src/' + g;
    relDenied(D(write(fwd)));
    landsAt(tmp, fwd, path.win32.join(repo, 'src', g));
  });
  test('fix C: rooted-relative targets are denied for EVERY write: non-code outside the repo (\\<tmp>\\outside\\x.md)', () => {
    fixcDirs();
    const f = uniq('md');
    const raw = nodrive(tmp) + '\\outside\\' + f;
    relDenied(D(write(raw)));
    landsAt(tmp, raw, path.win32.join(tmp, 'outside', f));
  });
  test('fix C END-TO-END: spawned hook, cwd <primary>\\docs, Write C:..\\src\\x.ts -> deny with the relative-path message', () => {
    fixcDirs();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(write(dl() + '..\\src\\' + uniq())),
      encoding: 'utf8', env: childEnv(homeValid), cwd: path.win32.join(repo, 'docs'),
    });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision, 'deny', r.stdout);
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /fully qualified path/);
  });
  test('fix C: a PLAIN relative path is unchanged: it resolves against the hook process cwd (src\\x.ts: deny from the primary, allow from a feat worktree)', () => {
    fixcDirs();
    mkdirSync(path.win32.join(wt('feat-wt'), 'src'), { recursive: true });
    const run = (cwd, raw) => {
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write(raw)), encoding: 'utf8', env: childEnv(homeValid), cwd });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const f = uniq();
    const a = run(repo, 'src\\' + f);
    assert.equal(a.hookSpecificOutput && a.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(a));
    assert.doesNotMatch(a.hookSpecificOutput.permissionDecisionReason, /fully qualified path/);
    landsAt(repo, 'src\\' + f, path.win32.join(repo, 'src', f));
    const g = uniq();
    const b = run(wt('feat-wt'), 'src\\' + g);
    assert.equal(b.hookSpecificOutput, undefined, JSON.stringify(b));
    landsAt(wt('feat-wt'), 'src\\' + g, path.win32.join(wt('feat-wt'), 'src', g));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 (fix C) . and .. are never trimmed: a segment made only of dots and/or
  // spaces (" ", ". .", ".. ", " .", "...") is ONE literal segment to every Windows writer, so
  // a following ".." cancels IT, not the segment before it. Each case makes real writes.
  // ---------------------------------------------------------------------------

  for (const seg of [' ', '. .', '.. ', ' .', '...']) {
    test(`fix C: <primary>\\src\\${JSON.stringify(seg)}\\..\\x.ts -> deny; it really lands in <primary>\\src (Node and Win32)`, (t) => {
      fixcDirs();
      const f = uniq();
      const raw = repo + '\\src\\' + seg + '\\..\\' + f;
      denied(D(write(raw)));
      landsAt(tmp, raw, path.win32.join(repo, 'src', f));
      const g = uniq();
      landsAtWin32(t, tmp, repo + '\\src\\' + seg + '\\..\\' + g, path.win32.join(repo, 'src', g));
    });
  }
  test('fix C: nested <primary>\\src\\sub\\..\\. .\\..\\x.ts and <primary>\\docs\\ \\..\\..\\src\\x.ts -> deny; both really land in <primary>\\src', (t) => {
    fixcDirs();
    for (const mk of [(f) => repo + '\\src\\sub\\..\\. .\\..\\' + f, (f) => repo + '\\docs\\ \\..\\..\\src\\' + f, (f) => repo + '\\docs\\. .\\..\\..\\src\\' + f]) {
      const f = uniq();
      denied(D(write(mk(f))));
      landsAt(tmp, mk(f), path.win32.join(repo, 'src', f));
      const g = uniq();
      landsAtWin32(t, tmp, mk(g), path.win32.join(repo, 'src', g));
    }
  });
  test('fix C: <primary>\\docs\\. .\\..\\src\\x.ts -> allow (the ". ." segment is cancelled, not docs); it really lands in <primary>\\docs\\src', (t) => {
    fixcDirs();
    const f = uniq();
    const raw = repo + '\\docs\\. .\\..\\src\\' + f;
    allowed(D(write(raw)));
    landsAt(tmp, raw, path.win32.join(repo, 'docs', 'src', f));
    const g = uniq();
    landsAtWin32(t, tmp, repo + '\\docs\\. .\\..\\src\\' + g, path.win32.join(repo, 'docs', 'src', g));
  });
  test('fix C: <primary>\\docs\\.. \\src\\x.ts and <primary>\\docs\\...\\src\\x.ts -> allow (".. " and "..." are names, not ".."); they really land under docs', (t) => {
    fixcDirs();
    const dd = path.win32.join(repo, 'docs') + '\\.. \\src';
    const d3 = path.win32.join(repo, 'docs') + '\\...\\src';
    mkdirSync('\\\\?\\' + dd, { recursive: true }); // only creatable through \\?\ (no trimming)
    mkdirSync('\\\\?\\' + d3, { recursive: true });
    try {
      const f = uniq();
      allowed(D(write(repo + '\\docs\\.. \\src\\' + f)));
      landsAt(tmp, repo + '\\docs\\.. \\src\\' + f, dd + '\\' + f);
      const g = uniq();
      landsAtWin32(t, tmp, repo + '\\docs\\.. \\src\\' + g, dd + '\\' + g);
      const h = uniq();
      allowed(D(write(repo + '\\docs\\...\\src\\' + h)));
      landsAt(tmp, repo + '\\docs\\...\\src\\' + h, d3 + '\\' + h);
      const k = uniq();
      landsAtWin32(t, tmp, repo + '\\docs\\...\\src\\' + k, d3 + '\\' + k);
    } finally {
      rmSync('\\\\?\\' + path.win32.join(repo, 'docs') + '\\.. ', { recursive: true, force: true });
      rmSync('\\\\?\\' + path.win32.join(repo, 'docs') + '\\...', { recursive: true, force: true });
    }
  });
  test('fix C: a name with dots/spaces AND other characters is still trimmed (<primary>\\src. \\a.ts -> deny)', () => {
    denied(D(write(repo + '\\src. \\a.ts')));
    denied(D(write(repo + '\\src.\\a.ts')));
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 (fix C) the NT-namespace \??\ prefix is handled like \\?\ (a plain Win32
  // writer passes it straight through: Python open() lands \??\<P>\src\x.ts in <P>\src).
  // ---------------------------------------------------------------------------

  test('fix C: \\??\\<primary>\\src\\a.ts -> deny (primary rule, not a device refusal); a Win32 write really lands in <primary>\\src', (t) => {
    fixcDirs();
    const d = inPrimary('\\??\\' + repo + '\\src\\a.ts');
    denied(d);
    assert.doesNotMatch(d.reason, /device or volume namespace/);
    denied(inPrimary('/??/' + repo.replace(/\\/g, '/') + '/src/a.ts'));
    const g = uniq();
    landsAtWin32(t, tmp, '\\??\\' + repo + '\\src\\' + g, path.win32.join(repo, 'src', g));
  });
  test('fix C: \\??\\<primary>\\docs\\x.md and \\??\\<sibling>\\src\\a.ts -> allow; the docs write really lands in <primary>\\docs', (t) => {
    fixcDirs();
    const f = uniq('md');
    allowed(inPrimary('\\??\\' + repo + '\\docs\\' + f));
    allowed(inPrimary('\\??\\' + repo + '-sibling\\src\\a.ts'));
    landsAtWin32(t, tmp, '\\??\\' + repo + '\\docs\\' + f, path.win32.join(repo, 'docs', f));
  });
  test('fix C: \\??\\UNC\\localhost\\<d>$\\...\\src\\a.ts -> deny (folded to the drive); a Win32 write really lands in <primary>\\src', (t) => {
    fixcDirs();
    denied(inPrimary('\\??\\UNC\\localhost\\' + drive() + '$' + tail()));
    const g = uniq();
    landsAtWin32(t, tmp, '\\??\\UNC\\localhost\\' + drive() + '$' + nodrive(repo) + '\\src\\' + g, path.win32.join(repo, 'src', g));
  });
  test('fix C: \\??\\UNC\\fileserver\\share\\x.md -> deny (unresolvable UNC target); \\??\\Volume{GUID} and \\??\\GLOBALROOT -> deny (device)', () => {
    uncDenied(inPrimary('\\??\\UNC\\fileserver\\share\\x.md'));
    const v = inPrimary('\\??\\Volume{00000000-0000-0000-0000-000000000000}\\my-project\\src\\a.ts');
    denied(v);
    assert.match(v.reason, /device or volume namespace/);
    const g = inPrimary('\\??\\GLOBALROOT\\Device\\HarddiskVolume1\\x.md');
    denied(g);
    assert.match(g.reason, /device or volume namespace/);
    denied(inPrimary('\\??\\\\\\?\\' + repo + '\\docs\\x.md')); // a doubled device prefix is not unwrapped twice
  });

  // ---------------------------------------------------------------------------
  // NEW — 2026-10-03 (fix C) NotebookEdit (tool_input.notebook_path, new_source) and MultiEdit
  // (tool_input.file_path, edits[].new_string) are guarded exactly like Write and Edit.
  // ---------------------------------------------------------------------------

  const nb = (file, src = 'x') => ({ tool_name: 'NotebookEdit', tool_input: { notebook_path: file, new_source: src, cell_type: 'code', edit_mode: 'replace' } });
  const me = (file, ...news) => ({ tool_name: 'MultiEdit', tool_input: { file_path: file, edits: news.map((n) => ({ old_string: 'a', new_string: n })) } });

  test('fix C: NotebookEdit into the primary src -> deny; with the ack in new_source -> allow', () => {
    denied(D(nb(path.win32.join(repo, 'src', 'a.ipynb'))));
    allowed(D(nb(path.win32.join(repo, 'src', 'a.ipynb'), '# guard-ack: primary-worktree')));
  });
  test('fix C: NotebookEdit: feat/* worktree -> allow; claude/* worktree -> deny; primary docs -> allow; outside -> allow', () => {
    allowed(D(nb(path.win32.join(wt('feat-wt'), 'src', 'a.ipynb'))));
    denied(D(nb(path.win32.join(wt('claude-auto'), 'src', 'a.ipynb'))));
    allowed(D(nb(path.win32.join(repo, 'docs', 'a.ipynb'))));
    allowed(D(nb(path.win32.join(tmp, 'elsewhere', 'src', 'a.ipynb'))));
  });
  test('fix C: NotebookEdit with a drive-relative notebook_path -> deny; a file_path-only payload is still guarded', () => {
    relDenied(D(nb(dl() + '..\\src\\a.ipynb')));
    denied(D({ tool_name: 'NotebookEdit', tool_input: { file_path: path.win32.join(repo, 'src', 'a.ipynb'), new_source: 'x' } }));
  });
  test('fix C: MultiEdit into the primary src -> deny; an ack in any edit\'s new_string -> allow; an ack only in old_string -> deny', () => {
    const f = path.win32.join(repo, 'src', 'a.ts');
    denied(D(me(f, 'x', 'y')));
    allowed(D(me(f, 'x', '// guard-ack: primary-worktree')));
    denied(D({ tool_name: 'MultiEdit', tool_input: { file_path: f, edits: [{ old_string: '// guard-ack: primary-worktree', new_string: 'x' }] } }));
    denied(D({ tool_name: 'MultiEdit', tool_input: { file_path: f, edits: 'not-a-list' } }));
    denied(D({ tool_name: 'MultiEdit', tool_input: { file_path: f, edits: [null, 7, { new_string: 'x' }] } }));
  });
  test('fix C: MultiEdit: feat/* worktree -> allow; claude/* worktree -> deny; primary docs -> allow; rooted-relative -> deny', () => {
    allowed(D(me(path.win32.join(wt('feat-wt'), 'src', 'a.ts'), 'x')));
    denied(D(me(path.win32.join(wt('claude-auto'), 'src', 'a.ts'), 'x')));
    allowed(D(me(path.win32.join(repo, 'docs', 'a.md'), 'x')));
    relDenied(D(me(nodrive(repo) + '\\src\\a.ts', 'x')));
  });
  test('fix C END-TO-END: spawned hook denies a NotebookEdit and a MultiEdit into the primary src', () => {
    for (const input of [nb(path.win32.join(repo, 'src', 'a.ipynb')), me(path.win32.join(repo, 'src', 'a.ts'), 'x')]) {
      const r = spawnHook(homeValid, input);
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.equal(o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision, 'deny', r.stdout);
    }
  });
  test('fix C: the plugin hooks.json PreToolUse matcher covers Write, Edit, MultiEdit and NotebookEdit (and not Read/Bash)', () => {
    const hj = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
    const matchers = hj.hooks.PreToolUse.filter((e) => e.hooks.some((h) => (h.args || []).some((a) => /write-target-guard\.mjs$/.test(a)))).map((e) => new RegExp(e.matcher));
    assert.equal(matchers.length, 1);
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(matchers[0].test(tool), tool);
    for (const tool of ['Read', 'Bash', 'NotebookRead', 'WriteX']) assert.ok(!matchers[0].test(tool), tool);
  });
});
