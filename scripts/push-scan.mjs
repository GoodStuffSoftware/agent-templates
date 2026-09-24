#!/usr/bin/env node
// scripts/push-scan.mjs — scans every commit a push would publish, on EVERY
// pushed ref (wip/** and backup/** included), before it leaves the machine.
//
// WHY. leak-check.mjs scans the working tree: what is committable NOW. A push
// publishes history, and history can carry what the tree no longer does — a
// private name added in one commit and deleted in the next is gone from the
// tree, passes leak-check, and is published forever by the push. This repo is
// public, so the only safe place to catch that is before the push.
//
// WHAT IS SCANNED, per commit (diffed against its FIRST parent; a root commit
// against the empty tree):
//   - every ADDED line of the diff (a removed line was already in the parent,
//     which is either public already or one of the commits scanned here);
//   - the commit message (%B — the body and its trailers);
//   - every path the commit adds or modifies.
// Author and committer identity (name, email, dates) are NOT scanned: they
// are the operator's own identity by design, not content.
//
// TWO CHECKS on each of those:
//   (a) leak-check.mjs's own classes — static tokens, derived names, private
//       paths, SHA-like runs — with the same derivation and the same per-file
//       exemptions (LICENSE etc.), via its exported buildScanContext/scanText.
//       One exception, messages only: a SHA-like run that names a commit IN
//       THIS REPOSITORY is self-reference (git revert writes one into every
//       message it makes), not a leak.
//   (b) the local private-names denylist, <stateRoot>/config/private-names.txt
//       (stateRoot = $AGENT_COMPANION_STATE_DIR, else
//       ${CLAUDE_CONFIG_DIR:-~/.claude}/agent-companion — the plugin's own
//       resolution, hooks/lib/context.mjs stateRootPath()). One entry per
//       line, `#` comments and blank lines ignored. An entry is a
//       case-insensitive WHOLE-WORD literal: it matches only where the
//       characters on both sides are not ASCII letters or digits, so "ann"
//       hits "ann", "Ann's", "ann-notes" and "ann_x" but not "annotation" or
//       "joann". An entry starting `re:` is a case-insensitive JavaScript
//       regex, used as written. A missing file is a one-line warning, never
//       a failure; an entry that is not a valid regex FAILS the scan (a
//       security list that silently drops an entry is worse than a push that
//       stops and says which line to fix).
//
// OUTPUT CONTRACT. A hit prints the commit SHA, where it is (file:line, the
// commit message, or a touched path by number) and which check fired — NEVER
// the matched text, the line, or a path that itself matched. The operator
// finds the text with the SHA; the terminal, a CI log or a screenshot never
// carries it.
//
// Usage (normally called by ci-local.mjs --pre-push-hook, not by hand):
//   node scripts/push-scan.mjs <commit-range-or-sha>...
//     scans exactly the commits `git rev-list <args>` names, e.g.
//     `origin/main..HEAD`.
// Exit code: 0 clean (warnings allowed), 1 hits or a bad denylist entry, 2 on
// a bad invocation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildScanContext, scanText, scanOptionsForRel } from './leak-check.mjs';
import { cleanGitEnv } from '../plugins/agent-companion/scripts/lib/git-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MAX_PRINTED_HITS = 50;

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

export function denylistPath(env = process.env) {
  const stateRoot = env.AGENT_COMPANION_STATE_DIR
    || join(env.CLAUDE_CONFIG_DIR || join(env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude'), 'agent-companion');
  return join(stateRoot, 'config', 'private-names.txt');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One denylist line -> a global, case-insensitive RegExp. Throws on an
// invalid `re:` body. Whole-word = no ASCII letter or digit on either side.
export function compileDenyEntry(raw) {
  const entry = String(raw).trim();
  if (entry.startsWith('re:')) return new RegExp(entry.slice(3), 'gi');
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(entry)}(?![A-Za-z0-9])`, 'gi');
}

// { missing: true } when the file cannot be read; otherwise
// { missing: false, entries: [{ lineNo, re }], invalid: [lineNo] }.
// lineNo is 1-based within the denylist file — safe to print, unlike the entry.
export function loadDenylist(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { missing: true, entries: [], invalid: [] };
  }
  return parseDenylist(text);
}

export function parseDenylist(text) {
  const entries = [];
  const invalid = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    try {
      entries.push({ lineNo: i + 1, re: compileDenyEntry(t) });
    } catch {
      invalid.push(i + 1);
    }
  });
  return { missing: false, entries, invalid };
}

// Every denylist entry that matches `text`, as { entryLine, line } (line is
// 1-based within `text`). Never returns the matched substring.
export function matchDenylist(text, entries) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    for (const { lineNo, re } of entries) {
      re.lastIndex = 0;
      if (re.test(l)) out.push({ entryLine: lineNo, line: i + 1 });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function makeGit(repo, env) {
  const childEnv = cleanGitEnv(env);
  return (args, input) => {
    const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: repo,
      env: childEnv,
      encoding: 'utf8',
      input,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.message}`);
    return res;
  };
}

function gitOk(git, args, input) {
  const res = git(args, input);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  return res.stdout;
}

