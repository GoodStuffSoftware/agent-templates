// Shell-read guard for subagents (0.31.65). Writers read code through `sed -n 'A,Bp' f`, `cat f`, `head`, `tail`, `Get-Content` and
// `awk` as much as through Read (514 shell reads against 164 Reads in a 38-writer sample, 22% of their context), and no hook saw those:
// read-cap and read-dedupe are registered on Read only, and a walk through new ranges of one file never repeats a covered range.
//
// A PreToolUse hook on Bash and PowerShell. A plain read of one text file is run through the SAME rules and the SAME per-agent ledger as
// a Read (hooks/lib/read-dedupe.mjs: decideShell), so a shell read and a Read of the same lines count once:
//   - the lines are already in this agent's context and the file is unchanged   -> deny (read_dedupe)
//   - the call reads more than read_cap_lines lines at once                     -> deny (read_cap)
//   - the file already cost this agent read_budget_lines distinct lines         -> deny new lines (read_budget); a nudge at 75%
//   - the first read of a file over 400 lines                                   -> allow, with a compact outline as additionalContext
// A denial names the equivalent Read call (file_path, offset, limit); the identical command, repeated, runs (dedupe's override).
//
// Untouched: the main thread (payloads from a subagent carry agent_id), a command that is not a plain read of one file (a search piped
// into grep, a list of commands, a redirect, a glob, several files), binary files, files outside the agent's cwd and repository, logs
// and tool output (*.log, *.out, tmp directories), and a file over 2 MB. Fails open: any error lets the command run.
// Cost: a call that is not a read costs one JSON.parse and a regex; the rest of the code is loaded only for a read-shaped command.

import { readFileSync } from 'node:fs';

function pass() { process.exit(0); }

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { pass(); }
if (!raw.includes('"agent_id"')) pass(); // main thread: nothing to do, and no further code loaded
let p;
try { p = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { pass(); }

const { mayBeShellRead } = await import('./lib/read-shell.mjs');
const command = p && p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
if (!p || !p.agent_id || (p.tool_name !== 'Bash' && p.tool_name !== 'PowerShell') || !mayBeShellRead(command)) pass();

try {
  const T0 = Date.now();
  const { parseShellRead, resolveRange, isOutputFile, outlineOf, outlineKind, countLinesIn, OUTLINE_MAX_CHARS } = await import('./lib/read-shell.mjs');
  const r = parseShellRead(command);
  if (!r) pass();
  const { statSync, readFileSync: rf, existsSync } = await import('node:fs');
  const { resolve, dirname, relative } = await import('node:path');
  const ctx = await import('./lib/context.mjs');
  const { isServedCall } = await import('./lib/delegation.mjs');
  const rd = await import('./lib/read-dedupe.mjs');
  if (!ctx.opt('read_dedupe', true) || isServedCall(p)) pass();
  const sid = String(p.session_id ?? '');
  if (!sid) pass();

  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const file = resolve(cwd, r.file);
  // The agent's own repository: nearest ancestor of cwd with a .git (a worktree has a .git file); else cwd.
  let root = cwd;
  for (let d = resolve(cwd), i = 0; i < 20; i += 1) {
    if (existsSync(resolve(d, '.git'))) { root = d; break; }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!ctx.pathUnder(file, root) && !ctx.pathUnder(file, cwd)) pass();
  if (isOutputFile(relative(ctx.pathUnder(file, root) ? root : cwd, file))) pass();
  const st = statSync(file);
  if (!st.isFile() || st.size > 2 * 1024 * 1024 || st.size === 0) pass();
  const buf = rf(file);
  if (buf.subarray(0, 8192).includes(0)) pass();
  const text = buf.toString('utf8');
  const total = countLinesIn(text);
  const range = resolveRange(r, total);
  if (!range) pass();
  const [a, b] = range;

  const budget = ctx.opt('read_budget', true) ? rd.budgetOf(Number(ctx.opt('read_budget_lines', rd.READ_BUDGET_LINES_DEFAULT))) : null;
  let cap = 0;
  if (ctx.opt('read_cap', true)) {
    cap = Number(ctx.opt('read_cap_lines', 300));
    if (!Number.isFinite(cap) || cap < 1) cap = 300;
    cap = Math.floor(cap);
  }
  const agent = rd.agentOf(p);
  const pk = rd.pathKeyOf(file, cwd);
  const stat = { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs };
  const bigLines = outlineKind(file) ? total : 0;
  const res = rd.withState(sid, agent, (state) => rd.decideShell(state, { agent, pk, a, b, total, stat, budget, cap, bigLines }));
  const v = res.value;
  if (!res.locked || !v) pass();

  const row = (outcome, x = {}) => {
    try {
      ctx.appendLog(rd.TELEMETRY_STREAM, {
        at: new Date().toISOString(), session_id: sid, agent_id: agent, hook_event: 'pre', source: 'shell',
        path_hash: rd.pathHash(pk), range: `${a}-${b}`, outcome, ...x, lock_wait_ms: res.wait_ms, duration_ms: Date.now() - T0,
      });
    } catch { /* telemetry never breaks a command */ }
  };
  const readCall = (lo, n) => `Read(file_path="${r.file}", offset=${lo}, limit=${n})`;
  const REPEAT = 'Repeat this exact command and it will run.';

  if (v.action === 'deny') {
    row('deny', { reason: v.reason, est_chars_avoided: v.est });
    let msg;
    if (v.reason === 'covered') {
      msg = `Unchanged since your earlier read (lines ${a}-${b}). If that content is no longer in your context, repeat this command and it will run. Equivalent: ${readCall(a, b - a + 1)}.`;
    } else if (v.reason === 'cap') {
      msg = `That reads ${b - a + 1} lines in one call, over the ${v.cap}-line cap. Read ${v.cap} at a time: ${readCall(a, v.cap)}, or grep -n for the symbol you need first and Read offset/limit 80. ${REPEAT}`;
    } else {
      msg = `Read budget: you have already read ${v.have} distinct lines of ${r.file} (budget ${v.max}). grep -n for the symbol you need, then ${readCall(a, Math.min(80, b - a + 1))}. ${REPEAT}`;
    }
    ctx.deny(msg);
  }
  const notes = [];
  if (v.nudge) {
    row('nudge', { have: v.have });
    notes.push(`[agent-companion] read budget: you have read ${v.have} distinct lines of ${r.file} and this read passes ${budget.nudge}. Stop walking it in chunks: grep -n for the symbol you need, then Read offset/limit 80. New lines past ${budget.max} are denied.`);
  }
  if (v.outline) {
    const o = outlineOf(text, file, OUTLINE_MAX_CHARS);
    if (o) {
      row('outline');
      notes.push(`[agent-companion] outline of ${r.file} (${total} lines, name:line): ${o}. Read offset/limit from these line numbers.`);
    }
  }
  if (v.action === 'retry') row('retry-ran');
  if (notes.length) {
    ctx.writeAndExit(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join('\n') } }));
  }
  pass();
} catch {
  pass();
}
