// Shell reads and file outlines for the read hooks (0.31.65). No parser dependency: a small tokenizer, one regex per command form,
// and one regex outline per language.
//
// parseShellRead(command) recognises a PLAIN read of one file: `sed -n 'A,Bp' f`, `cat f`, `head -n N f`, `tail -n N f`,
// `Get-Content f [-TotalCount N | -Head N | -Tail N]`, `awk 'NR>=A&&NR<=B' f`, each optionally piped into `head`/`tail`/
// `Select-Object -First/-Last/-Skip`/`grep -n ''` (a grep that matches every line only numbers them). A pipe into grep with a real
// pattern is a SEARCH, not a read, and so is anything else that is not exactly that shape (a list of commands, a redirect, a heredoc,
// a substitution, several files, a glob). Returns null for all of those. The caller decides whether the file is one to leave alone.

const READ_WORD = /\b(sed|cat|head|tail|awk|get-content|gc|type)\b/i;

// Cheap test before any parsing: can this command possibly be a read?
export function mayBeShellRead(command) {
  return typeof command === 'string' && command.length < 1000 && READ_WORD.test(command);
}

// Quote-aware split into words; `|` is its own token; any other operator, substitution or redirect makes the command not a plain read.
function tokenize(cmd) {
  const s = String(cmd).trim().replace(/\s+2>\s*(?:&1|\/dev\/null|NUL)\b/gi, '');
  const out = [];
  let cur = '';
  let has = false;
  let q = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '`' || c === ';' || c === '&' || c === '>' || c === '<' || c === '\n' || c === '\r' || c === '{' || c === '}') return null;
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) return null;
    if (c === '|') {
      if (s[i + 1] === '|') return null;
      if (has || cur) out.push(cur);
      cur = ''; has = false;
      out.push({ pipe: true });
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (has || cur) out.push(cur);
      cur = ''; has = false;
      continue;
    }
    cur += c;
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}

function splitPipes(tokens) {
  const segs = [[]];
  for (const t of tokens) {
    if (typeof t === 'object') segs.push([]);
    else segs[segs.length - 1].push(t);
  }
  return segs;
}

const int = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const goodFile = (f) => typeof f === 'string' && f && !/[*?[\]$%~]/.test(f) && !f.startsWith('-') && !f.startsWith('http');

function parseSed(args) {
  let n = false;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    if (w === '-n' || w === '--quiet' || w === '--silent') n = true;
    else if (w === '-e' || w === '--expression') { rest.push(args[i + 1]); i += 1; } else if (w.startsWith('-')) return null;
    else rest.push(w);
  }
  if (!n || rest.length !== 2) return null;
  const m = /^(\d+)(?:,(\d+|\$))?\s*p(?:\s*;\s*\d+q)?$/.exec(rest[0].trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : (m[2] === '$' ? null : Number(m[2]));
  if (a < 1 || (b !== null && b < a)) return null;
  return { file: rest[1], a, b };
}

function parseAwk(args) {
  const rest = args.filter((w) => !(w === '-F' || w === '--'));
  if (rest.length !== 2 || rest.some((w) => w.startsWith('-'))) return null;
  const s = rest[0].replace(/\s+/g, '');
  let m = /^NR>=(\d+)&&NR<=(\d+)(?:\{print(?:\$0)?\})?$/.exec(s);
  if (m) return { file: rest[1], a: Number(m[1]), b: Number(m[2]) };
  m = /^NR==(\d+)(?:\{print(?:\$0)?\})?$/.exec(s);
  if (m) return { file: rest[1], a: Number(m[1]), b: Number(m[1]) };
  m = /^NR<=(\d+)(?:\{print(?:\$0)?\})?$/.exec(s);
  if (m) return { file: rest[1], a: 1, b: Number(m[1]) };
  m = /^NR>=(\d+)(?:\{print(?:\$0)?\})?$/.exec(s);
  if (m) return { file: rest[1], a: Number(m[1]), b: null };
  return null;
}

function parseCat(args) {
  const files = [];
  for (const w of args) {
    if (w === '-n' || w === '-b' || w === '-s' || w === '-A' || w === '-T') continue;
    if (w.startsWith('-')) return null;
    files.push(w);
  }
  return files.length === 1 ? { file: files[0], a: 1, b: null } : null;
}