const isZeroSha = (s) => /^0+$/.test(String(s || ''));

// The commits a push of localSha over remoteSha publishes, oldest first.
// remoteSha known locally -> localSha ^remoteSha. Otherwise (a new ref, or a
// remote tip this clone has never fetched) -> everything not already on ANY
// remote-tracking ref, which is what the remote side can be missing.
export function listPushedCommits(git, { localSha, remoteSha }) {
  if (isZeroSha(localSha)) return [];
  let args = ['rev-list', '--reverse', localSha, '--not', '--remotes'];
  if (remoteSha && !isZeroSha(remoteSha)) {
    const known = git(['cat-file', '-e', `${remoteSha}^{commit}`]);
    if (known.status === 0) args = ['rev-list', '--reverse', localSha, `^${remoteSha}`];
  }
  return gitOk(git, args).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function unquoteGitPath(p) {
  if (!p.startsWith('"')) return p;
  // C-style quoting (tab, newline, quote, backslash); good enough to name
  // the file — only ever used as a scan `rel`, never to open anything.
  return p.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', '"': '"', '\\': '\\' }[c] ?? c));
}

// Parse a `git diff-tree -p -U0` stream into added lines with their
// new-file line numbers. A state machine, not a line-prefix test: a content
// line "++ x" appears in a diff as "+++ x", which only the hunk state can tell
// apart from a file header.
export function parseAddedLines(diffText) {
  const added = [];
  let file = null;
  let inHunk = false;
  let newLine = 0;
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).replace(/\r$/, '');
        file = p === '/dev/null' ? null : unquoteGitPath(p).replace(/^b\//, '');
      } else if (line.startsWith('@@')) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        inHunk = true;
        newLine = m ? Number(m[1]) : 0;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
    } else if (line.startsWith('+')) {
      if (file) added.push({ file, line: newLine, text: line.slice(1).replace(/\r$/, '') });
      newLine += 1;
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return added;
}

// { sha, message, paths, added } for one commit, diffed against its first
// parent (or the empty tree for a root commit).
export function readCommit(git, sha) {
  const head = gitOk(git, ['show', '-s', '--format=%P%x00%B', sha]);
  const nul = head.indexOf('\0');
  const parents = head.slice(0, nul).trim().split(/\s+/).filter(Boolean);
  const message = head.slice(nul + 1);
  // Two-tree form against the first parent; a root commit uses --root,
  // which diffs it against the empty tree.
  const range = parents[0] ? [parents[0], sha] : ['--root', sha];
  const common = ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'];
  const diff = gitOk(git, [...common, '-p', '-U0', ...range]);
  const paths = gitOk(git, [...common, '--name-only', '-z', '--diff-filter=d', ...range])
    .split('\0').filter(Boolean);
  return { sha, message, paths, added: parseAddedLines(diff) };
}

// ---------------------------------------------------------------------------
// Scanning one commit
// ---------------------------------------------------------------------------

// Hits: { sha, where: 'diff'|'message'|'path', file?, pathIndex?, line?, check, label }.
// `check` is 'leak-check' or 'private-names'; `label` is the leak-check class
// or "denylist line N". Nothing in a hit is text taken from the commit
// except the file path, which formatHits() withholds when the path matched.
export function scanCommit(commit, { leakCtx = null, denylist = [], isRepoCommit = () => false } = {}) {
  const hits = [];
  const { sha } = commit;
  const derived = leakCtx?.derived || [];
  const realUsers = leakCtx?.realUsers;

  const byFile = new Map();
  for (const a of commit.added) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  for (const [file, lines] of byFile) {
    // Scan the added lines as one text so the leak-check line numbers map
    // back through `lines[i].line` to the real new-file line.
    const text = lines.map((l) => l.text).join('\n');
    if (leakCtx) {
      const opts = scanOptionsForRel(file);
      for (const h of scanText(text, { ...opts, derived, realUsers }).hits) {
        hits.push({ sha, where: 'diff', file, line: lines[h.line - 1].line, check: 'leak-check', label: h.label });
      }
    }
    for (const m of matchDenylist(text, denylist)) {
      hits.push({ sha, where: 'diff', file, line: lines[m.line - 1].line, check: 'private-names', label: `denylist line ${m.entryLine}` });
    }
  }

  if (leakCtx) {
    for (const h of scanText(commit.message, { rel: '', derived, realUsers }).hits) {
      if (h.label === 'git-sha-like' && isRepoCommit(h.token)) continue;
      hits.push({ sha, where: 'message', line: h.line, check: 'leak-check', label: h.label });
    }
  }
  for (const m of matchDenylist(commit.message, denylist)) {
    hits.push({ sha, where: 'message', line: m.line, check: 'private-names', label: `denylist line ${m.entryLine}` });
  }

  commit.paths.forEach((p, i) => {
    if (leakCtx) {
      // A path is a name, not content: the SHA class is skipped here (a
      // fixture named after a hash is not a leak by itself, and a real SHA
      // inside the file is still caught by the diff scan above).
      for (const h of scanText(p, { rel: '', derived, realUsers, noSha: true }).hits) {
        hits.push({ sha, where: 'path', pathIndex: i + 1, file: p, check: 'leak-check', label: h.label });
      }
    }
    for (const m of matchDenylist(p, denylist)) {
      hits.push({ sha, where: 'path', pathIndex: i + 1, file: p, check: 'private-names', label: `denylist line ${m.entryLine}` });
    }
  });
  return hits;
}

