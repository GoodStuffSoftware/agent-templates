#!/usr/bin/env node
// worktree-remove-safe: `git worktree remove` for a tree that holds junctions or directory symlinks.
//
// Why: on Windows, `git worktree remove` followed `node_modules` junctions inside the tree
// and emptied the junction TARGETS (2026-11-22: a primary checkout's server/ and client/
// node_modules, while removing 7 agent worktrees). The safe order is: find the links, remove
// each LINK ITSELF without recursing, then let git remove the rest.
//
//   node worktree-remove-safe.mjs [-C <repo>] [--force|-f]... <path>
//
// The walk never follows a link and skips `.git`, so its cost is the size of the REAL tree
// (a linked node_modules costs one lstat). Each link found is unlinked as a link only
// (fs.unlinkSync; Node removes a Windows junction or directory symlink without touching its
// target, proved in tests/worktree-remove-safe.test.mjs). One line names what was removed,
// then `git [-C <repo>] worktree remove [--force] <path>` runs with git's own output and exit code.
// Also correct on macOS and Linux, where a symlinked directory is unlinked the same way.

import { lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The links (junctions, directory symlinks, file symlinks) inside `tree`, never descending
 * into one and skipping `.git`. Breadth first, so top-level links (node_modules) come first.
 * `maxEntries` / `maxMs` bound the walk (default: unbounded); `first` stops at the first link.
 * Returns { links: [absolute path], truncated }.
 */
export function findLinks(tree, { maxEntries = Infinity, maxMs = Infinity, first = false } = {}) {
  const links = [];
  const t0 = Date.now();
  let seen = 0;
  let queue = [tree];
  let head = 0;
  while (head < queue.length) {
    const dir = queue[head++];
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name === '.git') continue;
      if (++seen > maxEntries || ((seen & 255) === 0 && Date.now() - t0 > maxMs)) return { links, truncated: true };
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        links.push(p);
        if (first) return { links, truncated: false };
      } else if (e.isDirectory()) {
        queue.push(p);
      } else if (!e.isFile()) {
        // An unknown entry type (some filesystems): ask lstat, which never follows.
        try { const st = lstatSync(p); if (st.isSymbolicLink()) { links.push(p); if (first) return { links, truncated: false }; } else if (st.isDirectory()) queue.push(p); } catch { /* gone */ }
      }
    }
    if (head > 4096) { queue = queue.slice(head); head = 0; }
  }
  return { links, truncated: false };
}

/** Remove one link as a link, never its target. Returns true when it is gone. */
export function removeLink(p) {
  try { unlinkSync(p); } catch (e) {
    // Older Node on Windows can refuse unlink on a directory link; rmdir removes the junction itself.
    try { rmdirSync(p); } catch { throw e; }
  }
  try { lstatSync(p); return false; } catch { return true; }
}

const norm = (p) => {
  const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/**
 * The registered worktree git would act on for `arg`, found the way git finds it (a unique path suffix
 * first, then the path itself), as { path, main, bare, locked } | null (none, or ambiguous). Asks git;
 * never guesses from the typed text.
 */
export function findWorktree(arg, { cwd, dir = null, git = 'git' } = {}) {
  const r = spawnSync(git, [...(dir ? ['-C', dir] : []), 'worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const list = [];
  for (const block of String(r.stdout).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) continue;
    list.push({ path: wt.slice(9), main: list.length === 0, bare: lines.includes('bare'), locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) });
  }
  const want = String(arg).replace(/\\/g, '/').replace(/\/+$/, '');
  const bySuffix = list.filter((w) => { const p = w.path.replace(/\\/g, '/'); return p === want || p.endsWith(`/${want}`); });
  if (bySuffix.length === 1) return bySuffix[0];
  if (bySuffix.length > 1) return null;
  const abs = norm(resolve(dir ? resolve(cwd, dir) : cwd, arg));
  const byPath = list.filter((w) => norm(w.path) === abs);
  return byPath.length === 1 ? byPath[0] : null;
}

/** Parse `[-C dir] [--force|-f]... <path>`: { dir, forces, path } or null. */
export function parseArgs(argv) {
  let dir = null;
  let forces = 0;
  let path = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-C') { if (i + 1 >= argv.length) return null; dir = argv[i + 1]; i += 1; continue; }
    if (a === '--force' || a === '-f') { forces += 1; continue; }
    if (/^-[A-Za-z]+$/.test(a) && /^-f+$/.test(a)) { forces += a.length - 1; continue; }
    if (path !== null || a.startsWith('-')) return null;
    path = a;
  }
  return path === null ? null : { dir, forces, path };
}

/** Remove the links in the tree, then run git. Returns { removed: [rel], status }. */
export function run(argv, { cwd = process.cwd(), out = (s) => process.stdout.write(s), git = 'git' } = {}) {
  const a = parseArgs(argv);
  if (!a) {
    process.stderr.write('usage: worktree-remove-safe.mjs [-C <repo>] [--force|-f] <path>\n');
    return { removed: [], status: 2 };
  }
  const removed = [];
  // Unlink only what git itself would go on to remove: a registered, non-main worktree, not locked unless
  // forced twice, and clean unless forced. Anything else goes straight to git, which refuses it with its
  // own message and leaves the links in place.
  const wt = findWorktree(a.path, { cwd, dir: a.dir, git });
  let tree = null;
  if (wt && !wt.main && !wt.bare && !(wt.locked && a.forces < 2)) {
    try {
      const st = lstatSync(wt.path);
      if (st.isDirectory() && !st.isSymbolicLink()) tree = resolve(wt.path);
    } catch { /* missing: git reports it */ }
  }
  if (tree && a.forces === 0) {
    const s = spawnSync(git, ['-C', tree, 'status', '--porcelain', '--ignore-submodules=none'], { encoding: 'utf8', windowsHide: true });
    if (s.status !== 0 || String(s.stdout).trim()) tree = null;
  }
  if (tree) {
    for (const link of findLinks(tree).links) {
      try { if (removeLink(link)) removed.push(relative(tree, link).replace(/\\/g, '/')); } catch (e) {
        process.stderr.write(`worktree-remove-safe: could not remove link ${link}: ${e.code ?? e.message}; not running git\n`);
        return { removed, status: 1 };
      }
    }
  }
  if (removed.length) {
    const shown = removed.slice(0, 8).join(', ') + (removed.length > 8 ? `, +${removed.length - 8} more` : '');
    out(`worktree-remove-safe: removed ${removed.length} link${removed.length === 1 ? '' : 's'} (targets untouched): ${shown}\n`);
  }
  const gitArgs = [...(a.dir ? ['-C', a.dir] : []), 'worktree', 'remove', ...Array(a.forces).fill('--force'), a.path];
  const r = spawnSync(git, gitArgs, { cwd, stdio: 'inherit', windowsHide: true });
  return { removed, status: r.status ?? (r.error ? 127 : 1) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(run(process.argv.slice(2)).status);
}
