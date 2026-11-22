// worktree-remove-safe: the script (a real junction / directory symlink inside a real worktree
// is removed as a link and its target survives) and the bash-tail hook's step 0 (a
// `git worktree remove` of a tree holding a link is rewritten to the script; anything else
// passes through; a rewrite that is not clean is a denial).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHook } from './helpers.mjs';
import { findLinks, removeLink, parseArgs, run } from '../scripts/worktree-remove-safe.mjs';
import { worktreeRemoveDecision, SAFE_SCRIPT } from '../hooks/lib/worktree-remove.mjs';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const SCRIPT = resolve(SAFE_SCRIPT);
const slash = (p) => p.replace(/\\/g, '/');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', windowsHide: true });

// A repo with one worktree whose node_modules is a junction (directory symlink off Windows)
// to a separate target that holds files; node_modules is ignored, as in a real project.
function scene({ link = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wrs-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.');
  assert.equal(git(repo, 'commit', '-q', '-m', 'init').status, 0);
  const tree = join(root, 'tree');
  assert.equal(git(repo, 'worktree', 'add', '-q', '-b', 'wt', tree).status, 0);
  const target = join(root, 'shared-node-modules');
  mkdirSync(join(target, 'pkg'), { recursive: true });
  writeFileSync(join(target, 'pkg', 'index.js'), 'x');
  writeFileSync(join(target, 'top.txt'), 'x');
  if (link) symlinkSync(target, join(tree, 'node_modules'), 'junction');
  return { root, repo, tree, target, done: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}
const targetIntact = (s) => existsSync(join(s.target, 'pkg', 'index.js')) && existsSync(join(s.target, 'top.txt'));

// --- Node removes a junction without touching its target ------------------------------------------

test('proof: unlinkSync removes a junction / directory symlink and leaves the target alone', () => {
  const s = scene();
  try {
    const link = join(s.tree, 'node_modules');
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'lstat sees the junction as a link');
    assert.equal(removeLink(link), true);
    assert.equal(existsSync(link), false);
    assert.equal(targetIntact(s), true, 'the target is not emptied');
  } finally { s.done(); }
});

// --- findLinks / parseArgs ---------------------------------------------------------------------

test('findLinks: does not descend into a link, skips .git, and is bounded on request', () => {
  const s = scene();
  try {
    // a link INSIDE the link target must not be reported (the walk never follows)
    symlinkSync(s.root, join(s.target, 'inner-link'), 'junction');
    mkdirSync(join(s.tree, 'src', 'deep'), { recursive: true });
    symlinkSync(s.root, join(s.tree, 'src', 'deep', 'ln'), 'junction');
    const { links, truncated } = findLinks(s.tree);
    assert.equal(truncated, false);
    assert.deepEqual(links.map((l) => slash(l).slice(slash(s.tree).length + 1)).sort(), ['node_modules', 'src/deep/ln']);
    assert.equal(findLinks(s.tree, { first: true }).links.length, 1);
    assert.equal(findLinks(s.tree, { maxEntries: 1 }).truncated, true);
    assert.equal(findLinks(join(s.root, 'missing')).links.length, 0, 'a missing tree is empty, not an error');
  } finally { s.done(); }
});

test('parseArgs: -C, --force, -f and a cluster; anything else is refused', () => {
  assert.deepEqual(parseArgs(['p']), { dir: null, forces: 0, path: 'p' });
  assert.deepEqual(parseArgs(['-C', 'r', '--force', 'p']), { dir: 'r', forces: 1, path: 'p' });
  assert.deepEqual(parseArgs(['p', '-f', '-f']), { dir: null, forces: 2, path: 'p' });
  assert.deepEqual(parseArgs(['-ff', 'p']), { dir: null, forces: 2, path: 'p' });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['a', 'b']), null);
  assert.equal(parseArgs(['--weird', 'a']), null);
  assert.equal(parseArgs(['-C']), null);
});

// --- the script, run for real ----------------------------------------------------------------------

function runScript(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
}