// head/tail option words, shared by the command and the pipe form. -> { n, plus, file? } or null
function countArgs(args, def) {
  let n = def;
  let plus = false;
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    let v;
    if (w === '-n' || w === '--lines') { v = args[i + 1]; i += 1; } else if (/^-n./.test(w)) v = w.slice(2);
    else if (/^--lines=/.test(w)) v = w.slice(8);
    else if (/^-\d+$/.test(w)) v = w.slice(1);
    else if (w.startsWith('-')) return null; // -c, -f, -q ...
    else { files.push(w); continue; }
    if (typeof v !== 'string') return null;
    if (v.startsWith('+')) { plus = true; v = v.slice(1); }
    n = int(v);
    if (n === null) return null;
  }
  return { n, plus, files };
}

function parseHeadTail(kind, args) {
  const c = countArgs(args, 10);
  if (!c || c.files.length !== 1 || c.n < 1) return null;
  const file = c.files[0];
  if (kind === 'head') return { file, a: 1, b: c.n };
  if (c.plus) return { file, a: c.n, b: null };
  return { file, a: 1, b: null, tail: c.n };
}

function parseGetContent(args) {
  let file = '';
  let head = null;
  let tail = null;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const lw = w.toLowerCase();
    const val = () => { i += 1; return int(args[i]); };
    if (lw === '-totalcount' || lw === '-head' || lw === '-first') { head = val(); if (head === null) return null; } else if (lw === '-tail' || lw === '-last') { tail = val(); if (tail === null) return null; } else if (lw === '-path' || lw === '-literalpath') { file = args[i + 1] || ''; i += 1; } else if (lw === '-raw') continue;
    else if (lw === '-encoding') i += 1;
    else if (w.startsWith('-')) return null;
    else if (!file) file = w;
    else return null;
  }
  if (!file) return null;
  const r = { file, a: 1, b: head && head > 0 ? head : null };
  if (head === 0 || tail === 0) return null;
  if (tail) r.tail = tail;
  return r;
}

function pipeOp(seg) {
  const cmd = String(seg[0] || '').toLowerCase();
  const args = seg.slice(1);
  if (cmd === 'head' || cmd === 'tail') {
    const c = countArgs(args, 10);
    if (!c || c.files.length || c.plus || c.n < 1) return null;
    return [{ op: cmd, n: c.n }];
  }
  if (cmd === 'select-object' || cmd === 'select') {
    const ops = [];
    for (let i = 0; i < args.length; i += 1) {
      const lw = args[i].toLowerCase();
      const v = int(args[i + 1]);
      if (v === null || v < 1 && lw !== '-skip') return null;
      if (lw === '-skip') ops.unshift({ op: 'skip', n: v });
      else if (lw === '-first') ops.push({ op: 'head', n: v });
      else if (lw === '-last') ops.push({ op: 'tail', n: v });
      else return null;
      i += 1;
    }
    return ops.length ? ops : null;
  }
  // grep that matches every line only numbers or passes them: not a search.
  if (cmd === 'grep') {
    const flags = args.filter((w) => w.startsWith('-'));
    const pats = args.filter((w) => !w.startsWith('-'));
    if (pats.length === 1 && /^(\.\*?|\^|\$)?$/.test(pats[0]) && flags.every((w) => w === '-n' || w === '-a' || w === '--text')) return [];
  }
  return null;
}

// -> { file, a, b|null, tail?, ops: [{ op: 'head'|'tail'|'skip', n }] } or null
export function parseShellRead(command) {
  if (!mayBeShellRead(command)) return null;
  const tokens = tokenize(command);
  if (!tokens || !tokens.length) return null;
  const segs = splitPipes(tokens);
  const first = segs[0];
  if (!first.length) return null;
  const cmd = first[0].toLowerCase();
  const args = first.slice(1);
  let r = null;
  if (cmd === 'sed') r = parseSed(args);
  else if (cmd === 'cat' || cmd === 'type') r = parseCat(args);
  else if (cmd === 'head' || cmd === 'tail') r = parseHeadTail(cmd, args);
  else if (cmd === 'awk') r = parseAwk(args);
  else if (cmd === 'get-content' || cmd === 'gc') r = parseGetContent(args);
  if (!r || !goodFile(r.file)) return null;
  const ops = [];
  for (const seg of segs.slice(1)) {
    const o = pipeOp(seg);
    if (!o) return null;
    ops.push(...o);
  }
  return { ...r, ops };
}

