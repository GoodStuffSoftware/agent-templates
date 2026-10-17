// env_dump_guard, inline programs: judge the code inside `node -e|--eval|-p|--print`, `bun -e|-p`, `deno eval`,
// `python -c` (python3, py, pythonw, pypy), and a program fed on stdin (`node - <<'E'`, `python3 <<E`, `node <<< '...'`,
// `cat <<E | node`, `echo '...' | python -`, PowerShell `'...' | node -` and `@'...'@ | python -`) for environment dumps.
// Called from env-dump-guard.mjs, which owns the deny text, the option and the stream rules (redirect, filter, consumer).
//
// Denied (kind 'dump'): the whole environment object reaching output. JS: process.env (also process['env'],
//   require('process').env, Bun.env, Deno.env.toObject(), an alias `const e = process.env`, `const {env} = process`,
//   `{...process.env}`) as an argument of console.log|info|warn|error|debug|dir|table|trace, process.stdout|stderr.write
//   or a `node -p` result; JSON.stringify / Object.entries / Object.values / util.inspect of it with any print in the
//   program; a key loop that prints `process.env[k]`. Python: os.environ (also environ, environb, an alias, dict(...),
//   .copy(), {**...}) in print / sys.stdout|stderr.write / pprint / pp / logging; .items() / .values() / json.dumps /
//   str / repr of it with any print; a key loop with os.environ[k] / .get(k) / getenv(k). A string run as a shell
//   command (exec / execSync / execFile / execFileSync / spawn / spawnSync, a quoted string or a template literal with no
//   ${} part; os.system / os.popen / subprocess.*) is judged as a command.
// Denied (kind 'secret'): printing one variable whose name looks secret (the guard's TOKEN, KEY, SECRET, PASSWORD,
//   PASSWD, AUTH, CREDENTIAL, COOKIE rule), directly, through a variable assigned from it, or in a template / f-string.
// Allowed: one non-secret variable (process.env.PATH, os.environ.get('HOME')); presence tests that print no value
//   ('X' in process.env, !!process.env.X, process.env.X ? 'set' : 'unset', .length, bool(os.getenv('X')),
//   os.getenv('X') is not None); names only (Object.keys(process.env), list(os.environ), sorted(os.environ),
//   os.environ.keys(), for k in os.environ: print(k)); the environment passed to a child (`env: {...process.env}`,
//   `env=os.environ.copy()`); a secret used, not printed (fetch(url, { headers: { Authorization: process.env.X } })).
// Code that does not lex (an unterminated string, unbalanced brackets) is judged on its raw text for the clear forms
// only: the env object straight into a print, or a print of one secret-named read.
// Size cap: the full analysis runs on code up to INLINE_CAP (50,000 characters); its cost grows faster than linearly
// with size (M, 0.31.28 review: 78 ms median just under the cap). Longer code gets the same raw-text check for the clear
// forms instead of being skipped. The whole command is capped at 200,000 characters in env-dump-guard.mjs (over that the
// guard allows).

import { progIndex, baseName, psParam } from './process-kill-guard.mjs';

const INLINE_CAP = 50000;

const SECRET_PART = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)|(^|_)(KEY|O?AUTH|AUTHORIZATION)(_|$)|[A-Z0-9]KEY(_|$)/i;
const secretName = (name) => !!name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && SECRET_PART.test(name);
const secretLiteral = (s) => /^[A-Z][A-Z0-9_]*$/.test(s) && SECRET_PART.test(s);

const L = '\u0002';
const R = '\u0003';
const LIT = `${L}(\\d+)${R}`;
const MARK = '\u0005'; // where bash expanded a secret-named $NAME into the code (markExpanded)
const JS_PROGS = new Set(['node', 'nodejs']);
const PY_PROG = /^(?:python|pythonw|py|pyw|pypy)(?:\d+(?:\.\d+)*)?(?:-(?:32|64|arm64))?$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye']);

// ---------------------------------------------------------------------------------------------------------------------
// Where is the inline program? -> [{ lang: 'js'|'py'|'bash'|'powershell', code, printLast }]

// Bash expands $NAME and ${NAME...} inside a double-quoted or unquoted word, and in the body of a heredoc whose delimiter
// is unquoted, before the program sees its code: `node -e "console.log('$TOKEN')"` prints the value. A secret-named one
// (the guard's upper-case name rule) becomes MARK, so the analysis can tell whether the code prints it. ${NAME:+x} and
// ${NAME+x} are presence tests. Single-quoted code and a quoted delimiter (<<'E', <<"E", <<\E) are not expanded.
const EXPANDS = /(\\?)\$(?:\{([A-Za-z_]\w*)([^}]*)\}|([A-Za-z_]\w*))/g;
function markExpanded(text, honorBackslash) {
  if (!text || !text.includes('$')) return text;
  return text.replace(EXPANDS, (all, bs, n1, rest, n2) => {
    if (bs && honorBackslash) return all; // heredoc body: \$NAME is literal
    if (n1 !== undefined && /^:?\+/.test(rest || '')) return all;
    return secretLiteral(n1 ?? n2) ? bs + MARK : all;
  });
}
// the text bash hands the program for one word: an expanded $ is a plain '$' in nv, a quoted or escaped one is \u0001
const wordText = (x, shell) => (shell === 'powershell' || x.nv == null ? x.t : markExpanded(x.nv, false).replace(/\u0001/g, '$'));
const bodies = (c, shell, mark) => (c.heredocs || []).map((h, j) => (mark && shell !== 'powershell' && c.hereQuoted?.[j] === false ? markExpanded(h, true) : h));

