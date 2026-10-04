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
// Telemetry, telemetry/read-dedupe.jsonl: one row per denial (outcome "deny")
// and one per denied request that was repeated and ran (outcome "retry-ran").

import { resolve } from 'node:path';
import { readStdin, opt, deny, passthrough, appendLog } from './lib/context.mjs';
import { isServedCall } from './lib/delegation.mjs';
import {
  TELEMETRY_STREAM, agentOf, pathKeyOf, pathHash, statOf, withState, resetAgent, decide, record, invalidate, denyText,
} from './lib/read-dedupe.mjs';

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

function row(p, agent, pk, outcome, a, b, est) {
  appendLog(TELEMETRY_STREAM, {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_id: agent,
    path_hash: pathHash(pk),
    range: `${a}-${b}`,
    est_chars_avoided: outcome === 'deny' ? est : 0,
    outcome,
  });
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

  if (ev === 'reset') {
    resetAgent(sid, p.agent_id ? agent : null);
    passthrough();
  }

  if (ev === 'invalidate') {
    if (!['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(p.tool_name)) passthrough();
    const f = targetPath(p);
    if (!f) passthrough();
    const pk = pathKeyOf(f, cwd);
    withState(sid, (state) => invalidate(state, { agent, pk }));
    passthrough();
  }

  if (p.tool_name !== 'Read') passthrough();
  const f = targetPath(p);
  if (!f) passthrough();
  const pk = pathKeyOf(f, cwd);
  const stat = statOf(resolve(cwd, f));

  if (ev === 'post') {
    withState(sid, (state) => record(state, { agent, pk, input: p.tool_input, response: p.tool_response, stat }));
    passthrough();
  }

  if (ev === 'pre') {
    const { locked, value } = withState(sid, (state) => decide(state, { agent, pk, input: p.tool_input, stat }));
    if (!locked || !value) passthrough();
    if (value.action === 'retry') {
      row(p, agent, pk, 'retry-ran', value.a, value.b, value.est);
      passthrough();
    }
    if (value.action === 'deny') {
      row(p, agent, pk, 'deny', value.a, value.b, value.est);
      deny(denyText(value.a, value.b));
    }
  }
  passthrough();
} catch {
  passthrough(); // never break a session
}
