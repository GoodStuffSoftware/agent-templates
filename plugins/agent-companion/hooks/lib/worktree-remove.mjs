// Worktree-remove guard: a `git worktree remove` of a tree that holds junctions or directory
// symlinks is rewritten to scripts/worktree-remove-safe.mjs, which unlinks each link as a link
// and then runs git. Why: on Windows git followed `node_modules` junctions inside the tree and
// emptied the junction TARGETS (a primary checkout's node_modules, 2026-11-22).
//
// Pure decision logic; bash-tail.mjs wires it (only one PreToolUse hook's updatedInput survives
// a call, so the rewrite lives in the hook that already owns them).
//
//   worktreeRemoveDecision(command, { cwd, shell }) ->
//     { action: 'none' }                              nothing to do: not a worktree remove, or no link in the tree
//     { action: 'rewrite', command, count }           each qualifying `git [-C d] worktree remove [-f] p` replaced in place
//     { action: 'deny', text }                        a remove that cannot be rewritten cleanly
//
// A segment is rewritten in place (its original argument tokens, quoting and all, are kept, so
// `$d` in a loop still expands in the same shell; nothing moves into a child shell). It
// qualifies when its target tree exists and holds a link, or when the target cannot be known
// from the text (a variable, a `cd` to a variable) or is not found as typed (git resolves a worktree by a
// unique last path component too): the script is the safe superset and costs
// one walk. Fails open: any error is { action: 'none' }.

import { lstatSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCommand, wordsOf, psScanText } from './resource-gate.mjs';
import { findLinks } from '../../scripts/worktree-remove-safe.mjs';

export const SAFE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'worktree-remove-safe.mjs');
const WALK_ENTRIES = 20000; // the hook's look for a link; past this the script (unbounded, link-aware) decides
const WALK_MS = 2000;

const slash = (p) => String(p).replace(/\\/g, '/');
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Command prefixes that run the next word as the command: skipped (with their own -x options) before `git`.
// Not handled, listed as known gaps: options that take a value (`sudo -u user git`, `nice -n 5 git`).
const PREFIXES = new Set(['command', 'env', 'time', 'sudo', 'exec', 'nohup', 'nice', 'builtin']);
const baseName = (w) => slash(w).split('/').pop().replace(/\.exe$/i, '');
const CD_NAMES = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location']);
const POP_NAMES = new Set(['popd', 'pop-location']);

/** Raw tokens of a segment, [{ start, end, raw }] with offsets in `text`. Quotes keep their text together. */
function rawTokens(text, ps) {
  const out = [];
  let i = 0;
  const n = text.length;
  const esc = ps ? '`' : '\\';
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i += 1;
    if (i >= n) break;
    const start = i;
    let quote = '';
    for (; i < n; i += 1) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = '';
        else if (quote === '"' && c === esc) i += 1;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === esc) { i += 1; continue; }
      if (/\s/.test(c)) break;
    }
    out.push({ start, end: Math.min(i, n), raw: text.slice(start, Math.min(i, n)) });
  }
  return out;
}

/** The literal value of a raw token, or null when it cannot be known from the text. */
function literal(raw, ps) {
  if (!raw) return null;
  const single = raw.startsWith("'");
  if (!single && (/[$*?[\]%]/.test(raw) || raw.includes('`') && !ps || /^~/.test(raw))) return null;
  if (ps) {
    let v = raw;
    if (/^'.*'$/s.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/s.test(v)) v = v.slice(1, -1);
    return v.includes('`') ? null : v;
  }
  // Bash keeps a backslash inside double quotes unless it precedes $ ` " \ or a newline; wordsOf drops
  // it everywhere, which turns "C:\Users\x" into C:Usersx.
  if (/^"(?:[^"\\]|\\.)*"$/s.test(raw)) return raw.slice(1, -1).replace(/\\([$`"\\\n])/g, '$1');
  const w = wordsOf(raw);
  return w.length === 1 ? w[0] : null;
}

function nativePath(p) {
  // Git Bash spells C:\x as /c/x; node (and this hook) need the drive form.
  const m = process.platform === 'win32' ? /^\/([A-Za-z])(?:\/(.*))?$/.exec(slash(p)) : null;
  return m ? `${m[1].toUpperCase()}:/${m[2] ?? ''}` : p;
}

/**
 * Best reading of a call this rewrite cannot rebuild (`git -c k=v worktree remove T`): the repo dir from
 * any `-C` before `worktree`, and the single non-option word after `remove` as the path. null when
 * there is not exactly one path word. It only decides whether the tree holds links, so an unclean call
 * over a link-free tree runs untouched instead of being denied.
 */