test('script: removes the link as a link, keeps the target, then git removes the worktree', () => {
  const s = scene();
  try {
    const r = runScript([s.tree], s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed 1 link \(targets untouched\): node_modules/);
    assert.equal(existsSync(s.tree), false, 'the worktree is gone');
    assert.equal(targetIntact(s), true, 'the junction target was not emptied');
  } finally { s.done(); }
});

test('script: -C and --force are handled (relative path, other cwd, untracked file needs --force)', () => {
  const s = scene();
  try {
    writeFileSync(join(s.tree, 'untracked.txt'), 'u');
    const refused = runScript(['-C', s.repo, '../tree'], s.root);
    assert.notEqual(refused.status, 0, 'git refuses an untracked file without --force, and the exit code passes through');
    assert.equal(existsSync(s.tree), true);
    const r = runScript(['-C', s.repo, '--force', '../tree'], s.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.tree), false);
    assert.equal(targetIntact(s), true);
  } finally { s.done(); }
});

test('script: a tree with no links goes straight to git, with no extra output', () => {
  const s = scene({ link: false });
  try {
    const r = runScript(['-f', s.tree], s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(s.tree), false);
  } finally { s.done(); }
});

test('script: git failure and usage errors pass their exit code through', () => {
  const s = scene({ link: false });
  try {
    const missing = runScript([join(s.root, 'nope')], s.repo);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /nope|not a working tree|is not/i);
    assert.equal(runScript([], s.repo).status, 2);
    assert.equal(run(['a', 'b'], { cwd: s.repo }).status, 2);
  } finally { s.done(); }
});

// --- the decision (pure; real trees) ------------------------------------------------------------

const decide = (cmd, s, extra = {}) => worktreeRemoveDecision(cmd, { cwd: s.repo, ...extra });
const treeArg = (s) => slash(s.tree);

test('decision: a tree with a link is rewritten in place, keeping flags, -C and the rest of the line', () => {
  const s = scene();
  try {
    const d = decide(`git worktree remove ${treeArg(s)}`, s);
    assert.equal(d.action, 'rewrite');
    assert.equal(d.command, `node '${slash(SCRIPT)}' ${treeArg(s)}`);

    const f = decide(`git worktree remove --force ${treeArg(s)}`, s);
    assert.equal(f.command, `node '${slash(SCRIPT)}' --force ${treeArg(s)}`);
    const f2 = decide(`git worktree remove -f -f "${treeArg(s)}"`, s);
    assert.equal(f2.command, `node '${slash(SCRIPT)}' -f -f "${treeArg(s)}"`);

    const c = decide(`git -C ${slash(s.repo)} worktree remove --force ../tree && echo done`, { ...s, repo: s.root });
    assert.equal(c.action, 'rewrite');
    assert.equal(c.command, `node '${slash(SCRIPT)}' -C ${slash(s.repo)} --force ../tree && echo done`);

    const keep = decide(`git fetch; git worktree remove ${treeArg(s)} 2>&1 | tail -1`, s);
    assert.equal(keep.command, `git fetch; node '${slash(SCRIPT)}' ${treeArg(s)} 2>&1 | tail -1`);
  } finally { s.done(); }
});

test('decision: relative path follows a cd earlier in the command', () => {
  const s = scene();
  try {
    const d = worktreeRemoveDecision(`cd ${slash(s.root)} && git worktree remove tree`, { cwd: tmpdir() });
    assert.equal(d.action, 'rewrite');
    assert.match(d.command, /^cd .* && node '.*worktree-remove-safe\.mjs' tree$/);
  } finally { s.done(); }
});

test('decision: no link or another command passes through untouched; a path not found as typed is rewritten (unknown)', () => {
  const s = scene({ link: false });
  try {
    assert.equal(decide(`git worktree remove ${treeArg(s)}`, s).action, 'none');
    assert.equal(decide(`git worktree remove ${slash(s.root)}/nope`, s).action, 'rewrite', 'git may resolve it by suffix: the script decides');
    assert.equal(decide('git worktree list', s).action, 'none');
    assert.equal(decide('git worktree add ../x', s).action, 'none');
    assert.equal(decide('echo "git worktree remove x"', s).action, 'none', 'text inside a quoted word is not a command');
    assert.equal(decide('git status', s).action, 'none');
    assert.equal(decide('', s).action, 'none');
  } finally { s.done(); }
});