// mark: the reader is node or python (its code is judged here), so expanded secret names are marked; a shell or pwsh
// reader re-parses the text and sees the $NAME itself
function stdinCode(cmd, prev, shell, mark) {
  const word = (x) => (mark ? wordText(x, shell) : x.t);
  const out = bodies(cmd, shell, mark);
  const k = cmd.words.findIndex((x) => !x.q && x.t === '<<<');
  if (k >= 0 && cmd.words[k + 1]) out.push(word(cmd.words[k + 1]));
  if (prev) {
    out.push(...bodies(prev, shell, mark));
    const pk = progIndex(prev.words);
    const pw = prev.words;
    if (shell === 'powershell' && pw.length === 1 && pw[0].q && !prev.call) out.push(pw[0].t); // 'code' | node -
    else if (pk >= 0 && pk < pw.length && ['echo', 'printf', 'print', 'write-output'].includes(baseName(pw[pk].t))) {
      let a = pw.slice(pk + 1);
      while (a.length && /^-[neE]+$/.test(a[0].t)) a = a.slice(1);
      out.push(a.map(word).join(' '));
    }
  }
  return out.filter((c) => c && c.trim());
}

function nodeProgram(args) {
  let printLast = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    let m;
    if (a === '-') return { stdin: true, printLast };
    if (a === '--') return args[j + 1] === undefined || args[j + 1] === '-' ? { stdin: true, printLast } : null;
    if ((m = /^--(eval|print)=([\s\S]*)$/.exec(a))) return { code: m[2], printLast: printLast || m[1] === 'print' };
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-pe') {
      if (a !== '-e' && a !== '--eval') printLast = true;
      if (/^(-e|--eval)$/.test(args[j + 1] || '')) continue; // node -p -e CODE
      return args[j + 1] === undefined ? null : { code: args[j + 1], printLast };
    }
    if (/^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--title|--env-file|--input-type)$/.test(a)) { j++; continue; }
    if (a[0] === '-') continue;
    return null; // a script file: stdin is data
  }
  return { stdin: true, printLast };
}

function pyProgram(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    let m;
    if (a === '-') return { stdin: true };
    if (a === '--') return args[j + 1] === undefined || args[j + 1] === '-' ? { stdin: true } : null;
    if ((m = /^-([bBdEhiIOPqsSuvVxR]*)c([\s\S]*)$/.exec(a))) {
      if (m[2]) return { code: m[2] };
      return args[j + 1] === undefined ? null : { code: args[j + 1] };
    }
    if (/^-[bBdEhiIOPqsSuvVxR]*m/.test(a)) return null;
    if (/^-[bBdEhiIOPqsSuvVxR]*[WX]$/.test(a)) { j++; continue; }
    if (a[0] === '-') continue; // also the py launcher's -3 / -3.12 / -V:3.12
    return null;
  }
  return { stdin: true };
}

// argument words without redirections (`> f`, `2>&1`, `<<< text`, `<f`)
function plainArgs(words, shell) {
  const out = [];
  for (let j = 0; j < words.length; j++) {
    const x = words[j];
    if (!x.q && /^(\d*|&|\*)(<<<|>>?|<)$/.test(x.t)) { j++; continue; } // operator alone: its target is the next word
    if (!x.q && /^(\d*|&|\*)(>>?|<)/.test(x.t)) continue;
    out.push(wordText(x, shell));
  }
  return out;
}