function guessCall(toks, ps, wtIdx) {
  let dir = null;
  for (let j = 0; j + 1 < wtIdx; j += 1) if (literal(toks[j].raw, ps) === '-C') dir = toks[j + 1];
  const args = [];
  for (let j = wtIdx + 2; j < toks.length; j += 1) {
    if (/^\d*[<>]|^&>/.test(toks[j].raw)) break;
    const v = literal(toks[j].raw, ps);
    if (v !== null && v.startsWith('-')) continue;
    args.push(toks[j]);
  }
  if (args.length !== 1) return null;
  return { dir, path: args[0], words: { dir: dir ? literal(dir.raw, ps) : null, path: literal(args[0].raw, ps) } };
}

/** One segment as a worktree-remove call: { spanStart, spanEnd, dir, flags, path } | { unclean } | null. */
function parseSegment(seg, command, ps) {
  const text = command.slice(seg.start, seg.end);
  const toks = rawTokens(text, ps);
  let i = 0;
  while (i < toks.length) {
    const lit = literal(toks[i].raw, ps) ?? '';
    if (KEYWORDS.has(lit) || ASSIGN.test(lit)) { i += 1; continue; }
    if (!ps && PREFIXES.has(baseName(lit))) {
      i += 1;
      while (i < toks.length && /^-/.test(literal(toks[i].raw, ps) ?? '')) i += 1;
      continue;
    }
    break;
  }
  if (i >= toks.length || baseName(literal(toks[i].raw, ps) ?? '') !== 'git') return null;
  const gitTok = toks[i];
  i += 1;
  let dir = null;
  let sawWorktree = false;
  for (; i < toks.length; i += 1) {
    const v = literal(toks[i].raw, ps);
    if (v === '-C') { if (i + 1 >= toks.length) return null; dir = toks[i + 1]; i += 1; continue; }
    if (v !== null && v.startsWith('-')) {
      // Another global option before the subcommand: only a worktree remove makes it ours.
      const k = toks.findIndex((t, j) => j > i && literal(t.raw, ps) === 'worktree' && literal(toks[j + 1]?.raw, ps) === 'remove');
      if (k >= 0) return { unclean: `an unsupported git option (${v}) before worktree remove`, guess: guessCall(toks, ps, k), spanStart: seg.start + gitTok.start, spanEnd: seg.start + toks[toks.length - 1].end };
      return null;
    }
    sawWorktree = v === 'worktree';
    break;
  }
  if (!sawWorktree || literal(toks[i + 1]?.raw, ps) !== 'remove') return null;
  const wtIdx = i;
  i += 2;
  const flags = [];
  let path = null;
  let last = toks[i - 1];
  for (; i < toks.length; i += 1) {
    const t = toks[i];
    const v = literal(t.raw, ps);
    if (/^\d*[<>]|^&>/.test(t.raw)) break; // a redirect ends the arguments
    if (v !== null && (v === '--force' || /^-f+$/.test(v))) { flags.push(t); last = t; continue; }
    if (v === '--') { last = t; continue; } // end of options: dropped from the rewrite (the script takes the path as is)
    if ((v !== null && v.startsWith('-')) || path) return { unclean: 'an option or extra argument this rewrite does not handle', guess: guessCall(toks, ps, wtIdx), spanStart: seg.start + gitTok.start, spanEnd: seg.start + toks[toks.length - 1].end };
    path = t; last = t;
  }
  if (!path) return null; // git itself reports the usage error
  return { spanStart: seg.start + gitTok.start, spanEnd: seg.start + last.end, dir, flags, path, words: { dir: dir ? literal(dir.raw, ps) : null, path: literal(path.raw, ps) } };
}

/** The directory a cd-like segment changes to: string | null (unknown) | undefined (not a cd). */
function cdTarget(seg, command, ps, base) {
  const toks = rawTokens(command.slice(seg.start, seg.end), ps);
  let i = 0;
  while (i < toks.length && (KEYWORDS.has(literal(toks[i].raw, ps) ?? '') || ASSIGN.test(literal(toks[i].raw, ps) ?? ''))) i += 1;
  const name = literal(toks[i]?.raw, ps);
  if (name === null || name === undefined) return undefined;
  const lower = baseName(name).toLowerCase();
  if (POP_NAMES.has(lower)) return null;
  if (!CD_NAMES.has(lower)) return undefined;
  const args = toks.slice(i + 1).filter((t) => !/^-/.test(t.raw) || ps);
  if (args.length !== 1 || base === null) return null;
  const v = literal(args[0].raw, ps);
  if (v === null || v === '-') return null;
  return resolve(base, nativePath(v));
}