test('decision: several removes, a variable path (loop), and each only when it needs it', () => {
  const s = scene();
  const plain = scene({ link: false });
  try {
    const both = decide(`git worktree remove ${slash(plain.tree)}; git worktree remove ${treeArg(s)}`, s);
    assert.equal(both.action, 'rewrite');
    assert.equal(both.count, 1);
    assert.ok(both.command.startsWith(`git worktree remove ${slash(plain.tree)}; node `), 'the link-free one is left alone');

    const loop = decide('for d in a b; do git worktree remove $d; done', s);
    assert.equal(loop.action, 'rewrite', 'a path the text cannot show is sent through the script, which is a safe superset');
    assert.equal(loop.command, `for d in a b; do node '${slash(SCRIPT)}' $d; done`);
  } finally { s.done(); plain.done(); }
});

test('decision: a compound line that cannot be rewritten cleanly is denied, with the manual fix and the script command', () => {
  const s = scene();
  try {
    for (const cmd of [
      `git -c core.x=1 worktree remove ${treeArg(s)} && echo ok`,
      `git worktree remove --no-such-flag ${treeArg(s)}; echo ok`,
      `cat <<EOF\nhi\nEOF\ngit worktree remove ${treeArg(s)}`,
    ]) {
      const d = decide(cmd, s);
      assert.equal(d.action, 'deny', cmd);
      assert.match(d.text, /cmd \/c rmdir <link>/, 'the manual steps are in the text');
      assert.match(d.text, /Get-Item/);
      assert.match(d.text, /worktree-remove-safe\.mjs/, 'the script command is in the text');
    }
  } finally { s.done(); }
});

test('decision: PowerShell is a denial carrying the rewritten command unless psRewrite is on', () => {
  const s = scene();
  try {
    const cmd = `& git worktree remove '${s.tree}'`;
    const off = decide(cmd, s, { shell: 'powershell' });
    assert.equal(off.action, 'deny');
    assert.ok(off.text.includes(`node '${slash(SCRIPT)}' '${s.tree}'`), 'the exact command to run instead is in the denial');
    const on = decide(cmd, s, { shell: 'powershell', psRewrite: true });
    assert.equal(on.action, 'rewrite');
    assert.equal(on.command, `& node '${slash(SCRIPT)}' '${s.tree}'`);
    assert.equal(decide(`git -C '${s.repo}' worktree remove -f '${s.tree}'`, s, { shell: 'powershell', psRewrite: true }).command, `node '${slash(SCRIPT)}' -C '${s.repo}' -f '${s.tree}'`);
  } finally { s.done(); }
});

// --- the hook, end to end --------------------------------------------------------------------------

const payload = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-wrs', tool_name: 'Bash', tool_input: { command, description: 'd' },
  permission_mode: 'bypassPermissions', ...extra,
  // The hook walks up from cwd reading project settings; the scene lives under the real home (tmpdir), where that walk would
  // reach the operator's own settings.json. The sandbox home is the walk's stop, so the commands below use absolute paths.
  cwd: process.env.AGENT_COMPANION_HOME_OVERRIDE,
});

