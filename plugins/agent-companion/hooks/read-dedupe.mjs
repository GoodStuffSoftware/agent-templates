// Read dedupe: deny a repeat Read of lines this agent already has in context
// and the file has not changed since. Rules, state and the reasoning behind
// every threshold: hooks/lib/read-dedupe.mjs. Registered for several events,
// told apart by --event:
//   pre         PreToolUse Read: decide (the only event that can deny)
//   post        PostToolUse Read: record the lines the read returned
//   invalidate  PostToolUse Edit|Write|NotebookEdit|MultiEdit: forget the path
//   reset       PreCompact, SessionStart compact|clear: forget the agent
// Fails open everywhere: any error, unreadable state or lock timeout lets the
// read run. Returns a deny and NOTHING else (no allow decision, no
// updatedInput), so permission prompts are never skipped.
//
// read_dedupe (default true) is the opt-out: `false`, or
// CLAUDE_PLUGIN_OPTION_READ_DEDUPE=0 in the environment.
//
// Telemetry, telemetry/read-dedupe.jsonl (fields: docs/TELEMETRY.md): a row per
// denial (outcome "deny"), per denied request that was repeated and ran
// ("retry-ran"), per repeat-eligible read that was allowed ("allow", with the
// reason: the denominator of the denial rate), and per lock that could not be
// taken ("lock-timeout": the hook failed open and, for a post, a read went
// unrecorded).

import { resolve, dirname, relative } from 'node:path';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { readStdin, opt, deny, passthrough, appendLog, writeAndExit, callerIsSubagent, pathUnder } from './lib/context.mjs';
import { isServedCall } from './lib/delegation.mjs';
import { outlineKind, outlineOf, countLinesIn, OUTLINE_MAX_CHARS, inBudgetScope } from './lib/read-shell.mjs';
import {
  budgetOf, READ_BUDGET_LINES_DEFAULT, OUTLINE_MIN_LINES,
  TELEMETRY_STREAM, agentOf, pathKeyOf, pathHash, statOf, withState, resetAgent, decide, record, invalidate, denyText, requestOf,
} from './lib/read-dedupe.mjs';

const T0 = Date.now();

