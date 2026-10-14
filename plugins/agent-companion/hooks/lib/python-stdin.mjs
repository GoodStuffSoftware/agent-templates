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
// Accepted gaps (still allowed): a python call inside `for ...; do python3 -; done` (a loop counts
// as a group whose own redirect is not followed), inside a function body, `timeout N python3 -`,
// `env -u X python3 -`, and `"$(python3 -)"` (a substitution inside double quotes is read as data).

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

function pyStdinHang(cmd) {
  if (!/py/i.test(cmd)) return null;
  const n = cmd.length;
  const ws = (c) => c === ' ' || c === '\t' || c === '\r';
  const stop = (c) => ws(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')' || c === '`';
  const stack = [];      // {kind: 'group'|'loop'|'case'|'subst'|'bt', saved}
  const done = [];
  const pending = [];    // heredocs whose body starts at the next newline
  let i = 0, cur = null, gtop = null; // gtop: the innermost open ( ) / { } / do..done frame (each frame points at its parent)
  const start = (piped) => { cur = { words: [], redirs: [], piped, frame: gtop, afterGroup: null, fnDef: false }; };
  const open = (kind, piped, extra) => { const fr = { kind, parentG: gtop, piped, redirs: [], res: undefined, ...extra }; stack.push(fr); gtop = fr; };
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
      if (c === '"') { i++; while (i < n && cmd[i] !== '"') { if (cmd[i] === '\\' && i + 1 < n && '$`"\\\n'.includes(cmd[i + 1])) { o += cmd[i + 1]; i += 2; } else o += cmd[i++]; } i++; continue; }
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
    if (c === '\n') { finish(); if (pending.length) readBodies(); else i++; start(false); continue; }
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
      if (cmd[j] === ')' && cur.words.length === 1) { i = j + 1; start(false); cur.fnDef = true; continue; } // name() function definition
      const pp = cur.piped; finish(); open('group', pp); i++; start(false); continue;
    }
    if (c === ')') {
      const t = stack[stack.length - 1];
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
      if (w === '{') { open('group', cur.piped, { fn: cur.fnDef }); start(false); continue; }
      if (w === 'do') { open('loop', cur.piped); start(false); continue; }
      if (w === 'case') stack.push({ kind: 'case', pat: false });
      if (w === 'esac') { finish(); const t = stack[stack.length - 1]; if (t && t.kind === 'case') pop(); start(false); continue; }
      if (w === '}' || w === 'done') {
        finish(); const t = stack[stack.length - 1]; const closes = t && (t.kind === 'group' || t.kind === 'loop');
        if (closes) pop();
        start(false); if (closes && t.kind === 'group') cur.afterGroup = t;
        continue;
      }
    }
    cur.afterGroup = null;
    cur.words.push(w);
    if (w === 'in' && cur.words[0] === 'case') { const t = stack[stack.length - 1]; if (t && t.kind === 'case') t.pat = true; }
  }
  finish();
  for (const h of pending) h.r.bodyEmpty = true; // heredoc with no body before the end
  // Does stdin reach the commands of a group frame from outside? True when the group is piped into or has a stdin redirect that is
  // not NUL or an empty heredoc, or an enclosing group does. A loop or a function body is an accepted gap (counts as fed).
  // Memoized up the parent chain, so the cost stays linear.
  const ownFed = (fr) => fr.kind === 'loop' || fr.fn === true || fr.piped === true || fr.redirs.some((r) => r.fd === '0' && r.op[0] === '<'
    && !((r.op === '<<' || r.op === '<<-') ? r.bodyEmpty !== false : (r.op === '<' && PY_NUL.test(r.target))));
  const frameFed = (fr) => {
    const chain = [];
    let res = false;
    for (let x = fr; x; x = x.parentG) {
      if (x.res !== undefined) { res = x.res; break; }
      chain.push(x);
      if (ownFed(x)) { res = true; break; }
    }
    for (const x of chain) x.res = res;
    return res;
  };
  for (const c of done) {
    const w = c.words;
    let k = 0;
    while (k < w.length && (PY_PREFIX.has(w[k]) || PY_ASSIGN.test(w[k]))) k++;
    if (w[k] === 'env') { k++; while (k < w.length && (w[k].startsWith('-') || PY_ASSIGN.test(w[k]))) k++; }
    if (k >= w.length) continue;
    if (!PY_LAUNCHER.test(w[k].split(/[\\/]/).pop())) continue;
    if (!pyReadsStdin(w.slice(k + 1))) continue;
    let sin = null;
    for (const r of c.redirs) if (r.fd === '0' && r.op[0] === '<') sin = r;
    if (!sin) { if (c.piped || (c.frame && frameFed(c.frame))) continue; return PY_MSG; }
    if (sin.op === '<<' || sin.op === '<<-') { if (sin.bodyEmpty !== false) return PY_MSG; continue; }
    if (sin.op === '<' && PY_NUL.test(sin.target)) return PY_MSG;
  }
  return null;
}