test('hook: rewrites through updatedInput (any permission mode, no permissionDecision), and the rewritten line really runs safely', () => {
  const s = scene();
  try {
    const cmd = `git -C ${slash(s.repo)} worktree remove ${slash(s.tree)}`;
    for (const mode of ['bypassPermissions', 'default']) {
      const r = runHook('hooks/bash-tail.mjs', payload(cmd, { cwd: s.repo, permission_mode: mode }), { env: {} });
      assert.equal(r.status, 0);
      const out = r.json.hookSpecificOutput;
      assert.equal(out.permissionDecision, undefined);
      assert.equal(out.updatedInput.description, 'd', 'other tool_input fields pass through');
      assert.equal(out.updatedInput.command, `node '${slash(SCRIPT)}' -C ${slash(s.repo)} ${slash(s.tree)}`);
    }
    const r = runHook('hooks/bash-tail.mjs', payload(cmd, { cwd: s.repo }), { env: {} });
    const ran = spawnSync(BASH, ['-c', r.json.hookSpecificOutput.updatedInput.command], { cwd: s.repo, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(existsSync(s.tree), false);
    assert.equal(targetIntact(s), true, 'the target survived the rewritten command');
    assert.deepEqual(readdirSync(s.target).sort(), ['pkg', 'top.txt']);
  } finally { s.done(); }
});

test('hook: a tree with no link, another command, and the opt-out all pass through with no output', () => {
  const s = scene({ link: false });
  const withLink = scene();
  try {
    const none = runHook('hooks/bash-tail.mjs', payload(`git worktree remove ${slash(s.tree)}`, { cwd: s.repo }), { env: {} });
    assert.equal(none.status, 0);
    assert.equal(none.json, null);
    assert.equal(runHook('hooks/bash-tail.mjs', payload('git status', { cwd: s.repo }), { env: {} }).json, null);
    const off = runHook('hooks/bash-tail.mjs', payload(`git worktree remove ${slash(withLink.tree)}`, { cwd: withLink.repo }), { env: { CLAUDE_PLUGIN_OPTION_WORKTREE_REMOVE_SAFE: '0' } });
    assert.equal(off.json, null, 'worktree_remove_safe=false leaves the command alone');
  } finally { s.done(); withLink.done(); }
});

test('hook: a compound line it cannot rewrite cleanly is denied; PowerShell is denied with the command to run', () => {
  const s = scene();
  try {
    const deny = runHook('hooks/bash-tail.mjs', payload(`git -c a=b worktree remove ${slash(s.tree)} && echo ok`, { cwd: s.repo }), { env: {} });
    assert.equal(deny.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.json.hookSpecificOutput.permissionDecisionReason, /cmd \/c rmdir/);
    const ps = runHook('hooks/bash-tail.mjs', payload(`git worktree remove '${s.tree}'`, { cwd: s.repo, tool_name: 'PowerShell' }), { env: {} });
    assert.equal(ps.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(ps.json.hookSpecificOutput.permissionDecisionReason.includes('worktree-remove-safe.mjs'));
  } finally { s.done(); }
});

// --- review round 2: the gaps the first review found ---------------------------------------------

test('decision: a double-quoted backslash path (Windows style) is seen, not mangled to C:Usersx', () => {
  const s = scene();
  try {
    const bs = s.tree; // native separators: backslashes on Windows
    const d = decide(`git worktree remove "${bs}"`, s);
    assert.equal(d.action, 'rewrite');
    assert.equal(d.command, `node '${slash(SCRIPT)}' "${bs}"`);
    const esc = decide(`git worktree remove "${bs.replace(/\\/g, '\\\\')}"`, s);
    assert.equal(esc.action, 'rewrite', 'an escaped backslash is one backslash');
  } finally { s.done(); }
});

test('decision: a bare worktree name (git resolves it by unique suffix) is rewritten, and the script keeps the target safe', () => {
  const s = scene();
  try {
    const d = decide('git worktree remove tree', s); // cwd is the repo; the tree is ../tree
    assert.equal(d.action, 'rewrite');
    assert.equal(d.command, `node '${slash(SCRIPT)}' tree`);
    const r = runScript(['tree'], s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.tree), false, 'git resolved the suffix name and removed the tree');
    assert.equal(targetIntact(s), true, 'the target survived: links are unlinked before git sees a suffix name');
  } finally { s.done(); }
});

test('script: a worktree named in another letter case is found on Windows (git matches case-insensitively)', { skip: process.platform !== 'win32' }, () => {
  const s = scene();
  try {
    const r = runScript(['-f', 'TREE'], s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.tree), false);
    assert.equal(targetIntact(s), true, 'the link was unlinked before git saw the differently cased name');
  } finally { s.done(); }
});

test('script: no link is unlinked when git would refuse (dirty tree, main checkout, not a worktree)', () => {
  const s = scene();
  const plain = join(s.root, 'plain');
  try {
    writeFileSync(join(s.tree, 'dirty.txt'), 'x');
    const dirty = runScript([s.tree], s.repo);
    assert.notEqual(dirty.status, 0, 'git refuses a dirty tree without --force');
    assert.ok(lstatSync(join(s.tree, 'node_modules')).isSymbolicLink(), 'the link is still there');
    assert.equal(targetIntact(s), true);

    symlinkSync(s.target, join(s.repo, 'nm'), 'junction');
    const main = runScript([s.repo], s.tree);
    assert.notEqual(main.status, 0, 'git refuses the main checkout');
    assert.ok(lstatSync(join(s.repo, 'nm')).isSymbolicLink(), 'the main checkout keeps its link');

    mkdirSync(plain);
    symlinkSync(s.target, join(plain, 'nm'), 'junction');
    const other = runScript([plain], s.repo);
    assert.notEqual(other.status, 0, 'git refuses a directory that is not a worktree');
    assert.ok(lstatSync(join(plain, 'nm')).isSymbolicLink(), 'a plain directory keeps its link');
    assert.equal(targetIntact(s), true);
  } finally { s.done(); }
});

test('decision: git -c / -- over a tree with no link run as written; over a link they are denied or rewritten', () => {
  const plain = scene({ link: false });
  const s = scene();
  try {
    assert.equal(decide(`git -c core.longpaths=true worktree remove ${slash(plain.tree)}`, plain).action, 'none');
    assert.equal(decide(`git --no-pager worktree remove ${slash(plain.tree)}`, plain).action, 'none');
    assert.equal(decide(`git worktree remove -- ${slash(plain.tree)}`, plain).action, 'none');
    assert.equal(decide(`git worktree remove --no-such-flag ${slash(plain.tree)}`, plain).action, 'none');
    assert.equal(decide(`git -c core.longpaths=true worktree remove ${treeArg(s)}`, s).action, 'deny', 'a link: cannot be rebuilt, so denied');
    const dd = decide(`git worktree remove -- ${treeArg(s)}`, s);
    assert.equal(dd.action, 'rewrite');
    assert.equal(dd.command, `node '${slash(SCRIPT)}' ${treeArg(s)}`, '-- is dropped');
    assert.equal(decide('git -c a=b worktree remove $d', s).action, 'deny', 'an unknown path is not assumed link-free');
  } finally { s.done(); plain.done(); }
});

test('decision: command, env, time and sudo prefixes are looked through', () => {
  const s = scene();
  try {
    for (const prefix of ['command ', 'env ', 'env FOO=1 ', 'time ', 'time -p ', 'sudo ', 'FOO=1 command ', 'exec ', 'nohup ']) {
      const d = decide(`${prefix}git worktree remove ${treeArg(s)}`, s);
      assert.equal(d.action, 'rewrite', prefix);
      assert.equal(d.command, `${prefix}node '${slash(SCRIPT)}' ${treeArg(s)}`, prefix);
    }
  } finally { s.done(); }
});

test('hook: a heavy command beside a remove still gets the resource gate (deny, and rewrite with both rewrites)', () => {
  const s = scene();
  const out = mkdtempSync(join(tmpdir(), 'wrs-tail-'));
  try {
    const rm = `git worktree remove -f ${slash(s.tree)}`;
    const deny = runHook('hooks/bash-tail.mjs', payload(`npx vitest run && ${rm}`, { cwd: s.repo }), { env: { AGENT_COMPANION_BASH_TAIL_DIR: out, CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'deny' } });
    assert.equal(deny.json.hookSpecificOutput.permissionDecision, 'deny', 'the heavy command is denied, not waved through by the remove rewrite');
    const rew = runHook('hooks/bash-tail.mjs', payload(`npm ci && ${rm}`, { cwd: s.repo }), { env: { AGENT_COMPANION_BASH_TAIL_DIR: out, CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'rewrite' } });
    const cmd = rew.json.hookSpecificOutput.updatedInput.command;
    assert.match(cmd, /resource-queue/, 'the gate wrapped the heavy command');
    assert.match(cmd, /worktree-remove-safe\.mjs/, 'the remove is still rewritten');
  } finally { s.done(); rmSync(out, { recursive: true, force: true }); }
});