function eventArg() {
  const i = process.argv.indexOf('--event');
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

function targetPath(p) {
  const i = p.tool_input;
  if (!i || typeof i !== 'object') return '';
  const f = i.file_path ?? i.notebook_path ?? i.path;
  return typeof f === 'string' ? f : '';
}

// The transcript's size in bytes: a cheap proxy for how much context the agent
// carries, so a denial can be read against how deep into the session it fell.
function transcriptBytes(p) {
  try {
    return typeof p.transcript_path === 'string' && p.transcript_path ? statSync(p.transcript_path).size : undefined;
  } catch { return undefined; }
}

// One telemetry row. `x` carries the per-outcome fields.
function row(p, ctx, outcome, x = {}) {
  const r = {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_id: ctx.agent,
    ...(typeof p.agent_type === 'string' && p.agent_type ? { agent_type: p.agent_type } : {}),
    ...(typeof p.tool_use_id === 'string' && p.tool_use_id ? { tool_use_id: p.tool_use_id } : {}),
    hook_event: ctx.ev,
    path_hash: ctx.pk ? pathHash(ctx.pk) : '',
    range: x.a ? `${x.a}-${x.b}` : (ctx.range || ''),
    est_chars_avoided: outcome === 'deny' ? x.est : 0,
    ...(x.est !== undefined ? { est_chars: x.est } : {}),
    outcome,
    ...(outcome === 'deny' ? { deny_chars: denyText(x.a, x.b).length } : {}),
    ...(x.age_ms !== undefined ? { age_ms: x.age_ms } : {}),
    ...(x.deny_at !== undefined ? { deny_at: new Date(x.deny_at).toISOString() } : {}),
    ...(x.why ? { allow_reason: x.why } : {}),
    ...(x.reason ? { reason: x.reason } : {}),
    ...(x.have !== undefined ? { lines_read: x.have } : {}),
    ...(x.idx !== undefined ? { read_index: x.idx } : {}),
    lock_wait_ms: ctx.wait_ms,
    duration_ms: Date.now() - T0,
  };
  const tb = transcriptBytes(p);
  if (tb !== undefined) r.transcript_bytes = tb;
  appendLog(TELEMETRY_STREAM, r);
}

try {
  const p = readStdin();
  if (!opt('read_dedupe', true)) passthrough();
  if (!p || typeof p !== 'object' || isServedCall(p)) passthrough();
  const sid = String(p.session_id ?? '');
  if (!sid) passthrough();
  const agent = agentOf(p);
  const ev = eventArg();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const ctx = { agent, ev, pk: '', range: '', wait_ms: 0 };

  if (ev === 'reset') {
    const r = resetAgent(sid, p.agent_id ? agent : null);
    if (!r.locked) row(p, { ...ctx, wait_ms: r.wait_ms }, 'lock-timeout');
    passthrough();
  }

  if (ev === 'invalidate') {
    if (!['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(p.tool_name)) passthrough();
    const f = targetPath(p);
    if (!f) passthrough();
    const pk = pathKeyOf(f, cwd);
    const r = withState(sid, agent, (state) => invalidate(state, { agent, pk }));
    if (!r.locked) row(p, { ...ctx, pk, wait_ms: r.wait_ms }, 'lock-timeout');
    passthrough();
  }

  if (p.tool_name !== 'Read') passthrough();
  const f = targetPath(p);
  if (!f) passthrough();
  const pk = pathKeyOf(f, cwd);
  ctx.pk = pk;
  const req = requestOf(p.tool_input);
  if (req) ctx.range = `${req.start}-${req.end}`;
  const stat = statOf(resolve(cwd, f));

  if (ev === 'post') {
    const r = withState(sid, agent, (state) => record(state, { agent, pk, input: p.tool_input, response: p.tool_response, stat }));
    // A post that could not lock is a read that went unrecorded (a missed dedupe later).
    if (!r.locked) row(p, { ...ctx, wait_ms: r.wait_ms }, 'lock-timeout');
    passthrough();
  }

  if (ev === 'pre') {
    // Subagents only: a per-file line budget (read_budget, read_budget_lines) and an outline of a big file on its first read.
    const sub = callerIsSubagent(p);
    // Same scope as the shell-read hook: the agent's own repository, and not a log or test-output file.
    const budget = sub && opt('read_budget', true) && inBudgetScope(f, cwd, pathUnder, { existsSync }, { resolve, dirname, relative })
      ? budgetOf(Number(opt('read_budget_lines', READ_BUDGET_LINES_DEFAULT))) : null;
    let bigLines = 0;
    let outlineText = '';
    if (sub && stat && stat.size > 4000 && stat.size <= 2 * 1024 * 1024 && outlineKind(f)) {
      try {
        const buf = readFileSync(resolve(cwd, f));
        if (!buf.subarray(0, 8192).includes(0)) {
          const text = buf.toString('utf8');
          bigLines = countLinesIn(text);
          if (bigLines > OUTLINE_MIN_LINES) outlineText = outlineOf(text, f, OUTLINE_MAX_CHARS);
        }
      } catch { bigLines = 0; }
    }
    const r = withState(sid, agent, (state) => decide(state, { agent, pk, input: p.tool_input, stat, budget, bigLines }));
    ctx.wait_ms = r.wait_ms;
    if (!r.locked) {
      row(p, ctx, 'lock-timeout'); // fail open: the read runs
      passthrough();
    }
    const value = r.value;
    if (!value) passthrough();
    if (value.action === 'retry') {
      row(p, ctx, 'retry-ran', value);
      passthrough();
    }
    if (value.action === 'deny') {
      if (value.budget) {
        row(p, ctx, 'deny', { ...value, reason: 'budget', est: 0 });
        deny(`Read budget: you have already read ${value.have} distinct lines of ${f} (budget ${value.max}). grep -n for the symbol you need, then Read offset/limit 80. Repeat this call and it will run.`);
      }
      row(p, ctx, 'deny', value);
      deny(denyText(value.a, value.b));
    }
    if (value.action === 'allow' && value.why) row(p, ctx, 'allow', value);
    const notes = [];
    if (value.nudge) {
      row(p, ctx, 'nudge', { ...value, est: 0 });
      notes.push(`[agent-companion] read budget: you have read ${value.have} distinct lines of ${f} and this read passes ${budget.nudge}. Stop walking it in chunks: grep -n for the symbol you need, then Read offset/limit 80. New lines past ${budget.max} are denied.`);
    }
    if (value.outline && outlineText) {
      row(p, ctx, 'outline', { ...value, est: 0 });
      notes.push(`[agent-companion] outline of ${f} (${bigLines} lines, name:line): ${outlineText}. Read offset/limit from these line numbers.`);
    }
    if (notes.length) writeAndExit(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join('\n') } }));
  }
  passthrough();
} catch {
  passthrough(); // never break a session
}