// The lines [a, b] a parsed read returns from a file of `total` lines, or null when none.
export function resolveRange(r, total) {
  if (!r || !(total >= 1)) return null;
  let a = r.a;
  let b = r.b === null || r.b === undefined ? total : Math.min(r.b, total);
  if (r.tail) a = Math.max(a, b - r.tail + 1);
  for (const o of r.ops || []) {
    if (o.op === 'head') b = Math.min(b, a + o.n - 1);
    else if (o.op === 'tail') a = Math.max(a, b - o.n + 1);
    else if (o.op === 'skip') a += o.n;
  }
  return a >= 1 && b >= a ? [a, b] : null;
}

// --- files the read hooks leave alone --------------------------------------------

const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif|pdf|ipynb|zip|gz|tgz|7z|rar|exe|dll|so|dylib|wasm|woff2?|ttf|eot|mp[34]|mov|avi|sqlite3?|db|lock|log|out|err|tmp|trace)$/i;

// Logs and test or tool output: a read of those is the point of the command. `path` is relative to the repository root (so a repository
// that itself lives under a temp directory is not skipped).
export function isOutputFile(path) {
  const p = String(path || '').replace(/\\/g, '/').toLowerCase();
  return SKIP_EXT.test(p) || /(^|\/)(tmp|temp|\.tmp)\//.test(p) || /(^|\/)[^/]*(stdout|stderr)[^/]*$/.test(p) || /(^|\/)([^/]*[-_.])?output\.(txt|json|md)$/.test(p);
}

// --- outline ----------------------------------------------------------------

export const OUTLINE_MAX_CHARS = 1500;
const OUTLINE_EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', py: 'py', md: 'md', sh: 'sh', ps1: 'ps' };

export function outlineKind(path) {
  const m = /\.([a-z0-9]+)$/i.exec(String(path || ''));
  return m ? OUTLINE_EXT[m[1].toLowerCase()] || '' : '';
}

const clip = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}~` : s);

function entryOf(kind, line, inFence) {
  let m;
  if (kind === 'md') {
    if (inFence) return null;
    m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    return m ? `${m[1]} ${clip(m[2])}` : null;
  }
  if (kind === 'js') {
    m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(line);
    if (m) return `${m[1]}()`;
    m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+(\w+)/.exec(line);
    if (m) return `${m[1]} ${m[2]}`;
    m = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function|\w+\s*=>)/.exec(line);
    if (m) return `${m[1]}()`;
    m = /^export\s+(?:const|let|var)\s+(\w+)/.exec(line);
    if (m) return `export ${m[1]}`;
    m = /^export\s+(default|\{)/.exec(line);
    return m ? clip(line.trim(), 40) : null;
  }
  if (kind === 'py') {
    m = /^(?:async\s+)?def\s+(\w+)/.exec(line);
    if (m) return `${m[1]}()`;
    m = /^class\s+(\w+)/.exec(line);
    return m ? `class ${m[1]}` : null;
  }
  if (kind === 'sh') {
    m = /^(?:function\s+)?([A-Za-z_][\w:-]*)\s*\(\)\s*\{?/.exec(line) || /^function\s+([A-Za-z_][\w:-]*)/.exec(line);
    return m ? `${m[1]}()` : null;
  }
  if (kind === 'ps') {
    m = /^function\s+([\w-]+)/i.exec(line);
    return m ? `${m[1]}()` : null;
  }
  return null;
}

// Compact "name:line" outline of the top-level definitions of `text`, at most `max` characters. '' when nothing was found.
export function outlineOf(text, path, max = OUTLINE_MAX_CHARS) {
  const kind = outlineKind(path);
  if (!kind || typeof text !== 'string') return '';
  const entries = [];
  let fence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (kind === 'md' && /^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const e = entryOf(kind, line, fence);
    if (e) entries.push(`${e}:${i + 1}`);
  }
  if (!entries.length) return '';
  let out = '';
  let used = 0;
  for (const e of entries) {
    const add = (out ? 2 : 0) + e.length;
    if (out.length + add > max - 16) break;
    out += `${out ? ', ' : ''}${e}`;
    used += 1;
  }
  if (used < entries.length) out += `, +${entries.length - used} more`;
  return out;
}

// Line count of a text blob: a last line without a newline counts.
export function countLinesIn(text) {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1;
  return text.length && !text.endsWith('\n') ? n + 1 : n;
}