// Printable lines for a hit list. A path that itself matched is never
// printed: its hits, and every diff hit inside that file, are shown as
// "touched path #N" instead.
export function formatHits(hits, commitPaths = new Map()) {
  const sensitive = new Set(hits.filter((h) => h.where === 'path').map((h) => `${h.sha}\0${h.file}`));
  const seen = new Set();
  const lines = [];
  for (const h of hits) {
    let where;
    if (h.where === 'message') where = `commit message:${h.line}`;
    else if (h.where === 'path') where = `touched path #${h.pathIndex}`;
    else if (sensitive.has(`${h.sha}\0${h.file}`)) {
      const idx = (commitPaths.get(h.sha) || []).indexOf(h.file) + 1;
      where = `touched path #${idx || '?'}:${h.line}`;
    } else where = `${h.file}:${h.line}`;
    const line = `  ${h.sha.slice(0, 12)}  ${where}  [${h.check}: ${h.label}]`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// Scan every commit the given pushes publish. `pushes`: [{ localSha,
// remoteSha, remoteRef }] (deleted refs are ignored), or pass `commits`
// directly. Returns { status, hits, commits, warnings }; prints through
// `log`/`err` (default console) and never prints a matched name.
export function runPushScan({
  repo = REPO_ROOT, pushes = [], commits = null, env = process.env,
  log = (m) => console.log(m), err = (m) => console.error(m), leakCtx,
} = {}) {
  const git = makeGit(repo, env);
  const shas = [];
  const seen = new Set();
  const add = (s) => { if (!seen.has(s)) { seen.add(s); shas.push(s); } };
  if (commits) commits.forEach(add);
  for (const p of pushes) {
    if (isZeroSha(p.localSha)) continue;
    for (const s of listPushedCommits(git, p)) add(s);
  }

  const warnings = [];
  const listPath = denylistPath(env);
  const deny = loadDenylist(listPath);
  if (deny.missing) {
    const w = `push-scan: warning — no private-names denylist at ${listPath}; scanning with leak-check only.`;
    warnings.push(w);
    err(w);
  }
  if (deny.invalid.length) {
    err(`push-scan: BLOCKED — private-names denylist line(s) ${deny.invalid.join(', ')} are not valid regexes (re: entries). Fix the file, then push again.`);
    return { status: 1, hits: [], commits: shas, warnings };
  }

  if (shas.length === 0) {
    log('push-scan: no new commits to scan.');
    return { status: 0, hits: [], commits: shas, warnings };
  }

  const ctx = leakCtx === undefined ? buildScanContext({ root: repo, quiet: true }, env) : leakCtx;
  if (ctx && ctx.error) {
    err(`push-scan: BLOCKED — leak-check could not derive its names: ${ctx.error}`);
    return { status: 1, hits: [], commits: shas, warnings };
  }
  const repoCommitCache = new Map();
  const isRepoCommit = (tok) => {
    if (!repoCommitCache.has(tok)) {
      repoCommitCache.set(tok, git(['cat-file', '-e', `${tok}^{commit}`]).status === 0);
    }
    return repoCommitCache.get(tok);
  };

  const hits = [];
  const commitPaths = new Map();
  for (const sha of shas) {
    const c = readCommit(git, sha);
    commitPaths.set(sha, c.paths);
    hits.push(...scanCommit(c, { leakCtx: ctx, denylist: deny.entries, isRepoCommit }));
  }

  if (hits.length === 0) {
    log(`push-scan: OK — ${shas.length} commit(s) scanned (diff, message, paths): no leak-check or private-names hits.`);
    return { status: 0, hits, commits: shas, warnings };
  }
  const lines = formatHits(hits, commitPaths);
  err(`push-scan: BLOCKED — ${lines.length} hit(s) in ${new Set(hits.map((h) => h.sha)).size} of ${shas.length} commit(s). The matched text is never printed; inspect each commit with git show <sha>.`);
  for (const l of lines.slice(0, MAX_PRINTED_HITS)) err(l);
  if (lines.length > MAX_PRINTED_HITS) err(`  ... and ${lines.length - MAX_PRINTED_HITS} more.`);
  err('Rewrite those commits (e.g. an interactive rebase that edits them) so the text never enters history, then push again.');
  return { status: 1, hits, commits: shas, warnings };
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/push-scan.mjs <rev-list args, e.g. origin/main..HEAD>');
    return argv.length === 0 ? 2 : 0;
  }
  const git = makeGit(REPO_ROOT, process.env);
  const res = git(['rev-list', '--reverse', ...argv]);
  if (res.status !== 0) {
    console.error(`push-scan: git rev-list failed: ${(res.stderr || '').trim()}`);
    return 2;
  }
  const commits = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return runPushScan({ commits }).status;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
