// Python reading its program from a NUL stdin (0.31.18). Pure and unit-testable; called from
// hooks/poll-guard.mjs on Bash (win32 only), as a DENY path separate from that hook's advisories.
//
// Reproduced: Python 3.14.x on Windows, started with no program argument (`python3 -`,
// `python3 - x`, `python3 -u -`, bare `python3`) while stdin is the NUL device, takes NUL for a
// terminal (isatty True), starts the REPL and spins at ~1 MB/s of stderr, forever, through every
// entry point (the shims, `py`, the real python.exe). NUL stdin comes from `< /dev/null`, an
// empty heredoc, or the Bash tool's own stdin in background runs. Safe: -c, -m, a script path,
// a heredoc with a body, a pipe (even empty), an empty file. 3.12 is unaffected.
//
// One linear pass splits a Bash command into simple commands (quotes, escapes, comments, $(..),
// backticks, heredoc bodies skipped as data), then checks each Python launcher. Any exception
// allows (fail-open).
//
// A bare subshell or brace group is followed: `(python3 -)` and `{ python3 -; }` hang unless the group is
// piped into or has a stdin redirect of its own (`echo x | (python3 -)`, `{ python3 -; } < f`).
//
// Wrapped forms (0.31.21) are judged exactly as the plain call is: a loop body counts as a group (fed by a pipe into the
// loop or a stdin redirect on `done`), a function body is judged at its call sites (never called in this command:
// allowed; called with nothing on stdin: denied), `timeout [opts] N` and `env [-u X | -C D | -i | NAME=v]` are looked
// through, and a substitution inside double quotes (`"$(python3 -)"`) is parsed like an unquoted one. Quoted
// substitutions are followed to PY_MAX_DEPTH levels, deeper text is data. The judging pass has a step budget; running
// out of it, like any exception, allows.

import { recordDenial } from './context.mjs';

export const PY_ACK = /guard-ack:\s*python-stdin/i;

export const PY_MSG =
  'Python reading its program from stdin with nothing on stdin hangs here: Python 3.14 on Windows (every launcher: python3 / python.exe shim, ' +
  '`py`, and the real python.exe) sees the NUL device as a terminal, starts its REPL and spins at ~1 core ' +
  'writing to stderr, outliving the Bash tool timeout. It fires on `python3 -` or a bare ' +
  '`python3` with `< /dev/null`, an EMPTY heredoc, or no stdin at all (the Bash tool often hands commands a NUL stdin). Use instead: ' +
  '`python3 -c \'...\'`; `python3 -m <module>`; write the script to a scratch file and run `python3 <file>`; ' +
  'feed the program through a heredoc with a body; or pipe it in (`echo ... | python3 -`). ' +
  'The absolute python.exe path does NOT help (same bug). If stdin really is ' +
  'supplied another way, re-run with `# guard-ack: python-stdin` appended, or set the plugin option python_stdin_guard to warn or off.';

