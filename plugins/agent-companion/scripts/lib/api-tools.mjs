// api-tools.mjs — the read-only tools an API-credit review may call: read_file, grep, glob,
// confined to one repository root. No shell, no writes, no network. Used by api-run.mjs's
// tool loop; every function returns a string (the tool_result content) or throws a short
// message that the loop hands back to the model as an error result.

import { readFileSync, readdirSync, realpathSync, statSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUT_CHARS = 60000;
const MAX_WALK_FILES = 20000;

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a text file in the repository under review, with line numbers. Paths are relative to the repository root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the repository root.' },
        offset: { type: 'integer', description: 'First line to read, 1-based (default 1).' },
        limit: { type: 'integer', description: 'Number of lines to read (default 400, at most 1000).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents in the repository with a JavaScript regular expression. Returns path:line:text, at most 100 matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Directory or file to search, relative to the root (default the whole repository).' },
        glob: { type: 'string', description: 'Only files whose repository-relative path matches this glob, for example **/*.mjs.' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'List repository files whose path matches a glob (* within a folder, ** across folders, ?), at most 300.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
];

export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i += 1; if (g[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const WIN = process.platform === 'win32';
const DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

// A path component the tools never read: .git, .env* and, on Windows where names are
// case-insensitive and have other spellings, those under any case, trailing dots or spaces, an
// NTFS stream suffix (a colon), an 8.3 short name (GIT~1, ENV~1) or a reserved device name.
export function deniedName(seg) {
  const n = String(seg).replace(/[. ]+$/, '').toLowerCase();
  if (n === '.git' || n.startsWith('.env') || n.includes(':') || /^(?:git|env)~\d/.test(n)) return true;
  return WIN && DEVICE_RE.test(n.split('.')[0]);
}

export function makeTools(cwd) {
  const root = realpathSync.native(resolve(cwd));
  const inside = (p) => p === root || p.startsWith(root + sep);
  const rel = (p) => relative(root, p).split(sep).join('/');

  function confine(p) {
    const given = String(p || '.');
    // Before any filesystem call: no UNC or device path (touching one opens a network connection),
    // no drive letter, and a lexical containment and deny-list check of the name as given.
    // Either slash, on any platform: on Linux a backslash name is only a missing file, but the
    // refusal (and its message) is then the same everywhere.
    if (/^[\\/]{2}/.test(given) || /^[A-Za-z]:/.test(given)) throw new Error(`path is outside the repository: ${p}`);
    const abs = resolve(root, given);
    if (!inside(abs)) throw new Error(`path is outside the repository: ${p}`);
    if (relative(root, abs).split(sep).some(deniedName)) throw new Error(`path is not readable: ${p}`);
    let real;
    try { real = realpathSync.native(abs); } catch { throw new Error(`no such path: ${p}`); }
    if (!inside(real)) throw new Error(`path is outside the repository: ${p}`);
    if (rel(real).split('/').some(deniedName)) throw new Error(`path is not readable: ${p}`);
    return real;
  }

  function* walk(start) {
    const stack = [start];
    let seen = 0;
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => (a.name < b.name ? 1 : -1));
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || deniedName(e.name) || e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) { if (++seen > MAX_WALK_FILES) return; yield full; }
      }
    }
  }

  const isText = (file) => {
    let fd;
    try {
      fd = openSync(file, 'r');
      const b = Buffer.alloc(4096);
      const n = readSync(fd, b, 0, 4096, 0);
      return !b.subarray(0, n).includes(0);
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  };

  const cap = (s) => (s.length > MAX_OUT_CHARS ? `${s.slice(0, MAX_OUT_CHARS)}\n[output cut at ${MAX_OUT_CHARS} characters]` : s);

  const impl = {
    read_file({ path, offset = 1, limit = 400 }) {
      const file = confine(path);
      const st = statSync(file);
      if (!st.isFile()) throw new Error(`not a file: ${path}`);
      if (st.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes: ${path}`);
      if (!isText(file)) throw new Error(`binary file: ${path}`);
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const from = Math.max(1, Math.floor(Number(offset)) || 1);
      const n = Math.min(1000, Math.max(1, Math.floor(Number(limit)) || 400));
      const out = lines.slice(from - 1, from - 1 + n).map((l, i) => `${from + i}\t${l}`).join('\n');
      return cap(`${out}\n[lines ${from}-${Math.min(lines.length, from - 1 + n)} of ${lines.length}]`);
    },
    grep({ pattern, path = '.', glob = null, ignore_case = false }) {
      let re;
      // A nested quantifier such as (a+)+ can backtrack for minutes, and nothing in-process can stop a synchronous match.
      if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(String(pattern))) throw new Error('refused: nested quantifiers can hang the search; use a simpler pattern');
      try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch (e) { throw new Error(`bad regular expression: ${e.message}`); }
      const start = confine(path);
      const gre = glob ? globToRegExp(glob) : null;
      const files = lstatSync(start).isDirectory() ? walk(start) : [start];
      const hits = [];
      outer: for (const f of files) {
        const r = rel(f);
        if (gre && !gre.test(r)) continue;
        let st;
        try { st = statSync(f); } catch { continue; }
        if (st.size > MAX_FILE_BYTES || !isText(f)) continue;
        const lines = readFileSync(f, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) { hits.push(`${r}:${i + 1}:${lines[i].slice(0, 300)}`); if (hits.length >= 100) break outer; }
        }
      }
      return hits.length ? cap(hits.join('\n')) : 'no matches';
    },
    glob({ pattern }) {
      const gre = globToRegExp(pattern);
      const out = [];
      for (const f of walk(root)) { const r = rel(f); if (gre.test(r)) { out.push(r); if (out.length >= 300) break; } }
      return out.length ? out.sort().join('\n') : 'no files';
    },
  };

  return {
    definitions: TOOL_DEFINITIONS,
    run(name, input) {
      if (!impl[name]) throw new Error(`unknown tool ${name}`);
      return impl[name](input && typeof input === 'object' ? input : {});
    },
  };
}