/** The inline programs one simple command runs. prev: the command piped into it (same chain), or null. */
export function inlinePrograms(cmd, prev, shell) {
  const w = cmd.words;
  let k = progIndex(w);
  if (k < 0 || k >= w.length) return [];
  let prog = baseName(w[k].t);
  for (let hop = 0; hop < 3; hop++) { // uv run python ..., poetry run ..., npx node ...
    if (RUNNERS.has(prog) && w[k + 1] && w[k + 1].t === 'run') {
      k += 2;
      while (k < w.length && w[k].t[0] === '-') k++;
    } else if ((prog === 'npx' || prog === 'bunx') && w[k + 1]) {
      k++;
      while (k < w.length && w[k].t[0] === '-') k++;
    } else break;
    if (k >= w.length) return [];
    prog = baseName(w[k].t);
  }
  const args = plainArgs(w.slice(k + 1), shell);
  const fromStdin = (lang, printLast = false) => stdinCode(cmd, prev, shell, lang === 'js' || lang === 'py').map((code) => ({ lang, code, printLast }));
  if (JS_PROGS.has(prog)) {
    const p = nodeProgram(args);
    if (!p) return [];
    return p.stdin ? fromStdin('js', p.printLast) : [{ lang: 'js', code: p.code, printLast: p.printLast }];
  }
  if (prog === 'bun') {
    const p = nodeProgram(args);
    return p && !p.stdin ? [{ lang: 'js', code: p.code, printLast: p.printLast }] : [];
  }
  if (prog === 'deno') {
    if (args[0] === 'run' && args.slice(1).filter((a) => a[0] !== '-' || a === '-')[0] === '-') return fromStdin('js');
    if (args[0] !== 'eval') return [];
    const rest = args.slice(1);
    const code = rest.find((a) => a[0] !== '-');
    return code === undefined ? [] : [{ lang: 'js', code, printLast: rest.some((a) => a === '-p' || a === '--print') }];
  }
  if (PY_PROG.test(prog)) {
    const p = pyProgram(args);
    if (!p) return [];
    return p.stdin ? fromStdin('py') : [{ lang: 'py', code: p.code }];
  }
  if (SHELLS.has(prog)) {
    // bash -c is followed by env-dump-guard's nested pass; here only a script read from stdin
    if (args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) || !args.every((a) => a[0] === '-')) return [];
    return fromStdin('bash');
  }
  if (prog === 'powershell' || prog === 'pwsh') {
    const out = [];
    const ei = args.findIndex((a) => psParam(a, [['encodedcommand', 1]]) || /^-ec$/i.test(a));
    if (ei >= 0 && /^[A-Za-z0-9+/=]{4,}$/.test(args[ei + 1] || '')) {
      out.push({ lang: 'powershell', code: Buffer.from(args[ei + 1], 'base64').toString('utf16le') });
    }
    const ci = args.findIndex((a) => psParam(a, [['command', 1]]) || a.toLowerCase() === '-c');
    const fi = args.findIndex((a) => psParam(a, [['file', 1]]));
    if ((ci >= 0 && args[ci + 1] === '-') || (ci < 0 && ei < 0 && fi < 0 && args.every((a) => a[0] === '-'))) out.push(...fromStdin('powershell'));
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Lexers: string literals become L<n>R (values kept in lits), comments go, template / f-string expressions stay as
// code in a group; ok=false on an unterminated string or unbalanced brackets.

const CLOSE = { '(': ')', '[': ']', '{': '}' };

function lexJs(src) {
  const lits = [];
  const n = src.length;
  let i = 0;
  let ok = true;
  const code = (inTemplate) => {
    let out = '';
    const st = [];
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        if (e < 0) { ok = false; i = n; break; }
        out += ' '; i = e + 2; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        let v = '';
        for (; j < n && src[j] !== c && src[j] !== '\n'; j++) {
          if (src[j] === '\\') { v += src[j + 1] ?? ''; j++; } else v += src[j];
        }
        if (src[j] !== c) { ok = false; i = n; break; }
        lits.push(v); out += L + (lits.length - 1) + R; i = j + 1; continue;
      }
      if (c === '`') {
        i++;
        const parts = [];
        let v = '';
        let closed = false;
        while (i < n) {
          if (src[i] === '\\') { v += src[i + 1] ?? ''; i += 2; continue; }
          if (src[i] === '`') { i++; closed = true; break; }
          if (src[i] === '$' && src[i + 1] === '{') { i += 2; parts.push(code(true)); continue; }
          v += src[i]; i++;
        }
        if (!closed) { ok = false; break; }
        // a template with no ${} part is a plain string: execSync(`env`), process.env[`API_KEY`]
        if (!parts.length) { lits.push(v); out += L + (lits.length - 1) + R; continue; }
        if (v.includes(MARK)) parts.push(MARK); // `tok=$TOKEN ${x}` after bash expansion: the static text carries the value
        out += `\u0004(${parts.join(',')})`;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { st.push(c); out += c; i++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (!st.length) {
          i++;
          if (inTemplate && c === '}') return out;
          ok = false; out += c; continue;
        }
        if (CLOSE[st.pop()] !== c) ok = false;
        out += c; i++; continue;
      }
      out += c; i++;
    }
    if (st.length || inTemplate) ok = false;
    return out;
  };
  const text = code(false);
  return { text, lits, ok };
}

function lexPy(src, lits = [], depth = 0) {
  const n = src.length;
  let i = 0;
  let ok = true;
  let out = '';
  const st = [];
  while (i < n) {
    const c = src[i];
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    const pm = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i, i + 5));
    if (pm && (pm[1] === '' || !/[\w]/.test(src[i - 1] || ''))) {
      const fstr = /[fF]/.test(pm[1]);
      const q = pm[2];
      let j = i + pm[0].length;
      let v = '';
      const exprs = [];
      let closed = false;
      while (j < n) {
        if (src.startsWith(q, j)) { closed = true; j += q.length; break; }
        if (q.length === 1 && src[j] === '\n') break;
        if (src[j] === '\\') { v += src[j + 1] ?? ''; j += 2; continue; }
        if (fstr && src[j] === '{') {
          if (src[j + 1] === '{') { v += '{'; j += 2; continue; }
          let d = 0;
          let e = j;
          for (; e < n; e++) { // the expression ends at its matching }, quotes of the other kind skipped
            const ch = src[e];
            if (ch === '{' || ch === '(' || ch === '[') d++;
            else if (ch === '}' || ch === ')' || ch === ']') { d--; if (d === 0) break; }
            else if ((ch === '"' || ch === "'") && !q.startsWith(ch)) { const z = src.indexOf(ch, e + 1); if (z < 0) break; e = z; }
          }
          if (e >= n || depth > 4) { ok = false; break; }
          const inner = lexPy(src.slice(j + 1, e), lits, depth + 1);
          if (!inner.ok) ok = false;
          exprs.push(inner.text);
          j = e + 1;
          continue;
        }
        v += src[j]; j++;
      }
      if (!closed) { ok = false; break; }
      lits.push(v);
      out += L + (lits.length - 1) + R + (exprs.length ? `\u0004(${exprs.join(',')})` : '');
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { st.push(c); out += c; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (!st.length || CLOSE[st.pop()] !== c) ok = false;
      out += c; i++; continue;
    }
    out += c; i++;
  }
  if (st.length) ok = false;
  return { text: out, lits, ok };
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis on lexed text