const PY_LAUNCHER = /^(?:python|pythonw|py|pyw)(?:\d+(?:\.\d+)?)?(?:-(?:32|64|arm64))?(?:\.exe)?$/i;
const PY_PREFIX = new Set(['exec', 'command', 'builtin', 'nohup', 'time', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const PY_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PY_NUL = /^(?:\/dev\/null|nul:?)$/i;
const PY_FD = /\d+(?=[<>])/y;
const PY_LEAD = new Set(['then', 'else', 'elif', 'if', '!', 'time']); // words that may precede a command's own first word
const PY_LOOPS = new Set(['for', 'while', 'until', 'select']);
const PY_MAX_DEPTH = 8;      // nested double-quoted substitutions followed
const PY_BUDGET = 3000000;   // steps the judging pass may take before it gives up (allow)

/**
 * Decide on one Bash command. Returns null (allow) or { message }.
 * opts.platform defaults to process.platform (injectable for tests); opts.mode is deny|warn|off.
 * Fail-open: any exception returns null.
 */
export function pythonStdinCheck(command, opts = {}) {
  try {
    const platform = opts.platform ?? process.platform;
    const mode = String(opts.mode ?? 'deny').toLowerCase();
    if (platform !== 'win32' || mode === 'off') return null;
    const cmd = String(command || '');
    if (!cmd || PY_ACK.test(cmd)) return null;
    const msg = pyStdinHang(cmd);
    return msg ? { message: msg, mode: mode === 'warn' ? 'warn' : 'deny' } : null;
  } catch { return null; }
}

// true when the argument list leaves Python reading its program from stdin.
function pyReadsStdin(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-') return true;
    if (a === '--') return k + 1 >= args.length;
    if (a.startsWith('--')) return false;            // --help, --version, --list, ...: exits, or unknown
    if (a.length > 1 && a[0] === '-') {
      if (/^-0/.test(a)) return false;                // py -0 / -0p: lists runtimes and exits
      if (/^-[1-9]/.test(a) || /^-V:/i.test(a)) continue; // py version selectors
      for (let c = 1; c < a.length; c++) {
        const ch = a[c];
        if (ch === 'c' || ch === 'm' || ch === 'h' || ch === '?' || ch === 'V') return false;
        if (ch === 'W' || ch === 'X') { if (c === a.length - 1) k++; break; } // the option's value
      }
      continue;
    }
    return false;                                      // a script path (or anything unknown)
  }
  return true;                                         // no program argument: stdin
}

// env: skip its options and NAME=value words; returns the index of the command it runs (k is just past `env`).
function skipEnv(w, k) {
  while (k < w.length) {
    const a = w[k];
    if (a === '--') return k + 1;
    if (PY_ASSIGN.test(a)) { k++; continue; }
    if (a === '-') { k++; continue; } // legacy -i
    if (a.length === 1 || a[0] !== '-') return k;
    if (a[1] === '-') { // long option; these take a value in the next word when written without '='
      k += /^--(?:unset|chdir|split-string|argv0|block-signal|default-signal|ignore-signal)$/.test(a) ? 2 : 1;
      continue;
    }
    k++;
    for (let c = 1; c < a.length; c++) { // short cluster: u, C, S, a take a value; attached or in the next word
      if ('uCSa'.includes(a[c])) { if (c === a.length - 1) k++; break; }
    }
  }
  return k;
}

// timeout: skip its options and the DURATION; returns the index of the command it runs (k is just past `timeout`).
function skipTimeout(w, k) {
  while (k < w.length) {
    const a = w[k];
    if (a === '--') { k++; break; }
    if (a.length < 2 || a[0] !== '-') break;
    if (a[1] === '-') { k += /^--(?:signal|kill-after)$/.test(a) ? 2 : 1; continue; }
    k++;
    for (let c = 1; c < a.length; c++) {
      if (a[c] === 's' || a[c] === 'k') { if (c === a.length - 1) k++; break; }
    }
  }
  return k < w.length ? k + 1 : k;
}

// Index of the program word in a simple command: past prefix words, NAME=value, env and timeout, in any order.
function progIndex(w) {
  let k = 0;
  while (k < w.length) {
    const a = w[k];
    if (PY_PREFIX.has(a) || PY_ASSIGN.test(a)) k++;
    else if (a === 'env') k = skipEnv(w, k + 1);
    else if (a === 'timeout') k = skipTimeout(w, k + 1);
    else break;
  }
  return k;
}

function pyStdinHang(cmd) {
  if (!/py/i.test(cmd)) return null;
  const ctx = { done: [], fns: [] };
  scan(cmd, 0, null, 0, null, ctx);
  return judge(ctx);
}

// One linear pass over cmd[i0..]. base: the frame the text runs inside (null at the top). term: ')' or '`' when this is
// the body of a substitution inside double quotes (the scan stops after its closing character). Simple commands go to
// ctx.done; function-body frames to ctx.fns. Returns the index to continue from.
function scan(cmd, i0, base, depth, term, ctx) {
  const n = cmd.length;
  const ws = (c) => c === ' ' || c === '\t' || c === '\r';
  const stop = (c) => ws(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')' || c === '`';
  const stack = [];      // {kind: 'group'|'loop'|'case'|'subst'|'bt', saved}
  const done = ctx.done;
  const pending = [];    // heredocs whose body starts at the next newline
  const hdr = [];        // for/while/until headers seen, each holding whether its input is piped; popped by the matching `do`
  let i = i0, cur = null, gtop = base; // gtop: the innermost open ( ) / { } / do..done frame (each frame points at its parent)
  const start = (piped) => { cur = { words: [], redirs: [], piped, frame: gtop, afterGroup: null, fnDef: false, fnName: null, lead: true }; };
  const open = (kind, piped, extra) => {
    const fr = { kind, parentG: gtop, piped, redirs: [], res: undefined, ...extra };
    stack.push(fr); gtop = fr;
    if (fr.fn) ctx.fns.push(fr);
  };
  const pop = () => { const t = stack.pop(); if (t && (t.kind === 'group' || t.kind === 'loop')) gtop = t.parentG; return t; };
  const skipArith = (p) => { // p is just past an opening ((; returns the index past the matching ))
    let d = 2;
    for (; p < n; p++) { if (cmd[p] === '(') d++; else if (cmd[p] === ')' && --d === 0) return p + 1; }
    return n;
  };
  const finish = () => { if (cur && (cur.words.length || cur.redirs.length)) done.push(cur); cur = null; };
  const readWord = () => {
    let o = '';
    while (i < n) {
      const c = cmd[i];
      if (stop(c) || (c === '$' && cmd[i + 1] === '(')) break;
      if (c === "'") { const j = cmd.indexOf("'", i + 1); if (j < 0) { o += cmd.slice(i + 1); i = n; break; } o += cmd.slice(i + 1, j); i = j + 1; continue; }
      if (c === '"') {
        i++;
        while (i < n && cmd[i] !== '"') {
          const d = cmd[i];
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(cmd[i + 1])) { o += cmd[i + 1]; i += 2; }
          else if (depth < PY_MAX_DEPTH && (d === '`' || (d === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '('))) {
            // a substitution inside double quotes runs like an unquoted one: scan its body in place
            o += '\0';
            i = scan(cmd, i + (d === '`' ? 1 : 2), gtop, depth + 1, d === '`' ? '`' : ')', ctx);
          } else o += cmd[i++];
        }
        i++; continue;
      }
      if (c === '\\') { if (cmd[i + 1] !== '\n' && i + 1 < n) o += cmd[i + 1]; i += 2; continue; }
      if (c === '$' && cmd[i + 1] === '{') { const j = cmd.indexOf('}', i + 2); const e = j < 0 ? n : j + 1; o += cmd.slice(i, e); i = e; continue; }
      if (c === '$' && cmd[i + 1] === "'") { i++; continue; }
      o += c; i++;
    }
    if (i > n) i = n;
    return o;
  };
  const readBodies = () => { // i is on the newline that ends the heredoc line
    i++;
    for (let q = 0; q < pending.length; q++) {
      const h = pending[q];
      let empty = true;
      while (i < n) {
        let e = cmd.indexOf('\n', i); if (e < 0) e = n;
        let line = cmd.slice(i, e); if (line.endsWith('\r')) line = line.slice(0, -1);
        i = e + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        empty = false;
      }
      h.r.bodyEmpty = empty;
    }
    pending.length = 0;
    if (i > n) i = n;
  };
  start(false);
  while (i < n) {
    const c = cmd[i];
    if (ws(c)) { i++; continue; }
    if (c === '\\' && cmd[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && cmd[i] !== '\n') i++; continue; }
    if (c === '\n') {
      const fnHead = cur.fnDef && !cur.words.length && !cur.redirs.length ? cur.fnName : null; // `f()` then `{` on the next line
      finish(); if (pending.length) readBodies(); else i++; start(false);
      if (fnHead) { cur.fnDef = true; cur.fnName = fnHead; }
      continue;
    }
    if (c === ';') {
      finish();
      const t = stack[stack.length - 1];
      if (cmd[i + 1] === ';' && t && t.kind === 'case') t.pat = true; // ;; ends a case item: a pattern follows
      i++; while (cmd[i] === ';' || cmd[i] === '&') i++; start(false); continue;
    }
    if (c === '&' && cmd[i + 1] === '>') { // &> / &>> file
      i += 2; if (cmd[i] === '>') i++; while (i < n && ws(cmd[i])) i++;
      cur.redirs.push({ op: '>', fd: '1', target: readWord() }); continue;
    }
    if (c === '&') { finish(); i += cmd[i + 1] === '&' ? 2 : 1; start(false); continue; }
    if (c === '|') {
      const t = stack[stack.length - 1];
      if (t && t.kind === 'case' && t.pat) { i++; continue; } // a|b) pattern alternation
      finish();
      if (cmd[i + 1] === '|') { i += 2; start(false); } else { i += cmd[i + 1] === '&' ? 2 : 1; start(true); }
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] === '(') { cur.words.push(' '); i = skipArith(i + 3); continue; } // $(( .. ))
    if (c === '(' && cmd[i + 1] === '(' && cur.words.length === 0) { finish(); i = skipArith(i + 2); start(false); continue; } // (( .. ))
    if ((c === '$' || c === '<' || c === '>') && cmd[i + 1] === '(') { // $(..), <(..), >(..)
      cur.words.push('\0'); stack.push({ kind: 'subst', saved: cur }); i += 2; start(false); continue;
    }
    if (c === '(') {
      let j = i + 1;
      while (j < n && ws(cmd[j])) j++;
      if (cmd[j] === ')' && (cur.words.length === 1 || (cur.words.length === 2 && cur.words[0] === 'function'))) { // name() or function name()
        const nm = cur.words[cur.words.length - 1];
        i = j + 1; start(false); cur.fnDef = true; cur.fnName = nm; continue;
      }
      const pp = cur.piped; finish(); open('group', pp); i++; start(false); continue;
    }
    if (c === ')') {
      const t = stack[stack.length - 1];
      if (!t && term === ')') { finish(); return i + 1; } // the end of a substitution inside double quotes
      if (!t || t.kind === 'case') { if (t) t.pat = false; i++; start(false); continue; } // a case pattern: its words are not a command
      finish(); i++;
      const top = pop();
      if (top && top.kind === 'subst') cur = top.saved;
      else { start(false); if (top && top.kind === 'group') cur.afterGroup = top; }
      continue;
    }
    if (c === '`') {
      i++;
      const top = stack[stack.length - 1];
      if (!top && term === '`') { finish(); return i; } // the end of a backtick substitution inside double quotes (i is past it)
      if (top && top.kind === 'bt') { finish(); pop(); cur = top.saved; } else { cur.words.push('\0'); stack.push({ kind: 'bt', saved: cur }); start(false); }
      continue;
    }
    PY_FD.lastIndex = i;
    const fm = PY_FD.exec(cmd);
    const fd = fm ? fm[0] : null;
    const r0 = fm ? i + fd.length : i;
    if (cmd[r0] === '<' || cmd[r0] === '>') {
      i = r0;
      let op;
      if (cmd.startsWith('<<<', i)) op = '<<<';
      else if (cmd.startsWith('<<-', i)) op = '<<-';
      else if (cmd.startsWith('<<', i)) op = '<<';
      else if (cmd.startsWith('<&', i)) op = '<&';
      else if (cmd.startsWith('<>', i)) op = '<>';
      else if (cmd[i] === '<') op = '<';
      else if (cmd.startsWith('>>', i) || cmd.startsWith('>&', i) || cmd.startsWith('>|', i)) op = cmd.slice(i, i + 2);
      else op = '>';
      i += op.length;
      while (i < n && ws(cmd[i])) i++;
      const r = { op, fd: fd !== null ? fd : (op[0] === '<' ? '0' : '1'), target: readWord(), bodyEmpty: null };
      cur.redirs.push(r);
      if (cur.afterGroup) cur.afterGroup.redirs.push(r); // a redirect right after a group's close belongs to the group
      if (op === '<<' || op === '<<-') pending.push({ delim: r.target, strip: op === '<<-', r });
      continue;
    }
    const w = readWord();
    if (!w && i < n && !stop(cmd[i])) { i++; continue; } // never stall
    if (cur.words.length === 0) {
      if (w === '{') { open('group', cur.piped, cur.fnDef ? { fn: true, name: cur.fnName } : undefined); start(false); continue; }
      if (w === 'do') { open('loop', hdr.length ? hdr.pop() : cur.piped); start(false); continue; }
      if (w === 'case') stack.push({ kind: 'case', pat: false });
      if (w === 'esac') { finish(); const t = stack[stack.length - 1]; if (t && t.kind === 'case') pop(); start(false); continue; }
      if (w === '}' || w === 'done') {
        finish(); const t = stack[stack.length - 1]; const closes = t && (t.kind === 'group' || t.kind === 'loop');
        if (closes) pop();
        start(false); if (closes) cur.afterGroup = t;
        continue;
      }
    } else if (w === '{' && cur.words.length === 2 && cur.words[0] === 'function') { // function name { ... }
      open('group', false, { fn: true, name: cur.words[1] }); start(false); continue;
    }
    if (cur.lead) { // the first word of the command proper (past then/else/!/...)
      if (PY_LOOPS.has(w)) hdr.push(cur.piped);
      if (!PY_LEAD.has(w)) cur.lead = false;
    }
    cur.afterGroup = null;
    cur.words.push(w);
    if (w === 'in' && cur.words[0] === 'case') { const t = stack[stack.length - 1]; if (t && t.kind === 'case') t.pat = true; }
  }
  finish();
  for (const h of pending) h.r.bodyEmpty = true; // heredoc with no body before the end
  return i < n ? i : n;
}

