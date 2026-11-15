// api-worker-paths.mjs — the opt-in path allowances of an API worker (--allow-read / --allow-write).
// ~/.claude is off limits to a worker (it holds the user's settings, credentials and state). An allowance opens ONE directory
// inside it for reading (Read, Grep, Glob, read-only Bash) or for writing (Write, Edit, any Bash). Credential-like files stay
// denied even inside an allowed directory (denyNameReason). A guard rail, not a sandbox.

import { resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { parseCommands, baseName } from '../../hooks/lib/process-kill-guard.mjs';
import { opt } from '../../hooks/lib/context.mjs';
import { parseAdminKeySource, defaultAdminKeySource } from './api-spend.mjs';

const ROOT_RE = /^(?:\/|[a-z]:\/?)$/i;
const win = () => process.platform === 'win32';

// ~, $HOME, ${HOME}, %USERPROFILE% (leading only) -> the home dir; backslashes -> /; `..` and `.` resolved against cwd;
// drive letter lower-cased; no trailing slash (except a root).
export function expandHome(value, home = homedir()) {
  const h = String(home).replace(/\\/g, '/');
  return String(value ?? '').trim().replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/i, h).replace(/\\/g, '/');
}
export function normPath(value, cwd, home = homedir()) {
  const v = expandHome(value, home);
  // A drive-letter path (C:/x, C:) is absolute on every platform; posix resolve would treat it as relative to cwd.
  const drive = !win() && /^[A-Za-z]:/.test(v);
  let n = (drive ? win32.resolve(/^[A-Za-z]:$/.test(v) ? `${v}/` : v) : resolve(cwd || process.cwd(), v)).replace(/\\/g, '/');
  n = n.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
  if (n.length > 1 && !ROOT_RE.test(n)) n = n.replace(/\/+$/, '');
  return n;
}
const key = (p) => (win() || /^[a-z]:\//i.test(p) ? p.toLowerCase() : p);
// Path-boundary prefix check: /a/b is under /a, /a/bc is not.
export function isUnder(p, dir) {
  const kp = key(p); const kd = key(dir);
  if (kp === kd) return true;
  return kp.startsWith(kd.endsWith('/') ? kd : `${kd}/`);
}
export const claudeDir = (home = homedir()) => normPath('~/.claude', '/', home);

// The literal directory part of a path or glob (up to the last / before the first wildcard).
export function staticDir(value) {
  const raw = String(value ?? '').replace(/\\/g, '/');
  const g = raw.search(/[*?[{]/);
  return g < 0 ? raw : raw.slice(0, raw.lastIndexOf('/', g) + 1);
}

// null when ok; else a usage-error message. Refuses /, ~, a drive root and the home dir itself.
export function validateAllowDir(value, cwd, home = homedir()) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'an empty directory';
  if (/[*?[{]/.test(raw)) return `${raw}: a directory, not a pattern`;
  if (/^(?:\/|~\/?|[A-Za-z]:[\\/]?)$/.test(raw.replace(/\\/g, '/')) || /^(?:\/|~)[\\/]*$/.test(raw)) return `${raw}: /, ~ and a drive root are refused`;
  const n = normPath(raw, cwd, home);
  if (isUnder(normPath('~', '/', home), n)) return `${raw}: /, ~, a drive root and any parent of the home dir are refused`;
  if (ROOT_RE.test(n) || key(n) === key(normPath('~', '/', home))) return `${raw}: /, ~ and a drive root are refused`;
  return null;
}
export const normDirs = (list, cwd, home = homedir()) => [...new Set((list || []).map((d) => normPath(d, cwd, home)))];

function adminStorePaths(home) {
  const out = [];
  for (const src of [opt('api_admin_key_source', ''), defaultAdminKeySource()]) {
    const p = parseAdminKeySource(src);
    if (p && p.kind === 'dpapi' && p.name) out.push(normPath(p.name, '/', home));
  }
  return out;
}

// null when the name is fine; else the reason. `n` is a normalised path (wildcards allowed).
export function denyNameReason(n, home = homedir()) {
  const segs = n.toLowerCase().split('/');
  const base = segs[segs.length - 1] || segs[segs.length - 2] || '';
  if (base === '.credentials.json') return 'credential files are off limits';
  if (isUnder(n, claudeDir(home)) && (base === 'settings.json' || base === 'settings.local.json')) return 'settings files under ~/.claude are off limits';
  if (segs.includes('secrets')) return 'a secrets directory is off limits';
  if (/^\.env/.test(base) || /\.(?:pem|key)$/.test(base)) return 'env, .pem and .key files are off limits';
  if (/token|credential/.test(base)) return 'files named token or credential are off limits';
  if (adminStorePaths(home).some((a) => isUnder(n, a))) return 'the admin key store is off limits';
  return null;
}

export const WRITE_BLOCKED = 'Claude Code blocks writes under ~/.claude; write output to a folder outside it.';
// kind: 'read' | 'write'. Allowances under ~/.claude are read-only (Claude Code refuses writes there; we do not route around it). allow = { allowRead, allowWrite } (normalised dirs). null when fine; else the reason.
export function accessReason(value, cwd, kind, allow = {}, home = homedir()) {
  const ar = allow.allowRead || []; const aw = allow.allowWrite || [];
  const whole = normPath(value, cwd, home);
  const dir = normPath(staticDir(value) || '.', cwd, home);
  const dirs = kind === 'write' ? aw : [...ar, ...aw];
  const inAllowed = dirs.some((d) => isUnder(dir, d) && isUnder(whole, d));
  const inAny = [...ar, ...aw].some((d) => isUnder(dir, d));
  const zone = isUnder(dir, claudeDir(home)) || isUnder(whole, claudeDir(home));
  if (zone || inAny) {
    const why = denyNameReason(dir, home) || denyNameReason(whole, home);
    if (why) return why;
  }
  if (zone && kind === 'write') return WRITE_BLOCKED;
  if (zone && !inAllowed) return '~/.claude is off limits unless the directory is listed with --allow-read';
  return null;
}

// --- Bash ---------------------------------------------------------------------------------------
const RO_PROGS = new Set(['ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'stat', 'file', 'sort', 'uniq', 'diff', 'cmp', 'pwd', 'echo', 'printf', 'test', '[', 'true', 'node', 'git', 'tree', 'realpath', 'dirname', 'basename', 'du', 'type', 'cd']);
const RO_GIT = new Set(['log', 'show', 'status', 'diff', 'ls-files', 'rev-parse', 'blame', 'shortlog', 'describe', 'ls-tree', 'cat-file', 'grep', 'rev-list']);
const FIND_WRITE = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const stripExe = (t) => baseName(t).replace(/\.exe$/i, '').toLowerCase();

export function bashIsReadOnly(command) {
  const c = String(command ?? '');
  if (/[><]|\$\(|`|\btee\b/.test(c) || /\n/.test(c.trim())) return false;
  try {
    const cmds = parseCommands(c, 'bash', 0, { nextChain: 0, steps: 0 });
    if (!cmds.length) return false;
    for (const { words } of cmds) {
      let i = 0;
      while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i].t)) i++;
      if (i >= words.length) continue;
      const prog = stripExe(words[i].t);
      if (!RO_PROGS.has(prog)) return false;
      const rest = words.slice(i + 1).map((w) => w.t);
      if (prog === 'git') {
        let j = 0;
        while (j < rest.length && rest[j].startsWith('-')) j += ['-C', '-c', '--git-dir', '--work-tree'].includes(rest[j]) ? 2 : 1;
        if (!RO_GIT.has((rest[j] || '').toLowerCase())) return false;
      }
      if (prog === 'find' && rest.some((t) => FIND_WRITE.test(t))) return false;
    }
    return true;
  } catch { return false; }
}

const pathLike = (t, cwd) => /[\\/~$]/.test(t) || /^\./.test(t) || /\.\w{1,8}$/.test(t) || (() => { try { return existsSync(resolve(cwd, t)); } catch { return false; } })();
// null when fine. Every path-like word of the command (and the cwd) that falls in ~/.claude or an allowed dir is judged:
// read-only commands as reads, anything else as writes.
export function bashPathReason(command, cwd, allow = {}, home = homedir()) {
  const c = String(command ?? '');
  const kind = bashIsReadOnly(c) ? 'read' : 'write';
  const base = cwd || process.cwd();
  const cands = ['.'];
  for (const raw of c.split(/[\s'"`;|&<>()=,]+/)) {
    if (!raw) continue;
    const t = raw.startsWith('-') ? raw.replace(/^-+[^=]*=?/, '') : raw;
    if (t && pathLike(t, base)) cands.push(t);
  }
  for (const t of cands) {
    const why = accessReason(t, base, kind, allow, home);
    if (why) return why;
  }
  return null;
}