function matchClose(t, open) {
  let d = 0;
  for (let j = open; j < t.length; j++) {
    const c = t[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return j; }
  }
  return t.length;
}

// end of the value that starts at `from` (a , or an unmatched closer at depth 0)
function valueEnd(t, from) {
  let d = 0;
  for (let j = from; j < t.length; j++) {
    const c = t[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) return j; d--; } else if ((c === ',' || c === ';' || c === '\n') && d === 0) return j;
  }
  return t.length;
}

function depthAt(t, pos) {
  let d = 0;
  for (let j = 0; j < pos; j++) {
    const c = t[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return d;
}

// the last top-level statement (node -p prints its value)
function lastStatement(t) {
  let d = 0;
  let start = 0;
  let lastStart = 0;
  let lastEnd = t.length;
  for (let j = 0; j <= t.length; j++) {
    const c = t[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if ((c === ';' || c === '\n' || c === undefined) && d === 0) {
      if (t.slice(start, j).trim()) { lastStart = start; lastEnd = j; }
      start = j + 1;
    }
  }
  return { start: lastStart, end: lastEnd };
}

const esc = (s) => s.replace(/[$.*+?()[\]{}|\\^]/g, '\\$&');

const JS = {
  word: '[\\w$]',
  sinks: [
    [/(?<![\w$.])console\s*\.\s*(log|info|debug|dir|dirxml|table|group|groupCollapsed|warn|error|trace|assert)(?![\w$])/g, (m) => (/^(warn|error|trace|assert)$/.test(m[1]) ? 2 : 1)],
    [/(?<![\w$])process\s*\.\s*(stdout|stderr)\s*\.\s*write(?![\w$])/g, (m) => (m[1] === 'stderr' ? 2 : 1)],
    [/(?<![\w$])(?:fs\s*\.\s*)?write(?:File)?Sync(?=\s*\(\s*([12])\s*,)/g, (m) => Number(m[1])],
  ],
  base: '(?<![\\w$])(?:(?:globalThis|global)\\s*\\.\\s*)?process\\s*\\.\\s*env(?![\\w$])|(?<![\\w$.])Bun\\s*\\.\\s*env(?![\\w$])|(?<![\\w$.])Deno\\s*\\.\\s*env\\s*\\.\\s*toObject\\s*\\(\\s*\\)',
  normalize(t, lits) {
    return t
      .replace(new RegExp(`(?<![\\w$])require\\s*\\(\\s*${LIT}\\s*\\)`, 'g'), (all, n) => (/^(node:)?process$/.test(lits[n]) ? 'process' : all))
      .replace(new RegExp(`(?<![\\w$.])process\\s*\\[\\s*${LIT}\\s*\\]`, 'g'), (all, n) => (lits[n] === 'env' ? 'process.env' : all));
  },
  producer: (E) => `(?:${E}|\\{\\s*\\.\\.\\.\\s*(?:${E})\\s*\\}|Object\\s*\\.\\s*assign\\s*\\(\\s*\\{\\s*\\}\\s*,\\s*(?:${E})\\s*\\)|structuredClone\\s*\\(\\s*(?:${E})\\s*\\))`,
  assign: (P) => new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*${P}\\s*(?=[;,)\\n]|$)`, 'g'),
  extraAliases(t) {
    const out = [];
    for (const m of t.matchAll(/\{([^{}]*)\}\s*=\s*process(?![\w$.[])/g)) {
      for (const part of m[1].split(',')) {
        const pm = /^\s*env\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=.*)?$/.exec(part);
        if (pm) out.push(pm[1] || 'env');
      }
    }
    return out;
  },
  childSpans(t, lits) {
    const spans = [];
    const re = new RegExp(`(?:(?<![\\w$.])env|${LIT})\\s*:(?!:)`, 'g');
    let m;
    while ((m = re.exec(t))) {
      if (m[1] !== undefined && lits[m[1]] !== 'env') continue;
      const s = m.index + m[0].length;
      spans.push([s, valueEnd(t, s)]);
    }
    return spans;
  },
  // classify one env-object reference from what follows / precedes it
  ref(t, lits, s, e) {
    const after = t.slice(e, e + 120);
    const before = t.slice(Math.max(0, s - 80), s);
    let m;
    if ((m = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(after))) {
      if (/^(hasOwnProperty|propertyIsEnumerable)$/.test(m[1])) return { cat: 'presence' };
      return { cat: 'read', name: m[1], end: e + m[0].length };
    }
    if ((m = new RegExp(`^\\s*(?:\\?\\.)?\\[\\s*${LIT}\\s*\\]`).exec(after))) return { cat: 'read', name: lits[m[1]], end: e + m[0].length };
    if (/^\s*(?:\?\.)?\[/.test(after)) return { cat: 'dyn' };
    if (/(?:Object\s*\.\s*(?:keys|getOwnPropertyNames)|Reflect\s*\.\s*ownKeys)\s*\(\s*$/.test(before)) return { cat: 'keys' };
    if (/for\s*\(\s*(?:const|let|var)?\s*[\w$]+\s+in\s*$/.test(before)) return { cat: 'keys' };
    if (/(?:(?<![\w$])in|Object\s*\.\s*hasOwn\s*\(|typeof)\s*$/.test(before)) return { cat: 'presence' };
    if (/(?:JSON\s*\.\s*stringify|Object\s*\.\s*(?:entries|values|getOwnPropertyDescriptors)|(?<![\w$])inspect|(?<![\w$])String)\s*\(\s*(?:\{\s*\.\.\.\s*|Object\s*\.\s*assign\s*\(\s*\{\s*\}\s*,\s*)?$/.test(before)) {
      // its .length is a count, no value: Object.entries(process.env).length, JSON.stringify(process.env).length
      if (/^\s*\}?\s*\)?\s*\)\s*(?:\?\.|\.)\s*length(?![\w$])/.test(after)) return { cat: 'presence' };
      return { cat: 'flow' };
    }
    return { cat: 'whole' };
  },
  files: /(?<![\w$])(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\((?!\s*[12]\s*,)|(?<!process\s*\.\s*std(?:out|err)\s*)\.\s*write\s*\(/g,
  reads: null,
  exec: [new RegExp(`(?<![\\w$])(?:execSync|execFileSync|spawnSync|execFile|spawn|exec)\\s*\\(\\s*${LIT}(?:\\s*,\\s*\\[((?:\\s*${L}\\d+${R}\\s*,?)*)\\s*\\])?`, 'g')],
  safeBefore: /(?:!|(?<![\w$])typeof\s+|Boolean\s*\(\s*)$/,
  safeAfter: /^\s*(?:\?(?![.?])|\?\.\s*length\b|&&|[=!]==?|[<>]=?|\.\s*(?:length|startsWith|endsWith|includes|test)\b|\)\s*\.\s*length\b)/,
  assignBefore: /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*$/,
  destructure(t, E) {
    const out = { taint: [], alias: [] };
    for (const m of t.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*(?:${E})(?![\\w$.\\[])`, 'g'))) {
      for (const part of m[1].split(',')) {
        const pm = /^\s*(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=.*)?$/.exec(part);
        if (!pm) continue;
        if (pm[1]) out.alias.push(pm[2]);
        else if (secretName(pm[2])) out.taint.push(pm[3] || pm[2]);
      }
    }
    return out;
  },
};