// A stdin redirect (fd 0, '<' family) leaves the command fed unless it is NUL or an empty heredoc.
const redirFed = (r) => ((r.op === '<<' || r.op === '<<-') ? r.bodyEmpty === false : !(r.op === '<' && PY_NUL.test(r.target)));
const stdinRedir = (r) => r.fd === '0' && r.op[0] === '<';

// Decide on the commands scan() found. Returns PY_MSG for the first python that reads stdin with nothing feeding it.
function judge(ctx) {
  const { done, fns } = ctx;
  let steps = 0;
  const tick = () => { if (++steps > PY_BUDGET) throw new Error('step budget'); };
  // Function bodies are judged at their call sites in this command: calls[name] lists the commands that run the function.
  const fnNames = new Set();
  for (const f of fns) fnNames.add(f.name);
  const calls = new Map();
  for (const c of done) {
    c.k = progIndex(c.words);
    if (fnNames.size && c.k < c.words.length && fnNames.has(c.words[c.k])) {
      const l = calls.get(c.words[c.k]);
      if (l) l.push(c); else calls.set(c.words[c.k], [c]);
    }
  }
  // Does stdin reach a group, loop or function frame from outside? True when it is piped into or has a stdin redirect that is
  // not NUL or an empty heredoc, or an enclosing frame does. A function frame without a redirect of its own is fed when every
  // call to it is (no call in this command: it only defines the function, so nothing runs). Memoized up the parent chain, so
  // the cost stays linear; a result that leaned on a function still being evaluated (recursion) is not memoized.
  let hits = new Set();            // names of functions met while still being evaluated, in the current evaluation
  const fnRes = new Map();         // name -> true | false | 'busy'
  const ownFed = (fr) => fr.piped === true || fr.redirs.some((r) => stdinRedir(r) && redirFed(r));
  const fnFed = (fr) => {
    const st = fnRes.get(fr.name);
    if (st === true || st === false) return st;
    if (st === 'busy') { hits.add(fr.name); return true; } // a call inside the function itself adds no new source
    fnRes.set(fr.name, 'busy');
    const saved = hits; hits = new Set();
    let fed = true;
    const list = calls.get(fr.name);
    if (list) for (const c of list) { tick(); if (!cmdFed(c)) { fed = false; break; } }
    hits.delete(fr.name);
    if (hits.size) { fnRes.delete(fr.name); for (const h of hits) saved.add(h); } else fnRes.set(fr.name, fed);
    hits = saved;
    return fed;
  };
  const frameFed = (fr) => {
    const saved = hits; hits = new Set();
    const chain = [];
    let res = false;
    for (let x = fr; x; x = x.parentG) {
      tick();
      if (x.res !== undefined) { res = x.res; break; }
      chain.push(x);
      if (ownFed(x)) { res = true; break; }
      if (x.fn) { res = fnFed(x); break; }
    }
    if (hits.size === 0) for (const x of chain) x.res = res;
    for (const h of hits) saved.add(h);
    hits = saved;
    return res;
  };
  // Is stdin supplied to this simple command by something other than NUL / an empty heredoc?
  const cmdFed = (c) => {
    let sin = null;
    for (const r of c.redirs) if (stdinRedir(r)) sin = r;
    if (sin) return redirFed(sin);
    return c.piped || (c.frame ? frameFed(c.frame) : false);
  };
  for (const c of done) {
    tick();
    const w = c.words, k = c.k;
    if (k >= w.length) continue;
    if (!PY_LAUNCHER.test(w[k].split(/[\\/]/).pop())) continue;
    if (!pyReadsStdin(w.slice(k + 1))) continue;
    if (!cmdFed(c)) return PY_MSG;
  }
  return null;
}

/**
 * The hook entry: pythonStdinCheck on a Bash payload, plus one denials.jsonl record per firing
 * (guard 'python-stdin', outcome 'deny', or 'warn' in warn mode; an allow writes nothing). The command text rides in
 * `detail`, which recordDenial truncates to 300 characters, as it does for every guard.
 */
export function pythonStdinGuard(payload, opts = {}) {
  const command = ((payload || {}).tool_input || {}).command;
  const r = pythonStdinCheck(command, opts);
  if (r) {
    try { recordDenial('python-stdin', payload, `python reading its program from stdin: ${String(command)}`, r.mode === 'warn' ? 'warn' : 'deny'); } catch { /* telemetry never blocks */ }
  }
  return r;
}
