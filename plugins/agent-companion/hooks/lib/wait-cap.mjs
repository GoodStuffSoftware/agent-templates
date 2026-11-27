// Wait-loop cap: a background Bash command that holds an unbounded `until ...; do ... sleep ...; done`
// (or `while`) loop gets a deadline in the loop body, so a condition that never comes true ends the
// command instead of running for hours (two such loops ran 8+ hours on 2026-11-22 and kept their
// agents, and those agents' worktrees, alive).
//
//   waitCapRewrite(command, minutes) -> { command, count } | null
//
// The cap is a `$SECONDS` deadline set on the loop's first pass and tested at the top of every pass:
//   do : "${__ac_wcN:=$((SECONDS+S))}"; [ "$SECONDS" -lt "$__ac_wcN" ] || { echo "wait-cap: ..."; exit 124; }; <body>
// The cap applies to the whole background command, not to each wait: the variable is set on the loop's
// first pass and kept, so a loop re-entered inside an outer loop (or a function) shares one deadline. That
// is the purpose (stop a forgotten waiter). Raise `wait_loop_cap_minutes`, or set it to 0, for long
// multi-stage jobs. The guard also makes `$?` 0 for the first body command (the condition's status is lost;
// restoring it with `(exit $s)` would trip `set -e`, so it is documented, not patched).
// Pure bash builtins: no `timeout` (on Windows Git Bash `timeout` can resolve to System32\timeout.exe, a
// different program) and no child process. The message goes to stdout, exit status 124.
//
// A loop is left alone when it has no `sleep`, or already carries a bound: `timeout`, `$SECONDS` /
// `$EPOCHSECONDS`, arithmetic (`((`, `$((`, `let`, `expr`, `++`), or `date +%s`. Quoted text, comments
// and `$(...)` / backtick bodies are not scanned for loops. A command containing a heredoc (`<<` or
// `<<-`, quoted or not) is left completely alone: the body is text for another program and the outer
// shell may expand it. Not seen: loops inside `bash -c '...'` strings, functions called later. Fails open: any error is null.

const SEP = new Set([';', '&', '|', '\n', '(', ')']);
const OPENERS = new Set(['do', 'then', 'else', 'elif', '{', '!', 'while', 'until', 'if', 'time']);
const BOUND = /\btimeout\b|\bSECONDS\b|\bEPOCHSECONDS\b|\(\(|\blet\b|\bexpr\b|\+\+|\bdate\s+[^;\n]*%s/;

/** Words of a bash line with offsets: [{ text, start, end, cmd }] (cmd: the word is at command position). */
function words(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let cmd = true;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '<' || c === '>') { i += 1; continue; }
    if (SEP.has(c)) { cmd = true; i += 1; continue; }
    const start = i;
    while (i < n) {
      const d = src[i];
      if (d === ' ' || d === '\t' || d === '\r' || d === '\n' || d === ';' || d === '&' || d === '|' || d === '<' || d === '>' || d === ')' || d === '(') break;
      if (d === '\\') { i += 2; continue; }
      if (d === "'") { i += 1; while (i < n && src[i] !== "'") i += 1; i += 1; continue; }
      if (d === '"') {
        i += 1;
        while (i < n && src[i] !== '"') { if (src[i] === '\\') i += 1; i += 1; }
        i += 1; continue;
      }
      if (d === '`') { i += 1; while (i < n && src[i] !== '`') { if (src[i] === '\\') i += 1; i += 1; } i += 1; continue; }
      if (d === '$' && src[i + 1] === '(') {
        let depth = 0;
        i += 1;
        for (; i < n; i += 1) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
        }
        continue;
      }
      i += 1;
    }
    const text = src.slice(start, i);
    out.push({ text, start, end: i, cmd });
    cmd = cmd && OPENERS.has(text);
  }
  return out;
}

/** while / until loops with a sleep and no bound: [{ doEnd }] (offset just after the loop's `do`). */
function unboundedLoops(src) {
  const stack = [];
  const found = [];
  for (const w of words(src)) {
    if (!w.cmd) continue;
    if (w.text === 'while' || w.text === 'until' || w.text === 'for' || w.text === 'select') {
      stack.push({ kind: w.text, start: w.start, doEnd: null });
    } else if (w.text === 'do') {
      const top = stack[stack.length - 1];
      if (top && top.doEnd === null) top.doEnd = w.end;
    } else if (w.text === 'done') {
      const l = stack.pop();
      if (!l || l.doEnd === null || (l.kind !== 'while' && l.kind !== 'until')) continue;
      const body = src.slice(l.start, w.end);
      if (/\bsleep\b/.test(body) && !BOUND.test(body)) found.push({ doEnd: l.doEnd });
    }
  }
  return found;
}

export function capSeconds(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(1, Math.round(m * 60));
}

const HEREDOC = /(^|[^<])<<-?[ \t]*['"\\]?[A-Za-z_]/;

export function waitCapRewrite(command, minutes) {
  try {
    const secs = capSeconds(minutes);
    if (!secs || typeof command !== 'string' || !/\b(until|while)\b/.test(command) || !/\bsleep\b/.test(command) || HEREDOC.test(command)) return null;
    const loops = unboundedLoops(command);
    if (!loops.length) return null;
    const label = `${Number(minutes)}`;
    let out = command;
    // Last loop first: each insert only shifts the text after it.
    const ordered = loops.map((l, idx) => ({ ...l, idx })).sort((a, b) => b.doEnd - a.doEnd);
    for (const l of ordered) {
      const v = `__ac_wc${l.idx + 1}`;
      const ins = ` : "\${${v}:=$((SECONDS+${secs}))}"; [ "$SECONDS" -lt "$${v}" ] || { echo "wait-cap: gave up after ${label} min; condition never met"; exit 124; };`;
      out = out.slice(0, l.doEnd) + ins + out.slice(l.doEnd);
    }
    return { command: out, count: loops.length };
  } catch { return null; }
}

// Worker one-wait rewrite (0.31.79): a repeat foreground wait (sleep, poll or watch loop) in a worker is not refused; it runs
// as the sanctioned one-wait form, a background command that notifies on finish, with the loop cap applied as for any background
// loop. Returns the new tool input, or null when there is nothing to rewrite (already background).
export const WAIT_REWRITE_NOTE = '[agent-companion] This wait runs as a background command (one-wait rule): its result arrives as a completion notice. Do not poll or re-run it.';
export function waitRewriteInput(input, { capMinutes = 60 } = {}) {
  try {
    if (!input || typeof input.command !== 'string' || input.run_in_background === true) return null;
    const cap = capMinutes > 0 && /sleep/.test(input.command) ? waitCapRewrite(input.command, capMinutes) : null;
    return { ...input, command: cap ? cap.command : input.command, run_in_background: true };
  } catch { return null; }
}