const PY = {
  word: '\\w',
  sinks: [
    [/(?<![\w.])print(?![\w])/g, null],
    [/(?<![\w])sys\s*\.\s*(stdout|stderr)\s*\.\s*write(?![\w])/g, (m) => (m[1] === 'stderr' ? 2 : 1)],
    [/(?<![\w])(?:pprint\s*\.\s*)?(?:pprint|pp)(?![\w])/g, null],
    [/(?<![\w])(?:logging|log|logger)\s*\.\s*(?:info|warning|warn|error|debug|critical|exception)(?![\w])/g, () => 2],
    [/(?<![\w])json\s*\.\s*dump(?![\w])/g, 'json'],
  ],
  base: '(?<![\\w])(?:[A-Za-z_]\\w*\\s*\\.\\s*)?environb?(?![\\w])',
  normalize: (t) => t,
  producer: (E) => `(?:${E}|dict\\s*\\(\\s*(?:${E})\\s*\\)|(?:${E})\\s*\\.\\s*copy\\s*\\(\\s*\\)|\\{\\s*\\*\\*\\s*(?:${E})\\s*\\})`,
  assign: (P) => new RegExp(`(?<![\\w.])([A-Za-z_]\\w*)\\s*=(?!=)\\s*${P}\\s*(?=[;\\n]|$)`, 'g'),
  extraAliases(t) {
    const out = [];
    for (const m of t.matchAll(/from\s+os\s+import\s+([^\n;]*)/g)) {
      for (const am of m[1].matchAll(/\benvironb?\s+as\s+([A-Za-z_]\w*)/g)) out.push(am[1]);
    }
    return out;
  },
  childSpans(t) {
    const spans = [];
    const re = /(?<![\w.])env\s*=(?!=)/g;
    let m;
    while ((m = re.exec(t))) {
      if (depthAt(t, m.index) <= 0) continue; // a kwarg, not an assignment
      const s = m.index + m[0].length;
      spans.push([s, valueEnd(t, s)]);
    }
    return spans;
  },
  ref(t, lits, s, e) {
    const after = t.slice(e, e + 120);
    const before = t.slice(Math.max(0, s - 80), s);
    let m;
    if (/import\s+[^\n;]*$/.test(before) || /^\s*=(?!=)/.test(after)) return { cat: 'none' };
    // len(...) of it is a count, no value: len(os.environ.items()), len(dict(os.environ)), len(json.dumps(dict(os.environ)))
    if (/(?<![\w.])len\s*\(\s*(?:(?:json\s*\.\s*dumps?|(?<![\w.])str|(?<![\w.])repr|pformat)\s*\(\s*)?(?:dict\s*\(\s*)?$/.test(before)) return { cat: 'presence' };
    if (/^\s*\.\s*(?:items|values)\s*\(/.test(after)) return { cat: 'flow' };
    if (/^\s*\.\s*keys\s*\(/.test(after)) return { cat: 'keys' };
    if ((m = new RegExp(`^\\s*\\.\\s*(?:get|pop|setdefault)\\s*\\(\\s*${LIT}`).exec(after))) return { cat: 'read', name: lits[m[1]], end: e + matchClose(after, after.indexOf('(')) + 1 };
    if (/^\s*\.\s*(?:get|pop|setdefault)\s*\(/.test(after)) return { cat: 'dyn' };
    if (/^\s*\.\s*(?:update|clear)\b/.test(after)) return { cat: 'none' };
    if ((m = new RegExp(`^\\s*\\[\\s*${LIT}\\s*\\]`).exec(after))) return { cat: 'read', name: lits[m[1]], end: e + m[0].length };
    if (/^\s*\[/.test(after)) return { cat: 'dyn' };
    if (/(?:json\s*\.\s*dumps?|(?<![\w.])str|(?<![\w.])repr|pformat)\s*\(\s*(?:dict\s*\(\s*)?$/.test(before)) return { cat: 'flow' };
    if (/(?<![\w.])(?:list|sorted|set|len|tuple|frozenset)\s*\(\s*$/.test(before)) return { cat: 'keys' };
    if (/(?<![\w.])for\s+[\w\s,()]+\s+in\s*$/.test(before)) return { cat: 'keys' };
    if (/(?<![\w.])(?:not\s+)?in\s*$/.test(before)) return { cat: 'presence' };
    return { cat: 'whole' };
  },
  files: /(?<![\w])json\s*\.\s*dump\s*\((?![^()]*sys\s*\.\s*std)|(?<!sys\s*\.\s*std(?:out|err)\s*)\.\s*(?:write|write_text|writelines)\s*\(/g,
  reads: new RegExp(`(?<![\\w])(?:[A-Za-z_]\\w*\\s*\\.\\s*)?getenvb?\\s*\\(\\s*(?:${LIT})?`, 'g'),
  exec: [new RegExp(`(?<![\\w])(?:os\\s*\\.\\s*(?:system|popen)|(?:subprocess\\s*\\.\\s*)?(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))\\s*\\(\\s*(?:${LIT}|\\[((?:\\s*${L}\\d+${R}\\s*,?)*)\\s*\\])`, 'g')],
  safeBefore: /(?:(?<![\w.])(?:bool|len|hash)\s*\(\s*|(?<![\w.])(?:not|if)\s+)$/,
  safeAfter: /^\s*(?:is\s+(?:not\s+)?None\b|[=!]=|[<>]=?|and\b|\.\s*(?:startswith|endswith)\b|\)\s*is\s+(?:not\s+)?None\b)/,
  assignBefore: /(?<![\w.])([A-Za-z_]\w*)\s*=(?!=)\s*$/,
  destructure: () => ({ taint: [], alias: [] }),
};

function sinksOf(lang, t, printLast) {
  const spans = [];
  const bare = [];
  for (const [re, streamOf] of lang.sinks) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const p = m.index + m[0].length;
      const open = /^\s*\(/.exec(t.slice(p));
      if (!open) { bare.push(streamOf === 'json' ? 1 : typeof streamOf === 'function' ? streamOf(m) : 1); continue; }
      const start = p + open[0].length - 1;
      const end = matchClose(t, start);
      const inner = t.slice(start + 1, end);
      let stream = typeof streamOf === 'function' ? streamOf(m) : 1;
      if (streamOf === null || streamOf === 'json') { // print(..., file=sys.stderr) / pprint(x, stream=f) / json.dump(x, sys.stdout)
        const f = /(?:^|,)\s*(?:file|stream)\s*=\s*([\w.]+)/.exec(inner);
        const target = f ? f[1] : streamOf === 'json' ? (/sys\s*\.\s*(stdout|stderr)/.exec(inner) || [])[0] : null;
        if (streamOf === 'json' && !target) continue;
        if (target && !/^sys\s*\.\s*(stdout|stderr)$/.test(target.replace(/\s+/g, ''))) continue; // to a file: not a print
        if (target && /stderr/.test(target)) stream = 2;
      }
      spans.push({ start, end, stream });
    }
  }
  if (printLast) { const ls = lastStatement(t); spans.push({ start: ls.start - 1, end: ls.end, stream: 1 }); }
  return { spans, bare };
}

// enclosing group of pos is a plain ( ... ) followed by .length: (process.env.X || '').length
function inLengthGroup(t, pos) {
  let d = 0;
  for (let j = pos - 1; j >= 0; j--) {
    const c = t[j];
    if (c === ')' || c === ']' || c === '}') d++;
    else if (c === '(' || c === '[' || c === '{') {
      if (d === 0) {
        if (c !== '(' || /[\w$]/.test(t[j - 1] || '')) return false;
        return /^\s*\.\s*length\b/.test(t.slice(matchClose(t, j) + 1));
      }
      d--;
    }
  }
  return false;
}

// python: the command's output is captured, not printed (the caller also requires that nothing in the program prints):
// capture_output=True; stdout=PIPE|DEVNULL, check_output, getoutput, getstatusoutput or os.popen while the command sends
// nothing to stderr itself (no >&2)
function pyCaptured(t, at, command) {
  const o = t.indexOf('(', at);
  if (o < 0) return false;
  const args = t.slice(o + 1, matchClose(t, o));
  if (/(?<![\w.])capture_output\s*=\s*True(?![\w])/.test(args)) return true;
  if (/(?<![\w.])stderr\s*=\s*(?:subprocess\s*\.\s*)?(?:PIPE|DEVNULL|STDOUT)(?![\w])/.test(args) && /(?<![\w.])stdout\s*=\s*(?:subprocess\s*\.\s*)?(?:PIPE|DEVNULL)(?![\w])/.test(args)) return true;
  if (/>&\s*2|1\s*>&/.test(command)) return false;
  return /(?<![\w.])stdout\s*=\s*(?:subprocess\s*\.\s*)?(?:PIPE|DEVNULL)(?![\w])/.test(args) || /(?:check_output|getoutput|getstatusoutput|popen)\s*\($/.test(t.slice(at, o + 1));
}

function analyze(lang, lx, printLast, nested) {
  const lits = lx.lits;
  const t = lang.normalize(lx.text, lits);
  const { spans, bare } = sinksOf(lang, t, printLast);
  const allStreams = new Set([...spans.map((s) => s.stream), ...bare]);
  const anySink = allStreams.size > 0;
  const sinkAt = (pos) => spans.filter((s) => pos > s.start && pos < s.end).map((s) => s.stream);

  // a string the program runs as a shell command is judged as a command
  for (const re of lang.exec) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const words = [];
      if (m[1] !== undefined) words.push(lits[m[1]]);
      if (m[2]) for (const lm of m[2].matchAll(new RegExp(LIT, 'g'))) words.push(lits[lm[1]]);
      const kind = words.length ? nested(words.join(' ')) : null;
      if (kind && lang === PY && !anySink && pyCaptured(t, m.index, words.join(' '))) continue;
      if (kind) return { kind, streams: new Set([1, 2]) };
    }
  }

  // the env object and its aliases
  let E = lang.base;
  const aliases = new Set(lang.extraAliases(t));
  for (let pass = 0; pass < 2; pass++) {
    const cur = aliases.size ? `${lang.base}|(?<![\\w$.])(?:${[...aliases].map(esc).join('|')})(?![\\w$])` : lang.base;
    for (const m of t.matchAll(lang.assign(lang.producer(cur)))) aliases.add(m[1]);
    for (const a of lang.destructure(t, cur).alias) aliases.add(a);
    E = aliases.size ? `${lang.base}|(?<![\\w$.])(?:${[...aliases].map(esc).join('|')})(?![\\w$])` : lang.base;
  }
  const children = lang.childSpans(t, lits);
  const inChild = (pos) => children.some(([a, b]) => pos >= a && pos < b);
  const fileSpans = [];
  lang.files.lastIndex = 0;
  for (const fm of t.matchAll(lang.files)) { const o = fm.index + fm[0].length - 1; fileSpans.push([o, matchClose(t, o)]); }
  const inFile = (pos) => fileSpans.some(([a, b]) => pos > a && pos < b);

  const hit = { dump: new Set(), secret: new Set() };
  const taint = new Set(lang.destructure(t, E).taint);
  let flow = false;
  let keyIter = false;
  let dyn = false;
  const secretRead = (s, end) => {
    const before = t.slice(Math.max(0, s - 40), s);
    const am = lang.assignBefore.exec(before);
    if (am) { taint.add(am[1]); return; }
    const st = sinkAt(s);
    if (!st.length) return;
    if (lang.safeBefore.test(before) || lang.safeAfter.test(t.slice(end, end + 40)) || inLengthGroup(t, s)) return;
    for (const x of st) hit.secret.add(x);
  };

  const re = new RegExp(E, 'g');
  let m;
  while ((m = re.exec(t))) {
    const s = m.index;
    const e = s + m[0].length;
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (inChild(s)) continue;
    // an alias word used as an object key or as its own assignment target is not a reference
    if (aliases.has(m[0]) && (/^\s*:(?!:)/.test(t.slice(e)) && /[{,]\s*$/.test(t.slice(0, s)) || /^\s*=(?![=>])/.test(t.slice(e)))) continue;
    const r = lang.ref(t, lits, s, e);
    if (r.cat === 'read') { if (secretName(r.name)) secretRead(s, r.end); continue; }
    if (r.cat === 'dyn') { dyn = true; continue; }
    if (r.cat === 'keys') { keyIter = true; continue; }
    if (r.cat === 'flow') {
      const st = sinkAt(s);
      if (!st.length && inFile(s)) continue; // JSON.stringify(process.env) written to a file is not printed
      flow = true; for (const x of st) hit.dump.add(x); continue;
    }
    if (r.cat === 'whole') for (const x of sinkAt(s)) hit.dump.add(x);
  }
  if (lang.reads) { // getenv('NAME') / getenv(name)
    lang.reads.lastIndex = 0;
    while ((m = lang.reads.exec(t))) {
      if (m[1] === undefined) { dyn = true; continue; }
      if (secretName(lits[m[1]])) secretRead(m.index, m.index + matchClose(t.slice(m.index), t.slice(m.index).indexOf('(')) + 1);
    }
  }
  // a secret-named $NAME bash expanded into the code (MARK, in a string literal or bare): a read of that secret where it stands
  if (t.includes(MARK) || lits.some((v) => v.includes(MARK))) {
    for (const mm of t.matchAll(new RegExp(`${LIT}|${MARK}`, 'g'))) {
      if (mm[1] !== undefined && !lits[mm[1]].includes(MARK)) continue;
      secretRead(mm.index, mm.index + mm[0].length);
    }
  }
  if (anySink && (flow || (keyIter && dyn))) for (const x of allStreams) hit.dump.add(x);
  if (anySink && dyn && lits.some(secretLiteral)) for (const x of allStreams) hit.secret.add(x);
  for (const id of taint) {
    const ire = new RegExp(`(?<![\\w$.])${esc(id)}(?![\\w$])`, 'g');
    let im;
    while ((im = ire.exec(t))) {
      const s = im.index;
      const end = s + im[0].length;
      const st = sinkAt(s);
      if (!st.length) continue;
      const before = t.slice(Math.max(0, s - 40), s);
      if (/^\s*:(?!:)/.test(t.slice(end)) && /[{,]\s*$/.test(before)) continue;
      if (lang.safeBefore.test(before) || lang.safeAfter.test(t.slice(end, end + 40)) || inLengthGroup(t, s)) continue;
      for (const x of st) hit.secret.add(x);
    }
  }
  if (hit.dump.size) return { kind: 'dump', streams: hit.dump };
  if (hit.secret.size) return { kind: 'secret', streams: hit.secret };
  return null;
}

// raw text, for code that does not lex: the clear forms only
const JS_WRAP = '(?:(?:JSON\\s*\\.\\s*stringify|Object\\s*\\.\\s*(?:entries|values)|(?:util\\s*\\.\\s*)?inspect)\\s*\\(\\s*|\\{\\s*\\.\\.\\.\\s*)?';
const JS_ENV = 'process\\s*\\.\\s*env';
const JS_SINK = '(?:console\\s*\\.\\s*(?:log|info|debug|dir|table|warn|error|trace)|process\\s*\\.\\s*std(?:out|err)\\s*\\.\\s*write)\\s*\\(\\s*';
const JS_CLEAR_DUMP = new RegExp(`${JS_SINK}${JS_WRAP}${JS_ENV}\\s*[,)}]`);
const JS_CLEAR_SECRET = new RegExp(`${JS_SINK}${JS_ENV}\\s*(?:\\.\\s*(\\w+)|\\[\\s*["'\`](\\w+)["'\`]\\s*\\])\\s*[,)]`);
const PY_SINK = '(?:print|pprint|pp|sys\\s*\\.\\s*std(?:out|err)\\s*\\.\\s*write)\\s*\\(\\s*';
const PY_CLEAR_DUMP = new RegExp(`${PY_SINK}(?:(?:(?:dict|str|repr|json\\s*\\.\\s*dumps)\\s*\\(\\s*)*(?:os\\s*\\.\\s*)?environ\\s*[,)]|(?:[\\w.]+\\s*\\(\\s*)*(?:os\\s*\\.\\s*)?environ\\s*\\.\\s*(?:items|values)\\s*\\()`);
const PY_CLEAR_SECRET = new RegExp(`${PY_SINK}(?:os\\s*\\.\\s*)?(?:environ\\s*\\[\\s*["'](\\w+)["']\\s*\\]|(?:environ\\s*\\.\\s*get|getenv)\\s*\\(\\s*["'](\\w+)["']\\s*(?:,[^()]*)?\\))\\s*[,)]`);

const JS_MARK_PRINT = new RegExp(`${JS_SINK}[^;\\n]{0,400}${MARK}`);
const PY_MARK_PRINT = new RegExp(`${PY_SINK}[^;\\n]{0,400}${MARK}`);

function rawJudge(lang, code, printLast) {
  if (code.includes(MARK) && (lang === JS ? JS_MARK_PRINT : PY_MARK_PRINT).test(code)) return { kind: 'secret', streams: new Set([1, 2]) };
  if (lang === JS) {
    if (JS_CLEAR_DUMP.test(code)) return { kind: 'dump', streams: new Set([1, 2]) };
    if (printLast && new RegExp(`^\\s*${JS_WRAP}${JS_ENV}\\s*\\)?\\s*;?\\s*$`).test(code)) return { kind: 'dump', streams: new Set([1]) };
    const sm = JS_CLEAR_SECRET.exec(code) || (printLast ? new RegExp(`^\\s*${JS_ENV}\\s*\\.\\s*(\\w+)\\s*;?\\s*$`).exec(code) : null);
    if (sm && secretName(sm[1] || sm[2])) return { kind: 'secret', streams: new Set([1, 2]) };
    return null;
  }
  if (PY_CLEAR_DUMP.test(code)) return { kind: 'dump', streams: new Set([1, 2]) };
  const sm = PY_CLEAR_SECRET.exec(code);
  if (sm && secretName(sm[1] || sm[2])) return { kind: 'secret', streams: new Set([1, 2]) };
  return null;
}

/**
 * Judge one inline program. lang 'js' | 'py'. nested(text) judges a shell command string and returns a kind or null.
 * Returns { kind: 'dump'|'secret', streams: Set<1|2> } or null. A copy with \" and \' unescaped (PowerShell and cmd
 * quoting hand those to the program) is judged too; the stronger verdict wins.
 */
export function judgeProgram(langName, code, printLast, nested) {
  const lang = langName === 'py' ? PY : JS;
  const variants = [code];
  if (/\\["']/.test(code)) variants.push(code.replace(/\\(["'])/g, '$1'));
  let best = null;
  for (const v of variants) {
    let r;
    if (v.length > INLINE_CAP) r = rawJudge(lang, v, printLast); // over the cap: the clear forms only, no full analysis
    else {
      const lx = lang === PY ? lexPy(v) : lexJs(v);
      r = lx.ok ? analyze(lang, lx, printLast, nested) : rawJudge(lang, v, printLast);
    }
    if (r && (!best || (r.kind === 'dump' && best.kind !== 'dump'))) best = r;
  }
  return best;
}