/** 'links' | 'none' | 'unknown' for one parsed segment. */
function verdict(call, base, seam) {
  const dirWord = call.dir ? call.words.dir : undefined;
  if (call.words.path === null || dirWord === null || base === null) return 'unknown';
  const root = dirWord ? resolve(base, nativePath(dirWord)) : base;
  const tree = resolve(root, nativePath(call.words.path));
  try {
    const st = lstatSync(tree);
    if (st.isSymbolicLink()) return 'unknown'; // git resolves it by real path: it may point at a worktree
    if (!st.isDirectory()) return 'none';
  } catch { return 'unknown'; } // not there as typed: git may still resolve it (a unique last path component), so the script decides
  const r = seam(tree);
  return r.links.length || r.truncated ? 'links' : 'none';
}

const MANUAL = 'Manual fix: 1. list the junctions and symlinks inside the tree (PowerShell: `Get-Item <dir> | Select-Object LinkType, Target` for node_modules and every other directory that may be linked; LinkType is Junction or SymbolicLink). '
  + '2. Remove each link itself, never recursing (`cmd /c rmdir <link>`; on macOS or Linux `rm <link>` with no trailing slash). '
  + '3. Only then run `git worktree remove`.';

function denyText(why, scriptCmd) {
  return `git worktree remove not run: on Windows it follows junctions and directory symlinks inside the tree and empties their targets (it emptied a primary checkout's node_modules). ${why} `
    + `Use the safe script, which unlinks each link as a link and then runs git: ${scriptCmd}\n${MANUAL}`;
}

/**
 * See the header. `shell`: 'bash' | 'powershell'. `psRewrite`: false makes a PowerShell rewrite a
 * deny that carries the script command (nothing documents that the PowerShell tool applies updatedInput,
 * and a command that runs unrewritten is the damage). `walk` is a test seam.
 */
export function worktreeRemoveDecision(command, { cwd = process.cwd(), shell = 'bash', psRewrite = false, script = SAFE_SCRIPT, walk } = {}) {
  const none = { action: 'none' };
  try {
    const s = String(command ?? '');
    if (!/worktree/.test(s) || !/remove/.test(s)) return none;
    const ps = shell === 'powershell';
    const scanned = scanCommand(ps ? psScanText(s) : s);
    const seam = walk ?? ((tree) => findLinks(tree, { maxEntries: WALK_ENTRIES, maxMs: WALK_MS }));
    const grouped = scanned.flags.has('group');
    let base = isAbsolute(cwd) ? cwd : resolve(cwd);
    const hits = [];
    for (const seg of scanned.segments) {
      const call = parseSegment(seg, s, ps);
      if (call?.unclean) {
        // Deny only when the tree may hold links: a call over a link-free tree (git -c k=v ...) runs as written.
        if (!call.guess || verdict(call.guess, base, seam) !== 'none') hits.push({ call, unclean: true });
        continue;
      }
      if (call) {
        const v = verdict(call, base, seam);
        if (v !== 'none') hits.push({ call, v });
        continue;
      }
      const cd = cdTarget(seg, s, ps, base);
      if (cd !== undefined) base = grouped ? null : cd;
    }
    if (!hits.length) return none;
    const sq = (v) => (ps ? `'${String(v).replace(/'/g, "''")}'` : `'${String(v).replace(/'/g, `'\\''`)}'`);
    const argsOf = (c) => [c.dir ? `-C ${c.dir.raw}` : '', ...c.flags.map((f) => f.raw), c.path.raw].filter(Boolean).join(' ');
    const scriptCmd = (c) => `node ${sq(slash(script))} ${argsOf(c)}`;
    const first = hits.find((h) => !h.unclean)?.call;
    const example = first ? scriptCmd(first) : `node ${sq(slash(script))} [-C <repo>] [--force] <path>`;
    if (hits.some((h) => h.unclean)) {
      const why = hits.find((h) => h.unclean).call.unclean;
      return { action: 'deny', text: denyText(`It could not be rewritten: ${why}.`, example) };
    }
    if (scanned.flags.has('heredoc')) return { action: 'deny', text: denyText('It could not be rewritten cleanly: the command holds a heredoc.', example) };
    let out = s;
    for (const h of hits.slice().sort((a, b) => b.call.spanStart - a.call.spanStart)) {
      out = `${out.slice(0, h.call.spanStart)}${scriptCmd(h.call)}${out.slice(h.call.spanEnd)}`;
    }
    if (ps && !psRewrite) return { action: 'deny', text: denyText('The PowerShell tool is not trusted to apply a rewrite, so this is a denial; run the rewritten command instead.', `\n${out}`), command: out };
    return { action: 'rewrite', command: out, count: hits.length };
  } catch { return none; }
}
